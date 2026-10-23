/**
 * The Claude Subscription route for DSH.
 *
 * This plugin registers one `LlmAdapter` route, `claude-sub`, which sends
 * model requests to Anthropic using a Claude Pro/Max subscription obtained
 * through the official browser OAuth flow. It also exposes the subscription's
 * rate-limit windows and enforces an egress policy on every request it makes.
 *
 * ## Deviation from the adapter attribution contract
 *
 * `LlmAdapter` documents that every provider HTTP request must include
 * `attributionHeaders()`. **This route deliberately does not**, and that is the
 * point of it: a subscription request is authenticated as the Claude Code
 * client, and presenting harness attribution in the same request would make the
 * two identities contradict each other. The guard rewrites the User-Agent to
 * `claude-cli/<version>` as the final step before dispatch, and this note
 * records that the omission is intentional rather than an oversight.
 *
 * @module dsh-ccsub
 */

import Schema from '@deepseek-ai/schemastery';
import { EgressGuard, parseAllowlist, normalizeProxyUrl, DEFAULT_EGRESS_URL } from './egress.js';
import { Tunnel, normalizeServerUrl } from './tunnel.js';
import { createAdapter } from './adapter.js';
import { LoginBridge } from './auth/bridge.js';
import { registerLogin } from './auth/flow.js';
import {
  resolveAccessToken,
  fetchUsage,
  guardTokenEndpoint,
  ensureFetchGuarded,
  subscriptionProvider,
  modelsFor,
  fetchModelList,
} from './auth/claude.js';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { PROVIDER_ID, recordKeyFor, describeGrant } from './auth/store.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Fail-loudly diagnose dependency drift.
 *
 * pi-ai is a **peer** dependency, so exactly one copy exists in the process:
 * the harness's. The plugin cannot pin its own and it must not try — a private
 * copy would be a second module instance, and the provider objects this plugin
 * builds would then cross a type boundary the harness's adapter does not
 * expect. The trade-off is that a harness that ships a pi-ai older than this
 * plugin's code expects turns the failure into an opaque
 * `Cannot read properties of undefined` deep inside a stream.
 *
 * This check resolves *the copy that is actually loaded* — not a copy found by
 * walking `node_modules` upward, which is what a peer dependency does not have
 * — and turns a mismatch into an actionable message at startup and a visible
 * flag on /status.
 * @returns the compatibility report for logging and /status.
 */
function dependencyReport() {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const path = require('node:path');

  /**
   * Read a package manifest by walking the `node_modules` chain from this file.
   *
   * Still needed for the harness packages: `dsh-llm-pi-ai` is a peer resolved
   * through the runtime resolver, which is invisible to a plain filesystem walk,
   * but on a linked (source-directory) install it *is* on disk above us.
   */
  const read = (id) => {
    const name = id.endsWith('/package.json') ? id.slice(0, -'/package.json'.length) : id;
    let here = path.dirname(fileURLToPath(import.meta.url));
    while (true) {
      const candidate = path.join(here, 'node_modules', name, 'package.json');
      if (fs.existsSync(candidate)) {
        try {
          return JSON.parse(fs.readFileSync(candidate, 'utf8'));
        } catch {
          return undefined;
        }
      }
      const parent = path.dirname(here);
      if (parent === here) return undefined;
      here = parent;
    }
  };

  /**
   * Resolve the pi-ai entry the interceptor will hand this module, then read
   * the manifest of the package that entry belongs to.
   *
   * `import.meta.resolve` — not `require.resolve` — because pi-ai is pure ESM
   * and its `exports` map declares only the `import` condition: a CJS resolve
   * fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` even though the module loads
   * fine. The ESM resolver is also the one the harness hooks, so this reports
   * the copy that will actually be *imported*, not a stale one that merely sits
   * in a `node_modules` above.
   */
  const loadedManifest = (id) => {
    let entry;
    try {
      entry = fileURLToPath(import.meta.resolve(id));
    } catch {
      return undefined;
    }
    let here = path.dirname(entry);
    while (true) {
      const candidate = path.join(here, 'package.json');
      if (path.basename(here) !== 'node_modules' && fs.existsSync(candidate)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          if (manifest.name === id) return manifest;
          return undefined;
        } catch {
          return undefined;
        }
      }
      const parent = path.dirname(here);
      if (parent === here) return undefined;
      here = parent;
    }
  };

  const own = loadedManifest('@earendil-works/pi-ai') ?? read('@earendil-works/pi-ai/package.json');
  const adapter = read('@deepseek-ai/dsh-llm-pi-ai/package.json');
  const required = adapter?.dependencies?.['@earendil-works/pi-ai'];
  const satisfies =
    own?.version !== undefined && required !== undefined
      ? satisfiesRange(own.version, required)
      : undefined;
  return {
    piAiVersion: own?.version ?? null,
    piAiRequiredByAdapter: required ?? null,
    adapterVersion: adapter?.version ?? null,
    compatible: satisfies,
  };
}

/** Split a version into its numeric triple and prerelease tag. */
function parseVersion(version) {
  const [core, ...pre] = String(version).trim().split('-');
  const [major, minor, patch] = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return { major, minor, patch, pre: pre.join('-') };
}

/** Compare two parsed versions: negative, zero, or positive like a sort key. */
function compareParsed(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  // A prerelease sorts *below* the release it leads to: 1.0.0-rc.1 < 1.0.0.
  if (a.pre === b.pre) return 0;
  if (a.pre === '') return 1;
  if (b.pre === '') return -1;
  return a.pre < b.pre ? -1 : 1;
}

/**
 * Does `version` satisfy `range`?
 *
 * Handles the comparator shapes this plugin actually reasons about — `||`
 * unions of space-separated comparators, `^`, `~`, and the `>= <= > < =`
 * operators — because the range comes from another package's manifest and
 * cannot be assumed to be a bare caret. Anything unparsable is treated as
 * "unknown" (`undefined`) rather than silently reported as incompatible, so a
 * range this helper does not understand never produces a false alarm.
 * @returns true, false, or undefined when the range is not understood.
 */
function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!Number.isFinite(parsed.major)) return undefined;
  let understood = false;

  for (const clause of String(range).split('||')) {
    const comparators = clause.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) continue;
    const checks = [];
    for (const token of comparators) {
      const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(token);
      if (m === null) {
        checks.length = 0;
        break;
      }
      const operator = m[1] ?? '=';
      const base = {
        major: Number(m[2]),
        minor: Number(m[3] ?? 0),
        patch: Number(m[4] ?? 0),
        pre: m[5] ?? '',
      };
      if (operator === '^') {
        // ^0.87.1 pins the minor, ^1.1.0 pins the major, ^0.0.3 pins the patch.
        const upper =
          base.major > 0
            ? { major: base.major + 1, minor: 0, patch: 0, pre: '' }
            : base.minor > 0
              ? { major: 0, minor: base.minor + 1, patch: 0, pre: '' }
              : { major: 0, minor: 0, patch: base.patch + 1, pre: '' };
        checks.push((v) => compareParsed(v, base) >= 0 && compareParsed(v, upper) < 0);
      } else if (operator === '~') {
        const upper = { major: base.major, minor: base.minor + 1, patch: 0, pre: '' };
        checks.push((v) => compareParsed(v, base) >= 0 && compareParsed(v, upper) < 0);
      } else if (operator === '>=') checks.push((v) => compareParsed(v, base) >= 0);
      else if (operator === '<=') checks.push((v) => compareParsed(v, base) <= 0);
      else if (operator === '>') checks.push((v) => compareParsed(v, base) > 0);
      else if (operator === '<') checks.push((v) => compareParsed(v, base) < 0);
      else checks.push((v) => compareParsed(v, base) === 0);
    }
    if (checks.length === 0) continue;
    understood = true;
    if (checks.every((check) => check(parsed))) return true;
  }
  return understood ? false : undefined;
}



/** The only route this plugin serves. */
const ROUTE = PROVIDER_ID;

/** Base path for this plugin's HTTP surface. */
const API_BASE = '/plugins/dsh-ccsub';

/**
 * Prefix that makes a value look like an Anthropic OAuth access token.
 *
 * pi-ai sniffs the api key for this substring to pick the subscription request
 * shape, which is the only shape that carries the leading Claude Code system
 * block Anthropic requires. In `claude-server` mode the local process holds no
 * real access token, so the client bearer is presented with this prefix purely
 * to select that shape; `Tunnel` removes it before building `authorization`.
 */
const OAUTH_SHAPE_PREFIX = 'sk-ant-oat-';

/** Where the latest official CLI version is read from (through the guard). */
const NPM_LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
/** Used when no auto-resolved version is available yet. */
const FALLBACK_CLI_VERSION = '2.1.283';
/** How often the auto-resolved version is refreshed. */
const CLI_VERSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the global fetch guard is re-asserted against over-wrapping. */
const FETCH_GUARD_HEAL_MS = 60 * 1000;
/** How often the dynamic model catalog overlay is refreshed. */
const MODELS_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum spacing between usage probes.
 *
 * The usage endpoint's rate limit is much stricter than the messages endpoint
 * and its 429s persist, so every caller shares one cache window. The quota
 * windows are five-hourly and weekly, so five minutes loses no decision the
 * throttle gate would otherwise make correctly.
 */
const QUOTA_MIN_INTERVAL_MS = 5 * 60_000;

export const name = 'dsh-ccsub';

/**
 * Required services.
 *
 * Only `llm` is a hard requirement: it is what this plugin exists to extend.
 * The web server, authorization, and credential store are optional — a headless
 * or TUI profile has no web server yet still uses the model route. Those are
 * attached with `ctx.inject` inside `apply`, which waits for each service
 * instead of preventing activation.
 */
export const inject = ['llm'];

/** Resolve a volatile schema field (reactive ref or {value} wrapper) to a plain value. */
function resolvePrefValue(candidate) {
  if (candidate === null || candidate === undefined) return candidate;
  if (Array.isArray(candidate)) return candidate;
  if (typeof candidate === 'object' && typeof candidate.get === 'function') {
    try {
      return candidate.get();
    } catch {
      return undefined;
    }
  }
  if (typeof candidate === 'object' && candidate.meta?.volatile === true && 'value' in candidate) {
    return candidate.value;
  }
  return candidate;
}

/** Read one scalar preference with a fallback, tolerating volatile wrappers. */
function prefScalar(fallback, candidate) {
  const value = resolvePrefValue(candidate);
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

/**
 * Plugin configuration.
 *
 * Every field is volatile: the values live in user settings (editable from
 * the Settings sidebar at runtime through the `settings` service), not only
 * in the profile patch file.
 */
export const Config = Schema.object({
  /**
   * Where the subscription lives.
   *
   * - `direct`      — this process holds the OAuth grant and talks to Anthropic
   *                   itself, through the mandatory proxy.
   * - `claude-server` — a separate `claude-server` deployment holds the grant;
   *                   this process presents a bearer to it and never sees the
   *                   Claude token. The proxy block is unused in this mode.
   */
  mode: Schema.union(['direct', 'claude-server']).default('direct'),
  /** Settings for `mode: claude-server`. */
  claudeServer: Schema.object({
    /**
     * The server's origin, e.g. `http://127.0.0.1:4710`. Required in
     * claude-server mode; the route refuses every request until it is set.
     */
    url: Schema.string().default(''),
    /**
     * Where the client bearer is read from. The value is stored through the
     * harness credential plane (an `api-key` record under this plugin's scope),
     * never in the config file — a bearer in plain text would be copied into
     * every settings export.
     */
    bearerRecord: Schema.string().default('claude-server'),
  }),
  proxy: Schema.object({
    /**
     * The single transport every request must use. Empty means "refuse to send".
     *
     * 9077 is the Claude-specific proxy. The general proxy (9076) resets the
     * connection for every `api.anthropic.com` / `claude.ai` host, so it can
     * serve the egress probe but not this route.
     */
    url: Schema.string().default('http://127.0.0.1:9077'),
    /** Expected egress addresses; empty enables session-pinning of the first observed IP. */
    egressAllow: Schema.array(Schema.string()).default([]),
    /** Refuse when the egress cannot be verified rather than only warning. Default on. */
    requireEgressCheck: Schema.boolean().default(true),
    /** Where to read the observed egress address from. */
    egressUrl: Schema.string().default(DEFAULT_EGRESS_URL),
  }),
  /** The Claude Code version to present on the wire. The literal `auto`
   * resolves to the latest published CLI version (read from the npm registry
   * through the guarded transport, refreshed weekly); any other string is
   * pinned as-is.
   */
  claudeCliVersion: Schema.string().default('auto'),
  /**
   * Declared context window for every catalog model (0 = keep the catalog
   * value). Raising it defers dsh's pressure compaction (thresholdRatio ×
   * window) so long sessions keep their prompt cache instead of compacting
   * at the stock 200k ceiling.
   */
  contextWindowOverride: Schema.number().default(0),
  /** Refresh an access token this long before it expires. */
  refreshSkewMs: Schema.number().default(300_000),
  /** How often the client polls the quota endpoint. */
  quotaPollMs: Schema.number().default(180_000),
  /**
   * Quota throttle: when any subscription window is at least this percent
   * used, new model requests park until the window resets (polled; they wake
   * and continue automatically). 0 disables the throttle.
   */
  quotaThrottlePercent: Schema.number().default(90),
  /** How often the background usage watcher refreshes while far from the
   * threshold (it tightens to 2 min once any window is within 10 points). */
  /**
   * @deprecated No background poller exists any more, so this has no effect.
   * Kept in the schema so a settings file written by an older version still
   * validates; usage is now probed on demand (see `QUOTA_MIN_INTERVAL_MS`).
   */
  quotaWatchPollMs: Schema.number().default(1_800_000),
  /**
   * Longest a request may stay parked on the quota gate before failing with
   * the reset time. Bounded because the adapter's resolveApiKey hook carries
   * no abort signal — an unbounded park would ignore UI "stop".
   */
  quotaParkMaxMs: Schema.number().default(15 * 60_000),
}).volatile();

/**
 * Read one JSON request body.
 * @param req - the incoming request.
 * @param limit - the largest body to accept.
 * @returns the parsed body, or undefined when absent.
 */
async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Answer one request with JSON.
 * @param res - the response to write.
 * @param status - the HTTP status.
 * @param body - the value to serialize.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Turn a thrown failure into a stable JSON error body.
 * @param error - the thrown value.
 * @returns the body to send with a 4xx/5xx status.
 */
function errorBody(error) {
  return { error: String(error?.message ?? error), code: error?.code ?? null };
}

/**
 * Everything the Host/Origin fence needs, derived from the live listener.
 *
 * The values are deliberately **not** literal addresses: hardcoding the port and
 * LAN IP of whichever machine the plugin was written on turns a port change or a
 * second machine into a total UI outage, and it never matched reality on any
 * other host. The listener knows its own bind address, port, and protocol, so
 * ask it instead of guessing.
 * @typedef {object} FencePolicy
 * @property {string} bindHost - the listener's bind IP literal.
 * @property {number} port - the port it actually bound.
 * @property {string} protocol - `http:` or `https:`.
 */

/**
 * Parse a `Host`-header authority into its hostname and port.
 *
 * Node's URL parser rejects a bare `host:port` (it expects a scheme), so this
 * reads the shape by hand: `[::1]:3080`, `127.0.0.1:3080`, `example.com`.
 * @param authority - the verbatim `Host` header.
 * @returns the parsed parts, or undefined when it is not an authority.
 */
function parseAuthority(authority) {
  const text = String(authority).trim();
  if (text === '') return undefined;
  let hostname;
  let rest;
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close === -1) return undefined;
    hostname = text.slice(1, close);
    rest = text.slice(close + 1);
  } else {
    const colon = text.lastIndexOf(':');
    // More than one colon without brackets cannot be a valid authority.
    if (colon !== -1 && text.indexOf(':') !== colon) return undefined;
    hostname = colon === -1 ? text : text.slice(0, colon);
    rest = colon === -1 ? '' : text.slice(colon);
  }
  if (hostname === '') return undefined;
  if (rest !== '' && !rest.startsWith(':')) return undefined;
  const portText = rest.slice(1);
  if (portText !== '' && !/^\d+$/.test(portText)) return undefined;
  return { hostname: hostname.toLowerCase(), port: portText === '' ? undefined : Number(portText) };
}

/** Whether a hostname is the IPv4 loopback range, `::1`, or the `localhost` name. */
function isLoopbackHostname(hostname) {
  const name = hostname.toLowerCase();
  if (name === 'localhost' || name === '::1') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(name)) return true;
  // IPv4-mapped IPv6 loopback, e.g. ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(name);
  return mapped !== null && mapped[1].startsWith('127.');
}

/** The port implicit in a scheme, so `Host: example.com` matches `Origin: https://example.com`. */
function defaultPortFor(protocol) {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * Reject cross-origin and rebound requests to this plugin's HTTP surface.
 *
 * Routes registered with `webServer.register` bypass the client-connection
 * layer's token admission, so this guard is the plugin's own defence. It mirrors
 * the fence DSH applies to its own `/api` transport, which is not exported:
 *
 * - `Host` must be loopback, the listener's own bind address, or the listening
 *   port on a loopback name — which is what defeats DNS rebinding, since an
 *   attacker's domain never produces a loopback `Host`;
 * - a browser's `Origin`, when present, must be the same authority as `Host`;
 * - `Sec-Fetch-Site: cross-site` is refused outright;
 * - non-browser clients (curl, the host itself) send no `Origin` and pass.
 * @param req - the incoming request.
 * @param policy - the live listener's bind facts.
 * @returns whether the request may reach the handler.
 */
function requestAuthorized(req, policy) {
  const authority = parseAuthority(req.headers?.host ?? '');
  if (authority === undefined) return false;

  const loopback = isLoopbackHostname(authority.hostname);
  const bindAddress = policy.bindHost !== undefined && authority.hostname === String(policy.bindHost).toLowerCase();
  if (!loopback && !bindAddress) return false;

  // A port, when present, must be one this listener could actually be serving:
  // its own, or the scheme's default. This is what keeps a stale port from
  // being accepted on an otherwise-correct hostname.
  const scheme = policy.protocol === 'https:' ? 'https:' : 'http:';
  const ownPort = policy.port;
  if (authority.port !== undefined && ownPort !== undefined && authority.port !== ownPort) {
    if (authority.port !== defaultPortFor(scheme)) return false;
  }

  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false;

  const origin = req.headers?.origin;
  if (origin === undefined) return true;

  let originUrl;
  try {
    originUrl = new URL(String(origin));
  } catch {
    return false;
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
  // Compare under the Origin's own scheme so `Host: example.com` (no port) and
  // `Origin: https://example.com` (implicit 443) match.
  const originPort = originUrl.port === '' ? defaultPortFor(originUrl.protocol) : Number(originUrl.port);
  const hostPort = authority.port === undefined ? defaultPortFor(originUrl.protocol) : authority.port;
  if (originPort !== hostPort) return false;

  // `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`) while
  // `parseAuthority` strips them, so normalise both sides before comparing.
  const stripBrackets = (name) =>
    name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
  const originHost = stripBrackets(originUrl.hostname.toLowerCase());
  const hostHost = stripBrackets(authority.hostname.toLowerCase());
  if (originHost !== hostHost) return false;

  return loopback || bindAddress;
}

/**
 * Wrap one handler with the Host/Origin fence.
 *
 * `policy` is a getter rather than a value so a listener that rebinds (or a
 * port assigned by the OS at listen time) is always read fresh.
 * @param handler - the route body.
 * @param policy - returns the live {@link FencePolicy}.
 * @returns a guarded handler.
 */
function guarded(handler, policy) {
  return (req, res) => {
    if (!requestAuthorized(req, policy())) {
      sendJson(res, 403, { error: 'request refused: unrecognised origin or host', code: 'FORBIDDEN' });
      return;
    }
    return handler(req, res);
  };
}

/**
 * The plugin body.
 * @param ctx - the plugin context.
 * @param config - the validated configuration.
 */
export function apply(ctx, config) {
  /**
   * Live volatile values live in the settings service, not in the boot-time
   * `config` (volatile fields are stripped from it). Read them through
   * describe() whenever the settings service is mounted; Schema defaults and
   * the patch-layer values remain the fallback.
   */
  let describeValue = null;
  /** Memoized describe(): the call iterates every entry with secret redaction,
   * and current() consults it per field — without a cache one request runs it
   * dozens of times and the event loop stalls. */
  let describeCache = { at: 0, value: null };
  ctx.inject(['settings'], (sctx) => {
    const svc = sctx.settings ?? sctx;
    if (typeof svc.describe !== 'function') return;
    const ns = (() => {
      try {
        for (const entry of ctx.loader.entries()) {
          const options = entry?.options;
          if (options?.name === name && typeof options.id === 'string' && options.id !== '') {
            return options.id;
          }
        }
      } catch {
        /* fall through */
      }
      return 'llm-claude-sub';
    })();
    describeValue = () => {
      if (Date.now() - describeCache.at < 1500) return describeCache.value;
      try {
        const form = (svc.describe({ redactSecrets: true }) ?? []).find((d) => d?.ns === ns);
        describeCache = { at: Date.now(), value: form?.value ?? null };
      } catch {
        describeCache = { at: Date.now(), value: null };
      }
      return describeCache.value;
    };
  });

  /** Read one scalar with priority: live settings → boot config → fallback. */
  const liveScalar = (fallback, key) => {
    const live = describeValue?.() ?? null;
    const fromLive = live === null ? undefined : resolvePrefValue(live[key]);
    if (fromLive !== undefined && fromLive !== null && fromLive !== '') return fromLive;
    const fromConfig = resolvePrefValue(config[key]);
    if (fromConfig !== undefined && fromConfig !== null && fromConfig !== '') return fromConfig;
    return fallback;
  };
  const liveProxyField = (fallback, key) => {
    const live = describeValue?.() ?? null;
    const liveProxy = live === null ? undefined : resolvePrefValue(live.proxy);
    const fromLive = liveProxy === undefined ? undefined : resolvePrefValue(liveProxy[key]);
    if (fromLive !== undefined && fromLive !== null && fromLive !== '') return fromLive;
    const configProxy = resolvePrefValue(config.proxy);
    const fromConfig = configProxy === undefined ? undefined : resolvePrefValue(configProxy[key]);
    if (fromConfig !== undefined && fromConfig !== null && fromConfig !== '') return fromConfig;
    return fallback;
  };

  /** Which transport serves this route: `direct` or `claude-server`. */
  const mode = () => {
    const value = String(liveScalar('direct', 'mode') ?? '').trim();
    return value === 'claude-server' ? 'claude-server' : 'direct';
  };
  /** The claude-server block, read live. */
  const serverSettings = () => {
    const live = describeValue?.() ?? null;
    const liveBlock = live === null ? undefined : resolvePrefValue(live.claudeServer);
    const configBlock = resolvePrefValue(config.claudeServer);
    const pick = (key, fallback) => {
      const fromLive = liveBlock === undefined ? undefined : resolvePrefValue(liveBlock[key]);
      if (fromLive !== undefined && fromLive !== null && fromLive !== '') return fromLive;
      const fromConfig = configBlock === undefined ? undefined : resolvePrefValue(configBlock[key]);
      if (fromConfig !== undefined && fromConfig !== null && fromConfig !== '') return fromConfig;
      return fallback;
    };
    return {
      url: pick('url', ''),
      bearerRecord: pick('bearerRecord', 'claude-server'),
      // The tunnel re-asserts the Claude Code identity before forwarding, and
      // that rewrite needs the same CLI version the direct path presents.
      // Without it here the tunnel would fall back to identity.js's built-in
      // default and the two modes would advertise different versions.
      claudeCliVersion: current().claudeCliVersion,
    };
  };

  /**
   * Resolve the client bearer for claude-server mode.
   *
   * Stored as an `api-key` record through the harness credential plane rather
   * than in configuration: it is this process's only credential in that mode,
   * and `modifyRecord` is the one serialized write path.
   * @returns the bearer string.
   * @throws {LlmError} `NOT_CONFIGURED` when no bearer is stored.
   */
  const resolveServerBearer = async () => {
    const key = serverSettings().bearerRecord;
    const credentials = ctx.get('credentials');
    if (credentials === undefined) {
      throw new LlmError(
        'dsh-ccsub: claude-server mode needs the credentials service to hold its client bearer, and this composition mounts none',
        'NO_CREDENTIAL_STORE',
      );
    }
    const record = await credentials.readRecord(recordKeyFor(key));
    const stored = record?.kind === 'api-key' ? record.key?.trim() : undefined;
    if (typeof stored !== 'string' || stored.length === 0) {
      throw new LlmError(
        `dsh-ccsub: no client bearer is stored for the claude-server at ${serverSettings().url || '(unset)'}. Paste the server's CLIENT_BEARER into the Claude Subscription card to sign in.`,
        'NOT_CONFIGURED',
      );
    }
    return stored;
  };

  /** The auto-resolved CLI version, when claudeCliVersion is `auto`. */
  const versionState = { resolved: undefined, at: 0 };
  const resolveInProgress = { running: false };

  /**
   * Read the latest published CLI version through the guarded transport.
   *
   * Best-effort: failures keep the previous value (or the fallback) and are
   * retried on the next interval tick, so a registry hiccup never blocks a
   * model request on version resolution.
   */
  const refreshCliVersion = async () => {
    if (resolveInProgress.running) return;
    resolveInProgress.running = true;
    try {
      const response = await guard.fetch(NPM_LATEST_URL, {
        // NB: the Claude-specific proxy answers 406 to npm's install-v1
        // accept type; plain application/json passes.
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return;
      const payload = await response.json();
      const version = payload?.version;
      if (typeof version === 'string' && version.length > 0) {
        versionState.resolved = version;
        versionState.at = Date.now();
        ctx.logger?.info('dsh-ccsub: presenting claude-cli/%s (auto)', version);
      }
    } catch {
      // Keep the previous resolution; the next tick retries.
    } finally {
      resolveInProgress.running = false;
    }
  };

  /**
   * The live configuration, re-read per request so edits apply immediately.
   * `auto` is materialised here so every consumer downstream of `current()`
   * sees a concrete version string.
   */
  const current = () => {
    const resolved = {
      claudeCliVersion: liveScalar(undefined, 'claudeCliVersion'),
      contextWindowOverride: Number(liveScalar(0, 'contextWindowOverride')) || 0,
      refreshSkewMs: Number(liveScalar(300_000, 'refreshSkewMs')) || 300_000,
      quotaPollMs: Number(liveScalar(180_000, 'quotaPollMs')) || 180_000,
      proxy: {
        url: liveProxyField('http://127.0.0.1:9077', 'url'),
        egressAllow: (() => {
          const value = liveProxyField(undefined, 'egressAllow');
          return Array.isArray(value) ? value : [];
        })(),
        requireEgressCheck: liveProxyField(true, 'requireEgressCheck') !== false,
        egressUrl: liveProxyField('https://api.ipify.org?format=json', 'egressUrl'),
      },
    };
    resolved.claudeCliVersion =
      resolved.claudeCliVersion === undefined || resolved.claudeCliVersion === 'auto'
        ? versionState.resolved ?? FALLBACK_CLI_VERSION
        : String(resolved.claudeCliVersion);
    return { ...config, ...resolved };
  };
  const guard = new EgressGuard(() => current().proxy ?? {}, ctx.logger);
  ctx.effect(() => () => guard.dispose());

  // In claude-server mode nothing local egresses to Anthropic: the server owns
  // the grant and the address. The tunnel therefore replaces the guard's role
  // as the transport rather than sitting behind it.
  const tunnel = new Tunnel(serverSettings, resolveServerBearer, ctx.logger);

  // pi-ai exchanges and refreshes tokens with the bare global `fetch`, so the
  // token endpoint is redirected through the guard for the life of the plugin.
  ctx.effect(() => guardTokenEndpoint(guard));
  // Another plugin or an undici upgrade can wrap the global after us; heal the
  // patch on a slow tick so the guarantee survives the process lifetime.
  ctx.effect(() => {
    const timer = setInterval(() => ensureFetchGuarded(guard), FETCH_GUARD_HEAL_MS);
    return () => clearInterval(timer);
  });
  // Resolve the CLI version now (for a fresh process) and on the TTL.
  void refreshCliVersion();
  ctx.effect(() => {
    const timer = setInterval(() => void refreshCliVersion(), CLI_VERSION_TTL_MS);
    return () => clearInterval(timer);
  });

  // One provider instance serves both the route adapter and the Models
  // collection, so a dynamic catalog refresh is visible to the route without
  // re-registering the adapter.
  /**
   * The transport the route uses right now.
   *
   * `claude-server` mode hands pi-ai the tunnel, which presents a bearer to a
   * remote server; `direct` mode hands it the guard, which enforces the
   * mandatory proxy. Both are `fetch`-shaped, so nothing downstream branches.
   */
  const transportNow = () => (mode() === 'claude-server' ? tunnel : guard);

  /** Provider cache: rebuilt when the context window or the transport changes. */
  let providerRev = null;
  let providerCache;
  /**
   * Ids discovered from the endpoint by this plugin.
   *
   * Held outside the provider because discovering them is asynchronous and the
   * provider is built synchronously on the request path; a refresh swaps this
   * list and bumps the revision, which rebuilds the provider with the new ids.
   */
  let discoveredModels = [];
  const providerNow = () => {
    const override = current().contextWindowOverride;
    const transport = transportNow();
    const revision = `${override}|${transport === tunnel ? 'tunnel' : 'guard'}|${
      transport === tunnel ? modelServerUrl() : ''
    }|${discoveredModels.map((model) => model.id).join(',')}`;
    if (providerCache === undefined || providerRev !== revision) {
      providerRev = revision;
      providerCache = subscriptionProvider(transport, {
        contextWindowOverride: override,
        extraModels: discoveredModels,
        ...(transport === tunnel ? { baseUrl: modelServerUrl() } : {}),
      });
    }
    return providerCache;
  };

  /** The origin the catalog should advertise in claude-server mode. */
  function modelServerUrl() {
    return normalizeServerUrl(serverSettings().url) ?? '';
  }

  // One provider instance serves both the route adapter and the Models
  // collection, so a dynamic catalog refresh is visible to the route without
  // re-registering the adapter.
  //
  // `fallbackRead` exists for claude-server mode. pi-ai's `Models.refresh()`
  // reads the provider's credential record purely to decide whether the network
  // is allowed; in that mode `ccsub/claude-sub` is intentionally blank (this
  // process holds no Claude grant), so the refresh used to return before asking
  // the server for its catalog. Supplying the client bearer as an `api_key`
  // credential satisfies that check, and the catalog then comes from the server,
  // which is also where the subscription actually lives.
  const models = modelsFor(ctx, transportNow(), providerNow(), {
    fallbackRead: async () => {
      if (mode() !== 'claude-server') return undefined;
      try {
        const bearer = await resolveServerBearer();
        return { type: 'api_key', key: bearer };
      } catch {
        // Not configured yet: no credential, so the catalog stays static.
        return undefined;
      }
    },
  });

  /**
   * Refresh the dynamic model catalog overlay through the guarded transport.
   *
   * Best-effort like the CLI version resolution: a failure keeps the previous
   * overlay (and the static baseline) and is retried on the next tick.
   */
  const refreshModelCatalog = async () => {
    try {
      // This plugin owns the credential and the server address in every mode, so
      // it asks the endpoint itself. pi-ai's own `fetchModels` hook cannot be
      // used for `claude-server` mode: pi-ai resolves the credential from the
      // route's grant record, which is blank there by design, so its refresh
      // returns before any request is made.
      const transport = transportNow();
      const access =
        mode() === 'claude-server'
          ? OAUTH_SHAPE_PREFIX + (await resolveServerBearer())
          : await resolveAccessToken(ctx, current(), AbortSignal.timeout(20_000));
      const found = await fetchModelList(transport, access, AbortSignal.timeout(20_000));
      const known = new Set(providerNow().getModels().map((model) => model.id));
      const fresh = found.filter((model) => !known.has(model.id));
      if (fresh.length === 0) {
        ctx.logger?.debug?.(
          'dsh-ccsub: model catalog already current (%d models)',
          known.size,
        );
        return;
      }
      discoveredModels = [...discoveredModels, ...fresh];
      const provider = providerNow();
      models.setProvider(provider);
      ctx.logger?.info(
        'dsh-ccsub: model catalog refreshed (+%d, %d models on the route)',
        fresh.length,
        provider.getModels().length,
      );
    } catch (error) {
      ctx.logger?.warn('dsh-ccsub: model catalog refresh failed: %s', error?.message ?? error);
    }
  };

  const adapter = createAdapter({
    // The adapter only reads `fetch` off this; in claude-server mode the tunnel
    // supplies it so no request can reach Anthropic from this process.
    guard: transportNow(),
    provider: providerNow,
    resolveApiKey: async (providerArg, profileArg, signalArg) => {
      await quotaGate.waitForCapacity(signalArg);
      // The token handed to pi-ai is only used to shape the request. Direct
      // mode hands over the real subscription token; claude-server mode hands
      // over the client bearer, which the server swaps for the real token.
      //
      // pi-ai decides the *request shape* by sniffing this value for
      // `sk-ant-oat`, and only that shape carries the two things Anthropic
      // requires of a subscription call: the `x-app`/oauth beta header set and
      // the leading system block `You are Claude Code, Anthropic's official CLI
      // for Claude.` Without it a claude-server request goes out as an ordinary
      // API call and Anthropic answers 429 — measured, with the same body
      // succeeding once the block is present.
      //
      // So the bearer is presented with the prefix, and `Tunnel` strips it
      // again before setting `authorization`. The prefix therefore never
      // reaches the wire, and the real secret is unchanged.
      if (mode() === 'claude-server') return OAUTH_SHAPE_PREFIX + (await resolveServerBearer());
      return await resolveAccessToken(ctx, current(), signalArg);
    },
    resolveAttachments: () => ctx.get('attachments'),
  });

  ctx.effect(() => ctx.llm.registerAdapter([ROUTE], adapter));

  // Mark every compaction-purpose LLM call: the quota gate lets them consume
  // the reserved 90-98% band instead of parking them. Without this, a manual
  // /compact over the threshold parks at the gate, the UI request times out
  // (~18 s), and the durable compaction lock stays wedged.
  //
  // The waterfall hands listeners the chunk STREAM, and downstream consumes it
  // with `yield*` — the listener must stay synchronous and return an async
  // iterable directly (an async listener returning Promise<stream> breaks the
  // pipeline with "yield* (intermediate value) is not async iterable"). The
  // flag clears when the consumer finishes, errors, or cancels the stream.
  ctx.effect(() =>
    ctx.on('llm/stream', (options, next) => {
      if (options?.purpose !== 'compaction') return next();
      const previous = globalThis.__CCSUB_COMPACTING;
      globalThis.__CCSUB_COMPACTING = true;
      const restore = () => {
        globalThis.__CCSUB_COMPACTING = previous;
      };
      let stream;
      try {
        stream = next();
      } catch (error) {
        restore();
        throw error;
      }
      return {
        [Symbol.asyncIterator]() {
          const iterator = stream[Symbol.asyncIterator]();
          return {
            async next(...args) {
              try {
                const result = await iterator.next(...args);
                if (result.done) restore();
                return result;
              } catch (error) {
                restore();
                throw error;
              }
            },
            async return(...args) {
              restore();
              return (await iterator.return?.(...args)) ?? { done: true, value: undefined };
            },
            async throw(...args) {
              restore();
              return (await iterator.throw?.(...args)) ?? { done: true, value: undefined };
            },
          };
        },
      };
    }),
  );

  // ---- Quota throttle: park requests once a window crosses the threshold ----
  //
  // The watcher refreshes usage in the background (tightening its cadence as a
  // window approaches the threshold). waitForCapacity blocks — polling every
  // 30 s — while any window is over threshold and its reset time is still in
  // the future, then releases automatically after the reset.
  const quotaGate = (() => {
    const state = {
      windows: [],
      fetchedAt: 0,
      lastError: null,
      waiting: 0,
    };
    /** Wakes every parked waiter (escape hatch: the resolveApiKey hook has no
     * abort signal, so UI "stop" cannot reach a parked request on its own). */
    const releasers = new Set();
    const releaseAll = () => {
      for (const resolve of [...releasers]) resolve();
    };

    const threshold = () => Number(liveScalar(90, 'quotaThrottlePercent')) || 0;
    /** Longest a request may stay parked before failing with the reset time. */
    const parkMaxMs = () => Number(liveScalar(15 * 60_000, 'quotaParkMaxMs')) || 15 * 60_000;

    const overWindows = () => {
      const t = threshold();
      if (t <= 0) return [];
      const now = Date.now();
      return state.windows.filter(
        (w) => Number(w.usedPercent) >= t && (w.resetsAt === undefined || w.resetsAt > now),
      );
    };

    const refresh = async (options = {}) => {
      // Anthropic rate-limits the usage endpoint far more tightly than the
      // messages endpoint, and its 429s are sticky: once tripped, every caller
      // keeps seeing them for a while. The card, the background watcher and the
      // throttle gate all reach `refresh()`, so the brake belongs here — one
      // cache shared by every path instead of a per-caller interval.
      //
      // Five minutes is chosen against what the numbers mean: the windows are
      // five-hourly and weekly, so a fresher reading changes no decision, while
      // a tighter loop only spends rate-limit budget. `force` is for the one
      // caller that must bypass it: the threshold-crossing re-check, whose whole
      // purpose is to observe a just-passed reset.
      const force = options.force === true;
      if (!force && state.fetchedAt !== 0 && Date.now() - state.fetchedAt < QUOTA_MIN_INTERVAL_MS) {
        return;
      }
      // In claude-server mode the grant lives on the server, so this process
      // cannot read it — but the server relays `/api/oauth/usage` just as it
      // relays `/v1/messages`, and it owns the real token. Probing *through* it
      // is therefore both possible and correct: the card shows the same numbers
      // the server's own console shows, and the throttle gate keeps working
      // instead of sitting idle.
      const accessSource =
        mode() === 'claude-server' ? async () => await resolveServerBearer() : undefined;
      try {
        const usage = await fetchUsage(
          ctx,
          transportNow(),
          current(),
          AbortSignal.timeout(30_000),
          accessSource,
        );
        state.windows = usage?.windows ?? [];
        state.fetchedAt = Date.now();
        state.lastError = null;
      } catch (error) {
        // Not signed in yet, or the usage probe failed: never throttle on
        // unknown data — requests must fail for their real reason instead.
        state.lastError = String(error?.message ?? error);
        if (/not signed in|NOT_CONFIGURED/.test(state.lastError)) state.windows = [];
      }
      // In-process flags for sibling plugins. __CCSUB_QUOTA_OVER parks normal
      // requests; __CCSUB_QUOTA_MAX_PCT lets compaction consume the reserved
      // headroom above the threshold (see waitForCapacity's bypass).
      globalThis.__CCSUB_QUOTA_OVER = overWindows().length > 0;
      globalThis.__CCSUB_QUOTA_MAX_PCT = state.windows.reduce(
        (max, w) => Math.max(max, Number(w.usedPercent) || 0),
        0,
      );
    };

    const sleep = (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });

    const waitForCapacity = async (signal) => {
      // With the background watcher gone the snapshot can be arbitrarily old,
      // and a stale snapshot reports "nothing over threshold" — which would let
      // a request through exactly when it should park. So a request re-reads
      // usage first. `refresh()` enforces the shared interval, so this costs one
      // probe per window of use rather than one per request.
      await refresh();
      for (;;) {
        // Reserved headroom: compaction summarization (flagged in-process by
        // dsh-idle-compact) may consume the band above the normal threshold —
        // that quota is deliberately reserved for it — until the hard ceiling.
        const maxPct = Number(globalThis.__CCSUB_QUOTA_MAX_PCT) || 0;
        if (globalThis.__CCSUB_COMPACTING === true && maxPct < 98) return;
        const over = overWindows();
        if (over.length === 0) return;
        const nextReset = Math.min(...over.map((w) => (typeof w.resetsAt === 'number' ? w.resetsAt : Infinity)));
        const waitMin = Number.isFinite(nextReset)
          ? Math.max(1, Math.ceil((nextReset - Date.now()) / 60_000))
          : null;
        ctx.logger?.warn(
          'dsh-ccsub: quota at/over %s%% on %d window(s)%s — parking request until reset',
          threshold(), over.length, waitMin === null ? '' : ` (resets in ~${waitMin} min)`,
        );
        state.waiting += 1;
        try {
          // Wake sources: the authoritative reset time (+skew), a caller
          // abort when a signal exists, an explicit release (the resolveApiKey
          // hook normally carries no signal, so "stop" in the UI cannot reach
          // a parked request — the release endpoint is the escape hatch), or
          // the park cap failing the turn with the reset time.
          const until = Number.isFinite(nextReset) ? nextReset + 90_000 : Date.now() + 10 * 60_000;
          const deadline = Math.min(until, Date.now() + parkMaxMs());
          const releaseCleanups = [];
          const released = new Promise((resolve) => {
            releasers.add(resolve);
            releaseCleanups.push(() => releasers.delete(resolve));
          });
          let skipped = false;
          try {
            await Promise.race([
              sleep(deadline - Date.now(), signal).then(() => 'time'),
              released.then(() => ((skipped = true), 'release')),
            ]);
          } finally {
            for (const cleanup of releaseCleanups.splice(0)) cleanup();
          }
          if (signal?.aborted) {
            throw new LlmError(
              `dsh-ccsub: subscription quota is over ${threshold()}% — waiting was cancelled. Window resets ${waitMin === null ? 'at an unknown time' : `in ~${waitMin} min`}.`,
              'QUOTA_THROTTLED',
            );
          }
          if (skipped) {
            throw new LlmError(
              `dsh-ccsub: quota wait was skipped manually. Window resets ${waitMin === null ? 'at an unknown time' : `in ~${waitMin} min`}.`,
              'QUOTA_THROTTLED',
            );
          }
          if (Date.now() >= deadline && deadline < until) {
            throw new LlmError(
              `dsh-ccsub: subscription quota is over ${threshold()}% — request waited ${Math.round(parkMaxMs() / 60_000)} min and gave up. Window resets ${waitMin === null ? 'at an unknown time' : `in ~${waitMin} min`}; retry after that, raise quotaParkMaxMs, or disable the throttle (0).`,
              'QUOTA_THROTTLED',
            );
          }
          // Reset time has passed: refresh once before re-checking, bypassing
          // the cache — the whole point is to read the window that just reset.
          await refresh({ force: true });
        } finally {
          state.waiting -= 1;
        }
      }
    };

    return {
      state,
      refresh,
      waitForCapacity,
      releaseAll,
      snapshot: () => ({
        threshold: threshold(),
        over: overWindows(),
        // The raw windows are what the card renders. `over` is the derived
        // subset the gate acts on, so it cannot stand in for this: a caller
        // displaying usage needs every window, including those under threshold.
        windows: state.windows,
        fetchedAt: state.fetchedAt,
        lastError: state.lastError,
        waiting: state.waiting,
      }),
    };
  })();

  // Usage is refreshed on demand only.
  //
  // There used to be a background watcher here. It was removed because polling
  // for a number nobody is reading buys nothing and costs the one thing the
  // usage endpoint is scarce on: its rate-limit budget is far tighter than the
  // messages endpoint's, and a tripped limit returns 429 for a sustained period,
  // which then breaks the panel for the operator who finally does look.
  //
  // What still reads usage:
  //   - `GET /quota`, whenever a card asks (returns the cached snapshot)
  //   - `waitForCapacity`, but only while a parked request exists
  //
  // The second is the case that genuinely needs a timer: a request is waiting on
  // a threshold crossing and must wake when the window resets. It arms one sleep
  // per parked request and stops when none are parked, so an idle process probes
  // nothing at all.

  // Refresh the dynamic model overlay now (when signed in) and daily. When no
  // grant is stored the refresh resolves no credential and is a no-op. The
  // scheduling waits for the credentials service: at mount time the service
  // may not be attached yet, and a refresh that reads no credential silently
  // skips its network phase — which is exactly what must not happen.
  ctx.inject(['credentials'], () => {
    void refreshModelCatalog();
    ctx.effect(() => {
      const timer = setInterval(() => void refreshModelCatalog(), MODELS_REFRESH_MS);
      return () => clearInterval(timer);
    });
  });

  // ---- Host HTTP surface, consumed by the settings card -------------------
  //
  // The service surfaces below are gated with `ctx.inject` rather than the
  // module-level `inject` array. Declaring them there would make them hard
  // requirements, so `apply` would never run in a profile without a web server
  // — and the model route, which does not need one, would disappear with it.

  ctx.inject(['authorization'], (authCtx) => {
    // Register the flow the settings card begins. Without this the flow key has
    // no handler and `authorization.begin` fails with `NO_FLOW`.
    registerLogin(authCtx);
  });

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');

    /**
     * The fence policy, read from the live listener.
     *
     * Evaluated per request rather than captured once: the OS-assigned port (and
     * a configuration reload) only settles after `listen`, and a stale port here
     * would 403 every request — the exact failure the previous hardcoded lists
     * produced on any machine but the one they were written on.
     * @returns the current bind facts.
     */
    const fencePolicy = () => {
      const host = typeof webServer.host === 'string' ? webServer.host : undefined;
      const port = typeof webServer.port === 'number' ? webServer.port : undefined;
      const protocol = typeof webServer.protocol === 'string' ? webServer.protocol : 'http:';
      return { bindHost: host, port, protocol };
    };

    /** Bind one handler to the live fence policy. */
    const guard = (handler) => guarded(handler, fencePolicy);

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/status`,
        handler: guard(async function (_req, res) {
          try {
            const record = await ctx.get('credentials')?.readRecord(recordKeyFor(ROUTE));
            const server = serverSettings();
            const serverUrl = normalizeServerUrl(server.url);
            const bearerRecord = await ctx
              .get('credentials')
              ?.readRecord(recordKeyFor(server.bearerRecord));
            const proxyUrl = normalizeProxyUrl(current().proxy?.url);
            const active = mode();
            sendJson(res, 200, {
              route: ROUTE,
              mode: active,
              compat: report,
              quotaThrottle: quotaGate.snapshot(),
              grant: describeGrant(record),
              // Presence only: the bearer itself never leaves the process.
              claudeServer: {
                url: serverUrl ?? null,
                valid: serverUrl !== undefined,
                bearerConfigured:
                  bearerRecord?.kind === 'api-key' &&
                  typeof bearerRecord.key === 'string' &&
                  bearerRecord.key.length > 0,
              },
              // The proxy block is inert in claude-server mode, and saying so is
              // clearer than reporting a setting that does nothing.
              proxy: {
                active: active === 'direct',
                url: proxyUrl ?? null,
                valid: proxyUrl !== undefined,
                allow: parseAllowlist(current().proxy?.egressAllow),
                requireEgressCheck: current().proxy?.requireEgressCheck === true,
              },
              claudeCliVersion: current().claudeCliVersion,
              quotaPollMs: current().quotaPollMs,
              // Report whether sign-in can actually run, not merely whether an
              // authorization service exists: a service without our flow fails
              // `begin` with NO_FLOW, and this field is what the card trusts.
              loginAvailable:
                ctx.get('authorization')?.describe?.(recordKeyFor(ROUTE)) !== undefined,
              models: (await adapter.listModels(ROUTE)).map((model) => ({ id: model.id, name: model.name })),
            });
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        }),
      }),
    );

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/quota`,
        handler: guard(async function (req, res) {
          // The card must not probe upstream on every mount: the usage
          // endpoint's limit is tight and its 429s persist. `quotaGate` owns the
          // shared cache, so route the read through it and serve whatever it
          // has. A miss (first call, or older than the shared interval) triggers
          // one probe; a hit returns without touching the network.
          await quotaGate.refresh();
          const snapshot = quotaGate.snapshot();
          if (snapshot.lastError !== null) {
            sendJson(res, 502, { error: snapshot.lastError, code: 'USAGE_FAILED' });
            return;
          }
          sendJson(res, 200, {
            supported: true,
            windows: snapshot.windows,
            fetchedAt: snapshot.fetchedAt,
          });
        }),
      }),
    );

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/settings`,
        handler: guard(async function (req, res) {
          if (req.method === 'GET') {
            try {
              const c = current();
              const server = serverSettings();
              sendJson(res, 200, {
                mode: mode(),
                claudeServer: {
                  url: server.url,
                  bearerRecord: server.bearerRecord,
                  // Presence only. The bearer itself is stored as a credential
                  // record and must never travel back out through a settings read.
                  bearerConfigured: (await ctx.get('credentials')?.readRecord(recordKeyFor(server.bearerRecord)))
                    ?.kind === 'api-key',
                },
                claudeCliVersion: (() => {
                  const v = liveScalar(undefined, 'claudeCliVersion');
                  return v === undefined ? 'auto' : String(v);
                })(),
                contextWindowOverride: c.contextWindowOverride,
                refreshSkewMs: c.refreshSkewMs,
                quotaPollMs: Number(liveScalar(180_000, 'quotaPollMs')) || 180_000,
                quotaThrottlePercent: Number(liveScalar(90, 'quotaThrottlePercent')) || 0,
                quotaWatchPollMs: Number(liveScalar(1_800_000, 'quotaWatchPollMs')) || 1_800_000,
                proxy: c.proxy,
                resolved: { claudeCliVersion: c.claudeCliVersion },
              });
            } catch (error) {
              sendJson(res, 500, errorBody(error));
            }
            return;
          }
          if (req.method === 'POST') {
            try {
              const body = (await readJson(req)) ?? {};
              const settings = ctx.get('settings');
              if (settings === undefined || typeof settings.update !== 'function') {
                sendJson(res, 503, { error: 'no settings service mounted; edit cordis.patch.yml instead', code: 'NO_SETTINGS' });
                return;
              }
              // Namespace is this plugin's loader entry id.
              let ns = 'llm-claude-sub';
              try {
                for (const entry of ctx.loader.entries()) {
                  const options = entry?.options;
                  if (options?.name === name && typeof options.id === 'string' && options.id !== '') {
                    ns = options.id;
                    break;
                  }
                }
              } catch {
                /* keep fallback ns */
              }
              let revision;
              try {
                const form = (settings.describe?.({ redactSecrets: true }) ?? []).find((d) => d?.ns === ns);
                revision = form?.revision;
              } catch {
                /* update without revision */
              }
              const patch = {};
              const accepted = ['claudeCliVersion', 'contextWindowOverride', 'refreshSkewMs', 'quotaPollMs', 'quotaThrottlePercent', 'quotaWatchPollMs', 'quotaParkMaxMs'];
              for (const key of accepted) {
                if (body[key] !== undefined) patch[key] = body[key];
              }
              // Transport selection. Both fields are live: `mode()` and
              // `serverSettings()` read the settings store on every request, so a
              // switch takes effect without a restart. Validate rather than trust
              // the body — a bad `mode` would otherwise silently fall back to
              // direct in `mode()` while the stored value disagreed.
              if (body.mode !== undefined) {
                const next = String(body.mode).trim();
                if (next !== 'direct' && next !== 'claude-server') {
                  sendJson(res, 400, {
                    error: `mode must be "direct" or "claude-server", got ${JSON.stringify(body.mode)}`,
                    code: 'BAD_MODE',
                  });
                  return;
                }
                patch.mode = next;
              }
              if (body.claudeServer !== undefined && typeof body.claudeServer === 'object' && body.claudeServer !== null) {
                const prev = serverSettings();
                const url = typeof body.claudeServer.url === 'string' ? body.claudeServer.url.trim() : prev.url;
                // Reject an unusable origin here instead of failing every model
                // request later: an empty value is allowed (it just means "not
                // configured yet"), a non-empty one must be a bare http(s) origin.
                if (url.length > 0 && normalizeServerUrl(url) === undefined) {
                  sendJson(res, 400, {
                    error: `${JSON.stringify(url)} is not a plain http(s) origin; give a bare scheme, host, and optional port (for example http://127.0.0.1:4710)`,
                    code: 'BAD_SERVER_URL',
                  });
                  return;
                }
                patch.claudeServer = {
                  url,
                  bearerRecord:
                    typeof body.claudeServer.bearerRecord === 'string' && body.claudeServer.bearerRecord.trim().length > 0
                      ? body.claudeServer.bearerRecord.trim()
                      : prev.bearerRecord,
                };
              }
              if (body.proxy !== undefined && typeof body.proxy === 'object') {
                const prev = current().proxy;
                patch.proxy = {
                  url: typeof body.proxy.url === 'string' ? body.proxy.url : prev.url,
                  egressAllow: Array.isArray(body.proxy.egressAllow)
                    ? body.proxy.egressAllow.map((x) => String(x).trim()).filter(Boolean)
                    : prev.egressAllow,
                  requireEgressCheck:
                    typeof body.proxy.requireEgressCheck === 'boolean'
                      ? body.proxy.requireEgressCheck
                      : prev.requireEgressCheck,
                  egressUrl: typeof body.proxy.egressUrl === 'string' ? body.proxy.egressUrl : prev.egressUrl,
                };
              }
              await settings.update(ns, patch, revision);
              describeCache = { at: 0, value: null }; // invalidate: read back immediately
              // A transport or endpoint change can mean a different catalog, so
              // re-ask now instead of waiting for the 24h tick.
              if (patch.mode !== undefined || patch.claudeServer !== undefined) {
                discoveredModels = [];
                void refreshModelCatalog();
              }
              sendJson(res, 200, { ok: true, saved: Object.keys(patch) });
            } catch (error) {
              sendJson(res, 500, errorBody(error));
            }
            return;
          }
          sendJson(res, 405, { error: 'method not allowed', code: 'BAD_METHOD' });
        }),
      }),
    );

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/throttle/release`,
        handler: guard(async function (_req, res) {
          try {
            const n = quotaGate.state.waiting;
            quotaGate.releaseAll();
            sendJson(res, 200, { ok: true, released: n });
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        }),
      }),
    );

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/egress`,
        handler: guard(async function (_req, res) {
          try {
            const observed = await guard.observeEgress(undefined);
            const allow = parseAllowlist(current().proxy?.egressAllow);
            sendJson(res, 200, {
              proxyUrl: normalizeProxyUrl(current().proxy?.url) ?? null,
              observed: observed ?? null,
              allow,
              allowed: observed === undefined || allow.length === 0 ? null : allow.includes(observed),
              error: observed === undefined ? 'the proxy did not report an egress address' : null,
            });
          } catch (error) {
            sendJson(res, 502, errorBody(error));
          }
        }),
      }),
    );

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/logout`,
        handler: guard(async function (_req, res) {
          try {
            await ctx.get('credentials')?.deleteRecord(recordKeyFor(ROUTE));
            sendJson(res, 200, { ok: true });
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        }),
      }),
    );

    // Store the claude-server client bearer. Kept as an `api-key` record so it
    // shares the credential plane's serialized write path and never lands in a
    // settings export, which is exactly what would happen to a config field.
    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/server/bearer`,
        handler: guard(async function (req, res) {
          try {
            const body = (await readJson(req)) ?? {};
            const bearer = typeof body?.bearer === 'string' ? body.bearer.trim() : '';
            const credentials = ctx.get('credentials');
            if (credentials === undefined) {
              sendJson(res, 500, {
                error: 'this composition mounts no credentials service, so the bearer cannot be stored',
                code: 'NO_CREDENTIAL_STORE',
              });
              return;
            }
            const key = recordKeyFor(serverSettings().bearerRecord);
            if (bearer.length === 0) {
              await credentials.deleteRecord(key);
              sendJson(res, 200, { ok: true, configured: false });
              return;
            }
            await credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: bearer }));
            sendJson(res, 200, { ok: true, configured: true });
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        }),
      }),
    );
  });

  // The sign-in conversation needs both a flow registry and somewhere to serve
  // its notices and questions.
  ctx.inject(['webServer', 'authorization'], (bothCtx) => {
    const webServer = bothCtx.get('webServer');
    const bridge = new LoginBridge(bothCtx.get('authorization'), recordKeyFor(ROUTE), ctx.logger);

    bothCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/login`,
        handler: guard(async function (req, res) {
          try {
            const controller = new AbortController();
            req.on('close', () => controller.abort());
            // The attempt outlives this request: the card polls /login/poll for
            // the notice or question it must render next.
            void bridge.start();
            sendJson(res, 202, await bridge.poll(controller.signal));
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        }),
      }),
    );

    bothCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/login/poll`,
        handler: guard(async function (req, res) {
          const controller = new AbortController();
          req.on('close', () => controller.abort());
          try {
            const state = await bridge.poll(controller.signal);
            // A finished sign-in means a credential now exists where none did
            // at boot: pull the dynamic model catalog immediately so the route
            // reflects the freshly signed-in subscription without waiting for
            // the daily tick.
            if (state?.outcome != null) void refreshModelCatalog();
            sendJson(res, 200, state);
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        }),
      }),
    );

    bothCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/login/answer`,
        handler: guard(async function (req, res) {
          try {
            const body = (await readJson(req)) ?? {};
            const accepted = bridge.answer(String(body.id ?? ''), String(body.value ?? ''));
            sendJson(res, accepted ? 200 : 409, { accepted });
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        }),
      }),
    );

    bothCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/login/cancel`,
        handler: guard(async function (_req, res) {
          bridge.cancel();
          sendJson(res, 200, { ok: true });
        }),
      }),
    );
  });

  ctx.logger?.info(
    'dsh-ccsub: route "%s" registered (proxy %s)',
    ROUTE,
    normalizeProxyUrl(current().proxy?.url) ?? 'NOT CONFIGURED — requests will be refused',
  );

  // Surface dependency drift at startup: a mismatch here is the cause behind
  // opaque stream failures after a host upgrade.
  const report = dependencyReport();
  if (report.compatible === false) {
    ctx.logger?.warn(
      'dsh-ccsub: dependency drift — pi-ai %s does not satisfy %s required by dsh-llm-pi-ai %s. Reinstall this plugin (dsh plugin add <this-plugin>) to re-resolve, or model requests will fail.',
      report.piAiVersion,
      report.piAiRequiredByAdapter,
      report.adapterVersion,
    );
  } else {
    ctx.logger?.info(
      'dsh-ccsub: pi-ai %s satisfies dsh-llm-pi-ai %s (requires %s)',
      report.piAiVersion,
      report.adapterVersion,
      report.piAiRequiredByAdapter,
    );
  }
}

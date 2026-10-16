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
} from './auth/claude.js';
import { PROVIDER_ID, recordKeyFor, describeGrant } from './auth/store.js';
import { createRequire } from 'node:module';

/**
 * Fail-loudly diagnose dependency drift.
 *
 * The module-copy architecture means this plugin runs its own pi-ai next to the
 * host's; when a dsh upgrade moves the host line forward and the plugin's
 * embedded copies stay behind, the failure surfaces as an opaque
 * `Cannot read properties of undefined` deep inside a stream. This check turns
 * that into an actionable message at startup and a visible flag on /status.
 * @returns the compatibility report for logging and /status.
 */
function dependencyReport() {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const path = require('node:path');
  /** Read a package manifest by walking the node_modules chain from this file. */
  const read = (id) => {
    const name = id.endsWith('/package.json') ? id.slice(0, -'/package.json'.length) : id;
    let here = path.dirname(new URL(import.meta.url).pathname);
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
  const own = read('@earendil-works/pi-ai/package.json');
  const adapter = read('@deepseek-ai/dsh-llm-pi-ai/package.json');
  const required = adapter?.dependencies?.['@earendil-works/pi-ai'];
  const satisfies =
    own?.version !== undefined && required !== undefined
      ? simpleSatisfies(own.version, required)
      : undefined;
  return {
    piAiVersion: own?.version ?? null,
    piAiRequiredByAdapter: required ?? null,
    adapterVersion: adapter?.version ?? null,
    compatible: satisfies,
  };
}

/** Minimal semver "range ^x.y.z or ||-union contains version" check. */
function simpleSatisfies(version, range) {
  const clauses = String(range).split('||').map((c) => c.trim());
  for (const clause of clauses) {
    const m = /^\^(\d+)\.(\d+)\.(\d+)/.exec(clause);
    if (m === null) continue;
    const [major, minor] = [Number(m[1]), Number(m[2])];
    const parts = String(version).split('-')[0].split('.').map(Number);
    if (parts[0] === major && parts[1] >= minor) return true;
  }
  return false;
}

/** The only route this plugin serves. */
const ROUTE = PROVIDER_ID;

/** Base path for this plugin's HTTP surface. */
const API_BASE = '/plugins/dsh-ccsub';

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
 * Reject cross-origin and rebound requests to this plugin's HTTP surface.
 *
 * The webserver's token admission lives in the client-connection layer, which
 * routes registered directly on `webServer.register` bypass — so this guard is
 * the plugin's own defence:
 *
 * - a browser sends `Origin` on every cross-site request: anything present
 *   must be our own loopback origin, or the request is refused;
 * - `Host` must be the loopback listener, which breaks DNS rebinding (an
 *   attacker's domain never resolves to a loopback `Host` header);
 * - non-browser clients (curl, the host itself) send no `Origin` and pass.
 */
function requestAuthorized(req) {
  const host = req.headers?.host;
  const loopbackHosts = new Set(['127.0.0.1:3080', 'localhost:3080', '[::1]:3080']);
  if (typeof host !== 'string' || !loopbackHosts.has(host.toLowerCase())) return false;
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  const loopbackOrigins = new Set([
    'http://127.0.0.1:3080',
    'http://localhost:3080',
    'http://[::1]:3080',
  ]);
  return loopbackOrigins.has(String(origin).toLowerCase());
}

/** Wrap one handler with the origin/host guard. */
function guarded(handler) {
  return (req, res) => {
    if (!requestAuthorized(req)) {
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
      try {
        const form = (svc.describe({ redactSecrets: true }) ?? []).find((d) => d?.ns === ns);
        return form?.value ?? null;
      } catch {
        return null;
      }
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
  /** Provider cache: rebuilt when the declared context window changes. */
  let providerRev = null;
  let providerCache;
  const providerNow = () => {
    const override = current().contextWindowOverride;
    if (providerCache === undefined || providerRev !== override) {
      providerRev = override;
      providerCache = subscriptionProvider(guard, { contextWindowOverride: override });
    }
    return providerCache;
  };

  // One provider instance serves both the route adapter and the Models
  // collection, so a dynamic catalog refresh is visible to the route without
  // re-registering the adapter.
  const models = modelsFor(ctx, guard, providerNow());

  /**
   * Refresh the dynamic model catalog overlay through the guarded transport.
   *
   * Best-effort like the CLI version resolution: a failure keeps the previous
   * overlay (and the static baseline) and is retried on the next tick.
   */
  const refreshModelCatalog = async () => {
    try {
      // Align the collection with the adapter's current provider instance
      // (settings changes rebuild it); the overlay must land where requests read.
      const provider = providerNow();
      models.setProvider(provider);
      const result = await models.refresh({ providers: [PROVIDER_ID] });
      void provider;
      const failure = result.errors.get(PROVIDER_ID);
      if (failure !== undefined) {
        ctx.logger?.warn('dsh-ccsub: model catalog refresh failed: %s', failure.message);
        return;
      }
      ctx.logger?.info(
        'dsh-ccsub: model catalog refreshed (%d models on the route)',
        providerNow().getModels().length,
      );
    } catch (error) {
      ctx.logger?.warn('dsh-ccsub: model catalog refresh failed: %s', error?.message ?? error);
    }
  };

  const adapter = createAdapter({
    guard,
    provider: providerNow,
    resolveApiKey: async () => await resolveAccessToken(ctx, current(), undefined),
    resolveAttachments: () => ctx.get('attachments'),
  });

  ctx.effect(() => ctx.llm.registerAdapter([ROUTE], adapter));

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

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/status`,
        handler: guarded(async function (_req, res) {
          try {
            const record = await ctx.get('credentials')?.readRecord(recordKeyFor(ROUTE));
            const proxyUrl = normalizeProxyUrl(current().proxy?.url);
            sendJson(res, 200, {
              route: ROUTE,
              compat: report,
              grant: describeGrant(record),
              proxy: {
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
        handler: guarded(async function (req, res) {
          const controller = new AbortController();
          req.on('close', () => controller.abort());
          try {
            sendJson(res, 200, await fetchUsage(ctx, guard, current(), controller.signal));
          } catch (error) {
            sendJson(res, 502, errorBody(error));
          }
        }),
      }),
    );

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/settings`,
        handler: guarded(async function (req, res) {
          if (req.method === 'GET') {
            try {
              const c = current();
              sendJson(res, 200, {
                claudeCliVersion: (() => {
                  const v = liveScalar(undefined, 'claudeCliVersion');
                  return v === undefined ? 'auto' : String(v);
                })(),
                contextWindowOverride: c.contextWindowOverride,
                refreshSkewMs: c.refreshSkewMs,
                quotaPollMs: c.quotaPollMs,
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
              const accepted = ['claudeCliVersion', 'contextWindowOverride', 'refreshSkewMs', 'quotaPollMs'];
              for (const key of accepted) {
                if (body[key] !== undefined) patch[key] = body[key];
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
        path: `${API_BASE}/egress`,
        handler: guarded(async function (_req, res) {
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
        handler: guarded(async function (_req, res) {
          try {
            await ctx.get('credentials')?.deleteRecord(recordKeyFor(ROUTE));
            sendJson(res, 200, { ok: true });
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
        handler: guarded(async function (req, res) {
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
        handler: guarded(async function (req, res) {
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
        handler: guarded(async function (req, res) {
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
        handler: guarded(async function (_req, res) {
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

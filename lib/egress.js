/**
 * Egress guard: the only transport this route is allowed to use.
 *
 * Three guarantees, in the order they matter:
 *
 * 1. **The proxy is mandatory.** Every request goes through one explicitly
 *    configured proxy. There is no "fall back to direct" path: a missing proxy
 *    fails the request instead of leaking the real IP.
 * 2. **The User-Agent is restored.** The header merge that runs above this
 *    transport re-asserts the harness attribution header over the subscription
 *    identity. This transport sits below that merge, so it rewrites the header
 *    immediately before the socket write, where nothing can clobber it.
 * 3. **The egress allowlist is opt-in but enforced once configured.** When an
 *    allowlist is set, the guard verifies the IP the outside world observes
 *    against it and refuses to send on a mismatch.
 *
 * @module dsh-ccsub/egress
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';
import os from 'node:os';

/** Per-attempt dial timeout for the proxy itself. */
const CONNECT_TIMEOUT_MS = 5000;
/** How long an observed egress answer is reused before re-probing. */
const EGRESS_CACHE_MS = 5 * 60 * 1000;
/** The endpoint answering "what IP do you see me as", overridable in config. */
export const DEFAULT_EGRESS_URL = 'https://api.ipify.org?format=json';
/** The SDK version the official client reports through x-stainless-package-version. */
const STAINLESS_SDK_VERSION = '0.70.0';

/**
 * Normalize one proxy URL, rejecting anything that is not a bare HTTP(S)
 * origin. Embedded credentials, paths, queries, and fragments are refused so
 * the value cannot smuggle a different request target.
 * @param raw - the configured proxy URL.
 * @returns the normalized origin, or undefined when unusable.
 */
export function normalizeProxyUrl(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username.length > 0 || url.password.length > 0) return undefined;
  if (url.pathname !== '/' && url.pathname !== '') return undefined;
  if (url.search.length > 0 || url.hash.length > 0) return undefined;
  return url.origin;
}

/** One refusal from the guard, carrying a stable code for the UI. */
export class EgressError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'EgressError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Parse the allowlist into trimmed non-empty entries.
 * @param value - the raw configured list.
 * @returns the entries to compare against, or an empty list.
 */
export function parseAllowlist(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The egress-guarded transport.
 *
 * The guard owns one `ProxyAgent` per configured proxy URL, so a settings
 * change swaps the dispatcher without leaving the old connection pool behind.
 */
export class EgressGuard {
  #config;
  #agent;
  #agentKey;
  #egress;
  #logger;
  /** The egress IP pinned on first observation, when no allowlist is set. */
  #pinned;

  /**
   * @param config - a function returning the *current* proxy settings, read per
   *   request so a settings change reaches the next call.
   * @param logger - the plugin logger for refusals worth surfacing.
   */
  constructor(config, logger) {
    this.#config = config;
    this.#logger = logger;
    this.#agent = undefined;
    this.#agentKey = undefined;
    this.#egress = undefined;
    this.#pinned = undefined;
  }

  /** Release the dispatcher and any cached egress observation. */
  dispose() {
    const agent = this.#agent;
    this.#agent = undefined;
    this.#agentKey = undefined;
    this.#egress = undefined;
    this.#pinned = undefined;
    if (agent !== undefined) void agent.close().catch(() => {});
  }

  /** The current settings snapshot. */
  get settings() {
    return this.#config();
  }

  /**
   * The dispatcher for the current settings, or a refusal.
   *
   * The proxy URL is the cache key: a different URL builds a different agent,
   * and the previous one is closed so two proxies are never both live.
   * @returns the agent to dispatch through.
   * @throws {EgressError} code `PROXY_NOT_CONFIGURED` when no proxy is set.
   */
  #dispatcher() {
    const { url } = this.settings;
    const normalized = normalizeProxyUrl(url);
    if (normalized === undefined) {
      throw new EgressError(
        'dsh-ccsub: this route only sends through an explicit proxy, and none is configured. Set proxy.url (for example http://127.0.0.1:9077, the Claude-specific proxy) before using it — refusing to send directly.',
        'PROXY_NOT_CONFIGURED',
      );
    }
    if (this.#agent === undefined || this.#agentKey !== normalized) {
      const previous = this.#agent;
      this.#agent = new ProxyAgent({ uri: normalized, connect: { timeout: CONNECT_TIMEOUT_MS } });
      this.#agentKey = normalized;
      this.#egress = undefined;
      // A different proxy is a different egress path, so the address pinned
      // from the previous one is no longer the address this route would use.
      // Keeping it would reject every request as "drifted mid-session" — a
      // message that points at the operator's own settings change as if it
      // were a hijack, and that only a restart could clear.
      this.#pinned = undefined;
      if (previous !== undefined) void previous.close().catch(() => {});
    }
    return this.#agent;
  }

  /**
   * Probe the egress IP as seen through the current proxy.
   *
   * The probe deliberately uses the guarded dispatcher, so it measures the
   * path requests actually take rather than the host's own connectivity. The
   * answer is cached briefly: this is a health check, not a per-token tax.
   * @param signal - caller cancellation.
   * @returns the observed egress IP, or undefined when unobservable.
   */
  async observeEgress(signal) {
    const cached = this.#egress;
    if (cached !== undefined && Date.now() - cached.at < EGRESS_CACHE_MS) return cached.ip;
    let dispatcher;
    try {
      dispatcher = this.#dispatcher();
    } catch {
      return undefined;
    }
    const url = this.settings.egressUrl ?? DEFAULT_EGRESS_URL;
    try {
      const response = await undiciFetch(url, {
        method: 'GET',
        dispatcher,
        signal,
        headers: { accept: 'application/json,text/plain' },
      });
      const text = await response.text();
      const ip = extractIp(text);
      this.#egress = { at: Date.now(), ip };
      return ip;
    } catch {
      return undefined;
    }
  }

  /**
   * Verify the current egress against the allowlist.
   *
   * The check is on by default. When an explicit allowlist is set it is
   * enforced as-is; when it is empty, the first observed egress IP is pinned
   * for the process lifetime and any later drift is refused — a proxy node
   * silently changing mid-session is exactly the IP-hop signal worth blocking.
   * @param signal - caller cancellation.
   * @throws {EgressError} code `EGRESS_NOT_ALLOWED` on a mismatch, or
   *   `EGRESS_UNVERIFIABLE` when the egress cannot be verified and the
   *   configuration demands verification.
   */
  async assertEgressAllowed(signal) {
    const allow = parseAllowlist(this.settings.egressAllow);
    // Default ON: only an explicit `false` disables the check.
    const require = this.settings.requireEgressCheck !== false;
    if (allow.length === 0 && !require) return undefined;
    const observed = await this.observeEgress(signal);
    if (observed === undefined) {
      if (require) {
        throw new EgressError(
          'dsh-ccsub: the egress check is required, but the proxy did not report an observable egress IP — refusing to send.',
          'EGRESS_UNVERIFIABLE',
        );
      }
      this.#logger?.warn('dsh-ccsub: could not observe the proxy egress IP; the allowlist was not verified');
      return undefined;
    }
    if (allow.length > 0) {
      if (!allow.includes(observed)) {
        throw new EgressError(
          `dsh-ccsub: the proxy egress IP ${observed} is not in the configured allowlist — refusing to send.`,
          'EGRESS_NOT_ALLOWED',
          { observed, allow },
        );
      }
      return observed;
    }
    if (this.#pinned === undefined) {
      this.#pinned = observed;
      this.#logger?.info('dsh-ccsub: egress pinned to %s for this session (no explicit allowlist)', observed);
      return observed;
    }
    if (this.#pinned !== observed) {
      throw new EgressError(
        `dsh-ccsub: the proxy egress IP drifted from ${this.#pinned} to ${observed} mid-session — refusing to send. If the new IP is intended, add it to proxy.egressAllow and restart.`,
        'EGRESS_NOT_ALLOWED',
        { observed, pinned: this.#pinned },
      );
    }
    return observed;
  }

  /**
   * One request through the guarded transport.
   *
   * Shaped as `typeof globalThis.fetch` so pi-ai can take it directly. The
   * allowlist is asserted before the body is sent, and the subscription
   * identity is written last so nothing upstream can overwrite it.
   * @param input - the request target.
   * @param init - the request options.
   * @returns the upstream response.
   */
  fetch = async (input, init) => {
    const dispatcher = this.#dispatcher();
    const signal = init?.signal ?? undefined;
    await this.assertEgressAllowed(signal ?? undefined);
    const headers = withClaudeIdentity(init?.headers, this.settings.claudeCliVersion);
    return await undiciFetch(input, { ...init, headers, dispatcher });
  };
}

/**
 * Re-assert the Claude Code subscription identity on the wire.
 *
 * Applied last, immediately before dispatch, because the harness attribution
 * merge above this transport is exactly what clobbers it. Beyond the identity
 * names, the header set is rebuilt to match what the official client emits:
 *
 * - headers are re-inserted in the official client's order (authorization,
 *   content-type, accept, anthropic-version, anthropic-beta first), because
 *   header ordering is a passive fingerprint;
 * - the `x-stainless-*` telemetry the official SDK always sends is appended
 *   with values derived from this process, so the pair "UA claims claude-cli,
 *   telemetry absent" never appears on the wire.
 *
 * Only names the guard owns are rewritten; everything else passes through.
 * @param headers - the headers pi-ai prepared.
 * @param cliVersion - the version to present, or a bundled default.
 * @returns headers with the subscription identity restored.
 */
export function withClaudeIdentity(headers, cliVersion) {
  const version = typeof cliVersion === 'string' && cliVersion.length > 0 ? cliVersion : '2.1.283';
  const source = new Headers();
  if (headers !== undefined) {
    const entries =
      headers instanceof Headers
        ? [...headers.entries()]
        : Array.isArray(headers)
          ? headers
          : Object.entries(headers);
    for (const [name, value] of entries) {
      if (value === undefined || value === null) continue;
      source.set(String(name), String(value));
    }
  }
  const out = new Headers();
  // The official client emits these first, in this order.
  for (const name of ['authorization', 'content-type', 'accept', 'anthropic-version', 'anthropic-beta']) {
    const value = source.get(name);
    if (value !== null) out.set(name, value);
  }
  out.set('user-agent', `claude-cli/${version} (external, cli)`);
  out.set('x-app', 'cli');
  // x-stainless-* telemetry, as the official TypeScript SDK sends it.
  out.set('x-stainless-lang', 'js');
  out.set('x-stainless-package-version', STAINLESS_SDK_VERSION);
  out.set('x-stainless-os', stainlessOs());
  out.set('x-stainless-arch', stainlessArch());
  out.set('x-stainless-runtime', 'node');
  out.set('x-stainless-runtime-version', process.version);
  out.set('x-stainless-retry-count', '0');
  // Anything the caller carried that we did not place yet keeps its relative order after ours.
  for (const [name, value] of source.entries()) {
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/** Map process.platform onto the SDK's spelling of x-stainless-os. */
function stainlessOs() {
  if (process.platform === 'darwin') return 'MacOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

/** Map os.arch() onto the SDK's spelling of x-stainless-arch. */
function stainlessArch() {
  const arch = os.arch();
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  return arch;
}

/**
 * Pull an IP address out of a plain-text or JSON egress response.
 * @param text - the raw response body.
 * @returns the IP, or undefined when the body carried none.
 */
function extractIp(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    for (const key of ['ip', 'origin', 'address', 'query']) {
      const value = parsed?.[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
  } catch {
    // Not JSON; fall through to a plain-text match.
  }
  const match = /([0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-fA-F:]{2,})/.exec(trimmed);
  return match?.[1];
}

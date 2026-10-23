/**
 * The outbound transport: how this server reaches Anthropic.
 *
 * Two modes, chosen by configuration rather than by fallback:
 *
 * - `proxy`  — every request goes through one explicit HTTP proxy. Used on the
 *              machine that has no direct route; a missing proxy is a refusal,
 *              never a silent direct connection.
 * - `direct` — a plain connection from the host's own address. Used on a server
 *              whose egress IP is itself the fixed address worth presenting.
 *
 * There is deliberately no "try proxy, fall back to direct" path: that would
 * make the observable egress IP depend on whether the proxy happened to be up.
 *
 * @module claude-server/transport
 */

import { ProxyAgent, request as undiciRequest } from 'undici';

/** Per-attempt dial timeout for the proxy itself. */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Reject anything that is not a bare HTTP(S) origin.
 *
 * Embedded credentials, paths, queries and fragments are refused so the value
 * cannot smuggle a different request target than the one configured.
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

/**
 * A refusal from the transport layer.
 */
export class TransportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

/**
 * The outbound transport, holding at most one live dispatcher.
 */
export class Transport {
  #mode;
  #proxyUrl;
  #agent;
  #agentKey;

  /**
   * @param options - mode and proxy URL.
   * @throws {TransportError} `PROXY_NOT_CONFIGURED` when proxy mode has no usable URL.
   */
  constructor(options) {
    this.#mode = options.mode === 'direct' ? 'direct' : 'proxy';
    this.#proxyUrl = options.proxyUrl;
    this.#agent = undefined;
    this.#agentKey = undefined;
    if (this.#mode === 'proxy' && this.#dispatcherUrl() === undefined) {
      throw new TransportError(
        'transport mode "proxy" requires a valid proxy URL (for example http://claude-gate:9077); refusing to start with a direct fallback',
        'PROXY_NOT_CONFIGURED',
      );
    }
  }

  /** The configured mode. */
  get mode() {
    return this.#mode;
  }

  /** The normalized proxy origin, or undefined in direct mode. */
  #dispatcherUrl() {
    if (this.#mode === 'direct') return undefined;
    return normalizeProxyUrl(this.#proxyUrl);
  }

  /** The dispatcher for the current configuration, or undefined for direct. */
  #dispatcher() {
    const normalized = this.#dispatcherUrl();
    if (normalized === undefined) return undefined;
    if (this.#agent === undefined || this.#agentKey !== normalized) {
      const previous = this.#agent;
      this.#agent = new ProxyAgent({ uri: normalized, connect: { timeout: CONNECT_TIMEOUT_MS } });
      this.#agentKey = normalized;
      if (previous !== undefined) void previous.close().catch(() => {});
    }
    return this.#agent;
  }

  /**
   * One request to `url`.
   *
   * `undici.request` is used rather than `fetch` because `fetch` transparently
   * decodes the response body and drops `content-encoding`, which would force
   * this server to strip that header on the way back and hand the client a
   * different header set than a direct connection produces. `request` returns
   * the raw byte stream, so the response can be relayed untouched.
   *
   * @param url - the absolute upstream URL.
   * @param init - method, headers, and body.
   * @returns the raw undici response.
   */
  async request(url, init) {
    const dispatcher = this.#dispatcher();
    return await undiciRequest(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      ...(dispatcher === undefined ? {} : { dispatcher }),
    });
  }

  /**
   * A `fetch`-shaped wrapper used for the OAuth calls, so those go through the
   * same egress path as model traffic instead of quietly bypassing the proxy.
   * @param url - the absolute URL.
   * @param init - fetch options.
   * @returns a `Response`.
   */
  fetch = async (url, init = {}) => {
    const result = await this.request(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    const chunks = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(result.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, String(value));
    }
    return new Response(Buffer.concat(chunks), { status: result.statusCode, headers });
  };

  /** Release the dispatcher. */
  async dispose() {
    const agent = this.#agent;
    this.#agent = undefined;
    this.#agentKey = undefined;
    if (agent !== undefined) await agent.close().catch(() => {});
  }
}

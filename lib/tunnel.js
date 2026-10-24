/**
 * The `claude-server` transport: how this plugin reaches a remote subscription
 * server instead of Anthropic directly.
 *
 * In this mode the plugin holds **no** Claude credential. It holds a bearer that
 * a `claude-server` deployment minted, and that server owns the grant, refreshes
 * it, and swaps in the real token. Two consequences follow, and both are load
 * bearing:
 *
 * 1. **No refresh here.** Anthropic rotates the refresh token on every refresh,
 *    so two refreshers would invalidate each other. The local side therefore
 *    never touches the grant; it presents its bearer and nothing else.
 * 2. **No proxy here.** The egress IP that matters is the server's, so routing
 *    through a local proxy would change nothing about what Anthropic observes
 *    while adding a failure mode. The mandatory-proxy rule belongs to the
 *    direct mode it was written for.
 *
 * The identity rewrite is still applied, per the agreed two-sided design: the
 * server repeats it, and neither side assumes the other ran first.
 *
 * @module dsh-ccsub/tunnel
 */

import { fetch as undiciFetch } from 'undici';
import { withClaudeIdentity } from './egress.js';

/** How long to wait for the subscription server before failing the request. */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * The prefix that puts pi-ai on its subscription request path.
 *
 * Kept as a local constant rather than imported from `index.js` so this module
 * stays a self-contained description of the remote transport. The two values
 * must agree; the test suite asserts round-tripping a prefixed value.
 */
const OAUTH_SHAPE_PREFIX = 'sk-ant-oat-';

/**
 * Remove the shape prefix from a bearer before it is used as a credential.
 *
 * The prefix exists only to make pi-ai emit the subscription request shape and
 * is never part of what the server minted, so it must not reach the wire. The
 * operation is idempotent for an unprefixed value.
 * @param token - the bearer, possibly carrying the shape prefix.
 * @returns the bearer the server actually accepts.
 */
export function stripOauthShapePrefix(token) {
  if (typeof token !== 'string') return token;
  return token.startsWith(OAUTH_SHAPE_PREFIX) ? token.slice(OAUTH_SHAPE_PREFIX.length) : token;
}

/**
 * Normalize the configured server URL.
 *
 * Only a bare http(s) origin is accepted, with an optional port: a value
 * carrying a path, query, or credentials is refused rather than silently
 * reinterpreted, mirroring the proxy-URL rule.
 * @param raw - the configured URL.
 * @returns the normalized origin, or undefined when unusable.
 */
export function normalizeServerUrl(raw) {
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

/** One refusal from the tunnel. */
export class TunnelError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TunnelError';
    this.code = code;
  }
}

/**
 * The transport used when the route is served by a `claude-server`.
 *
 * Shaped as `typeof globalThis.fetch` so pi-ai accepts it directly, and
 * deliberately *not* routing through `EgressGuard`: there is no proxy to
 * enforce and no local egress to vouch for in this mode.
 */
export class Tunnel {
  #config;
  #logger;
  #bearer;

  /**
   * @param config - returns the current settings, read per request so a
   *   settings change reaches the next call without a re-registration.
   * @param bearer - returns the current client bearer, or throws when unset.
   * @param logger - the plugin logger.
   */
  constructor(config, bearer, logger) {
    this.#config = config;
    this.#bearer = bearer;
    this.#logger = logger;
  }

  /** The current settings snapshot. */
  get settings() {
    return this.#config();
  }

  /**
   * The origin every request is sent to.
   * @returns the normalized origin.
   * @throws {TunnelError} `SERVER_NOT_CONFIGURED` when unset or malformed.
   */
  origin() {
    const normalized = normalizeServerUrl(this.settings.url);
    if (normalized === undefined) {
      throw new TunnelError(
        'dsh-ccsub: this route is in claude-server mode, but no server URL is configured. Set claudeServer.url (for example http://127.0.0.1:4710) before using it.',
        'SERVER_NOT_CONFIGURED',
      );
    }
    return normalized;
  }

  /**
   * Rewrite an Anthropic-hosted URL onto the subscription server.
   *
   * pi-ai targets `https://api.anthropic.com/v1/messages`; in this mode the
   * path is preserved and only the origin changes. The OAuth host is mapped to
   * the server's `/platform` prefix, which is the route it exposes for token
   * traffic — the local side has no token traffic of its own, but a library
   * that still attempts one must not escape to the real host.
   * @param input - the request target pi-ai produced.
   * @returns the rewritten URL.
   */
  rewrite(input) {
    const origin = this.origin();
    const source = typeof input === 'string' ? input : (input?.url ?? String(input));
    let parsed;
    try {
      parsed = new URL(source);
    } catch {
      return `${origin}${source.startsWith('/') ? '' : '/'}${source}`;
    }
    const path =
      parsed.hostname === 'platform.claude.com'
        ? `/platform${parsed.pathname}`
        : parsed.pathname;
    return `${origin}${path}${parsed.search}`;
  }

  /**
   * One request through the subscription server.
   *
   * The bearer is attached here rather than by the caller because it is this
   * mode's only credential, and the Claude Code identity is re-asserted last so
   * nothing above can clobber it.
   * @param input - the request target.
   * @param init - the request options.
   * @returns the upstream response.
   */
  fetch = async (input, init) => {
    const target = this.rewrite(input);
    const token = await this.#bearer();
    const source = new Headers(withClaudeIdentity(init?.headers, this.settings.claudeCliVersion));
    // The route presents the bearer to pi-ai with the `sk-ant-oat-` prefix so
    // pi-ai selects the subscription request shape; that prefix is ours, not
    // part of the secret this server minted, so it comes off here. If a future
    // caller hands over an unprefixed bearer this is a no-op.
    source.set('authorization', `Bearer ${stripOauthShapePrefix(token)}`);
    // Name the account when the operator pinned one. Absent means "let the
    // server route", which is the right default: routing keeps a conversation on
    // one subscription so its prompt cache survives. The server treats this as a
    // request rather than an instruction — it refuses a name this bearer may not
    // spend and answers 404 for one it does not know, so a stale setting fails
    // loudly instead of silently spending the wrong subscription.
    const pinnedAccount = typeof this.settings?.account === 'string' ? this.settings.account.trim() : '';
    if (pinnedAccount.length > 0) source.set('x-ccsub-account', pinnedAccount);
    else source.delete('x-ccsub-account');
    // The tunnel is plain HTTP to the server; compression stays off so the
    // server's response headers describe exactly the bytes it relays.
    source.delete('accept-encoding');
    return await undiciFetch(target, {
      ...init,
      headers: source,
      signal: init?.signal ?? AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  };
}

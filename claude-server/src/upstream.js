/**
 * Upstream routing.
 *
 * The local plugin points its provider at this server, so every path arrives
 * relative to it. Two Anthropic hosts are needed:
 *
 *   /platform/…   → platform.claude.com   (the OAuth token endpoint)
 *   anything else → api.anthropic.com     (messages, models, usage)
 *
 * Keeping the `platform` prefix as an explicit escape hatch rather than
 * matching on path shape means a new OAuth path keeps working without a change
 * here — the same reasoning that makes the local guard route by host.
 *
 * @module claude-server/upstream
 */

/** Anthropic API host: messages, model listing, usage. */
export const API_HOST = 'https://api.anthropic.com';
/** Anthropic platform host: OAuth token exchange and refresh. */
export const PLATFORM_HOST = 'https://platform.claude.com';
/** Prefix that selects the platform host. */
export const PLATFORM_PREFIX = '/platform';

/**
 * Resolve the upstream URL for one incoming request path.
 *
 * `/v1/messages` gains `?beta=true` when absent, because the official client
 * posts through the beta namespace (`client.beta.messages.create`). Without it
 * the request is served from a different bucket and can be rate-limited
 * independently of the subscription's real allowance.
 *
 * The two hosts are parameters rather than module constants so a deployment can
 * point this server at a different Anthropic-compatible endpoint, and so the
 * relay path can be exercised against a local stub without a network. The
 * defaults are the real hosts, so the ordinary call site passes nothing.
 *
 * @param pathname - the request path as received.
 * @param search - the request query string, including the leading `?`.
 * @param hosts - host overrides.
 * @returns the absolute upstream URL.
 */
export function upstreamFor(pathname, search = '', hosts = {}) {
  const apiHost = hosts.apiHost ?? API_HOST;
  const platformHost = hosts.platformHost ?? PLATFORM_HOST;
  const path = typeof pathname === 'string' && pathname.length > 0 ? pathname : '/';
  let target;
  if (path === PLATFORM_PREFIX || path.startsWith(`${PLATFORM_PREFIX}/`)) {
    const rest = path.slice(PLATFORM_PREFIX.length) || '/';
    target = new URL(platformHost.replace(/\/+$/, '') + rest);
  } else {
    target = new URL(apiHost.replace(/\/+$/, '') + path);
  }
  target.search = search ?? '';
  if (target.pathname === '/v1/messages' && !target.searchParams.has('beta')) {
    target.searchParams.set('beta', 'true');
  }
  return target;
}

/**
 * Whether a path carries a JSON body this server may need to read.
 * @param pathname - the request path.
 * @returns true for the messages endpoint.
 */
export function hasJsonBody(pathname) {
  return pathname === '/v1/messages';
}

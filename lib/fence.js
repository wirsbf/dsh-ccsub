/**
 * The Host/Origin fence for this plugin's HTTP surface.
 *
 * Routes registered with `webServer.register` bypass the client-connection
 * layer's token admission, so this guard is the plugin's own defence. Every
 * piece here is a pure function of the request headers and the live listener
 * facts, which is what makes it testable without a running host.
 *
 * @module dsh-ccsub/fence
 */

/**
 * The listener facts the fence compares against.
 * @typedef {object} FencePolicy
 * @property {string} [bindHost] - the listener's bind address.
 * @property {number} [port] - the port it actually bound.
 * @property {string} [protocol] - `http:` or `https:`.
 */

/**
 * Parse a `Host`-header authority into its hostname and port.
 *
 * Node's URL parser rejects a bare `host:port` (it expects a scheme), so this
 * reads the shape by hand: `[::1]:3080`, `127.0.0.1:3080`, `example.com`.
 * @param authority - the verbatim `Host` header.
 * @returns the parsed parts, or undefined when it is not an authority.
 */
export function parseAuthority(authority) {
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
export function isLoopbackHostname(hostname) {
  const name = hostname.toLowerCase();
  if (name === 'localhost' || name === '::1') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(name)) return true;
  // IPv4-mapped IPv6 loopback, e.g. ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(name);
  return mapped !== null && mapped[1].startsWith('127.');
}

/** The port implicit in a scheme, so `Host: example.com` matches `Origin: https://example.com`. */
export function defaultPortFor(protocol) {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * Reject cross-origin and rebound requests to this plugin's HTTP surface.
 *
 * It mirrors the fence DSH applies to its own `/api` transport, which is not
 * exported:
 *
 * - `Host` must be loopback or the listener's own bind address — which is what
 *   defeats DNS rebinding, since an attacker's domain never produces a
 *   loopback `Host`;
 * - a browser's `Origin`, when present, must be the same authority as `Host`;
 * - `Sec-Fetch-Site: cross-site` is refused outright;
 * - non-browser clients (curl, the host itself) send no `Origin` and pass.
 * @param req - the incoming request.
 * @param policy - the live listener's bind facts.
 * @returns whether the request may reach the handler.
 */
export function requestAuthorized(req, policy) {
  const authority = parseAuthority(req.headers?.host ?? '');
  if (authority === undefined) return false;

  const loopback = isLoopbackHostname(authority.hostname);
  const bindAddress =
    policy.bindHost !== undefined && authority.hostname === String(policy.bindHost).toLowerCase();
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
  const stripBrackets = (name) => (name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name);
  const originHost = stripBrackets(originUrl.hostname.toLowerCase());
  const hostHost = stripBrackets(authority.hostname.toLowerCase());
  if (originHost !== hostHost) return false;

  // `loopback || bindAddress` already holds — the guard above returns false
  // when both are false — so re-testing it here would suggest a second
  // decision that does not exist.
  return true;
}

/**
 * Answer one request with JSON.
 * @param res - the response to write.
 * @param status - the HTTP status.
 * @param body - the value to serialize.
 */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
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
export function guarded(handler, policy) {
  return (req, res) => {
    if (!requestAuthorized(req, policy())) {
      sendJson(res, 403, { error: 'request refused: unrecognised origin or host', code: 'FORBIDDEN' });
      return;
    }
    return handler(req, res);
  };
}

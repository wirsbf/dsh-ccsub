/**
 * The HTTP surface.
 *
 * Two kinds of route:
 *
 * - `/login/*` — authorization-code sign-in. These are the only routes that do
 *   not require the client bearer… except they do: minting or completing a
 *   grant over an unauthenticated channel would let anyone on the network bind
 *   their own Claude account (or reset the operator's). They require it too.
 * - everything else — a transparent relay to Anthropic, with the client bearer
 *   swapped for the real access token and the Claude Code identity re-asserted.
 *
 * `/healthz` is the single unauthenticated route. It reports liveness and
 * whether a grant exists, and nothing that could help an attacker (no paths, no
 * token material, no upstream identity).
 *
 * @module claude-server/server
 */

import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { ADMIN_COOKIE, ADMIN_PREFIX, AdminSessions, cookieOf, renderAdminPage } from './admin.js';
import { ClientAuth } from './auth.js';
import { THINKING_BETAS, ensureBaseBetas, wantsThinkingBetas, withClaudeIdentity } from './identity.js';
import { LoginSessions } from './login.js';
import { exchangeCode, parseAuthorizationInput, refreshGrant } from './oauth.js';
import { sanitizeBody } from './sanitize.js';
import { hasJsonBody, upstreamFor } from './upstream.js';
import { UsageLedger, UsageObserver } from './usage.js';

/** Responses must never be cached by an intermediary. */
const NO_STORE = 'no-store';

/**
 * Send a JSON reply.
 * @param res - the response.
 * @param status - the status code.
 * @param payload - the body to serialise.
 */
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': NO_STORE,
  });
  res.end(text);
}

/**
 * Read the whole request body.
 *
 * Bounded because this server is reachable beyond loopback: an unbounded buffer
 * would be a trivial memory exhaustion, and the image is expected to run on a
 * small host.
 * @param req - the request.
 * @param limit - the maximum number of bytes accepted.
 * @returns the body bytes.
 */
async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error(`the request body exceeded ${limit} bytes`);
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Build the server.
 * @param options - config, transport, grant store, and logger.
 * @returns the http.Server plus a dispose hook.
 */
export function createServer(options) {
  const { config, transport, grants, logger, hosts } = options;
  const auth = new ClientAuth(config.clientBearer);
  const sessions = new LoginSessions({ ttlMs: config.loginTtlMs });
  const adminSessions = new AdminSessions();
  // Console reads of the usage endpoint share this cache. Anthropic rate-limits
  // usage far more tightly than messages and its 429s persist, so an operator
  // clicking Refresh repeatedly must not translate into repeated upstream calls.
  // Token accounting for relayed model traffic. Process memory only: see
  // src/usage.js for why it is not persisted.
  const usageLedger = new UsageLedger();
  const quotaCache = { at: 0, usage: undefined, error: undefined };
  const QUOTA_CACHE_MS = 5 * 60_000;
  const maxBodyBytes = config.maxBodyBytes ?? 32 * 1024 * 1024;

  /** Resolve the access token through the grant store. */
  const accessToken = async () =>
    await grants.accessToken(async (refreshToken) => await refreshGrant(refreshToken, transport.fetch));

  /** Send an HTML reply. Always uncacheable: it reflects live credential state. */
  const sendHtml = (res, status, html) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': NO_STORE,
      // The console is same-origin only; no framing, no external loads.
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
  };

  /** Read the current grant state without letting a corrupt file throw. */
  const grantState = async () => {
    try {
      const grant = await grants.read();
      return {
        signedIn: grant !== undefined,
        expiresAt: typeof grant?.expires === 'number' ? grant.expires : null,
      };
    } catch {
      return { signedIn: false, expiresAt: null };
    }
  };

  /**
   * The operator console, mounted under `/admin`.
   *
   * The page itself is served to anyone who can reach the port, but it shows
   * nothing but a login form until a valid client bearer has been exchanged for
   * a session cookie. Every mutating call checks that cookie again, so serving
   * the shell to an unauthenticated caller grants nothing.
   */
  const admin = async (req, res, ctx) => {
    const { pathname } = ctx;
    const sessionId = cookieOf(req.headers.cookie, ADMIN_COOKIE);
    const authed = adminSessions.valid(sessionId);

    // --- the page ---------------------------------------------------------
    if (pathname === ADMIN_PREFIX && req.method === 'GET') {
      const state = await grantState();
      sendHtml(
        res,
        200,
        renderAdminPage({ ...state, mode: transport.mode, authed }),
      );
      return;
    }

    // --- unlock: bearer in, session cookie out ---------------------------
    if (pathname === `${ADMIN_PREFIX}/session` && req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8') || '{}');
      } catch {
        sendJson(res, 400, { error: 'the request body must be JSON', code: 'BAD_BODY' });
        return;
      }
      const presented = typeof payload?.bearer === 'string' ? payload.bearer.trim() : '';
      if (!auth.check(`Bearer ${presented}`)) {
        // Deliberately vague and rate-limit-free at this size: the bearer is a
        // long random string, so guessing is not the threat model.
        logger.warn('console unlock refused: bad client bearer');
        sendJson(res, 401, { error: 'that bearer was not accepted' });
        return;
      }
      const id = adminSessions.create();
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': NO_STORE,
        'set-cookie': `${ADMIN_COOKIE}=${id}; Path=${ADMIN_PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${30 * 60}`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === `${ADMIN_PREFIX}/logout` && req.method === 'POST') {
      adminSessions.destroy(sessionId);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': NO_STORE,
        'set-cookie': `${ADMIN_COOKIE}=; Path=${ADMIN_PREFIX}; HttpOnly; SameSite=Strict; Max-Age=0`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Everything below mutates or reveals credential state.
    if (!authed) {
      sendJson(res, 401, { error: 'the console session is missing or expired; unlock again' });
      return;
    }

    /**
     * Read one Anthropic endpoint through the transport the relay uses.
     *
     * The console must not reach upstream by a second path: a probe that
     * bypassed the proxy would report numbers for an egress the relay never
     * uses, and would expose the real address. So the request is built the same
     * way `relay()` builds one, minus the body.
     * @param path - the upstream path.
     * @returns the parsed JSON body.
     */
    const probeUpstream = async (path) => {
      const target = upstreamFor(path, '');
      const token = await accessToken();
      const headers = withClaudeIdentity(
        { accept: 'application/json', 'anthropic-version': '2023-06-01' },
        config.claudeCliVersion,
        config.stainlessRuntimeVersion,
      );
      headers.set('authorization', `Bearer ${token}`);
      ensureBaseBetas(headers);
      headers.delete('host');
      const response = await transport.request(target, {
        method: 'GET',
        headers: Object.fromEntries(headers.entries()),
      });
      const chunks = [];
      for await (const chunk of response.body) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      // Log the outcome: a console probe that trips the usage limit is otherwise
      // invisible, and the only way to learn about it is to watch the panel fail.
      logger.info(
        'console probe GET %s -> %d%s',
        path,
        response.statusCode,
        typeof response.headers['request-id'] === 'string' ? ` request-id=${response.headers['request-id']}` : '',
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(`the upstream answered ${response.statusCode}`);
        error.upstreamBody = text.slice(0, 300);
        throw error;
      }
      return JSON.parse(text);
    };

    // The subscription's rate-limit windows, as Anthropic reports them.
    if (pathname === `${ADMIN_PREFIX}/quota` && req.method === 'GET') {
      const fresh = Date.now() - quotaCache.at < QUOTA_CACHE_MS;
      if (fresh && quotaCache.usage !== undefined) {
        sendJson(res, 200, { ok: true, usage: quotaCache.usage, cached: true, at: quotaCache.at });
        return;
      }
      if (fresh && quotaCache.error !== undefined) {
        // Serve the recent failure rather than re-tripping the limit.
        sendJson(res, 502, { ...quotaCache.error, cached: true, at: quotaCache.at });
        return;
      }
      try {
        const usage = await probeUpstream('/api/oauth/usage');
        quotaCache.at = Date.now();
        quotaCache.usage = usage;
        quotaCache.error = undefined;
        sendJson(res, 200, { ok: true, usage, cached: false, at: quotaCache.at });
      } catch (error) {
        const payload = { error: String(error?.message ?? error), detail: error?.upstreamBody };
        quotaCache.at = Date.now();
        quotaCache.error = payload;
        quotaCache.usage = undefined;
        sendJson(res, 502, payload);
      }
      return;
    }

    // The model catalog this account can actually call.
    if (pathname === `${ADMIN_PREFIX}/models` && req.method === 'GET') {
      try {
        const payload = await probeUpstream('/v1/models?limit=1000');
        const entries = Array.isArray(payload?.data) ? payload.data : [];
        sendJson(res, 200, {
          ok: true,
          models: entries
            .filter((entry) => typeof entry?.id === 'string')
            .map((entry) => ({
              id: entry.id,
              displayName:
                typeof entry.display_name === 'string' && entry.display_name.length > 0
                  ? entry.display_name
                  : entry.id,
            })),
        });
      } catch (error) {
        sendJson(res, 502, { error: String(error?.message ?? error), detail: error?.upstreamBody });
      }
      return;
    }

    // Token accounting for relayed model traffic. Read-only and cheap: the
    // ledger is process memory, so this never touches the network and cannot
    // trip a rate limit.
    if (pathname === `${ADMIN_PREFIX}/usage` && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...usageLedger.snapshot() });
      return;
    }

    if (pathname === `${ADMIN_PREFIX}/login/start` && req.method === 'POST') {
      try {
        const attempt = sessions.create();
        sendJson(res, 200, { id: attempt.id, url: attempt.url, expiresAt: attempt.expiresAt });
      } catch (error) {
        sendJson(res, 429, { error: error.message, code: error.code });
      }
      return;
    }

    if (pathname === `${ADMIN_PREFIX}/login/complete` && req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      } catch {
        sendJson(res, 400, { error: 'the request body must be JSON', code: 'BAD_BODY' });
        return;
      }
      let attempt;
      try {
        attempt = sessions.peek(payload?.id);
      } catch (error) {
        sendJson(res, 404, { error: error.message, code: error.code });
        return;
      }
      let parsed;
      try {
        parsed = parseAuthorizationInput(payload?.code);
      } catch (error) {
        sendJson(res, 400, { error: error.message, code: 'BAD_CODE' });
        return;
      }
      if (parsed.state !== undefined && parsed.state !== attempt.verifier) {
        sendJson(res, 400, {
          error: 'the pasted code belongs to a different sign-in attempt',
          code: 'STATE_MISMATCH',
        });
        return;
      }
      try {
        const grant = await exchangeCode(parsed.code, attempt.verifier, transport.fetch);
        await grants.write(grant);
        sessions.consume(payload.id);
        logger.info('stored a new Claude subscription grant (console)');
        sendJson(res, 200, { ok: true, expiresAt: grant.expires });
      } catch (error) {
        logger.warn('the console authorization-code exchange failed: %s', String(error));
        sendJson(res, 502, { error: String(error?.message ?? error), code: 'EXCHANGE_FAILED' });
      }
      return;
    }

    if (pathname === `${ADMIN_PREFIX}/login/cancel` && req.method === 'POST') {
      try {
        const payload = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8') || '{}');
        sessions.consume(payload?.id);
      } catch {
        // Cancelling an unknown attempt is not an error worth reporting.
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: 'unknown console route' });
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;

      // Liveness is the only unauthenticated route.
      if (pathname === '/healthz') {
        let signedIn = false;
        try {
          signedIn = (await grants.read()) !== undefined;
        } catch {
          signedIn = false;
        }
        sendJson(res, 200, { ok: true, signedIn, mode: transport.mode });
        return;
      }

      // The operator console. It authenticates through its own cookie rather
      // than the client bearer, because a browser cannot send an Authorization
      // header on a top-level navigation. It is handled before the bearer gate
      // for exactly that reason, and every state-changing call beneath it
      // re-checks the session.
      if (pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`)) {
        await admin(req, res, { pathname, url });
        return;
      }

      if (!auth.check(req.headers.authorization)) {
        // Refuse before touching the upstream or the grant.
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (pathname === '/login/start' && req.method === 'POST') {
        const attempt = sessions.create();
        sendJson(res, 200, { id: attempt.id, url: attempt.url, expiresAt: attempt.expiresAt });
        return;
      }

      if (pathname === '/login/complete' && req.method === 'POST') {
        let payload;
        try {
          const raw = await readBody(req, 64 * 1024);
          payload = JSON.parse(raw.toString('utf8') || '{}');
        } catch (error) {
          sendJson(res, 400, { error: `the request body must be JSON: ${String(error)}` });
          return;
        }
        let attempt;
        try {
          attempt = sessions.peek(payload?.id);
        } catch (error) {
          sendJson(res, 404, { error: error.message, code: error.code });
          return;
        }
        let parsed;
        try {
          parsed = parseAuthorizationInput(payload?.code);
        } catch (error) {
          sendJson(res, 400, { error: error.message, code: 'BAD_CODE' });
          return;
        }
        if (parsed.state !== undefined && parsed.state !== attempt.verifier) {
          sendJson(res, 400, {
            error: 'the pasted code belongs to a different sign-in attempt',
            code: 'STATE_MISMATCH',
          });
          return;
        }
        try {
          const grant = await exchangeCode(parsed.code, attempt.verifier, transport.fetch);
          await grants.write(grant);
          sessions.consume(payload.id);
          logger.info('stored a new Claude subscription grant');
          sendJson(res, 200, { ok: true, expiresAt: grant.expires });
        } catch (error) {
          logger.warn('the authorization-code exchange failed: %s', String(error));
          sendJson(res, 502, { error: String(error?.message ?? error), code: 'EXCHANGE_FAILED' });
        }
        return;
      }

      if (pathname === '/login/cancel' && req.method === 'POST') {
        try {
          const raw = await readBody(req, 8 * 1024);
          const payload = JSON.parse(raw.toString('utf8') || '{}');
          sessions.consume(payload?.id);
        } catch {
          // Cancelling an unknown attempt is not an error worth reporting.
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/status' && req.method === 'GET') {
        let grant;
        let error;
        try {
          grant = await grants.read();
        } catch (caught) {
          error = String(caught?.message ?? caught);
        }
        sendJson(res, 200, {
          mode: transport.mode,
          signedIn: grant !== undefined && error === undefined,
          expiresAt: typeof grant?.expires === 'number' ? grant.expires : null,
          ...(error === undefined ? {} : { error }),
        });
        return;
      }

      // Everything else is a relay.
      await relay(req, res, { config, transport, logger, accessToken, hosts, usageLedger });
    })().catch((error) => {
      logger.error('unhandled request failure: %s', String(error));
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });

  return {
    server,
    // Exposed so a caller can read the accounting in-process: the console route
    // covers the HTTP path, and tests need the same numbers without a session.
    usage: usageLedger,
    async dispose() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Relay one request to Anthropic.
 *
 * The body is optionally sanitised, the client bearer is replaced with the real
 * access token, and the Claude Code identity is rebuilt. The response is copied
 * back byte for byte with its framing headers intact.
 */
async function relay(req, res, ctx) {
  const { config, transport, logger, accessToken, usageLedger } = ctx;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const target = upstreamFor(url.pathname, url.search, ctx.hosts ?? {});

  let body;
  try {
    const raw = await readBody(req, config.maxBodyBytes ?? 32 * 1024 * 1024);
    body = raw.length === 0 ? undefined : raw;
  } catch (error) {
    sendJson(res, 413, { error: String(error?.message ?? error) });
    return;
  }

  // Parse once: the beta set depends on whether the body asks for thinking,
  // and the sanitiser already needs the text form.
  let parsedBody;
  if (body !== undefined && hasJsonBody(url.pathname)) {
    try {
      parsedBody = JSON.parse(body.toString('utf8'));
    } catch {
      // A non-JSON body cannot ask for thinking; leave it undecided.
      parsedBody = undefined;
    }
  }

  if (config.sanitizeBody && body !== undefined && hasJsonBody(url.pathname)) {
    const outcome = sanitizeBody(body.toString('utf8'));
    if (outcome.changed) {
      logger.info('sanitised %d identity string(s) in the request body', outcome.hits);
      body = Buffer.from(outcome.body, 'utf8');
    }
  }

  let token;
  try {
    token = await accessToken();
  } catch (error) {
    const code = error?.code ?? 'TOKEN_UNAVAILABLE';
    const status = code === 'NOT_SIGNED_IN' ? 401 : 502;
    sendJson(res, status, { error: String(error?.message ?? error), code });
    return;
  }

  // Rebuild the identity from the incoming headers, then swap in the real token.
  // The rebuild is idempotent, so a client that already did it is unharmed.
  const headers = withClaudeIdentity(req.headers, config.claudeCliVersion, config.stainlessRuntimeVersion);
  headers.set('authorization', `Bearer ${token}`);
  ensureBaseBetas(headers, wantsThinkingBetas(parsedBody) ? THINKING_BETAS : '');
  // Hop-by-hop and body-framing headers describe the incoming connection, not
  // the outbound one; undici computes its own. `accept-encoding` is
  // deliberately **not** stripped: it is an end-to-end header, and dropping it
  // would make the upstream answer in plaintext, so the relay would hand back a
  // response lacking the `content-encoding` that a direct connection produced.
  for (const name of ['host', 'connection', 'content-length', 'transfer-encoding']) {
    headers.delete(name);
  }
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');

  let upstream;
  try {
    upstream = await transport.request(target, {
      method: req.method,
      headers: Object.fromEntries(headers.entries()),
      body,
      signal: undefined,
    });
  } catch (error) {
    logger.warn('%s %s failed: %s', req.method, target.pathname, String(error));
    sendJson(res, 502, { error: `the upstream request failed: ${String(error?.message ?? error)}` });
    return;
  }

  // Report the outcome of every relayed request. Without this line a non-2xx
  // from Anthropic — a rate limit in particular — is invisible in the log, and
  // the only way to learn what happened is to replay the request by hand.
  // The request-id is Anthropic's own handle for the call, which is what their
  // support and their rate-limit dashboards key on.
  {
    const requestId = upstream.headers?.['request-id'] ?? upstream.headers?.['x-request-id'];
    const retry = upstream.headers?.['x-should-retry'];
    // Keep 2xx out of the default log: a busy session would drown it. Anything
    // the caller will see as a failure is worth a line at info level or above.
    const level = upstream.statusCode >= 500 ? 'error' : upstream.statusCode >= 400 ? 'warn' : 'debug';
    logger[level](
      '%s %s -> %d%s%s',
      req.method,
      target.pathname,
      upstream.statusCode,
      requestId === undefined ? '' : ` request-id=${requestId}`,
      retry === undefined ? '' : ` should-retry=${retry}`,
    );
  }

  // Headers are copied from the upstream response, with one deliberate
  // exception: the body is decompressed on the way through, so the headers that
  // describe the *compressed* framing must not survive. Forwarding
  // `content-encoding: gzip` while writing plaintext would corrupt the client's
  // read, and `content-length` would describe the wrong byte count.
  //
  // Why decompress at all: gzip is a block codec, so a browser handed a
  // compressed SSE stream can only surface events once a block completes. The
  // observable effect is output arriving in visible bursts instead of token by
  // token. Decoding here restores per-event delivery. The cost is that
  // `content-encoding` / `content-length` no longer match a direct connection;
  // they carry no semantic weight for the client, which receives identical
  // content either way.
  const encoding = String(upstream.headers['content-encoding'] ?? '').toLowerCase();
  const outHeaders = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (name === 'transfer-encoding') continue;
    if (name === 'content-encoding') continue;
    if (name === 'content-length') continue;
    if (value === undefined) continue;
    outHeaders[name] = Array.isArray(value) ? value : String(value);
  }
  res.writeHead(upstream.statusCode, outHeaders);

  // `deflate`/`br` are not produced by Anthropic but a proxy in the path can
  // rewrite the encoding, so handle what Node can decode and pass anything else
  // through untouched rather than corrupting it.
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : undefined;

  // Token accounting runs alongside the forwarding, never in front of it: the
  // observer reads the same bytes the client receives and every one of its own
  // failures is swallowed. `startedAt` measures the call for the recent-calls
  // view, not for accounting correctness.
  const observer = hasJsonBody(url.pathname) ? new UsageObserver() : undefined;
  const startedAt = Date.now();

  try {
    if (decoder === undefined) {
      for await (const chunk of upstream.body) {
        observer?.observe(chunk);
        res.write(chunk);
      }
    } else {
      // Pipe rather than buffer: the whole point is to keep each decoded
      // fragment available to the client as soon as it arrives. `flush` keeps a
      // small zlib output buffer from withholding the tail of an SSE event.
      const source = Readable.from(upstream.body);
      await pipeline(source, decoder, new Writable({
        write(chunk, _encoding, callback) {
          observer?.observe(chunk);
          res.write(chunk, callback);
        },
      }));
    }
    res.end();
  } catch (error) {
    logger.warn('the upstream response stream broke: %s', String(error));
    res.destroy();
  } finally {
    // Record even a broken stream: whatever usage Anthropic reported before the
    // break was still consumed from the subscription.
    const accounting = observer?.finish();
    if (accounting !== undefined) {
      usageLedger.record({ ...accounting, durationMs: Date.now() - startedAt });
    }
  }
}

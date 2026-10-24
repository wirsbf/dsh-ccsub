/**
 * The HTTP surface.
 *
 * Four kinds of route:
 *
 * - `/healthz` — liveness. The single unauthenticated route; it reports whether
 *   a grant exists and the transport mode, and nothing that could help an
 *   attacker (no paths, no token material, no upstream identity).
 * - `/admin/*` — the operator console. It authenticates through its own session
 *   cookie rather than the bearer, because a browser cannot send an
 *   `Authorization` header on a top-level navigation. Pages are HTML; everything
 *   under `/admin/api/` is JSON and answers 401 JSON when the session is absent
 *   or expired, never an HTML page.
 * - `/login/*` and `/status` — the scripted, non-browser view of the same state.
 *   These require an **admin** credential: `/login/*` can mint or replace the
 *   Claude grant, so admitting a `client` token here would make every relay user
 *   an administrator by another name.
 * - everything else — a transparent relay to Anthropic, with the client bearer
 *   swapped for the real access token and the Claude Code identity re-asserted.
 *   Any live user of either role may call it: the relay is the product.
 *
 * The role split is the whole point of the user directory. A `client` token can
 * spend quota; it cannot mint users, unlock the console, or replace the grant.
 *
 * @module claude-server/server
 */

import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  ADMIN_COOKIE,
  ADMIN_HOME,
  ADMIN_PREFIX,
  AdminSessions,
  cookieOf,
  pageForPath,
  redirectForPath,
  renderConsolePage,
  renderLockPage,
} from './admin.js';
import {
  AccountDirectory,
  AccountsError,
  DEFAULT_ACCOUNT_ID,
  rankForNewSession,
  sessionHeadroom,
} from './accounts.js';
import { ClientAuth } from './auth.js';
import { THINKING_BETAS, ensureBaseBetas, wantsThinkingBetas, withClaudeIdentity } from './identity.js';
import { LoginSessions } from './login.js';
import { SessionBindings, fingerprintOf } from './sessions.js';
import { exchangeCode, parseAuthorizationInput, refreshGrant } from './oauth.js';
import { sanitizeBody } from './sanitize.js';
import { hasJsonBody, upstreamFor } from './upstream.js';
import { UsageLedger, UsageObserver } from './usage.js';
import { AUTO_ACCOUNT, UserDirectory, UsersError } from './users.js';

/** Responses must never be cached by an intermediary. */
const NO_STORE = 'no-store';

/** The console cookie: HttpOnly, Strict, scoped to the console path. */
function sessionCookie(id, maxAgeSeconds) {
  return `${ADMIN_COOKIE}=${id}; Path=${ADMIN_PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

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

/** Parse a JSON request body, or reply 400 and return undefined. */
async function readJson(req, res, limit) {
  try {
    return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
  } catch {
    sendJson(res, 400, { error: 'the request body must be JSON', code: 'BAD_BODY' });
    return undefined;
  }
}

/**
 * Build the server.
 * @param options - config, transport, grant store, user directory, and logger.
 * @returns the http.Server plus a dispose hook.
 */
export function createServer(options) {
  const { config, transport, grants, logger, hosts } = options;
  // The directory is injected by the entry point. A caller that provides no
  // directory still gets a working relay for the environment bearer; only the
  // user-management routes are unavailable, which keeps the console meaningful
  // on a deployment that has not mounted a writable volume.
  const users =
    options.users ??
    (typeof config?.usersPath === 'string' && config.usersPath.length > 0
      ? new UserDirectory({ path: config.usersPath, logger })
      : undefined);
  const auth = new ClientAuth(config.clientBearer, { users });
  /**
   * The account directory.
   *
   * `options.accounts` is injected by the entry point. A caller that provides
   * none still gets a working single-account server: the directory is built over
   * the legacy grant path, so `GRANT_PATH` keeps working exactly as before and
   * only the multi-account routes have anything to list.
   */
  const accounts =
    options.accounts ??
    // Without a `grantPath` there is nothing to key a directory on. That is the
    // shape a caller uses when it injects its own single `grants` store (tests,
    // and any embedder that owns one grant); such a server keeps the
    // single-account behaviour and simply has no account list to serve.
    (typeof config?.grantPath === 'string' && config.grantPath.length > 0
      ? new AccountDirectory({
          path: config.accountsPath ?? `${config.grantPath}.accounts.json`,
          grantsDir: config.grantsDir ?? `${config.grantPath}.grants`,
          legacyGrantPath: config.grantPath,
          refreshSkewMs: config.refreshSkewMs,
          logger,
        })
      : undefined);
  const sessions = new LoginSessions({ ttlMs: config.loginTtlMs });
  const adminSessions = new AdminSessions();
  // Console reads of the usage endpoint share this cache. Anthropic rate-limits
  // usage far more tightly than messages and its 429s persist, so an operator
  // clicking Refresh repeatedly must not translate into repeated upstream calls.
  // Token accounting for relayed model traffic. Process memory only: see
  // src/usage.js for why it is not persisted.
  const usageLedger = new UsageLedger();
  /**
   * Which conversation runs on which subscription.
   *
   * In memory, like the usage ledger: a restart re-binds each in-flight
   * conversation on its next turn, which costs one cache write and keeps
   * routing state out of the grant volume.
   */
  const bindings = new SessionBindings();
  /**
   * Quota probe results, keyed per account.
   *
   * One cache entry per account rather than one global: with several
   * subscriptions, a single slot would let one account's figures overwrite
   * another's, and the console would show the wrong quota beside the wrong
   * name.
   */
  const quotaCache = new Map();
  /** The cache entry for one account, created on first use. */
  const quotaSlot = (accountId) => {
    const key = accountId ?? DEFAULT_ACCOUNT_ID;
    let slot = quotaCache.get(key);
    if (slot === undefined) {
      slot = { at: 0, usage: undefined, error: undefined };
      quotaCache.set(key, slot);
    }
    return slot;
  };
  const QUOTA_CACHE_MS = 5 * 60_000;
  const maxBodyBytes = config.maxBodyBytes ?? 32 * 1024 * 1024;

  /**
   * Resolve the access token for one account.
   *
   * The account is chosen by the caller's identity, not by configuration: a
   * token issued on account A must spend account A's subscription. `null` or
   * absent means the default account, which is what every pre-accounts token
   * and the bootstrap bearer resolve to.
   * @param accountId - the account the caller is bound to.
   * @returns the bearer token to send upstream.
   */
  const refreshFn = async (refreshToken) => await refreshGrant(refreshToken, transport.fetch);
  const accessToken = async (accountId) => {
    if (accounts !== undefined) return await accounts.accessToken(accountId, refreshFn);
    // Single-account embedder: one injected store serves every caller, which is
    // exactly what this server did before accounts existed.
    if (grants === undefined) {
      const error = new Error('no grant store is mounted on this server');
      error.code = 'NOT_SIGNED_IN';
      throw error;
    }
    return await grants.accessToken(refreshFn);
  };
  /** The grant store for one account, or the injected single store. */
  const storeFor = (accountId) => (accounts !== undefined ? accounts.store(accountId) : grants);

  /**
   * Per-account 5-hour headroom, cached briefly.
   *
   * The usage endpoint is rate-limited far more aggressively than messages
   * (its 429s persist), so this cannot be called per request. A short cache is
   * enough because the routing decision only needs "roughly how much room is
   * left" at the moment a conversation starts, and the 429 path corrects it
   * immediately when a guess turns out wrong.
   */
  const headroomCache = new Map();
  const HEADROOM_TTL_MS = 60_000;
  /** A background usage probe gives up after this long. */
  const HEADROOM_PROBE_TIMEOUT_MS = 5_000;
  /** Account ids known to have run out, with the moment their window resets. */
  const exhausted = new Map();
  /**
   * Probes still in flight. Disposal aborts them: a background probe that
   * outlives the server touches the grant volume after shutdown, which shows up
   * as a scratch directory that cannot be removed and as work happening on a
   * closed server.
   */
  const inflightProbes = new Set();
  let closing = false;

  const headroomOf = (accountId) => {
    const entry = headroomCache.get(accountId);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.at > HEADROOM_TTL_MS) return undefined;
    return entry.value;
  };

  /**
   * Refresh one account's headroom if the cache is stale or absent.
   * Best effort: a failure leaves the previous value (or none), which the
   * ranking treats as "unknown" rather than as "empty".
   */
  const refreshHeadroom = async (accountId) => {
    if (closing) return;
    if (headroomOf(accountId) !== undefined) return;
    const probe = (async () => {
    try {
      const token = await accessToken(accountId);
      const target = upstreamFor('/api/oauth/usage', '');
      const headers = withClaudeIdentity(
        { accept: 'application/json', 'anthropic-version': '2023-06-01' },
        config.claudeCliVersion,
        config.stainlessRuntimeVersion,
      );
      headers.set('authorization', `Bearer ${token}`);
      ensureBaseBetas(headers);
      headers.delete('host');
      // Bounded: this runs in the background, so a hung probe must not pin a
      // pending promise forever.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEADROOM_PROBE_TIMEOUT_MS);
      try {
        const response = await transport.request(target, {
          method: 'GET',
          headers: Object.fromEntries(headers.entries()),
          signal: controller.signal,
        });
        if (response.statusCode !== 200) return;
        const chunks = [];
        for await (const chunk of response.body) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        headroomCache.set(accountId, { at: Date.now(), value: sessionHeadroom(payload) });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // A probe failure is not a routing failure: it just leaves this account
      // ranked as unknown.
    }
    })();
    inflightProbes.add(probe);
    try {
      await probe;
    } finally {
      inflightProbes.delete(probe);
    }
  };

  /**
   * Choose the account for a conversation that has no binding yet.
   *
   * Ordering: the most 5-hour headroom, ties broken by the window that resets
   * soonest. Accounts already known to be exhausted are skipped for the life of
   * their window, so a conversation started after one fills up does not land on
   * it again.
   * @returns the account id, or null when nothing better than the default exists.
   */
  const chooseAccount = async () => {
    if (accounts === undefined) return null;
    let rows;
    try {
      rows = await accounts.list();
    } catch {
      return null;
    }
    // Never wait on a usage probe here: this runs in the request path, and the
    // usage endpoint is both slow and rate-limited. The decision uses whatever
    // headroom is already cached, and a probe is kicked off in the background
    // for next time. An account with unknown headroom still ranks ahead of a
    // known-exhausted one, so a cold cache degrades to "first usable account"
    // rather than to a stall.
    for (const row of rows) {
      if (headroomOf(row.id) === undefined) void refreshHeadroom(row.id);
    }
    const now = Date.now();
    const ranked = rankForNewSession(rows, headroomOf);
    const usable = ranked.filter((id) => {
      const until = exhausted.get(id);
      if (until === undefined) return true;
      if (until > now) return false;
      // The window has reset; forget the mark.
      exhausted.delete(id);
      return true;
    });
    return usable.length === 0 ? null : usable[0];
  };

  /**
   * Mark an account as out of quota for its current window.
   *
   * Called when upstream answers 429: that is the authoritative signal, ahead
   * of any cached usage probe. The mark expires when the window resets, so a
   * recovered account becomes selectable again without a manual step.
   */
  const markExhausted = (accountId, resetsAt) => {
    if (typeof accountId !== 'string') return;
    const until = typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : Date.now() + 5 * 60_000;
    exhausted.set(accountId, until);
    headroomCache.set(accountId, { at: Date.now(), value: { remaining: 0, resetsAt: until } });
    logger.warn('account %s is out of quota until %s', accountId, new Date(until).toISOString());
  };

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

  /** A 302 that never carries a body. */
  const sendRedirect = (res, location) => {
    res.writeHead(302, { location, 'cache-control': NO_STORE, 'content-length': 0 });
    res.end();
  };

  /**
   * Read one account's grant state without letting a corrupt file throw.
   * @param accountId - the account to inspect (null = default).
   * @returns whether it is signed in and when its token expires.
   */
  const grantState = async (accountId) => {
    try {
      const store = storeFor(accountId);
      const grant = store === undefined ? undefined : await store.read();
      return {
        signedIn: grant !== undefined,
        expiresAt: typeof grant?.expires === 'number' ? grant.expires : null,
      };
    } catch {
      return { signedIn: false, expiresAt: null };
    }
  };

  /** Read the user list, or an empty list when the directory is unusable. */
  const userList = async () => {
    if (users === undefined) return [];
    try {
      return await users.list();
    } catch (error) {
      logger.warn('could not read the user directory: %s', String(error?.message ?? error));
      return [];
    }
  };

  /**
   * The operator console, mounted under `/admin`.
   *
   * Pages are served to anyone who can reach the port, but a page that is not
   * the lock page requires a live session; without one it redirects to `/admin`
   * rather than rendering anything. Every JSON call under `/admin/api/` checks
   * the cookie again, so serving the lock page to an unauthenticated caller
   * grants nothing.
   */
  const admin = async (req, res, ctx) => {
    const { pathname, url } = ctx;
    const sessionId = cookieOf(req.headers.cookie, ADMIN_COOKIE);
    const signedIn = adminSessions.valid(sessionId);
    const identity = signedIn ? adminSessions.identityOf(sessionId) : undefined;

    // Wrap a JSON handler so an unexpected throw becomes a JSON 500 rather than
    // an HTML error page (which would break every client of these routes).
    const api = (handler) => async () => {
      try {
        await handler();
      } catch (error) {
        if (error instanceof UsersError) {
          sendJson(res, error.code === 'UNKNOWN_USER' ? 404 : 400, {
            error: error.message,
            code: error.code,
          });
          return;
        }
        logger.error('console api failure: %s', String(error?.message ?? error));
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      }
    };

    // --- pages ------------------------------------------------------------
    if (req.method === 'GET' && (pathname === ADMIN_PREFIX || pathname === `${ADMIN_PREFIX}/`)) {
      if (!signedIn) {
        const state = await grantState(null);
        sendHtml(res, 200, renderLockPage({ ...state, mode: transport.mode }));
        return;
      }
      sendRedirect(res, ADMIN_HOME);
      return;
    }

    // A retired page path redirects instead of 404ing: the URL may be a
    // bookmark, and landing on the successor is friendlier than a dead end.
    const retired = req.method === 'GET' ? redirectForPath(pathname) : undefined;
    if (retired !== undefined) {
      if (!signedIn) {
        sendRedirect(res, ADMIN_PREFIX);
        return;
      }
      sendRedirect(res, retired);
      return;
    }

    const page = req.method === 'GET' ? pageForPath(pathname) : undefined;
    if (page !== undefined) {
      if (!signedIn) {
        sendRedirect(res, ADMIN_PREFIX);
        return;
      }
      const state = await grantState(null);
      sendHtml(
        res,
        200,
        renderConsolePage({
          page,
          ...state,
          mode: transport.mode,
          cliVersion: config.claudeCliVersion,
          identity,
          // Only the pages that need the user list pay for the read: Users and
          // Overview count them, and Accounts shows how many tokens spend each
          // account.
          users: page === 'users' || page === 'overview' || page === 'accounts' ? await userList() : [],
          // The Accounts page renders the list; the Users page needs it to
          // resolve each token's account name. Other pages pay nothing.
          accounts:
            (page === 'accounts' || page === 'users' || page === 'overview') && accounts !== undefined
              ? await accounts.list().catch(() => [])
              : [],
        }),
      );
      return;
    }

    // --- unlock: bearer in, session cookie out ----------------------------
    if (pathname === `${ADMIN_PREFIX}/api/session` && req.method === 'POST') {
      const payload = await readJson(req, res, 8 * 1024);
      if (payload === undefined) return;
      const presented = typeof payload?.bearer === 'string' ? payload.bearer.trim() : '';
      // Admin credentials only: a `client` token must not mint a session, or any
      // relay user could create more users or replace the Claude grant.
      const who = await auth.checkAdmin(`Bearer ${presented}`);
      if (who === undefined) {
        // Deliberately vague and rate-limit-free at this size: the token is a
        // long random string, so guessing is not the threat model.
        if (presented.length === 0) logger.warn('console unlock refused: no token presented');
        else logger.warn('console unlock refused: the token is not an enabled admin');
        sendJson(res, 401, { error: 'that token was not accepted' });
        return;
      }
      const id = adminSessions.create(who);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': NO_STORE,
        'set-cookie': sessionCookie(id, 30 * 60),
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === `${ADMIN_PREFIX}/api/logout` && req.method === 'POST') {
      adminSessions.destroy(sessionId);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': NO_STORE,
        'set-cookie': sessionCookie('', 0),
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // --- accounts (bearer) -----------------------------------------------------
    // The same account list the console shows, reachable with the operator
    // bearer rather than a console cookie. A remote plugin needs this to offer a
    // subscription picker, and it holds a bearer, not a browser session — asking
    // it to sign into the console would mean a second credential to keep alive.
    if (pathname === `${ADMIN_PREFIX}/api/accounts` && req.method === 'GET') {
      const who = await auth.checkAdmin(req.headers.authorization);
      if (who === undefined) {
        sendJson(res, 401, { error: 'this endpoint needs the operator bearer', code: 'UNAUTHORIZED' });
        return;
      }
      if (accounts === undefined) {
        sendJson(res, 200, {
          ok: true,
          accounts: [
            {
              id: DEFAULT_ACCOUNT_ID,
              name: 'Default account',
              signedIn: (await grantState(null)).signedIn === true,
              disabled: false,
              quotaLimit: null,
              default: true,
            },
          ],
        });
        return;
      }
      await api(async () => {
        try {
          sendJson(res, 200, { ok: true, accounts: await accounts.list() });
        } catch (error) {
          sendJson(res, 500, { error: error.message, code: error.code ?? 'ACCOUNTS_FAILED' });
        }
      })();
      return;
    }


    /**
     * Read one upstream endpoint with one account's credentials.
     * @param path - the upstream path.
     * @param accountId - the account to spend; null means the default account.
     */
    const probeUpstream = async (path, accountId = null) => {
      // `ctx.hosts` is how an embedder points this server at a different
      // origin; omitting it here made every quota probe bypass the injected
      // host and reach the real API even in tests.
      const target = upstreamFor(path, '', hosts ?? {});
      const token = await accessToken(accountId);
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

    if (pathname === `${ADMIN_PREFIX}/api/quota` && req.method === 'GET') {
      // The console reaches this with its cookie; a remote plugin holds only the
      // operator bearer, and asking it to keep a console session alive would mean
      // a second credential to maintain. Either proof is accepted.
      if (!signedIn && (await auth.checkAdmin(req.headers.authorization)) === undefined) {
        sendJson(res, 401, {
          error: 'this endpoint needs the console session or the operator bearer',
          code: 'UNAUTHORIZED',
        });
        return;
      }
      await api(async () => {
        const usageFor = async (accountId) => {
          const slot = quotaSlot(accountId);
          const fresh = Date.now() - slot.at < QUOTA_CACHE_MS;
          if (fresh && slot.usage !== undefined) {
            return { usage: slot.usage, cached: true, at: slot.at };
          }
          if (fresh && slot.error !== undefined) {
            // Serve the recent failure rather than re-tripping the limit.
            throw Object.assign(new Error(slot.error.error), { cached: true, at: slot.at });
          }
          const usage = await probeUpstream('/api/oauth/usage', accountId);
          slot.at = Date.now();
          slot.usage = usage;
          slot.error = undefined;
          return { usage, cached: false, at: slot.at };
        };

        const requested = url.searchParams.get('account');
        if (requested !== null && requested !== '') {
          try {
            const result = await usageFor(requested);
            sendJson(res, 200, { ok: true, accountId: requested, ...result });
          } catch (error) {
            const payload = { error: String(error?.message ?? error), detail: error?.upstreamBody };
            const slot = quotaSlot(requested);
            slot.at = Date.now();
            slot.error = payload;
            slot.usage = undefined;
            sendJson(res, 502, payload);
          }
          return;
        }

        // All accounts: one entry per account, failures included per account so
        // one broken subscription does not blank the whole panel.
        const rows = accounts === undefined ? [] : await accounts.list().catch(() => []);
        const targets = rows.length === 0
          ? [{ id: DEFAULT_ACCOUNT_ID, name: 'Default account', signedIn: true, default: true }]
          : rows;
        const out = [];
        for (const row of targets) {
          if (row.signedIn !== true || row.disabled === true) {
            out.push({
              accountId: row.id,
              name: row.name,
              signedIn: false,
              windows: [],
              error: row.disabled === true ? 'account is disabled' : 'account is signed out',
            });
            continue;
          }
          try {
            const result = await usageFor(row.id);
            out.push({
              accountId: row.id,
              name: row.name,
              signedIn: true,
              // The raw payload is passed through: this server does not
              // interpret quota shapes, and the consumers (console script,
              // plugin) already know how to read both the modern `limits`
              // array and the legacy `five_hour`/`seven_day` buckets.
              usage: result.usage,
              cached: result.cached,
              at: result.at,
            });
          } catch (error) {
            out.push({
              accountId: row.id,
              name: row.name,
              signedIn: true,
              windows: [],
              error: String(error?.message ?? error),
            });
          }
        }
        sendJson(res, 200, { ok: true, accounts: out });
      })();
      return;
    }

    // Everything below mutates or reveals credential state.
    if (!signedIn) {
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
    // --- status -----------------------------------------------------------
    if (pathname === `${ADMIN_PREFIX}/api/status` && req.method === 'GET') {
      const state = await grantState(null);
      sendJson(res, 200, {
        ok: true,
        signedIn: state.signedIn,
        expiresAt: state.expiresAt,
        mode: transport.mode,
        cliVersion: config.claudeCliVersion,
      });
      return;
    }

    // --- quota -----------------------------------------------------------------
    // The subscription's rate-limit windows, as Anthropic reports them.
    // `?account=<id>` reads one subscription; without it, every signed-in
    // account is returned so the console and the plugin can show them side by
    // side instead of presenting one account's numbers as if they were the
    // deployment's.


    // --- models ----------------------------------------------------------------
    // The model catalog this account can actually call.
    if (pathname === `${ADMIN_PREFIX}/api/models` && req.method === 'GET') {
      await api(async () => {
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
      })();
      return;
    }

    // --- usage -----------------------------------------------------------------
    // Token accounting for relayed model traffic. Read-only and cheap: the
    // ledger is process memory, so this never touches the network and cannot
    // trip a rate limit.
    if (pathname === `${ADMIN_PREFIX}/api/usage` && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...usageLedger.snapshot() });
      return;
    }

    // --- users -----------------------------------------------------------------
    if (pathname === `${ADMIN_PREFIX}/api/users` && req.method === 'GET') {
      await api(async () => {
        if (users === undefined) {
          sendJson(res, 501, {
            error: 'multi-user support is not mounted on this server',
            code: 'USERS_UNAVAILABLE',
          });
          return;
        }
        let list;
        try {
          list = await users.list();
        } catch (error) {
          // The read failure is reportable here: an operator asking for the list
          // needs to know the file is broken, unlike a relay request which must
          // keep working with the legacy bearer alone.
          sendJson(res, 500, {
            error: String(error?.message ?? error),
            code: error?.code ?? 'USERS_CORRUPT',
          });
          return;
        }
        sendJson(res, 200, { ok: true, users: list });
      })();
      return;
    }

    if (pathname === `${ADMIN_PREFIX}/api/users` && req.method === 'POST') {
      await api(async () => {
        if (users === undefined) {
          sendJson(res, 501, { error: 'multi-user support is not mounted on this server', code: 'USERS_UNAVAILABLE' });
          return;
        }
        const payload = await readJson(req, res, 8 * 1024);
        if (payload === undefined) return;
        try {
          // A named account must exist before a token can be bound to it: a
          // token pointing at a removed account would be refused at relay time
          // with no clue why, so the mistake is caught at creation instead.
          const requestedAccount =
            payload?.accountId === undefined || payload?.accountId === null || payload?.accountId === ''
              ? null
              : String(payload.accountId).trim();
          if (requestedAccount !== null && accounts !== undefined) {
            await accounts.require(requestedAccount);
          }
          const { user, token } = await users.create({
            name: payload?.name,
            role: payload?.role,
            accountId: requestedAccount,
          });
          // The one and only reveal. Nothing is logged with the token in it.
          sendJson(res, 200, { ok: true, user, token });
        } catch (error) {
          if (error instanceof UsersError) {
            sendJson(res, 400, { error: error.message, code: error.code });
            return;
          }
          logger.warn('could not create a user: %s', String(error?.message ?? error));
          sendJson(res, 500, { error: 'the user file could not be written', code: 'USERS_WRITE_FAILED' });
        }
      })();
      return;
    }

    const userRoute = /^\/admin\/api\/users\/([^/]+)$/.exec(pathname);
    if (userRoute !== null && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const id = decodeURIComponent(userRoute[1]);
      await api(async () => {
        if (users === undefined) {
          sendJson(res, 501, { error: 'multi-user support is not mounted on this server', code: 'USERS_UNAVAILABLE' });
          return;
        }
        if (req.method === 'PATCH') {
          const payload = await readJson(req, res, 8 * 1024);
          if (payload === undefined) return;
          try {
            const user = await users.update(id, {
              name: payload?.name,
              role: payload?.role,
              disabled: payload?.disabled,
            });
            sendJson(res, 200, { ok: true, user });
          } catch (error) {
            const status = error?.code === 'UNKNOWN_USER' ? 404 : 400;
            sendJson(res, status, { error: error.message, code: error.code });
          }
          return;
        }
        try {
          const removed = await users.remove(id);
          if (!removed) {
            sendJson(res, 404, { error: 'that user does not exist', code: 'UNKNOWN_USER' });
            return;
          }
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendJson(res, 400, { error: error.message, code: error.code });
        }
      })();
      return;
    }

    // --- Accounts ----------------------------------------------------------
    // The accounts this server serves. Reading the list is what the console's
    // Accounts page needs; mutating one is admin work like user management, and
    // sits under the same session gate above.
    if (pathname === `${ADMIN_PREFIX}/api/accounts` && req.method === 'GET') {
      await api(async () => {
        try {
          sendJson(res, 200, { ok: true, accounts: await accounts.list() });
        } catch (error) {
          sendJson(res, 500, { error: error.message, code: error.code ?? 'ACCOUNTS_FAILED' });
        }
      })();
      return;
    }

    if (pathname === `${ADMIN_PREFIX}/api/accounts` && req.method === 'POST') {
      await api(async () => {
        const payload = await readJson(req, res, 16 * 1024);
        if (payload === undefined) return;
        try {
          const account = await accounts.create({
            name: payload?.name,
            quotaLimit: payload?.quotaLimit,
          });
          sendJson(res, 201, { ok: true, account });
        } catch (error) {
          sendJson(res, 400, { error: error.message, code: error.code });
        }
      })();
      return;
    }

    if (pathname.startsWith(`${ADMIN_PREFIX}/api/accounts/`)) {
      const rest = pathname.slice(`${ADMIN_PREFIX}/api/accounts/`.length);
      const id = decodeURIComponent(rest);
      await api(async () => {
        if (req.method === 'PATCH') {
          const payload = await readJson(req, res, 16 * 1024);
          if (payload === undefined) return;
          try {
            const account = await accounts.update(id, payload ?? {});
            sendJson(res, 200, { ok: true, account });
          } catch (error) {
            const status = error?.code === 'UNKNOWN_ACCOUNT' ? 404 : 400;
            sendJson(res, status, { error: error.message, code: error.code });
          }
          return;
        }
        if (req.method === 'DELETE') {
          try {
            const removed = await accounts.remove(id);
            if (!removed) {
              sendJson(res, 404, { error: 'that account does not exist', code: 'UNKNOWN_ACCOUNT' });
              return;
            }
            sendJson(res, 200, { ok: true });
          } catch (error) {
            const status = error?.code === 'UNKNOWN_ACCOUNT' ? 404 : 400;
            sendJson(res, status, { error: error.message, code: error.code });
          }
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      })();
      return;
    }

    // --- Claude sign-in ----------------------------------------------------
    if (pathname === `${ADMIN_PREFIX}/api/login/start` && req.method === 'POST') {
      await api(async () => {
        const payload = await readJson(req, res, 8 * 1024);
        if (payload === undefined) return;
        // `accountId` picks which subscription this grant belongs to. Absent or
        // null is the default account, which is what the single-account shape
        // has always meant.
        const requested = payload?.accountId === undefined || payload.accountId === null ? null : String(payload.accountId).trim();
        try {
          if (requested !== null && requested !== '') await accounts.require(requested);
          const attempt = sessions.create({ accountId: requested === '' ? null : requested });
          sendJson(res, 200, {
            id: attempt.id,
            url: attempt.url,
            accountId: attempt.accountId,
            expiresAt: attempt.expiresAt,
          });
        } catch (error) {
          const status = error?.code === 'UNKNOWN_ACCOUNT' || error?.code === 'ACCOUNT_DISABLED' ? 404 : 429;
          sendJson(res, status, { error: error.message, code: error.code });
        }
      })();
      return;
    }

    if (pathname === `${ADMIN_PREFIX}/api/login/complete` && req.method === 'POST') {
      await api(async () => {
        const payload = await readJson(req, res, 64 * 1024);
        if (payload === undefined) return;
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
          // Write to the account the attempt was opened for, so a grant cannot
          // land on a different subscription than the URL the operator used.
          await storeFor(attempt.accountId).write(grant);
          sessions.consume(payload.id);
          logger.info(
            'stored a new Claude subscription grant (console, account %s)',
            attempt.accountId ?? 'default',
          );
          sendJson(res, 200, { ok: true, accountId: attempt.accountId, expiresAt: grant.expires });
        } catch (error) {
          logger.warn('the console authorization-code exchange failed: %s', String(error));
          sendJson(res, 502, { error: String(error?.message ?? error), code: 'EXCHANGE_FAILED' });
        }
      })();
      return;
    }

    if (pathname === `${ADMIN_PREFIX}/api/login/cancel` && req.method === 'POST') {
      try {
        const payload = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8') || '{}');
        sessions.consume(payload?.id);
      } catch {
        // Cancelling an unknown attempt is not an error worth reporting.
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith(`${ADMIN_PREFIX}/api/`)) {
      sendJson(res, 404, { error: 'unknown console api route' });
      return;
    }

    // A console page path that is not one of the five, or a non-GET on one.
    sendJson(res, 404, { error: 'unknown console route' });
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;

      // Liveness is the only unauthenticated route.
      if (pathname === '/healthz') {
        // The deployment's own liveness is defined by its default account: a
        // caller cannot name an account here, and reporting every account's
        // state would leak the account list to an unauthenticated probe.
        let signedIn = false;
        try {
          const store = storeFor(null);
          signedIn = store !== undefined && (await store.read()) !== undefined;
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

      // Root-level routes: the relay needs any live user; the grant-mutating
      // login routes need an admin, because they can replace the credential the
      // whole deployment depends on.
      const isLoginRoute = pathname.startsWith('/login/');
      const identity = isLoginRoute
        ? await auth.checkAdmin(req.headers.authorization)
        : await auth.checkUser(req.headers.authorization);
      if (identity === undefined) {
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
          await storeFor(attempt.accountId).write(grant);
          sessions.consume(payload.id);
          logger.info(
            'stored a new Claude subscription grant (account %s)',
            attempt.accountId ?? 'default',
          );
          sendJson(res, 200, { ok: true, accountId: attempt.accountId, expiresAt: grant.expires });
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
        // The relay's own status is the default account's: the caller here
        // holds a bearer whose account is not part of this contract, and
        // changing what `/status` means would break existing clients.
        let grant;
        let error;
        try {
          const store = storeFor(null);
          grant = store === undefined ? undefined : await store.read();
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
      await relay(req, res, {
        config,
        transport,
        logger,
        accessToken,
        hosts,
        usageLedger,
        // The account the caller's token is bound to. `null` means "bound to the
        // default account"; `undefined` means "not bound at all, route by
        // session". The distinction is load-bearing: the bootstrap bearer is
        // bound to the default account and must never be moved by routing.
        accountId: identity === undefined ? undefined : identity.accountId,
        identity,
        // Session routing: the relay decides the account, so it needs the
        // binding table and the chooser, both owned by this closure.
        bindings,
        chooseAccount,
        markExhausted,
        exhaustedUntilOf,
        // Needed to validate a client-named account; undefined on a
        // single-grant deployment, where the header can only name the default.
        accounts,
      });
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
    // Exposed for the same reason: tests drive the directory through the server.
    users,
    // The account directory this server actually holds. A caller must mutate
    // *this* instance, not a second one over the same files: the directory
    // memoizes its file, so a separate instance would write a change the
    // running server never sees.
    accounts,
    async dispose() {
      // Refuse new probes, then let the running ones settle: a probe that
      // touches the grant volume after the caller has moved on is a leak, and
      // it is what makes a scratch directory unremovable in tests.
      closing = true;
      await Promise.allSettled([...inflightProbes]);
      // Bookkeeping writes (lastUsedAt) are fire-and-forget by design; wait for
      // them before the caller removes the volume they land on.
      if (accounts !== undefined) await accounts.drain();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The request header a client uses to name the account for one request.
 *
 * It lets a client pick a subscription explicitly instead of accepting whatever
 * routing decides. Routing is still the default, because a conversation that
 * moves accounts loses its prompt cache, so this is for the deliberate case: an
 * operator draining a specific subscription, or testing one.
 *
 * It is a *request* header, not an instruction: the server refuses a name it does
 * not know, and a token pinned to one account cannot use it to reach another.
 */
export const ACCOUNT_HEADER = 'x-ccsub-account';

/**
 * Read the requested account from a request.
 * @param headers - the incoming headers.
 * @returns the trimmed account id, or undefined when the header is absent/blank.
 */
export function requestedAccount(headers) {
  const raw = headers?.[ACCOUNT_HEADER];
  if (raw === undefined) return undefined;
  const value = String(Array.isArray(raw) ? raw[0] : raw).trim();
  return value.length === 0 ? undefined : value;
}

/**
 * When a 429 says the account's quota window refills.
 *
 * Anthropic reports the reset as either `retry-after` (seconds) or a
 * `*-reset` timestamp header, and the exact name varies by limit kind. Each is
 * tried in turn; if none is present the caller falls back to a short cooldown,
 * which is still better than retrying an account that just refused.
 * @param headers - the upstream response headers.
 * @returns epoch milliseconds, or undefined.
 */
function exhaustedUntilOf(headers) {
  if (headers === null || typeof headers !== 'object') return undefined;
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000;
  for (const name of [
    'anthropic-ratelimit-unified-5h-reset',
    'anthropic-ratelimit-unified-reset',
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset',
  ]) {
    const raw = headers[name];
    if (raw === undefined) continue;
    // Some resets arrive as epoch seconds, others as an HTTP date.
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      // A bare number below 1e12 is seconds, not milliseconds.
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(String(raw));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Relay one request to Anthropic.
 *
 * The body is optionally sanitised, the client bearer is replaced with the real
 * access token, and the Claude Code identity is rebuilt. The response is copied
 * back byte for byte with its framing headers intact.
 */
async function relay(req, res, ctx) {
  const {
    config,
    transport,
    logger,
    accessToken,
    usageLedger,
    accountId,
    identity,
    bindings,
    chooseAccount,
    markExhausted,
    exhaustedUntilOf,
    accounts,
  } = ctx;
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

  /**
   * Which subscription serves this request.
   *
   * A token bound to an account still pins it — that is an explicit operator
   * decision. An unbound token (`accountId == null`) is routed by conversation:
   * the first turn picks the roomiest account, and every later turn of the same
   * conversation follows the binding so its prompt cache keeps hitting.
   *
   * Moving a live conversation to another account is the one thing this must
   * never do casually: cache is per credential, so a hop turns every subsequent
   * turn into a full cache write instead of a cache read.
   */
  // Two different absences: a token explicitly bound to the *default* account
  // carries `accountId: null` and must stay there, while a token with no binding
  // at all (`undefined`) is eligible for session routing. Collapsing them would
  // silently move the bootstrap bearer off the default account.
  const fingerprint = fingerprintOf(parsedBody);
  let serving = accountId;
  let switchedFrom;

  // An explicit request-level choice wins over routing, but only within what the
  // token is allowed to reach. A token pinned to one account must not be able to
  // name another: the pin is the operator's statement about whose subscription
  // this token spends, and honouring the header there would turn any leaked
  // token into access to every subscription.
  const requested = requestedAccount(req.headers);
  if (requested !== undefined) {
    const pinned = accountId !== undefined && accountId !== AUTO_ACCOUNT && accountId !== null;
    if (pinned && requested !== accountId) {
      sendJson(res, 403, {
        error: `this token is pinned to account ${accountId} and cannot spend ${requested}`,
        code: 'ACCOUNT_NOT_PERMITTED',
      });
      return;
    }
    if (accounts !== undefined) {
      // `require` resolves the default account and rejects an unknown or
      // disabled one, so a disabled subscription cannot be drained by naming it.
      try {
        await accounts.require(requested);
      } catch (error) {
        sendJson(res, error?.code === 'ACCOUNT_DISABLED' ? 403 : 404, {
          error: String(error?.message ?? error),
          code: error?.code ?? 'UNKNOWN_ACCOUNT',
        });
        return;
      }
    }
    // A named account is a deliberate override, so the conversation's binding is
    // rewritten rather than merely bypassed; otherwise the next turn would
    // silently drift back to the routed account.
    serving = requested === DEFAULT_ACCOUNT_ID ? null : requested;
    if (fingerprint !== undefined) bindings.set(fingerprint, serving);
  } else if (accountId === undefined || accountId === AUTO_ACCOUNT) {
    // `AUTO_ACCOUNT` is the explicit opt-in to per-conversation routing; `null`
    // is a pin to the default account and stays put.
    const bound = bindings.get(fingerprint);
    if (bound !== undefined) {
      serving = bound;
    } else {
      serving = await chooseAccount();
      if (serving === undefined) serving = null;
      switchedFrom = undefined;
    }
  }

  let token;
  try {
    token = await accessToken(serving);
  } catch (error) {
    const code = error?.code ?? 'TOKEN_UNAVAILABLE';
    // Three distinct refusals, three distinct statuses: the account itself is
    // unusable (403, retrying will not help), that account is signed out (401,
    // an operator has to sign it in), or the refresh failed (502, upstream).
    const status =
      code === 'ACCOUNT_DISABLED' || code === 'UNKNOWN_ACCOUNT'
        ? 403
        : code === 'NOT_SIGNED_IN'
          ? 401
          : 502;
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

    if (upstream.statusCode === 429) {
      // The authoritative "this account is done" signal, ahead of any cached
      // usage probe. Marking it here is what stops the *next* conversation from
      // being started on an account that will immediately refuse it.
      markExhausted(serving, exhaustedUntilOf(upstream.headers));
      // A binding to an account that just ran out must be dropped, so the next
      // turn can move. This is the one place where moving costs less than
      // staying: staying cannot succeed at all.
      if (fingerprint !== undefined) bindings.delete(fingerprint);
    } else if (upstream.statusCode < 500 && fingerprint !== undefined && typeof serving === 'string') {
      // Bind only on a response the account actually served. A 4xx that is not
      // a rate limit (a bad request, a validation error) says nothing about
      // whether this account is the right one to keep using.
      bindings.set(fingerprint, serving);
      if (switchedFrom !== undefined) {
        logger.info('session moved from account %s to %s after a quota limit', switchedFrom, serving);
      }
    }
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
      usageLedger.record({
        ...accounting,
        durationMs: Date.now() - startedAt,
        // Attribution: who spent it, and which subscription paid. Both are
        // carried into the ledger so the console can answer "who costs me the
        // most" and "which account is being drained" separately.
        userId: identity?.id,
        userName: identity?.name,
        // The account that *served* the call, not the token's declared binding:
        // an `auto` token is attributed to the subscription it actually spent.
        accountId: typeof serving === 'string' ? serving : null,
      });
    }
  }
}

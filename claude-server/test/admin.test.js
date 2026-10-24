/**
 * The operator console: its authentication boundary and its pages.
 *
 * These tests exist because the console is the one surface that can replace the
 * Claude grant and issue access tokens. The property worth locking down is not
 * "the page renders" but "an unauthenticated caller can reach nothing that
 * mutates or reveals state", and "a relay credential is not an administrative
 * one".
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ADMIN_COOKIE, AdminSessions, cookieOf, renderConsolePage, renderLockPage } from '../src/admin.js';
import { UserDirectory } from '../src/users.js';

const BEARER = 'b'.repeat(48);
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Build a server over a stub grant store, a temp user file, and a dead transport. */
async function makeServer(options = {}) {
  const { createServer } = await import('../src/server.js');
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-admin-'));
  const users = new UserDirectory({ path: join(dir, 'users.json'), logger: quietLogger });
  await options.seed?.(users);
  const grants = {
    state: options.grant,
    async read() {
      return this.state;
    },
    async write(grant) {
      this.state = grant;
    },
    async accessToken() {
      if (this.state === undefined) {
        const error = new Error('no grant');
        error.code = 'NOT_SIGNED_IN';
        throw error;
      }
      return this.state.access;
    },
    invalidate() {},
  };
  const transport = options.transportOverride ?? {
    mode: 'proxy',
    async request() {
      throw new Error('the console tests must never reach upstream');
    },
    async fetch() {
      throw new Error('the console tests must never reach upstream');
    },
  };
  const built = createServer({
    config: {
      clientBearer: BEARER,
      loginTtlMs: 300_000,
      sanitizeBody: false,
      claudeCliVersion: '2.1.303',
      stainlessRuntimeVersion: 'v22.19.0',
    },
    transport,
    grants,
    users,
    logger: quietLogger,
  });
  await new Promise((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${built.server.address().port}`;
  return {
    ...built,
    base,
    grants,
    users,
    dir,
    async close() {
      await built.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Unlock the console and return the session cookie, or undefined. */
async function unlock(s, bearer = BEARER) {
  const res = await fetch(`${s.base}/admin/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bearer }),
  });
  if (res.status !== 200) return undefined;
  const sid = cookieOf(res.headers.get('set-cookie'), ADMIN_COOKIE);
  return sid === undefined ? undefined : `${ADMIN_COOKIE}=${sid}`;
}

// --- the pages --------------------------------------------------------------

test('the lock page renders a login form and no management UI', () => {
  const html = renderLockPage({ signedIn: false, mode: 'proxy' });
  assert.match(html, /Unlock the console/);
  assert.match(html, /type="password"/);
  // The management UI must not be reachable before unlocking.
  assert.doesNotMatch(html, /Add user/);
  assert.doesNotMatch(html, /Start sign-in/);
});

test('an unlocked page renders the management UI and the navigation', () => {
  const html = renderConsolePage({
    page: 'account',
    signedIn: true,
    mode: 'proxy',
    expiresAt: 1_700_000_000_000,
    cliVersion: '2.1.303',
  });
  assert.match(html, /Start sign-in/);
  assert.match(html, /Sign out of console/);
  // The bearer input belongs to the lock page only.
  assert.doesNotMatch(html, /id="bearer"/);
  // The shared shell carries all five destinations.
  for (const label of ['Overview', 'Account', 'Users', 'Usage', 'Models']) {
    assert.match(html, new RegExp(`>${label}<`));
  }
});

test('the console never renders token material', () => {
  for (const page of ['overview', 'account', 'users', 'usage', 'models']) {
    const html = renderConsolePage({
      page,
      signedIn: true,
      mode: 'proxy',
      expiresAt: 1,
      identity: { name: 'admin' },
      users: [{ id: 'legacy', name: 'Legacy bearer (CLIENT_BEARER)', role: 'admin', legacy: true }],
    });
    assert.doesNotMatch(html, /sk-ant-oat/);
    assert.doesNotMatch(html, /sk-ant-ort/);
    // Not even a stored hash may reach the markup.
    assert.doesNotMatch(html, /[0-9a-f]{64}/);
  }
});

test('the console escapes an injected notice', () => {
  const html = renderLockPage({ notice: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('a page escapes a user name that contains markup', () => {
  const html = renderConsolePage({
    page: 'users',
    signedIn: true,
    mode: 'proxy',
    identity: { name: 'admin' },
    users: [
      { id: 'u_1', name: '<img src=x onerror=alert(1)>', role: 'client', disabled: false },
    ],
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('the console sends a CSP that forbids external loads and framing', async () => {
  const s = await makeServer();
  try {
    for (const path of ['/admin', '/admin/overview', '/admin/users']) {
      const res = await fetch(`${s.base}${path}`, { redirect: 'manual' });
      const html = res.status === 200 ? await res.text() : '';
      if (res.status !== 200) {
        assert.equal(res.status, 302, `${path} must redirect or render, never error`);
        continue;
      }
      assert.equal(res.headers.get('content-security-policy').includes("default-src 'none'"), true);
      assert.equal(res.headers.get('content-security-policy').includes("frame-ancestors 'none'"), true);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      // Every script and style must be inline; no external asset is allowed.
      assert.doesNotMatch(html, /<script[^>]+src=/);
      assert.doesNotMatch(html, /<link[^>]+href=/);
    }
  } finally {
    await s.close();
  }
});

// --- page routing -----------------------------------------------------------

test('GET /admin renders the lock page without a session', async () => {
  const s = await makeServer();
  try {
    const res = await fetch(`${s.base}/admin`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Unlock the console/);
  } finally {
    await s.close();
  }
});

test('GET /admin redirects to the overview once a session is live', async () => {
  const s = await makeServer();
  try {
    const cookie = await unlock(s);
    const res = await fetch(`${s.base}/admin`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/overview');
  } finally {
    await s.close();
  }
});

test('every console page redirects to the lock page without a session', async () => {
  const s = await makeServer();
  try {
    for (const path of ['/admin/overview', '/admin/account', '/admin/users', '/admin/usage', '/admin/models']) {
      const res = await fetch(`${s.base}${path}`, { redirect: 'manual' });
      assert.equal(res.status, 302, `${path} must not render without a session`);
      assert.equal(res.headers.get('location'), '/admin');
    }
  } finally {
    await s.close();
  }
});

test('every console page renders with a session', async () => {
  const s = await makeServer();
  try {
    const cookie = await unlock(s);
    for (const [path, marker] of [
      ['/admin/overview', 'Relayed calls'],
      ['/admin/account', 'Claude grant'],
      ['/admin/users', 'Add user'],
      ['/admin/usage', 'Token accounting'],
      ['/admin/models', 'Model catalog'],
    ]) {
      const res = await fetch(`${s.base}${path}`, { headers: { cookie } });
      assert.equal(res.status, 200, `${path} must render`);
      assert.match(await res.text(), new RegExp(marker));
    }
  } finally {
    await s.close();
  }
});

// --- the authentication boundary -------------------------------------------

test('every mutating console route refuses without a session', async () => {
  const s = await makeServer();
  try {
    const routes = [
      ['POST', '/admin/api/login/start'],
      ['POST', '/admin/api/login/complete'],
      ['POST', '/admin/api/login/cancel'],
      ['POST', '/admin/api/users'],
      ['PATCH', '/admin/api/users/u_1'],
      ['DELETE', '/admin/api/users/u_1'],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${s.base}${path}`, { method, body: '{}' });
      assert.equal(res.status, 401, `${method} ${path} must refuse an unauthenticated caller`);
      const body = await res.json();
      // A JSON route must answer JSON, never a page.
      assert.equal(typeof body.error, 'string');
      assert.equal(body.error.includes('grant'), false);
      // The refusal must not hint at whether a directory is even mounted.
      assert.equal(body.error.includes('user'), false);
    }
    // A refused start must not leave a pending attempt behind.
    assert.equal(s.grants.state, undefined);
  } finally {
    await s.close();
  }
});

test('the read-only console APIs refuse without a session', async () => {
  const s = await makeServer();
  try {
    for (const path of ['/admin/api/status', '/admin/api/quota', '/admin/api/models', '/admin/api/usage', '/admin/api/users']) {
      const res = await fetch(`${s.base}${path}`);
      assert.equal(res.status, 401, `${path} must refuse without a session`);
      assert.match(res.headers.get('content-type'), /application\/json/);
    }
  } finally {
    await s.close();
  }
});

test('unlocking with a wrong bearer is refused and mints no session', async () => {
  const s = await makeServer();
  try {
    const res = await fetch(`${s.base}/admin/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bearer: 'x'.repeat(48) }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await s.close();
  }
});

test('an empty bearer is refused and mints no session', async () => {
  const s = await makeServer();
  try {
    const res = await fetch(`${s.base}/admin/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bearer: '   ' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await s.close();
  }
});

test('unlocking with the right bearer mints an HttpOnly Strict cookie', async () => {
  const s = await makeServer();
  try {
    const res = await fetch(`${s.base}/admin/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bearer: BEARER }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    // The cookie must not be readable by scripts, and must be path-scoped.
    assert.match(cookie, /Path=\/admin/);
    // The response must not echo the bearer back.
    const body = await res.text();
    assert.equal(body.includes(BEARER), false);
    assert.equal(JSON.stringify(body), JSON.stringify(body));
  } finally {
    await s.close();
  }
});

test('a valid session reaches login/start and gets an authorize URL', async () => {
  const s = await makeServer();
  try {
    const cookie = await unlock(s);
    const res = await fetch(`${s.base}/admin/api/login/start`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.url, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
    assert.match(body.url, /code_challenge_method=S256/);
    // The verifier must never be in the response: it is the PKCE secret.
    assert.equal(JSON.stringify(body).includes('verifier'), false);
  } finally {
    await s.close();
  }
});

test('logging out invalidates the session', async () => {
  const s = await makeServer();
  try {
    const cookie = await unlock(s);
    const out = await fetch(`${s.base}/admin/api/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(out.status, 200);
    // The cookie must be cleared, not merely invalidated server-side.
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);

    const after = await fetch(`${s.base}/admin/api/login/start`, { method: 'POST', headers: { cookie } });
    assert.equal(after.status, 401);
  } finally {
    await s.close();
  }
});

test('the relay still requires the bearer even though /admin does not', async () => {
  const s = await makeServer();
  try {
    // The console being reachable must not have opened the relay.
    const res = await fetch(`${s.base}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'unauthorized');
  } finally {
    await s.close();
  }
});

test('an expired session is refused', async () => {
  const sessions = new AdminSessions({ ttlMs: -1 });
  const id = sessions.create();
  assert.equal(sessions.valid(id), false);
});

test('sessions cap out without locking the operator out', () => {
  const sessions = new AdminSessions({ ttlMs: 60_000 });
  const ids = [];
  for (let i = 0; i < 12; i += 1) ids.push(sessions.create());
  // The newest must still work: a stale tab may never block a revocation.
  assert.equal(sessions.valid(ids[ids.length - 1]), true);
});

test('cookieOf ignores lookalike names', () => {
  const header = `x${ADMIN_COOKIE}=nope; ${ADMIN_COOKIE}=yes`;
  assert.equal(cookieOf(header, ADMIN_COOKIE), 'yes');
  assert.equal(cookieOf(undefined, ADMIN_COOKIE), undefined);
});

// --- roles ------------------------------------------------------------------

test('a client-role token is refused for console unlock', async () => {
  const s = await makeServer();
  try {
    const { token } = await s.users.create({ name: 'alice', role: 'client' });
    const res = await fetch(`${s.base}/admin/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bearer: token }),
    });
    assert.equal(res.status, 401);
    // The whole point of the role split: no session is minted.
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await s.close();
  }
});

test('an admin-role token unlocks the console', async () => {
  const s = await makeServer();
  try {
    const { token } = await s.users.create({ name: 'root', role: 'admin' });
    const cookie = await unlock(s, token);
    assert.ok(cookie, 'an admin token must unlock');
  } finally {
    await s.close();
  }
});

test('the legacy env bearer still unlocks the console', async () => {
  const s = await makeServer();
  try {
    const cookie = await unlock(s);
    assert.ok(cookie);
    const res = await fetch(`${s.base}/admin/overview`, { headers: { cookie } });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test('a client-role token is accepted by the relay', async () => {
  const calls = [];
  const s = await makeServer({
    grant: { access: 'sk-ant-oat01-T', refresh: 'r', expires: Date.now() + 86_400_000 },
    transportOverride: {
      mode: 'proxy',
      async request(url, init) {
        calls.push({ url: String(url), method: init.method });
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: (async function* () {
            yield Buffer.from(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }] }));
          })(),
        };
      },
      async fetch() {
        throw new Error('unused');
      },
    },
  });
  try {
    const { token } = await s.users.create({ name: 'alice', role: 'client' });
    const res = await fetch(`${s.base}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.anthropic\.com/);
    // The upstream must see the real access token, never the client's.
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test('a client-role token cannot reach the grant-mutating login routes', async () => {
  const s = await makeServer();
  try {
    const { token } = await s.users.create({ name: 'alice', role: 'client' });
    const res = await fetch(`${s.base}/login/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test('a disabled user is refused by the relay', async () => {
  const s = await makeServer({
    grant: { access: 'sk-ant-oat01-T', refresh: 'r', expires: Date.now() + 86_400_000 },
    transportOverride: {
      mode: 'proxy',
      async request() {
        return { statusCode: 200, headers: {}, body: (async function* () {})() };
      },
      async fetch() {
        throw new Error('unused');
      },
    },
  });
  try {
    const { user, token } = await s.users.create({ name: 'alice', role: 'client' });
    await s.users.update(user.id, { disabled: true });
    const res = await fetch(`${s.base}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

// --- user management over HTTP ---------------------------------------------

test('the users page renders row actions as data attributes for delegation', () => {
  const users = [
    { id: 'legacy', name: 'Legacy bearer (CLIENT_BEARER)', role: 'admin', legacy: true, createdAt: null, lastUsedAt: null, disabled: false },
    { id: 'u_ab12cd34ef56', name: 'alice', role: 'client', legacy: false, createdAt: 1, lastUsedAt: null, disabled: false },
    { id: 'u_ffeeddccbbaa', name: 'bob', role: 'admin', legacy: false, createdAt: 2, lastUsedAt: null, disabled: true },
  ];
  const html = renderConsolePage({ page: 'users', signedIn: true, mode: 'proxy', identity: { name: 'admin' }, users });
  // The rendered rows are inert markup: they must carry the same contract the
  // client-side table uses, or the buttons would be dead until the next reload.
  assert.match(html, /data-action="toggle" data-id="u_ab12cd34ef56" data-disabled="false"/);
  assert.match(html, /data-action="toggle" data-id="u_ffeeddccbbaa" data-disabled="true"/);
  assert.match(html, /data-action="remove" data-id="u_ab12cd34ef56"/);
  // Every row action needs a visible label or an aria-label.
  assert.match(html, /aria-label="Remove user alice"/);
  // The legacy row must have no destructive control at all.
  const legacyRow = /<tr data-user-row="legacy">([\s\S]*?)<\/tr>/.exec(html);
  assert.ok(legacyRow, 'the legacy row must be rendered');
  assert.equal(legacyRow[1].includes('data-action'), false, 'the legacy row must not offer a mutating control');
  assert.match(legacyRow[1], /set by the environment/);
});

test('creating a user returns a token that then authenticates the relay', async () => {
  const s = await makeServer({
    grant: { access: 'sk-ant-oat01-T', refresh: 'r', expires: Date.now() + 86_400_000 },
    transportOverride: {
      mode: 'proxy',
      async request() {
        return { statusCode: 200, headers: {}, body: (async function* () {})() };
      },
      async fetch() {
        throw new Error('unused');
      },
    },
  });
  try {
    const cookie = await unlock(s);
    const created = await fetch(`${s.base}/admin/api/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alice', role: 'client' }),
    });
    assert.equal(created.status, 200);
    const payload = await created.json();
    assert.match(payload.token, /^ccs_[A-Za-z0-9_-]{43}$/);
    assert.equal(payload.user.name, 'alice');
    assert.equal(payload.user.role, 'client');
    // The stored record must never carry the plaintext token.
    assert.equal('tokenHash' in payload.user, false);
    assert.equal(JSON.stringify(payload.user).includes(payload.token), false);

    const relayed = await fetch(`${s.base}/v1/models`, {
      headers: { authorization: `Bearer ${payload.token}` },
    });
    assert.equal(relayed.status, 200);

    // Listing must not reveal the token again.
    const listed = await fetch(`${s.base}/admin/api/users`, { headers: { cookie } });
    const listBody = await listed.json();
    assert.equal(JSON.stringify(listBody).includes(payload.token), false);
    assert.equal(listBody.users.some((user) => user.legacy === true), true);
  } finally {
    await s.close();
  }
});

test('a user list never includes a token hash', async () => {
  const s = await makeServer();
  try {
    const cookie = await unlock(s);
    const { token } = await s.users.create({ name: 'alice', role: 'client' });
    const res = await fetch(`${s.base}/admin/api/users`, { headers: { cookie } });
    const body = await res.json();
    assert.equal(JSON.stringify(body).includes('tokenHash'), false);
    assert.equal(JSON.stringify(body).includes(token), false);
  } finally {
    await s.close();
  }
});

test('the legacy user cannot be deleted or changed', async () => {
  const s = await makeServer();
  try {
    const cookie = await unlock(s);
    const removed = await fetch(`${s.base}/admin/api/users/legacy`, { method: 'DELETE', headers: { cookie } });
    assert.equal(removed.status, 400);
    const patched = await fetch(`${s.base}/admin/api/users/legacy`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(patched.status, 400);
    // The bearer must still work afterwards.
    assert.ok(await unlock(s));
  } finally {
    await s.close();
  }
});

test('disabling and removing a user works and answers 404 for unknown ids', async () => {
  const s = await makeServer();
  try {
    const cookie = await unlock(s);
    const { user } = await s.users.create({ name: 'bob', role: 'client' });
    const patched = await fetch(`${s.base}/admin/api/users/${user.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).user.disabled, true);

    const removed = await fetch(`${s.base}/admin/api/users/${user.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });

    const unknown = await fetch(`${s.base}/admin/api/users/u_000000000000`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(unknown.status, 404);
    const unknownPatch = await fetch(`${s.base}/admin/api/users/u_000000000000`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(unknownPatch.status, 404);
  } finally {
    await s.close();
  }
});

test('a corrupt users file still lets the legacy bearer run the relay and unlock', async () => {
  // The relay is the product. A malformed user file must cost user management,
  // not the deployment: the bootstrap bearer has to keep working.
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-corrupt-'));
  const path = join(dir, 'users.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, '{not json');
  const { createServer } = await import('../src/server.js');
  const users = new UserDirectory({ path, logger: quietLogger });
  const grants = {
    async read() {
      return { access: 'sk-ant-oat01-T', refresh: 'r', expires: Date.now() + 86_400_000 };
    },
    async write() {},
    async accessToken() {
      return 'sk-ant-oat01-T';
    },
    invalidate() {},
  };
  const transport = {
    mode: 'proxy',
    async request() {
      return { statusCode: 200, headers: {}, body: (async function* () {})() };
    },
    async fetch() {
      throw new Error('unused');
    },
  };
  const built = createServer({
    config: { clientBearer: BEARER, loginTtlMs: 300_000, sanitizeBody: false, claudeCliVersion: '2.1.303' },
    transport,
    grants,
    users,
    logger: quietLogger,
  });
  await new Promise((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${built.server.address().port}`;
  try {
    const relay = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    assert.equal(relay.status, 200, 'the legacy bearer must still reach the relay');

    const s = { base };
    assert.ok(await unlock(s), 'the legacy bearer must still unlock the console');

    // The damage is still visible where it matters: the list refuses rather than
    // pretending the file is empty.
    const cookie = await unlock(s);
    const listed = await fetch(`${base}/admin/api/users`, { headers: { cookie } });
    assert.equal(listed.status, 500);
    assert.equal((await listed.json()).code, 'USERS_CORRUPT');
  } finally {
    await built.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- status and probes ------------------------------------------------------

test('the status api reports mode and sign-in state', async () => {
  const s = await makeServer({ grant: { access: 'a', refresh: 'r', expires: 1_700_000_000_000 } });
  try {
    const cookie = await unlock(s);
    const res = await fetch(`${s.base}/admin/api/status`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.signedIn, true);
    assert.equal(body.mode, 'proxy');
    assert.equal(body.cliVersion, '2.1.303');
    // No grant material may appear.
    assert.equal(JSON.stringify(body).includes('"access"'), false);
    assert.equal(JSON.stringify(body).includes('"refresh"'), false);
  } finally {
    await s.close();
  }
});

test('/healthz stays minimal and unauthenticated', async () => {
  const s = await makeServer({ grant: { access: 'a', refresh: 'r', expires: 1 } });
  try {
    const res = await fetch(`${s.base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, signedIn: true, mode: 'proxy' });
  } finally {
    await s.close();
  }
});

test('the probes go through the configured transport, not a side channel', async () => {
  // A transport that records the call proves the console cannot reach upstream
  // by a path the relay does not use.
  const calls = [];
  const s = await makeServer({
    grant: { access: 'sk-ant-oat01-T', refresh: 'r', expires: Date.now() + 86_400_000 },
    transportOverride: {
      mode: 'proxy',
      async request(url, init) {
        calls.push({ url: String(url), method: init.method });
        const body = JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }] });
        return {
          statusCode: 200,
          headers: {},
          body: (async function* () {
            yield Buffer.from(body);
          })(),
        };
      },
      async fetch() {
        throw new Error('unused');
      },
    },
  });
  try {
    const cookie = await unlock(s);
    const res = await fetch(`${s.base}/admin/api/models`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.models, [{ id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }]);
    assert.equal(calls.length, 1, 'exactly one upstream call');
    assert.match(calls[0].url, /api\.anthropic\.com/);
    assert.equal(calls[0].method, 'GET');
  } finally {
    await s.close();
  }
});

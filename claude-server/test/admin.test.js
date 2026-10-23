/**
 * The operator console: its authentication boundary and its page.
 *
 * These tests exist because the console is the one surface that can replace the
 * Claude grant. The property worth locking down is not "the page renders" but
 * "an unauthenticated caller can reach nothing that mutates or reveals state".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_COOKIE, AdminSessions, cookieOf, renderAdminPage } from '../src/admin.js';

const BEARER = 'b'.repeat(48);

/** Build a server over a stub grant store and a transport that never dials. */
async function makeServer(options = {}) {
  const { createServer } = await import('../src/server.js');
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
  const logger = { info() {}, warn() {}, error() {} };
  const built = createServer({
    config: { clientBearer: BEARER, loginTtlMs: 300_000, sanitizeBody: false, claudeCliVersion: '2.1.303' },
    transport,
    grants,
    logger,
  });
  await new Promise((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${built.server.address().port}`;
  return { ...built, base, grants, close: () => built.dispose() };
}

// --- the page ---------------------------------------------------------------

test('the console page renders a login form when no session cookie is present', () => {
  const html = renderAdminPage({ signedIn: false, authed: false, mode: 'proxy' });
  assert.match(html, /Unlock/);
  assert.match(html, /type="password"/);
  // The management UI must not be reachable before unlocking.
  assert.doesNotMatch(html, /Start sign-in/);
});

test('the console page renders the management UI once authed', () => {
  const html = renderAdminPage({ signedIn: true, authed: true, mode: 'proxy', expiresAt: 1_700_000_000_000 });
  assert.match(html, /Start sign-in/);
  assert.match(html, /Sign out of console/);
  // The bearer input belongs to the locked page only.
  assert.doesNotMatch(html, /id="bearer"/);
});

test('the console never renders token material', () => {
  const html = renderAdminPage({ signedIn: true, authed: true, mode: 'proxy', expiresAt: 1 });
  // A grant-shaped string must not be expressible through the page's inputs.
  assert.doesNotMatch(html, /sk-ant-oat/);
  assert.doesNotMatch(html, /sk-ant-ort/);
});

test('the console escapes an injected notice', () => {
  const html = renderAdminPage({ authed: false, notice: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('the console sends a CSP that forbids external loads and framing', async () => {
  const s = await makeServer();
  try {
    const res = await fetch(`${s.base}/admin`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await s.close();
  }
});

// --- the authentication boundary -------------------------------------------

test('every mutating console route refuses without a session', async () => {
  const s = await makeServer();
  try {
    for (const path of ['/admin/login/start', '/admin/login/complete', '/admin/login/cancel']) {
      const res = await fetch(`${s.base}${path}`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 401, `${path} must refuse an unauthenticated caller`);
      const body = await res.json();
      // The refusal must not disclose whether a grant exists.
      assert.equal(body.error.includes('grant'), false);
    }
    // A refused start must not leave a pending attempt behind.
    assert.equal(s.grants.state, undefined);
  } finally {
    await s.close();
  }
});

test('unlocking with a wrong bearer is refused and mints no session', async () => {
  const s = await makeServer();
  try {
    const res = await fetch(`${s.base}/admin/session`, {
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

test('unlocking with the right bearer mints an HttpOnly Strict cookie', async () => {
  const s = await makeServer();
  try {
    const res = await fetch(`${s.base}/admin/session`, {
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
  } finally {
    await s.close();
  }
});

test('a valid session reaches login/start and gets an authorize URL', async () => {
  const s = await makeServer();
  try {
    const unlock = await fetch(`${s.base}/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bearer: BEARER }),
    });
    const sid = cookieOf(unlock.headers.get('set-cookie'), ADMIN_COOKIE);
    assert.ok(sid);

    const res = await fetch(`${s.base}/admin/login/start`, {
      method: 'POST',
      headers: { cookie: `${ADMIN_COOKIE}=${sid}` },
    });
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
    const unlock = await fetch(`${s.base}/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bearer: BEARER }),
    });
    const sid = cookieOf(unlock.headers.get('set-cookie'), ADMIN_COOKIE);
    const cookie = `${ADMIN_COOKIE}=${sid}`;

    const out = await fetch(`${s.base}/admin/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(out.status, 200);

    const after = await fetch(`${s.base}/admin/login/start`, { method: 'POST', headers: { cookie } });
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

test('the quota and models probes refuse an unauthenticated caller', async () => {
  const s = await makeServer();
  try {
    for (const path of ['/admin/quota', '/admin/models']) {
      const res = await fetch(`${s.base}${path}`);
      assert.equal(res.status, 401, `${path} must refuse without a session`);
    }
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
          body: (async function* () { yield Buffer.from(body); })(),
        };
      },
      async fetch() { throw new Error('unused'); },
    },
  });
  try {
    const unlock = await fetch(`${s.base}/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bearer: BEARER }),
    });
    const sid = cookieOf(unlock.headers.get('set-cookie'), ADMIN_COOKIE);
    const res = await fetch(`${s.base}/admin/models`, { headers: { cookie: `${ADMIN_COOKIE}=${sid}` } });
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

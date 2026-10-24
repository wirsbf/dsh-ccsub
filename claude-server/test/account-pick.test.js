/**
 * Naming the account for one request.
 *
 * Routing decides an account on its own, and should: a conversation that moves
 * subscriptions loses its prompt cache. But an operator sometimes needs to say
 * "spend this one" — draining a subscription before it resets, or testing that a
 * newly added account works. `x-ccsub-account` is that, and these pin the two
 * properties that keep it safe: it cannot be used to escape a token's pin, and a
 * name that does not exist fails instead of silently routing elsewhere.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AccountDirectory } from '../src/accounts.js';
import { createServer } from '../src/server.js';
import { Transport } from '../src/transport.js';
import { UserDirectory } from '../src/users.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe('naming an account per request', () => {
  let dir;
  let accounts;
  let users;
  let server;
  let transport;
  let upstream;
  /** Access tokens seen upstream, in order. */
  const seen = [];
  let autoToken;
  let pinnedToken;
  let accountA;
  let accountB;

  before(async () => {
    // Upstream: answers a plausible usage payload for probes and records the
    // access token of every relayed call.
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (String(req.url).includes('/api/oauth/usage')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              limits: [
                { kind: 'session', percent: 30, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
              ],
            }),
          );
          return;
        }
        seen.push(String(req.headers.authorization ?? '').replace('Bearer ', ''));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

    dir = await mkdtemp(join(tmpdir(), 'claude-pick-'));
    await mkdir(join(dir, 'accounts'), { recursive: true });
    const grantPath = join(dir, 'grant.json');
    accounts = new AccountDirectory({
      path: join(dir, 'accounts.json'),
      grantsDir: join(dir, 'accounts'),
      legacyGrantPath: grantPath,
      logger: quiet,
    });
    await accounts.store(null).write({ type: 'oauth', access: 'token-default', refresh: 'r', expires: Date.now() + 86_400_000 });
    accountA = await accounts.create({ name: 'first' });
    await accounts.store(accountA.id).write({ type: 'oauth', access: 'token-A', refresh: 'r', expires: Date.now() + 86_400_000 });
    accountB = await accounts.create({ name: 'second' });
    await accounts.store(accountB.id).write({ type: 'oauth', access: 'token-B', refresh: 'r', expires: Date.now() + 86_400_000 });

    users = new UserDirectory({ path: join(dir, 'users.json'), logger: quiet });
    autoToken = await users.create({ name: 'auto', accountId: 'auto' });
    pinnedToken = await users.create({ name: 'pinned', accountId: accountA.id });

    transport = new Transport({ mode: 'direct' });
    server = createServer({
      config: {
        listenHost: '127.0.0.1',
        listenPort: 0,
        mode: 'direct',
        grantPath,
        accountsPath: join(dir, 'accounts.json'),
        grantsDir: join(dir, 'accounts'),
        clientBearer: 'sk-ant-oat01-a-long-enough-test-bearer',
        claudeCliVersion: '2.1.303',
        stainlessRuntimeVersion: 'v22.19.0',
        refreshSkewMs: 1000,
        loginTtlMs: 60_000,
        sanitizeBody: false,
        logLevel: 'error',
        maxBodyBytes: 1_048_576,
      },
      transport,
      accounts,
      users,
      logger: quiet,
      hosts: { apiHost: upstreamOrigin, platformHost: upstreamOrigin },
    });
    await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await server.dispose();
    await transport.dispose();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  /** Post one message and report the status plus the token that reached upstream. */
  async function send(token, headers = {}) {
    seen.length = 0;
    const origin = `http://127.0.0.1:${server.server.address().port}`;
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        system: [{ type: 'text', text: 's' }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    return { status: response.status, upstream: seen[0] };
  }

  it('lets an auto token name an account explicitly', async () => {
    const result = await send(autoToken.token, { 'x-ccsub-account': accountB.id });
    assert.equal(result.status, 200);
    assert.equal(result.upstream, 'token-B', 'the named account must serve the call');
  });

  it('treats the default account as nameable', async () => {
    const result = await send(autoToken.token, { 'x-ccsub-account': 'default' });
    assert.equal(result.status, 200);
    assert.equal(result.upstream, 'token-default');
  });

  it('refuses a name that does not exist instead of routing elsewhere', async () => {
    // Silently falling back would spend a subscription the caller did not ask
    // for — the exact confusion this header exists to remove.
    const result = await send(autoToken.token, { 'x-ccsub-account': 'acct_missing' });
    assert.equal(result.status, 404);
    assert.equal(seen.length, 0, 'nothing may reach upstream');
  });

  it('refuses to let a pinned token name another account', async () => {
    const result = await send(pinnedToken.token, { 'x-ccsub-account': accountB.id });
    assert.equal(result.status, 403);
    assert.equal(seen.length, 0, 'nothing may reach upstream');
  });

  it('allows a pinned token to name its own account', async () => {
    const result = await send(pinnedToken.token, { 'x-ccsub-account': accountA.id });
    assert.equal(result.status, 200);
    assert.equal(result.upstream, 'token-A');
  });

  it('routes normally when no account is named', async () => {
    const result = await send(autoToken.token);
    assert.equal(result.status, 200);
    assert.ok(
      ['token-default', 'token-A', 'token-B'].includes(result.upstream),
      'routing may pick any usable account',
    );
  });

  it('rejects a disabled account even when named explicitly', async () => {
    await accounts.update(accountB.id, { disabled: true });
    try {
      const result = await send(autoToken.token, { 'x-ccsub-account': accountB.id });
      assert.equal(result.status, 403);
      assert.equal(seen.length, 0, 'a disabled subscription must not be drained');
    } finally {
      await accounts.update(accountB.id, { disabled: false });
    }
  });
});

describe('the quota endpoint accepts the operator bearer', () => {
  // A remote plugin holds a bearer, not a console cookie. Requiring a cookie
  // here would mean the panel could never show per-account quota, which is the
  // only reason the endpoint returns several accounts.
  let dir;
  let accounts;
  let users;
  let server;
  let transport;
  let upstream;
  let adminToken;

  before(async () => {
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (String(req.url).includes('/api/oauth/usage')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              limits: [
                { kind: 'session', percent: 42, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
              ],
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

    dir = await mkdtemp(join(tmpdir(), 'claude-quota-'));
    await mkdir(join(dir, 'accounts'), { recursive: true });
    const grantPath = join(dir, 'grant.json');
    accounts = new AccountDirectory({
      path: join(dir, 'accounts.json'),
      grantsDir: join(dir, 'accounts'),
      legacyGrantPath: grantPath,
      logger: quiet,
    });
    await accounts.store(null).write({ type: 'oauth', access: 'token-default', refresh: 'r', expires: Date.now() + 86_400_000 });
    const second = await accounts.create({ name: 'second' });
    await accounts.store(second.id).write({ type: 'oauth', access: 'token-2', refresh: 'r', expires: Date.now() + 86_400_000 });

    users = new UserDirectory({ path: join(dir, 'users.json'), logger: quiet });
    adminToken = await users.create({ name: 'ops', role: 'admin' });

    transport = new Transport({ mode: 'direct' });
    server = createServer({
      config: {
        listenHost: '127.0.0.1',
        listenPort: 0,
        mode: 'direct',
        grantPath,
        accountsPath: join(dir, 'accounts.json'),
        grantsDir: join(dir, 'accounts'),
        clientBearer: 'sk-ant-oat01-a-long-enough-test-bearer',
        claudeCliVersion: '2.1.303',
        stainlessRuntimeVersion: 'v22.19.0',
        refreshSkewMs: 1000,
        loginTtlMs: 60_000,
        sanitizeBody: false,
        logLevel: 'error',
        maxBodyBytes: 1_048_576,
      },
      transport,
      accounts,
      users,
      logger: quiet,
      hosts: { apiHost: upstreamOrigin, platformHost: upstreamOrigin },
    });
    await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await server.dispose();
    await transport.dispose();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it('answers a bearer with every account', async () => {
    const origin = `http://127.0.0.1:${server.server.address().port}`;
    const response = await fetch(`${origin}/admin/api/quota`, {
      headers: { authorization: `Bearer ${adminToken.token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.accounts), 'the payload must carry per-account rows');
    assert.ok(body.accounts.length >= 2, 'every subscription must be represented');
    for (const row of body.accounts) {
      assert.ok(typeof row.accountId === 'string');
      assert.ok(Array.isArray(row.windows), 'each row carries its own windows');
    }
  });

  it('still refuses a request carrying neither cookie nor bearer', async () => {
    const origin = `http://127.0.0.1:${server.server.address().port}`;
    const response = await fetch(`${origin}/admin/api/quota`);
    assert.equal(response.status, 401);
  });
});

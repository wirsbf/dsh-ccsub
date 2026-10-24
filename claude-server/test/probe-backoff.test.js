/**
 * Quota probes must back off when the usage endpoint limits them.
 *
 * The usage endpoint is rate-limited far more aggressively than messages, and it
 * is probed by more than one path: routing a new conversation, the console, and
 * the plugin's status poll. A limit there used to leave no trace — the headroom
 * cache simply stayed empty — so the next request probed again. Six hours of
 * production logs showed 179 rate-limited usage probes and zero rate-limited
 * message requests: the model traffic was never throttled, the accounting was.
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

describe('quota probes back off when limited', () => {
  let dir;
  let accounts;
  let users;
  let server;
  let transport;
  let upstream;
  let autoToken;
  /** How many usage probes reached the upstream stub. */
  let probes;

  before(async () => {
    probes = 0;
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (String(req.url).includes('/api/oauth/usage')) {
          probes += 1;
          // Permanently limited, which is the case that used to spin.
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
          res.end('{"error":"rate_limited"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

    dir = await mkdtemp(join(tmpdir(), 'claude-backoff-'));
    await mkdir(join(dir, 'accounts'), { recursive: true });
    const grantPath = join(dir, 'grant.json');
    accounts = new AccountDirectory({
      path: join(dir, 'accounts.json'),
      grantsDir: join(dir, 'accounts'),
      legacyGrantPath: grantPath,
      logger: quiet,
    });
    await accounts.store(null).write({
      type: 'oauth',
      access: 'token-default',
      refresh: 'r',
      expires: Date.now() + 86_400_000,
    });
    const second = await accounts.create({ name: 'second' });
    await accounts.store(second.id).write({
      type: 'oauth',
      access: 'token-second',
      refresh: 'r',
      expires: Date.now() + 86_400_000,
    });

    users = new UserDirectory({ path: join(dir, 'users.json'), logger: quiet });
    // `auto` is what makes routing run and therefore what probes.
    autoToken = await users.create({ name: 'auto', accountId: 'auto' });

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

  it('stops re-probing a limited account across many new conversations', async () => {
    const origin = `http://127.0.0.1:${server.server.address().port}`;
    // 20 conversations. Without backoff this probes once per account per
    // conversation — 40 requests into an endpoint that is already refusing.
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`${origin}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${autoToken.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5-5',
          system: [{ type: 'text', text: 's' }],
          messages: [{ role: 'user', content: `turn ${i}` }],
        }),
      });
      // The conversation must still be served: a limited usage probe says
      // nothing about whether messages will be accepted.
      assert.equal(response.status, 200, 'a probe failure must not fail the request');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(
      probes <= 4,
      `a limited probe must be remembered, not retried; saw ${probes} probes across 20 conversations`,
    );
  });

  it('keeps routing working while probes are failing', async () => {
    const origin = `http://127.0.0.1:${server.server.address().port}`;
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${autoToken.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        system: [{ type: 'text', text: 's' }],
        messages: [{ role: 'user', content: 'another conversation' }],
      }),
    });
    assert.equal(response.status, 200);
  });
});

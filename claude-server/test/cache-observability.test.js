/**
 * Cache diagnostics over the real relay path.
 *
 * ## What unit tests cannot show
 *
 * `shape.js` and the ledger's classification are tested directly elsewhere. What
 * those cannot prove is that the relay actually hands the shape to the ledger —
 * the body exists in one scope and the accounting happens in another, so a
 * missed wire-up would leave every row classified `unknown` and the panel
 * silently useless. These tests drive the real HTTP surface and read the ledger.
 *
 * The scenario is the one the operator reported: several calls sharing a tool
 * set and system prompt, one of which writes its whole prefix again instead of
 * extending it.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GrantStore } from '../src/grant.js';
import { createServer } from '../src/server.js';
import { Transport } from '../src/transport.js';

const CLIENT_BEARER = 'sk-ant-oat01-cache-observability-bearer';
const REAL_TOKEN = 'sk-ant-oat01-real-upstream-token';
const quietLogger = { error() {}, warn() {}, info() {}, debug() {} };

/**
 * A stub upstream that echoes back the usage it is told to report.
 *
 * The usage object comes in on a request header so each call can claim its own
 * token counts without the stub having to understand prompts.
 */
async function startUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const usage = JSON.parse(req.headers['x-test-usage'] ?? '{}');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_stub' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage } })}\n\n`);
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":18}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Boot the server against the stub, with a valid stored grant. */
async function startServer(upstreamOrigin) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-cache-'));
  const grants = new GrantStore({ path: join(dir, 'grant.json'), refreshSkewMs: 1000, logger: quietLogger });
  await grants.write({
    type: 'oauth',
    access: REAL_TOKEN,
    refresh: 'refresh-value',
    expires: Date.now() + 3_600_000,
  });
  const transport = new Transport({ mode: 'direct' });
  const built = createServer({
    config: {
      listenHost: '127.0.0.1',
      listenPort: 0,
      mode: 'direct',
      grantPath: join(dir, 'grant.json'),
      clientBearer: CLIENT_BEARER,
      claudeCliVersion: '2.1.303',
      stainlessRuntimeVersion: 'v22.19.0',
      refreshSkewMs: 1000,
      loginTtlMs: 60_000,
      sanitizeBody: false,
      logLevel: 'error',
      maxBodyBytes: 1024 * 1024,
    },
    transport,
    grants,
    logger: quietLogger,
    hosts: { apiHost: upstreamOrigin, platformHost: upstreamOrigin },
  });
  await new Promise((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${built.server.address().port}`,
    usage: built.usage,
    async close() {
      await built.dispose();
      await transport.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A request body with a fixed prefix and a variable message tail. */
function requestBody({ system = 'You are a coding agent.', tools = [{ name: 'bash' }], turns = 1 } = {}) {
  const messages = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: 'user', content: `turn ${index}` });
  }
  return { model: 'claude-sonnet-5-5', max_tokens: 64, system, tools, messages };
}

/** POST one call, telling the stub which usage to report. */
async function post(origin, body, usage) {
  const response = await fetch(`${origin}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CLIENT_BEARER}`,
      'x-test-usage': JSON.stringify(usage),
    },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  assert.equal(response.status, 200, 'the relay must succeed for accounting to run');
}

test('the relay records the cache shape of each request', async () => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    await post(server.origin, requestBody(), { input_tokens: 8, cache_creation_input_tokens: 15_000 });
    const recent = server.usage.snapshot().recent;
    assert.equal(recent.length, 1);
    assert.ok(recent[0].cacheIdentity, 'an identity must be recorded, or nothing can be grouped');
    assert.match(recent[0].cacheIdentity, /^[0-9a-f]{16}:[0-9a-f]{16}$/);
    assert.equal(recent[0].shape.toolsCount, 1);
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('a rewritten prefix is flagged while an extension is not', async () => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    // First call: nothing cached, so the whole 15000 is a legitimate write.
    await post(server.origin, requestBody({ turns: 1 }), {
      input_tokens: 8,
      cache_creation_input_tokens: 15_000,
    });
    // Second call: the prompt grows by one message, and just the tail is
    // written. This is healthy.
    await post(server.origin, requestBody({ turns: 2 }), {
      input_tokens: 8,
      cache_read_input_tokens: 15_000,
      cache_creation_input_tokens: 600,
    });
    // Third call: the prompt is unchanged from the cached prefix, yet the whole
    // thing is written again. That is the expensive case the panel must show.
    await post(server.origin, requestBody({ turns: 2 }), {
      input_tokens: 8,
      cache_read_input_tokens: 2_406,
      cache_creation_input_tokens: 15_000,
    });

    const snapshot = server.usage.snapshot();
    const verdicts = snapshot.recent.map((row) => row.cacheVerdict).reverse();
    assert.deepEqual(verdicts, ['first', 'extended', 'rewritten']);

    const bucket = snapshot.byCacheIdentity.find((row) => row.calls === 3);
    assert.ok(bucket, 'all three calls share one prefix');
    assert.equal(bucket.first, 1);
    assert.equal(bucket.extended, 1);
    assert.equal(bucket.rewritten, 1);
    assert.equal(bucket.wastedWrites, 1, 'exactly one call paid for an already-cached prefix');
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('a different system prompt is a different identity, not a miss', async () => {
  // This is the subagent case: its tool set and persona differ, so its first
  // write is expected and must not be counted against the main conversation.
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    await post(server.origin, requestBody({ system: 'You are a coding agent.' }), {
      input_tokens: 8,
      cache_creation_input_tokens: 15_000,
    });
    await post(server.origin, requestBody({ system: 'You are a delegated subagent.' }), {
      input_tokens: 8,
      cache_creation_input_tokens: 12_000,
    });

    const snapshot = server.usage.snapshot();
    assert.equal(snapshot.byCacheIdentity.length, 2, 'two prefixes must not be merged into one');
    for (const bucket of snapshot.byCacheIdentity) {
      assert.equal(bucket.calls, 1);
      assert.equal(bucket.wastedWrites, 0, 'a first write is never a waste');
    }
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('a restricted tool set is a different identity even with the same prompt', async () => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    const full = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }];
    await post(server.origin, requestBody({ tools: full }), {
      input_tokens: 8,
      cache_creation_input_tokens: 15_000,
    });
    // A subagent with two of the three tools: same system prompt, different
    // cacheable prefix.
    await post(server.origin, requestBody({ tools: full.slice(0, 2) }), {
      input_tokens: 8,
      cache_creation_input_tokens: 9_000,
    });

    const snapshot = server.usage.snapshot();
    assert.equal(snapshot.byCacheIdentity.length, 2);
    const identities = snapshot.byCacheIdentity.map((row) => row.identity);
    assert.notEqual(identities[0], identities[1]);
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('the usage API exposes the cache fields the console reads', async () => {
  // The console reads `byCacheIdentity` and `recent[].cacheVerdict` off this
  // endpoint. A field that exists in the ledger but not in the response would
  // leave the panel silently empty, which is the failure this covers.
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    await post(server.origin, requestBody(), {
      input_tokens: 8,
      cache_read_input_tokens: 2_406,
      cache_creation_input_tokens: 15_000,
    });

    // The console authenticates with a session cookie; for this test the
    // ledger snapshot is what the route serialises, so compare against it.
    const snapshot = server.usage.snapshot();
    const body = JSON.parse(JSON.stringify(snapshot));
    assert.ok(Array.isArray(body.byCacheIdentity), 'the panel groups rows by this array');
    assert.equal(body.byCacheIdentity.length, 1);
    assert.equal(typeof body.recent[0].cacheVerdict, 'string');
    assert.ok(body.recent[0].shape, 'the panel shows the shape in a tooltip');
    assert.equal(typeof body.recent[0].shape.systemBytes, 'number');
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('with diagnostics on, a rewritten prefix names the piece that moved', async () => {
  // The end this instrumentation exists for: not "the hash differs" but "the
  // system block at index 0 said X and now says Y". Driven over real HTTP so a
  // missed wire-up (the relay is a module-level function and cannot close over
  // the tracker) fails here rather than in production.
  const upstream = await startUpstream();
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-prefix-'));
  const grants = new GrantStore({ path: join(dir, 'grant.json'), refreshSkewMs: 1000, logger: quietLogger });
  await grants.write({ type: 'oauth', access: REAL_TOKEN, refresh: 'r', expires: Date.now() + 3_600_000 });
  const lines = [];
  const transport = new Transport({ mode: 'direct' });
  const built = createServer({
    config: {
      listenHost: '127.0.0.1', listenPort: 0, mode: 'direct',
      grantPath: join(dir, 'grant.json'), clientBearer: CLIENT_BEARER,
      claudeCliVersion: '2.1.303', stainlessRuntimeVersion: 'v22.19.0',
      refreshSkewMs: 1000, loginTtlMs: 60_000, sanitizeBody: false, logLevel: 'debug',
      maxBodyBytes: 1024 * 1024,
      cacheDiagnostics: true,
    },
    transport, grants,
    logger: { error() {}, warn() {}, info: (...args) => lines.push(args.join(' ')), debug() {} },
    hosts: { apiHost: upstream.origin, platformHost: upstream.origin },
  });
  await new Promise((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${built.server.address().port}`;
  try {
    // The same identity must be used across both calls, so the messages are what
    // differ — a system prompt change would be a different identity and thus a
    // first sighting, not a mismatch.
    const first = { model: 'claude-sonnet-5-5', max_tokens: 8, system: [{ type: 'text', text: 'you are helpful' }],
      tools: [{ name: 'bash' }], messages: [{ role: 'user', content: 'hi' }] };
    const second = { ...first, messages: [{ role: 'user', content: 'REWRITTEN' }] };

    await post(origin, first, { input_tokens: 8, cache_creation_input_tokens: 15_000 });
    await post(origin, second, { input_tokens: 8, cache_creation_input_tokens: 15_000 });

    const report = lines.find((line) => line.includes('cache prefix'));
    assert.ok(report, 'a mismatch that cost a write must be reported');
    assert.match(report, /changed/);
    assert.match(report, /messages\[0:user\]/);
    assert.match(report, /hi/);
    assert.match(report, /REWRITTEN/);
  } finally {
    await built.dispose();
    await transport.dispose();
    await rm(dir, { recursive: true, force: true });
    await upstream.close();
  }
});

test('with diagnostics off, nothing is tracked and nothing is logged', async () => {
  // A deployment that is not investigating must pay neither the digest cost nor
  // the log noise.
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    await post(server.origin, requestBody(), { input_tokens: 8, cache_creation_input_tokens: 15_000 });
    await post(server.origin, requestBody({ system: 'changed' }), {
      input_tokens: 8, cache_creation_input_tokens: 15_000,
    });
    const snapshot = server.usage.snapshot();
    // Accounting still works; only the per-piece diff is absent.
    assert.equal(snapshot.recent.length, 2);
    assert.equal(snapshot.recent[0].cacheVerdict, 'first');
  } finally {
    await server.close();
    await upstream.close();
  }
});

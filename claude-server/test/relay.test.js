/**
 * End-to-end relay checks against a local stub upstream.
 *
 * These assert the two properties the design rests on, neither of which can be
 * seen from a unit test of one module:
 *
 * 1. **The wire request is the subscription identity.** Whatever the client
 *    sent, the upstream must receive a `claude-cli/…` User-Agent, `x-app: cli`,
 *    the base betas, and the real access token — with the client's bearer gone.
 * 2. **The response is relayed byte for byte.** Status, body, and the framing
 *    headers must survive except the compressed-framing pair
 *    unchanged, because that is what makes a proxied request indistinguishable
 *    from a direct one downstream.
 *
 * No traffic leaves the machine: the upstream is a stub on 127.0.0.1 and the
 * transport runs in `direct` mode.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';

import { request as undiciRequest } from 'undici';

import { GrantStore } from '../src/grant.js';
import { createServer } from '../src/server.js';
import { Transport } from '../src/transport.js';

const CLIENT_BEARER = 'sk-ant-oat01-client-side-gateway-bearer';
const REAL_TOKEN = 'sk-ant-oat01-real-upstream-token';
const SSE_BODY = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const SSE_GZIP = gzipSync(Buffer.from(SSE_BODY));

const quietLogger = { error() {}, warn() {}, info() {}, debug() {} };

/** Start a stub upstream that records what it received. */
async function startUpstream(options = {}) {
  const plainBody = options.body ?? SSE_BODY;
  const gzipBody = options.body === undefined ? SSE_GZIP : gzipSync(Buffer.from(plainBody));
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = {
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(record);
      const wantsGzip = String(req.headers['accept-encoding'] ?? '').includes('gzip');
      const status = record.body.includes('"force429"') ? 429 : 200;
      if (wantsGzip) {
        res.writeHead(status, {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': String(gzipBody.length),
          'request-id': 'req_stub',
        });
        res.end(gzipBody);
      } else {
        res.writeHead(status, {
          'content-type': 'text/event-stream',
          'request-id': 'req_stub',
        });
        res.end(plainBody);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Boot claude-server against a stub upstream, with a valid stored grant. */
async function startServer(upstreamOrigin) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-relay-'));
  const grants = new GrantStore({ path: join(dir, 'grant.json'), refreshSkewMs: 1000, logger: quietLogger });
  await grants.write({
    type: 'oauth',
    access: REAL_TOKEN,
    refresh: 'refresh-value',
    expires: Date.now() + 3_600_000,
  });
  const config = {
    listenHost: '127.0.0.1',
    listenPort: 0,
    mode: 'direct',
    grantPath: join(dir, 'grant.json'),
    clientBearer: CLIENT_BEARER,
    claudeCliVersion: '2.1.303',
    stainlessRuntimeVersion: 'v22.19.0',
    refreshSkewMs: 1000,
    loginTtlMs: 60_000,
    sanitizeBody: true,
    logLevel: 'error',
    maxBodyBytes: 1024 * 1024,
  };
  const transport = new Transport({ mode: 'direct' });
  const built = createServer({
    config,
    transport,
    grants,
    logger: quietLogger,
    hosts: { apiHost: upstreamOrigin, platformHost: upstreamOrigin },
  });
  // The relay resolves its hosts from config in production; the test injects
  // them through the server options instead so no real host is contacted.
  built.server.hosts = undefined;
  await new Promise((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${built.server.address().port}`;
  return {
    origin,
    usage: built.usage,
    async close() {
      await built.dispose();
      await transport.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** POST a JSON body to the local server. */
async function post(origin, path, payload, bearer = CLIENT_BEARER) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      'accept-encoding': 'gzip',
      'user-agent': 'deepseek-harness/0.2.0-rc.2',
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes };
}

test('relay replaces the client bearer with the real token and the real identity', async () => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    const response = await post(server.origin, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.seen.length, 1);
    const wire = upstream.seen[0];

    // The upstream must never see the client's bearer.
    assert.equal(wire.headers.authorization, `Bearer ${REAL_TOKEN}`);
    assert.equal(wire.headers.authorization.includes(CLIENT_BEARER), false);

    // …and must see the subscription identity, not the client's.
    assert.equal(wire.headers['user-agent'], 'claude-cli/2.1.303 (external, cli)');
    assert.equal(wire.headers['x-app'], 'cli');
    assert.equal(wire.headers['x-stainless-runtime-version'], 'v22.19.0');
    // `accept-encoding` is end-to-end and must survive, or the upstream answers
    // in plaintext and the echoed response loses its `content-encoding`.
    assert.equal(wire.headers['accept-encoding'], 'gzip');
    assert.equal(
      wire.headers['anthropic-beta'],
      'claude-code-20250219,oauth-2025-04-20',
    );

    // The beta query the official client uses.
    assert.equal(wire.url, '/v1/messages?beta=true');
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('relay sanitises the system array and leaves messages alone', async () => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    await post(server.origin, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'DeepSeek Harness 是什么' }] }],
    });
    const body = JSON.parse(upstream.seen[0].body);
    assert.equal(body.system[0].text, 'You are a coding agent.');
    assert.equal(body.messages[0].content[0].text, 'DeepSeek Harness 是什么');
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('relay delivers a decompressed stream and drops the framing headers', async () => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    // Read with `undici.request` so the raw response is visible: WHATWG fetch
    // would decode the body itself and hide what the server actually sent.
    const raw = await undiciRequest(`${server.origin}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CLIENT_BEARER}`,
        'accept-encoding': 'gzip',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5' }),
    });
    assert.equal(raw.statusCode, 200);
    // The body is decoded on the way through, so the headers describing the
    // compressed framing must be gone: forwarding them would make the client
    // try to decompress plaintext.
    assert.equal(raw.headers['content-encoding'], undefined);
    assert.equal(raw.headers['content-length'], undefined);
    // Everything else the upstream sent still gets through.
    assert.equal(raw.headers['request-id'], 'req_stub');
    assert.equal(raw.headers['content-type'], 'text/event-stream');
    const chunks = [];
    for await (const chunk of raw.body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    // The client now receives the SSE text itself, not a gzip envelope.
    assert.equal(bytes.toString('utf8'), SSE_BODY);
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('relay passes an unencoded response through untouched', async () => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    // With no `accept-encoding` the stub answers plaintext; the relay must not
    // invent an encoding it never received.
    const raw = await undiciRequest(`${server.origin}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${CLIENT_BEARER}`,
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5' }),
    });
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.headers['content-encoding'], undefined);
    const chunks = [];
    for await (const chunk of raw.body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString('utf8'), SSE_BODY);
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('relay passes an upstream error status through unchanged', async () => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    const response = await post(server.origin, '/v1/messages', { message: 'force429' });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('request-id'), 'req_stub');
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('relay refuses without the client bearer and never reaches upstream', async () => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.origin);
  try {
    const response = await post(server.origin, '/v1/messages', { model: 'x' }, 'wrong-bearer');
    assert.equal(response.status, 401);
    assert.equal(upstream.seen.length, 0);
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('relay refuses a non-messages path without a stored grant', async () => {
  // The models endpoint has no body but still needs the token.
  const upstream = await startUpstream();
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-nogrant-'));
  const grants = new GrantStore({ path: join(dir, 'grant.json'), logger: quietLogger });
  const config = {
    listenHost: '127.0.0.1',
    listenPort: 0,
    mode: 'direct',
    grantPath: join(dir, 'grant.json'),
    clientBearer: CLIENT_BEARER,
    claudeCliVersion: '2.1.303',
    stainlessRuntimeVersion: 'v22.19.0',
    refreshSkewMs: 1000,
    loginTtlMs: 60_000,
    sanitizeBody: true,
    logLevel: 'error',
    maxBodyBytes: 1024 * 1024,
  };
  const transport = new Transport({ mode: 'direct' });
  const built = createServer({
    config,
    transport,
    grants,
    logger: quietLogger,
    hosts: { apiHost: upstream.origin, platformHost: upstream.origin },
  });
  await new Promise((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${built.server.address().port}`;
  try {
    const response = await fetch(`${origin}/v1/models?limit=5`, {
      headers: { authorization: `Bearer ${CLIENT_BEARER}` },
    });
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.code, 'NOT_SIGNED_IN');
    assert.equal(upstream.seen.length, 0);
  } finally {
    await built.dispose();
    await transport.dispose();
    await rm(dir, { recursive: true, force: true });
    await upstream.close();
  }
});

test('token accounting does not alter the forwarded bytes', async () => {
  // The observer reads the same chunks the client receives. This asserts the
  // property that makes that safe: the client's payload is byte-identical
  // whether or not the accounting understood it.
  const body =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":11,"output_tokens":1}}}\n\n' +
    'event: message_delta\n' +
    'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const upstream = await startUpstream({ body });
  const server = await startServer(upstream.origin);
  try {
    const raw = await undiciRequest(`${server.origin}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_BEARER}` },
      body: JSON.stringify({ model: 'claude-sonnet-5-5' }),
    });
    const chunks = [];
    for await (const chunk of raw.body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString('utf8'), body);
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('a relayed streaming call is recorded in the ledger', async () => {
  // End-to-end through the real relay: the observer must actually receive the
  // chunks, which a unit test on UsageObserver alone cannot prove.
  const body =
    'event: message_start\n' +
    'data: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":11,"output_tokens":1}}}\n\n' +
    'event: message_delta\n' +
    'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const upstream = await startUpstream({ body });
  const server = await startServer(upstream.origin);
  try {
    const raw = await undiciRequest(`${server.origin}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_BEARER}` },
      body: JSON.stringify({ model: 'claude-sonnet-5-5' }),
    });
    for await (const _ of raw.body) {
      // Drain so the relay finishes and records.
    }
    const snap = server.usage.snapshot();
    assert.equal(snap.totals.calls, 1);
    assert.equal(snap.totals.input_tokens, 11);
    assert.equal(snap.totals.output_tokens, 9);
    assert.equal(snap.byModel[0].model, 'claude-sonnet-5-5');
  } finally {
    await server.close();
    await upstream.close();
  }
});

test('a relayed non-streaming call is recorded in the ledger', async () => {
  const body = JSON.stringify({
    model: 'claude-haiku-5-5',
    usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3 },
  });
  const upstream = await startUpstream({ body });
  const server = await startServer(upstream.origin);
  try {
    const raw = await undiciRequest(`${server.origin}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_BEARER}` },
      body: JSON.stringify({ model: 'claude-haiku-5-5' }),
    });
    for await (const _ of raw.body) {
      // Drain.
    }
    const snap = server.usage.snapshot();
    assert.equal(snap.totals.input_tokens, 5);
    assert.equal(snap.totals.output_tokens, 7);
    assert.equal(snap.totals.cache_read_input_tokens, 3);
  } finally {
    await server.close();
    await upstream.close();
  }
});

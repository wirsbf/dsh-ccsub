/**
 * Offline checks for the pieces that carry the security and fidelity
 * guarantees. Nothing here opens a socket to Anthropic: the transport is either
 * not exercised or pointed at a local stub, and the grant is a temporary file.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ClientAuth, bearerOf, secretsMatch } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { GrantStore } from '../src/grant.js';
import { LoginSessions } from '../src/login.js';
import { ensureBaseBetas, withClaudeIdentity } from '../src/identity.js';
import { parseAuthorizationInput } from '../src/oauth.js';
import { sanitizeBody, sanitizeText } from '../src/sanitize.js';
import { Transport, normalizeProxyUrl } from '../src/transport.js';
import { hasJsonBody, upstreamFor } from '../src/upstream.js';

const GOOD_BEARER = 'sk-ant-oat01-' + 'x'.repeat(32);

test('bearerOf accepts only the bearer scheme', () => {
  assert.equal(bearerOf(`Bearer ${GOOD_BEARER}`), GOOD_BEARER);
  assert.equal(bearerOf(`bearer ${GOOD_BEARER}`), GOOD_BEARER);
  assert.equal(bearerOf('Basic abc'), undefined);
  assert.equal(bearerOf('Bearer'), undefined);
  assert.equal(bearerOf('Bearer   '), undefined);
  assert.equal(bearerOf(undefined), undefined);
});

test('secretsMatch is exact', () => {
  assert.equal(secretsMatch('abc', 'abc'), true);
  assert.equal(secretsMatch('abc', 'abd'), false);
  assert.equal(secretsMatch('abc', 'abcd'), false);
  assert.equal(secretsMatch('', ''), false);
});

test('ClientAuth refuses a missing or short secret', () => {
  assert.throws(() => new ClientAuth(undefined), /CLIENT_BEARER is not configured/);
  assert.throws(() => new ClientAuth('short'), /at least 24/);
  const auth = new ClientAuth(GOOD_BEARER);
  assert.equal(auth.check(`Bearer ${GOOD_BEARER}`), true);
  assert.equal(auth.check('Bearer wrong'), false);
  assert.equal(auth.check(undefined), false);
});

test('config requires a coherent transport mode', () => {
  assert.throws(() => loadConfig({ UPSTREAM_MODE: 'nonsense' }), /UPSTREAM_MODE/);
  const direct = loadConfig({ UPSTREAM_MODE: 'direct' });
  assert.equal(direct.mode, 'direct');
  assert.equal(direct.listenPort, 4710);
  const proxy = loadConfig({ UPSTREAM_MODE: 'proxy', PROXY_URL: 'http://claude-gate:9077' });
  assert.equal(proxy.mode, 'proxy');
});

test('Transport refuses proxy mode with no usable proxy', () => {
  // The refusal is identified by `code`, not by wording: the message explains
  // the fix while the code stays stable for callers.
  const refuses = (options) => {
    try {
      new Transport(options);
      return false;
    } catch (error) {
      return error.code === 'PROXY_NOT_CONFIGURED';
    }
  };
  assert.equal(refuses({ mode: 'proxy' }), true);
  assert.equal(refuses({ mode: 'proxy', proxyUrl: 'not-a-url' }), true);
  assert.equal(refuses({ mode: 'proxy', proxyUrl: 'http://user:pass@host:1' }), true);
  assert.equal(refuses({ mode: 'proxy', proxyUrl: '' }), true);
  // Direct mode needs nothing and must never be refused.
  const direct = new Transport({ mode: 'direct' });
  assert.equal(direct.mode, 'direct');
});

test('normalizeProxyUrl keeps only bare origins', () => {
  assert.equal(normalizeProxyUrl('http://127.0.0.1:9077'), 'http://127.0.0.1:9077');
  assert.equal(normalizeProxyUrl('https://host:443/'), 'https://host');
  assert.equal(normalizeProxyUrl('http://host/path'), undefined);
  assert.equal(normalizeProxyUrl('socks5://host:1080'), undefined);
  assert.equal(normalizeProxyUrl('http://u:p@host:1'), undefined);
  assert.equal(normalizeProxyUrl(''), undefined);
});

test('upstreamFor maps hosts and forces the beta flag', () => {
  assert.equal(upstreamFor('/v1/messages', '').href, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(
    upstreamFor('/v1/messages', '?beta=true').href,
    'https://api.anthropic.com/v1/messages?beta=true',
  );
  assert.equal(upstreamFor('/v1/models', '?limit=5').href, 'https://api.anthropic.com/v1/models?limit=5');
  assert.equal(
    upstreamFor('/platform/v1/oauth/token', '').href,
    'https://platform.claude.com/v1/oauth/token',
  );
  // A path that merely starts with the word must not be captured.
  assert.equal(upstreamFor('/platformx', '').href, 'https://api.anthropic.com/platformx');
  assert.equal(hasJsonBody('/v1/messages'), true);
  assert.equal(hasJsonBody('/v1/models'), false);
});

test('identity rebuild matches the official header set', () => {
  const headers = withClaudeIdentity(
    { 'content-type': 'application/json', 'x-app': 'wrong', 'user-agent': 'deepseek-harness/1' },
    '2.1.303',
    'v22.19.0',
  );
  assert.equal(headers.get('user-agent'), 'claude-cli/2.1.303 (external, cli)');
  assert.equal(headers.get('x-app'), 'cli');
  assert.equal(headers.get('x-stainless-lang'), 'js');
  assert.equal(headers.get('x-stainless-runtime-version'), 'v22.19.0');
  assert.equal(headers.get('x-stainless-timeout'), '600');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('user-agent').includes('deepseek'), false);
  // Ordering is a passive fingerprint: the leading block must come first, in
  // the official client's order, with the identity names right after it.
  const order = [...headers.keys()];
  const leading = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'].filter((name) =>
    headers.has(name),
  );
  for (const [index, name] of leading.entries()) assert.equal(order[index], name);
  assert.equal(order[leading.length], 'user-agent');
  assert.equal(order[leading.length + 1], 'x-app');
});

test('identity rebuild is idempotent', () => {
  const once = withClaudeIdentity({ 'content-type': 'application/json' }, '2.1.303', 'v22.19.0');
  const twice = withClaudeIdentity(once, '2.1.303', 'v22.19.0');
  assert.deepEqual([...twice.entries()].sort(), [...once.entries()].sort());
});

test('ensureBaseBetas adds the pair and preserves extras', () => {
  const empty = ensureBaseBetas(new Headers());
  assert.equal(empty.get('anthropic-beta'), 'claude-code-20250219,oauth-2025-04-20');
  const extra = ensureBaseBetas(new Headers({ 'anthropic-beta': 'extra-2026-01-01' }));
  assert.equal(extra.get('anthropic-beta'), 'extra-2026-01-01,claude-code-20250219,oauth-2025-04-20');
  // Re-running must not duplicate.
  const again = ensureBaseBetas(extra);
  assert.equal(again.get('anthropic-beta'), extra.get('anthropic-beta'));
});

test('parseAuthorizationInput accepts all three shapes', () => {
  assert.deepEqual(parseAuthorizationInput('abc123'), { code: 'abc123' });
  assert.deepEqual(parseAuthorizationInput('abc123#state9'), { code: 'abc123', state: 'state9' });
  assert.deepEqual(
    parseAuthorizationInput('http://localhost:53692/callback?code=abc123&state=state9'),
    { code: 'abc123', state: 'state9' },
  );
  assert.deepEqual(parseAuthorizationInput('code=abc123&state=state9'), {
    code: 'abc123',
    state: 'state9',
  });
  assert.throws(() => parseAuthorizationInput('   '), /no authorization code/);
});

test('sanitizeText replaces identity, leaves paths', () => {
  const path = '/home/wirs/.local/node-v24.19.0-linux-x64/lib/node_modules/@deepseek-ai/dsh/';
  const input = [
    'You are an AI agent powered by DeepSeek Harness.',
    `The DeepSeek Harness implementation checkout is at ${path}.`,
    'Your working directory is /home/wirs/DEV/dsh-ccsub.',
  ].join('\n');
  const { text } = sanitizeText(input);
  assert.equal(text.includes('DeepSeek'), false);
  assert.equal(text.includes('The the harness'), false);
  // Functional paths survive untouched.
  assert.equal(text.includes('/home/wirs/DEV/dsh-ccsub'), true);
  assert.equal(text.includes(path), true);
  assert.equal(text.includes('The harness implementation checkout is at'), true);
});

test('sanitizeBody only touches the system array', () => {
  const body = JSON.stringify({
    system: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'DeepSeek Harness 是什么' }] }],
  });
  const result = sanitizeBody(body);
  assert.equal(result.changed, true);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.system[0].text, 'You are a coding agent.');
  // User content is not a brand surface: leave it exactly as written.
  assert.equal(parsed.messages[0].content[0].text, 'DeepSeek Harness 是什么');
});

test('sanitizeBody passes through anything it cannot improve', () => {
  assert.equal(sanitizeBody('not json').changed, false);
  assert.equal(sanitizeBody('').changed, false);
  const noSystem = JSON.stringify({ messages: [] });
  assert.equal(sanitizeBody(noSystem).body, noSystem);
  const clean = JSON.stringify({ system: [{ type: 'text', text: 'nothing to do' }] });
  assert.equal(sanitizeBody(clean).changed, false);
  assert.equal(sanitizeBody(clean).body, clean);
});

test('grant store round-trips with owner-only permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-test-'));
  const path = join(dir, 'grant.json');
  try {
    const store = new GrantStore({ path, refreshSkewMs: 1000 });
    assert.equal(await store.read(), undefined);
    await store.write({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 });
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
    const readBack = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(readBack.access, 'a');
    // A fresh store must see the persisted value.
    const other = new GrantStore({ path, refreshSkewMs: 1000 });
    assert.equal((await other.read()).refresh, 'r');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('grant store rejects a corrupt file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-test-'));
  const path = join(dir, 'grant.json');
  try {
    await writeFile(path, '{not json');
    const store = new GrantStore({ path });
    await assert.rejects(() => store.read(), /not valid JSON/);
    await writeFile(path, JSON.stringify({ access: 'a' }));
    const missingRefresh = new GrantStore({ path });
    await assert.rejects(() => missingRefresh.read(), /missing access or refresh/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('accessToken returns a fresh token without refreshing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-test-'));
  const path = join(dir, 'grant.json');
  try {
    const store = new GrantStore({ path, refreshSkewMs: 1000 });
    await store.write({ type: 'oauth', access: 'fresh', refresh: 'r', expires: Date.now() + 3_600_000 });
    let refreshes = 0;
    const token = await store.accessToken(async () => {
      refreshes += 1;
      throw new Error('must not refresh');
    });
    assert.equal(token, 'fresh');
    assert.equal(refreshes, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('accessToken refreshes once and persists the rotated token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-test-'));
  const path = join(dir, 'grant.json');
  try {
    const store = new GrantStore({ path, refreshSkewMs: 1000 });
    await store.write({ type: 'oauth', access: 'stale', refresh: 'old', expires: Date.now() - 1 });
    let refreshes = 0;
    const refresh = async (refreshToken) => {
      refreshes += 1;
      assert.equal(refreshToken, 'old');
      return { access: 'new', refresh: 'rotated', expires: Date.now() + 3_600_000 };
    };
    // Concurrent callers must share one refresh.
    const [a, b, c] = await Promise.all([
      store.accessToken(refresh),
      store.accessToken(refresh),
      store.accessToken(refresh),
    ]);
    assert.equal(a, 'new');
    assert.equal(b, 'new');
    assert.equal(c, 'new');
    assert.equal(refreshes, 1);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(persisted.refresh, 'rotated');
    assert.equal(persisted.access, 'new');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('accessToken refuses when nothing is stored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-test-'));
  const path = join(dir, 'grant.json');
  try {
    const store = new GrantStore({ path });
    await assert.rejects(() => store.accessToken(async () => {}), /no Claude subscription is signed in/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('login sessions expire and are single-use', () => {
  const sessions = new LoginSessions({ ttlMs: 50, maxLive: 2 });
  const attempt = sessions.create();
  assert.match(attempt.url, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
  assert.equal(attempt.url.includes('code_challenge_method=S256'), true);
  assert.equal(attempt.url.includes('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e'), true);
  assert.equal(
    attempt.url.includes('redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback'),
    true,
  );
  const peeked = sessions.peek(attempt.id);
  assert.ok(typeof peeked.verifier === 'string' && peeked.verifier.length > 10);
  sessions.consume(attempt.id);
  assert.throws(() => sessions.peek(attempt.id), /unknown or has expired/);
});

test('login sessions cap concurrent attempts', () => {
  const sessions = new LoginSessions({ ttlMs: 60_000, maxLive: 1 });
  sessions.create();
  assert.throws(() => sessions.create(), /too many sign-in attempts/);
});

test('login sessions expire by TTL', async () => {
  const sessions = new LoginSessions({ ttlMs: 10 });
  const attempt = sessions.create();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.throws(() => sessions.peek(attempt.id), /unknown or has expired/);
});

test('ensureBaseBetas adds the thinking betas only when asked', async () => {
  const { ensureBaseBetas, wantsThinkingBetas, THINKING_BETAS } = await import('../src/identity.js');

  const plain = ensureBaseBetas(new Headers({}));
  assert.equal(plain.get('anthropic-beta'), 'claude-code-20250219,oauth-2025-04-20');

  const thinking = ensureBaseBetas(new Headers({}), THINKING_BETAS);
  const parts = thinking.get('anthropic-beta').split(',');
  assert.ok(parts.includes('claude-code-20250219'));
  assert.ok(parts.includes('thinking-binding-controls-2026-08-01'));
  // Idempotent: calling twice must not duplicate.
  const twice = ensureBaseBetas(new Headers({ 'anthropic-beta': thinking.get('anthropic-beta') }), THINKING_BETAS);
  assert.equal(twice.get('anthropic-beta'), thinking.get('anthropic-beta'));
});

test('wantsThinkingBetas keys off the body that carries the shape', async () => {
  const { wantsThinkingBetas } = await import('../src/identity.js');
  assert.equal(wantsThinkingBetas({ thinking: { type: 'adaptive' } }), true);
  assert.equal(wantsThinkingBetas({ output_config: { effort: 'high' } }), true);
  assert.equal(wantsThinkingBetas({ model: 'x', messages: [] }), false);
  assert.equal(wantsThinkingBetas(undefined), false);
  assert.equal(wantsThinkingBetas(null), false);
});

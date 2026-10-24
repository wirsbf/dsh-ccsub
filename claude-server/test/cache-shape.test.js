/**
 * The cache diagnostics: shape digests, and the verdict they make possible.
 *
 * ## What these tests protect
 *
 * A cache hit rate is not actionable on its own. The same 13% figure means
 * "a subagent's first call, working as designed" or "a live conversation paying
 * for its prefix every turn, which is a bug" depending on whether the prefix was
 * already cached and whether the prompt grew. These tests pin the distinction,
 * because getting it wrong sends the next investigation after the wrong cause —
 * which is exactly what happened before this instrumentation existed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cacheIdentityOf, cacheShape } from '../src/shape.js';
import { UsageLedger } from '../src/usage.js';

/** A body shaped like a real Messages request. */
function body({ system = 'you are helpful', tools = [{ name: 'bash' }], messages = [{ role: 'user', content: 'hi' }] } = {}) {
  return { model: 'claude-sonnet-5-5', system, tools, messages };
}

describe('cacheShape', () => {
  it('digests the tool set and the system prompt separately', () => {
    const shape = cacheShape(body());
    assert.match(shape.toolsHash, /^[0-9a-f]{16}$/);
    assert.match(shape.systemHash, /^[0-9a-f]{16}$/);
    assert.notEqual(shape.toolsHash, shape.systemHash);
  });

  it('gives the same digests for the same prefix', () => {
    // The whole instrument rests on this: two turns of one conversation must
    // compare equal, or every call looks like a new prefix.
    assert.deepEqual(cacheShape(body()), cacheShape(body()));
  });

  it('changes the system digest, and only that, when the system prompt changes', () => {
    const before = cacheShape(body({ system: 'you are helpful' }));
    const after = cacheShape(body({ system: 'you are a subagent' }));
    assert.notEqual(before.systemHash, after.systemHash);
    assert.equal(before.toolsHash, after.toolsHash);
  });

  it('changes the tools digest when a tool is restricted away', () => {
    // A subagent's `tools.restrict()` is the case that separates two identities.
    const parent = cacheShape(body({ tools: [{ name: 'bash' }, { name: 'read' }] }));
    const child = cacheShape(body({ tools: [{ name: 'bash' }] }));
    assert.notEqual(parent.toolsHash, child.toolsHash);
    assert.equal(parent.systemHash, child.systemHash);
  });

  it('counts tools and messages so a row can be identified by size', () => {
    const shape = cacheShape(body({ tools: [{ name: 'a' }, { name: 'b' }], messages: [{ role: 'user' }] }));
    assert.equal(shape.toolsCount, 2);
    assert.equal(shape.messagesCount, 1);
    assert.ok(shape.systemBytes > 0);
  });

  it('tracks the message count without touching the identity', () => {
    // Later turns append messages; that must not look like a different prefix,
    // because the prefix is unchanged and its cache still applies.
    const first = cacheShape(body({ messages: [{ role: 'user' }] }));
    const later = cacheShape(body({ messages: [{ role: 'user' }, { role: 'assistant' }] }));
    assert.notEqual(first.messagesCount, later.messagesCount);
    assert.equal(cacheIdentityOf(first), cacheIdentityOf(later));
  });

  it('is absent for a body that describes nothing cacheable', () => {
    assert.equal(cacheShape({}), undefined);
    assert.equal(cacheShape(null), undefined);
    assert.equal(cacheShape('not an object'), undefined);
    assert.equal(cacheIdentityOf(undefined), undefined);
  });

  it('handles a body with tools but no system prompt', () => {
    const shape = cacheShape({ tools: [{ name: 'bash' }] });
    assert.equal(shape.systemHash, undefined);
    assert.equal(shape.systemBytes, 0);
    assert.match(cacheIdentityOf(shape), /:nosystem$/);
  });

  it('names an identity by both halves, so either can be compared', () => {
    const identity = cacheIdentityOf(cacheShape(body()));
    assert.match(identity, /^[0-9a-f]{16}:[0-9a-f]{16}$/);
  });
});

describe('UsageLedger cache verdicts', () => {
  /** Record one call with the given token counts under one identity. */
  function call(ledger, identity, { input = 0, read = 0, write = 0, session = 'one' }) {
    ledger.record({
      input_tokens: input,
      output_tokens: 10,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      cacheIdentity: identity,
      // A verdict is decided per conversation; a call with no session can only
      // ever be a first sighting.
      sessionKey: session,
      shape: { toolsCount: 1, systemBytes: 10, messagesCount: 1 },
    });
    return ledger.recent[0];
  }

  it('calls the first write under a prefix expected', () => {
    const ledger = new UsageLedger();
    const row = call(ledger, 'a:b', { input: 8, write: 15000 });
    assert.equal(row.cacheVerdict, 'first');
  });

  it('calls a write expected when the prompt grew past the high-water mark', () => {
    const ledger = new UsageLedger();
    call(ledger, 'a:b', { input: 8, write: 15000 });
    const row = call(ledger, 'a:b', { input: 8, read: 15000, write: 2000 });
    assert.equal(row.cacheVerdict, 'extended');
  });

  it('flags a write when the prompt fits inside the cached prefix', () => {
    // The failure this instrumentation exists to find, in its purest form: the
    // prefix is already cached at 15000, this call's prompt (2406 read + 500
    // written + 8 input = 2914) fits inside it, and it still wrote 500 tokens
    // that bought nothing.
    const ledger = new UsageLedger();
    call(ledger, 'a:b', { input: 8, write: 15000 });
    const row = call(ledger, 'a:b', { input: 8, read: 2406, write: 500 });
    assert.equal(row.cacheVerdict, 'reused');
    assert.equal(ledger.byCacheIdentity.get('a:b').wastedWrites, 1);
  });

  it('flags a write that dwarfs the growth as a rewrite', () => {
    // The observed shape: the prompt grew a little (17414 vs a 15000 cached
    // prefix) but the write covers the whole prefix instead of just the 2414-token
    // tail. That is a rebuild, and it costs what never having cached would.
    const ledger = new UsageLedger();
    call(ledger, 'a:b', { input: 8, write: 15000 });
    const row = call(ledger, 'a:b', { input: 8, read: 2406, write: 15000 });
    assert.equal(row.cacheVerdict, 'rewritten');
    assert.equal(ledger.byCacheIdentity.get('a:b').wastedWrites, 1);
    // Whereas a small growth with a small tail write is the healthy case.
    const grown = call(ledger, 'a:b', { input: 8, read: 17414, write: 600 });
    assert.equal(grown.cacheVerdict, 'extended');
    assert.equal(ledger.byCacheIdentity.get('a:b').wastedWrites, 1);
  });

  it('does not treat a full read as a miss', () => {
    // The healthy turn: the prompt is entirely served from the prefix cached by
    // the previous call, with no write at all.
    const ledger = new UsageLedger();
    call(ledger, 'a:b', { input: 8, write: 15000 });
    const row = call(ledger, 'a:b', { input: 8, read: 14992 });
    assert.equal(row.cacheVerdict, 'reused');
    assert.ok(row.reuseRatio > 0.99);
    assert.equal(ledger.byCacheIdentity.get('a:b').wastedWrites, 0);
  });

  it('treats a prompt just past the mark as growth, not reuse', () => {
    // Block granularity means the prompt edges past the cached size on almost
    // every real turn; that turn is an extension, and calling it a miss would
    // make every healthy conversation look broken.
    const ledger = new UsageLedger();
    call(ledger, 'a:b', { input: 8, write: 15000 });
    const row = call(ledger, 'a:b', { input: 4, read: 15000 });
    assert.equal(row.cacheVerdict, 'extended');
    assert.equal(ledger.byCacheIdentity.get('a:b').wastedWrites, 0);
  });

  it('keeps each identity separate, so a subagent is not blamed for a main miss', () => {
    const ledger = new UsageLedger();
    call(ledger, 'parent:system', { input: 8, read: 40000, session: 'parent' });
    call(ledger, 'child:system', { input: 8, write: 12000, session: 'child' });
    const child = ledger.byCacheIdentity.get('child:system');
    const parent = ledger.byCacheIdentity.get('parent:system');
    assert.equal(child.first, 1);
    assert.equal(child.wastedWrites, 0);
    assert.equal(parent.wastedWrites, 0);
  });

  it('never lets the high-water mark fall when a shorter prompt arrives', () => {
    // A shorter prompt can still hit the longer cached prefix, so treating it as
    // the new baseline would let the bar drift down until every call looked like
    // an extension and real misses became invisible.
    const ledger = new UsageLedger();
    call(ledger, 'a:b', { input: 8, write: 50000 });
    call(ledger, 'a:b', { input: 8, read: 10000 });
    const bucket = ledger.byCacheIdentity.get('a:b');
    assert.ok(bucket.highWater >= 50000);
  });

  it('records no reuse ratio before anything was cached', () => {
    const ledger = new UsageLedger();
    const row = call(ledger, 'a:b', { input: 8, write: 15000 });
    assert.equal(row.reuseRatio, 0);
  });

  it('reports the ratio of a real hit', () => {
    const ledger = new UsageLedger();
    const row = call(ledger, 'a:b', { input: 4, read: 96 });
    assert.equal(row.reuseRatio, 0.96);
  });

  it('classifies a call with no identity as unknown rather than a miss', () => {
    const ledger = new UsageLedger();
    const row = call(ledger, undefined, { input: 8, write: 15000 });
    assert.equal(row.cacheVerdict, 'unknown');
    assert.equal(row.cacheIdentity, null);
  });

  it('survives a reset', () => {
    const ledger = new UsageLedger();
    call(ledger, 'a:b', { input: 8, write: 15000 });
    ledger.reset();
    assert.equal(ledger.byCacheIdentity.size, 0);
    assert.equal(ledger.recent.length, 0);
  });
});

describe('cache verdicts are per conversation, not per prompt shape', () => {
  /** Record one call under an identity and a session. */
  function call(ledger, identity, session, { input = 0, read = 0, write = 0 }) {
    ledger.record({
      input_tokens: input,
      output_tokens: 5,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      cacheIdentity: identity,
      sessionKey: session,
      shape: { toolsCount: 0, systemBytes: 100, messagesCount: 2 },
    });
    return ledger.recent[0];
  }

  it('does not call a second conversation a rewrite of the first', () => {
    // The bug this pins: two conversations sharing a system prompt were judged
    // against each other's high-water mark, so the smaller one was reported as
    // "reused + write" — a wasted cache write that never happened. In production
    // this inflated the waste count enough to send the investigation after the
    // wrong subsystem.
    const ledger = new UsageLedger();
    call(ledger, 'reviewer:policy', 'review-a', { input: 8, write: 50_000 });
    const second = call(ledger, 'reviewer:policy', 'review-b', { input: 8, write: 12_000 });
    assert.equal(second.cacheVerdict, 'first', 'a different conversation has its own first call');
    assert.equal(ledger.byCacheIdentity.get('reviewer:policy').wastedWrites, 0);
  });

  it('still calls a real rewrite inside one conversation a rewrite', () => {
    // The distinction must not weaken the real signal.
    const ledger = new UsageLedger();
    call(ledger, 'id', 'one', { input: 8, write: 50_000 });
    // The prompt must fit inside the cached prefix for this to be "reused": 8 +
    // 2000 read + 500 written = 2508, well under 50000, yet it still wrote.
    const rewritten = call(ledger, 'id', 'one', { input: 8, read: 2_000, write: 500 });
    assert.equal(rewritten.cacheVerdict, 'reused');
    assert.equal(ledger.byCacheIdentity.get('id').wastedWrites, 1);
  });

  it('counts each conversation once in the identity aggregate', () => {
    const ledger = new UsageLedger();
    call(ledger, 'id', 'a', { input: 8, write: 10_000 });
    call(ledger, 'id', 'b', { input: 8, write: 20_000 });
    call(ledger, 'id', 'a', { input: 8, read: 10_000, write: 200 });
    const bucket = ledger.byCacheIdentity.get('id');
    assert.equal(bucket.calls, 3);
    assert.equal(bucket.first, 2, 'each conversation contributed one first call');
    assert.equal(bucket.wastedWrites, 0);
    // The aggregate high-water is the largest single conversation's *cached*
    // size. Session `b` wrote 20000 and never grew past it. Input tokens are
    // beyond the last breakpoint, so they do not count toward the cache.
    assert.equal(bucket.highWater, 20_000);
  });

  it('treats a call with no session key as a first sighting every time', () => {
    // Better to under-report than to invent a history that does not exist.
    const ledger = new UsageLedger();
    call(ledger, 'id', undefined, { input: 8, write: 50_000 });
    const second = call(ledger, 'id', undefined, { input: 8, read: 2_000, write: 50_000 });
    assert.equal(second.cacheVerdict, 'first');
  });
});

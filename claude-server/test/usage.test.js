/**
 * Token accounting.
 *
 * The property worth locking down is that accounting never interferes with the
 * response: it must read both Anthropic response shapes, tolerate frames split
 * at arbitrary byte boundaries, and stay silent when it cannot understand the
 * body. A counter that throws would take the client's answer down with it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageLedger, UsageObserver } from '../src/usage.js';

/** SSE frame helper. */
const frame = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

test('a streaming response is counted from message_start and message_delta', () => {
  const o = new UsageObserver();
  o.observe(frame('message_start', {
    type: 'message_start',
    message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 42, output_tokens: 1, cache_read_input_tokens: 100 } },
  }));
  o.observe(frame('message_delta', { type: 'message_delta', usage: { output_tokens: 250 } }));
  const r = o.finish();
  assert.equal(r.input_tokens, 42);
  // `message_delta.usage.output_tokens` is cumulative for the message, so it
  // replaces the single token message_start reported rather than adding to it.
  assert.equal(r.output_tokens, 250);
  assert.equal(r.cache_read_input_tokens, 100);
  assert.equal(r.model, 'claude-sonnet-5-5');
});

test('a non-streaming response is counted from its top-level usage', () => {
  const o = new UsageObserver();
  o.observe(JSON.stringify({
    model: 'claude-haiku-5-5',
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5 },
  }));
  const r = o.finish();
  assert.equal(r.input_tokens, 10);
  assert.equal(r.output_tokens, 20);
  assert.equal(r.cache_creation_input_tokens, 5);
  assert.equal(r.model, 'claude-haiku-5-5');
});

test('a frame split at an arbitrary byte boundary is still read', () => {
  const o = new UsageObserver();
  const whole = frame('message_start', {
    type: 'message_start',
    message: { model: 'm', usage: { input_tokens: 7 } },
  });
  // Split mid-JSON, the harshest case.
  const cut = Math.floor(whole.length / 2);
  o.observe(whole.slice(0, cut));
  o.observe(whole.slice(cut));
  assert.equal(o.finish().input_tokens, 7);
});

test('CRLF framing is accepted', () => {
  const o = new UsageObserver();
  o.observe('data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":3}}}\r\n\r\n');
  assert.equal(o.finish().input_tokens, 3);
});

test('a body that is neither SSE nor JSON yields nothing and never throws', () => {
  const o = new UsageObserver();
  assert.doesNotThrow(() => o.observe('<html>not a completion</html>'));
  assert.equal(o.finish(), undefined);
});

test('a response with no usage at all yields nothing', () => {
  const o = new UsageObserver();
  o.observe(frame('message_start', { type: 'message_start', message: { model: 'm' } }));
  o.observe(frame('message_stop', { type: 'message_stop' }));
  assert.equal(o.finish(), undefined);
});

test('an oversized unterminated frame is abandoned instead of buffered forever', () => {
  const o = new UsageObserver({ limit: 64 });
  o.observe('data: ' + 'x'.repeat(200));
  assert.equal(o.abandoned, true);
  // Still safe to call, and still reports nothing.
  assert.equal(o.finish(), undefined);
});

test('a malformed frame does not stop a later good one from counting', () => {
  const o = new UsageObserver();
  o.observe('data: {not json}\n\n');
  o.observe(frame('message_start', { type: 'message_start', message: { model: 'm', usage: { input_tokens: 9 } } }));
  assert.equal(o.finish().input_tokens, 9);
});

test('the ledger totals, groups by model, and keeps recent calls', () => {
  const ledger = new UsageLedger();
  ledger.record({ model: 'a', input_tokens: 10, output_tokens: 5, calls: 1, durationMs: 100 });
  ledger.record({ model: 'a', input_tokens: 20, output_tokens: 7, calls: 1, durationMs: 200 });
  ledger.record({ model: 'b', input_tokens: 1, output_tokens: 2, calls: 1, durationMs: 300 });

  const snap = ledger.snapshot();
  assert.equal(snap.totals.calls, 3);
  assert.equal(snap.totals.input_tokens, 31);
  assert.equal(snap.totals.output_tokens, 14);
  assert.equal(snap.byModel.length, 2);
  // Sorted by input+output, largest first.
  assert.equal(snap.byModel[0].model, 'a');
  assert.equal(snap.recent.length, 3);
  // Newest first.
  assert.equal(snap.recent[0].model, 'b');
  assert.equal(snap.resetsOnRestart, true);
});

test('the ledger records nothing for an undefined entry', () => {
  const ledger = new UsageLedger();
  ledger.record(undefined);
  assert.equal(ledger.snapshot().totals.calls, 0);
});

test('the ledger caps the recent list', () => {
  const ledger = new UsageLedger();
  for (let i = 0; i < 80; i += 1) ledger.record({ model: 'm', input_tokens: 1, output_tokens: 1, calls: 1 });
  assert.equal(ledger.snapshot().recent.length, 50);
  // The cap must not truncate the totals themselves.
  assert.equal(ledger.snapshot().totals.calls, 80);
});

test('reset clears totals, models and recent', () => {
  const ledger = new UsageLedger();
  ledger.record({ model: 'm', input_tokens: 1, output_tokens: 1, calls: 1 });
  ledger.reset();
  const snap = ledger.snapshot();
  assert.equal(snap.totals.calls, 0);
  assert.equal(snap.byModel.length, 0);
  assert.equal(snap.recent.length, 0);
});

test('negative or non-numeric counters are ignored', () => {
  const ledger = new UsageLedger();
  ledger.record({ model: 'm', input_tokens: -5, output_tokens: 'x', calls: 1 });
  assert.equal(ledger.snapshot().totals.input_tokens, 0);
  assert.equal(ledger.snapshot().totals.output_tokens, 0);
});

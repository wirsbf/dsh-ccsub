/**
 * `GET /quota`'s reply shape.
 *
 * The gate's `lastError` is sticky, which is right for the throttle and wrong
 * for the panel: answering 502 while still holding windows made the card replace
 * real numbers with an error line and then restore them on the next poll — the
 * flash an operator sees as "red error screen, then the quota". The rule worth
 * pinning is that a failure only wins when there is nothing to show.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { quotaReply } from '../lib/quota-reply.js';

/** A snapshot with the fields the route reads. */
const snapshot = (overrides = {}) => ({
  threshold: 90,
  over: [],
  windows: [],
  fetchedAt: 0,
  lastError: null,
  waiting: 0,
  ...overrides,
});

test('a healthy read is a 200 with its windows', () => {
  const reply = quotaReply(
    snapshot({
      windows: [{ kind: 'session', usedPercent: 12 }],
      fetchedAt: 1_700_000_000_000,
    }),
  );
  assert.equal(reply.status, 200);
  assert.equal(reply.body.supported, true);
  assert.equal(reply.body.windows.length, 1);
  assert.equal(reply.body.fetchedAt, 1_700_000_000_000);
  assert.equal('staleError' in reply.body, false, 'a healthy read carries no stale marker');
});

test('a failure with nothing to show is a 502', () => {
  const reply = quotaReply(snapshot({ lastError: 'rate limited' }));
  assert.equal(reply.status, 502);
  assert.equal(reply.body.code, 'USAGE_FAILED');
  assert.equal(reply.body.error, 'rate limited');
});

test('a failure alongside known windows is a 200, with the error as a marker', () => {
  // This is the case the flash came from.
  const reply = quotaReply(
    snapshot({
      windows: [{ kind: 'session', usedPercent: 40 }],
      fetchedAt: 1_700_000_000_000,
      lastError: 'rate limited',
    }),
  );
  assert.equal(reply.status, 200, 'known figures outrank a failed refresh');
  assert.equal(reply.body.windows.length, 1, 'the figures are served');
  assert.equal(reply.body.staleError, 'rate limited', 'the failure is reported beside them');
});

test('an empty successful read is not an error', () => {
  const reply = quotaReply(snapshot({ windows: [], lastError: null }));
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.windows, []);
  assert.equal('staleError' in reply.body, false);
});

test('a missing snapshot degrades to an empty success rather than throwing', () => {
  for (const input of [undefined, null, {}, { windows: null }]) {
    const reply = quotaReply(input);
    assert.equal(reply.status, 200, `input ${JSON.stringify(input)} answers 200`);
    assert.deepEqual(reply.body.windows, []);
  }
});

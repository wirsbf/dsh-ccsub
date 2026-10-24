/**
 * Session routing: which subscription serves a conversation, and why it must
 * not move once chosen.
 *
 * The cost model is the whole reason this exists. Prompt cache is per
 * credential, so a conversation that hops accounts pays a full cache write
 * (1.25x input) on every turn instead of a cache read (0.1x). These tests pin
 * the three properties that keep it on one account.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AccountDirectory, rankForNewSession, sessionHeadroom } from '../src/accounts.js';
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, costOf, formatUsd, priceFor } from '../src/pricing.js';
import { SessionBindings, fingerprintOf } from '../src/sessions.js';

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A request body shaped like a real one, with a chosen opening message. */
function body(opening = 'first question') {
  return {
    model: 'claude-sonnet-5-5',
    system: [{ type: 'text', text: 'You are a coding agent.' }],
    tools: [{ name: 'bash' }],
    messages: [{ role: 'user', content: opening }],
  };
}

describe('session fingerprints', () => {
  it('are stable across turns of one conversation', () => {
    // The later turns append to `messages`; the opening message, system prompt
    // and tools do not change, which is what makes one conversation one key.
    const first = body('hello');
    const later = body('hello');
    later.messages.push({ role: 'assistant', content: 'hi' });
    later.messages.push({ role: 'user', content: 'and again' });
    assert.equal(fingerprintOf(later), fingerprintOf(first));
  });

  it('differ between conversations with different openings', () => {
    assert.notEqual(fingerprintOf(body('one task')), fingerprintOf(body('another task')));
  });

  it('differ when the system prompt or tools differ', () => {
    const a = body('same');
    const b = body('same');
    b.system = [{ type: 'text', text: 'A different prompt.' }];
    assert.notEqual(fingerprintOf(a), fingerprintOf(b));

    const c = body('same');
    const d = body('same');
    d.tools = [{ name: 'read' }];
    assert.notEqual(fingerprintOf(c), fingerprintOf(d));
  });

  it('is undefined when the body carries nothing to key on', () => {
    assert.equal(fingerprintOf({}), undefined);
    assert.equal(fingerprintOf({ model: 'x' }), undefined);
    assert.equal(fingerprintOf(null), undefined);
  });
});

describe('session bindings', () => {
  it('remembers the account a conversation was bound to', () => {
    const bounds = new SessionBindings();
    const fp = fingerprintOf(body());
    assert.equal(bounds.get(fp), undefined);
    bounds.set(fp, 'acct_a');
    assert.equal(bounds.get(fp), 'acct_a');
  });

  it('expires a binding after the TTL', async () => {
    const bounds = new SessionBindings({ ttlMs: 20 });
    const fp = fingerprintOf(body());
    bounds.set(fp, 'acct_a');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(bounds.get(fp), undefined, 'an idle conversation is released');
  });

  it('can drop one binding, which is how a conversation moves after a limit', () => {
    const bounds = new SessionBindings();
    const fp = fingerprintOf(body());
    bounds.set(fp, 'acct_a');
    bounds.delete(fp);
    assert.equal(bounds.get(fp), undefined);
  });

  it('stays bounded under many conversations', () => {
    const bounds = new SessionBindings({ max: 5 });
    for (let i = 0; i < 20; i++) bounds.set(`fp${i}`, 'acct_a');
    assert.ok(bounds.size <= 5, 'the LRU cap holds');
  });
});

describe('account ranking', () => {
  /** A five-hour window with the given usage percent. */
  const usage = (percent, resetsInMinutes = 60) => ({
    limits: [
      { kind: 'session', percent, resets_at: new Date(Date.now() + resetsInMinutes * 60_000).toISOString() },
      { kind: 'weekly_all', percent: 90 },
    ],
  });

  it('reads the five-hour window, not the weekly one', () => {
    // The weekly window is what runs out over days; the five-hour one is what
    // interrupts a conversation, so it is the only one that decides routing.
    const headroom = sessionHeadroom(usage(30));
    assert.equal(headroom.remaining, 70);
  });

  it('returns undefined when there is no session window', () => {
    assert.equal(sessionHeadroom({ limits: [] }), undefined);
    assert.equal(sessionHeadroom({}), undefined);
  });

  it('prefers the account with the most room', () => {
    const accounts = [
      { id: 'tight', signedIn: true, disabled: false },
      { id: 'roomy', signedIn: true, disabled: false },
    ];
    const headroom = { tight: { remaining: 10 }, roomy: { remaining: 90 } };
    assert.deepEqual(rankForNewSession(accounts, (id) => headroom[id]), ['roomy', 'tight']);
  });

  it('breaks ties toward the window that refills soonest', () => {
    // Equal room: the account whose budget is about to be replenished should
    // take the conversation, because its remaining room is about to grow.
    const accounts = [
      { id: 'later', signedIn: true, disabled: false },
      { id: 'sooner', signedIn: true, disabled: false },
    ];
    const headroom = {
      later: { remaining: 50, resetsAt: Date.now() + 3_600_000 },
      sooner: { remaining: 50, resetsAt: Date.now() + 60_000 },
    };
    assert.deepEqual(rankForNewSession(accounts, (id) => headroom[id]), ['sooner', 'later']);
  });

  it('skips signed-out and disabled accounts entirely', () => {
    const accounts = [
      { id: 'out', signedIn: false, disabled: false },
      { id: 'off', signedIn: true, disabled: true },
      { id: 'ok', signedIn: true, disabled: false },
    ];
    const ranked = rankForNewSession(accounts, () => ({ remaining: 50 }));
    assert.deepEqual(ranked, ['ok'], 'an account that cannot serve is not a candidate');
  });

  it('ranks an unknown account ahead of a known-exhausted one', () => {
    // Unknown is a guess; exhausted is a certainty.
    const accounts = [
      { id: 'known-empty', signedIn: true, disabled: false },
      { id: 'unprobed', signedIn: true, disabled: false },
    ];
    const ranked = rankForNewSession(accounts, (id) =>
      id === 'known-empty' ? { remaining: 0 } : undefined,
    );
    assert.deepEqual(ranked, ['unprobed', 'known-empty']);
  });
});

describe('pricing', () => {
  it('prices the model families the subscription exposes', () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5',
      'claude-sonnet-4-5-20250929',
    ]) {
      assert.ok(priceFor(model) !== undefined, `${model} must have a price`);
    }
  });

  it('matches a dated snapshot to its family', () => {
    assert.deepEqual(priceFor('claude-sonnet-4-5-20250929'), priceFor('claude-sonnet-4-5'));
  });

  it('prices cache traffic as multiples of the input rate', () => {
    const oneMillionInput = { input_tokens: 1_000_000 };
    const oneMillionCacheRead = { cache_read_input_tokens: 1_000_000 };
    const oneMillionCacheWrite = { cache_creation_input_tokens: 1_000_000 };
    const base = costOf(oneMillionInput, 'claude-sonnet-5-5');
    assert.equal(base, 2, 'a million input tokens on Sonnet 5.5 is $2');
    assert.equal(costOf(oneMillionCacheRead, 'claude-sonnet-5-5'), base * CACHE_READ_MULTIPLIER);
    assert.equal(costOf(oneMillionCacheWrite, 'claude-sonnet-5-5'), base * CACHE_WRITE_MULTIPLIER);
  });

  it('adds the four token classes into one figure', () => {
    const cost = costOf(
      { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 },
      'claude-opus-5-5',
    );
    // input 10 * 4/M + output 20 * 20/M + read 1000 * 4/M * 0.1 + write 500 * 4/M * 1.25
    const expected = 10 * 4e-6 + 20 * 20e-6 + 1000 * 4e-6 * 0.1 + 500 * 4e-6 * 1.25;
    assert.ok(Math.abs(cost - expected) < 1e-12);
  });

  it('returns undefined rather than zero for an unknown model', () => {
    // Zero would silently understate the total; undefined lets the caller say
    // which models it could not price.
    assert.equal(costOf({ input_tokens: 1000 }, 'some-unlisted-model'), undefined);
  });

  it('formats small amounts without rounding them to nothing', () => {
    assert.equal(formatUsd(0.0001234), '$0.0001');
    assert.equal(formatUsd(1.5), '$1.50');
  });
});

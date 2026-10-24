/**
 * Naming the piece of a prompt that stopped matching.
 *
 * ## Why this level of detail is needed
 *
 * "The system hash changed" is true of every mismatch and identifies none of
 * them. The production numbers that motivated this were 98 wasted cache writes
 * out of 116 calls across three prefixes; knowing *which* piece moved is the
 * difference between fixing the cause and guessing at it. These tests pin the
 * three outcomes that matter: a named first difference, a shrink, and a healthy
 * extension that reports nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PrefixTracker, prefixPieces } from '../src/prefix-diff.js';

/** A body with tools, system blocks, and messages, in that order. */
function body({ tools = [{ name: 'bash', description: 'run a command' }], system = ['you are helpful'], messages = [] } = {}) {
  return {
    model: 'claude-sonnet-5-5',
    tools,
    system: system.map((text) => ({ type: 'text', text })),
    messages,
  };
}

describe('prefixPieces', () => {
  it('lists pieces in the order the cache covers them', () => {
    // Anthropic caches tools, then system, then messages; the position in this
    // list is what makes "the first difference is at index 1" meaningful.
    const pieces = prefixPieces(body({ messages: [{ role: 'user', content: 'hi' }] }));
    assert.deepEqual(pieces.map((piece) => piece.label), ['tools[0:bash]', 'system[0]', 'messages[0:user]']);
  });

  it('names each tool, so a diff does not read as an index', () => {
    const pieces = prefixPieces(body({ tools: [{ name: 'bash' }, { name: 'read' }] }));
    assert.match(pieces[0].label, /bash/);
    assert.match(pieces[1].label, /read/);
  });

  it('gives identical hashes for identical pieces', () => {
    const a = prefixPieces(body());
    const b = prefixPieces(body());
    assert.deepEqual(a.map((p) => p.hash), b.map((p) => p.hash));
  });

  it('tolerates a body with no tools and no system', () => {
    assert.deepEqual(prefixPieces({ messages: [{ role: 'user', content: 'x' }] }).map((p) => p.label), ['messages[0:user]']);
    assert.deepEqual(prefixPieces({}), []);
  });

  it('accepts a system prompt sent as a bare string', () => {
    const pieces = prefixPieces({ system: 'plain', messages: [] });
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0].label, 'system[0]');
  });
});

describe('PrefixTracker.compare', () => {
  it('reports nothing for a first sighting', () => {
    const tracker = new PrefixTracker();
    assert.equal(tracker.compare('id', prefixPieces(body())), undefined);
  });

  it('reports nothing when the prompt only grew', () => {
    // The healthy case and the common one: a later turn appends messages.
    const tracker = new PrefixTracker();
    tracker.compare('id', prefixPieces(body({ messages: [{ role: 'user', content: 'a' }] })));
    const change = tracker.compare('id', prefixPieces(body({ messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ] })));
    assert.equal(change, undefined);
  });

  it('names the first system block that changed', () => {
    const tracker = new PrefixTracker();
    tracker.compare('id', prefixPieces(body({ system: ['you are helpful'] })));
    const change = tracker.compare('id', prefixPieces(body({ system: ['you are a subagent'] })));
    assert.equal(change.kind, 'changed');
    assert.equal(change.label, 'system[0]');
    assert.equal(change.sharedPrefixes, 1, 'the tool set still matched');
    assert.match(change.before, /helpful/);
    assert.match(change.after, /subagent/);
  });

  it('reports where the match stopped when a tool schema changed', () => {
    // A tool reordering or a description edit invalidates everything after it,
    // which is why the position is the useful part of the report.
    const tracker = new PrefixTracker();
    tracker.compare('id', prefixPieces(body({ tools: [{ name: 'bash', description: 'old' }, { name: 'read' }] })));
    const change = tracker.compare('id', prefixPieces(body({ tools: [{ name: 'bash', description: 'new' }, { name: 'read' }] })));
    assert.equal(change.label, 'tools[0:bash]');
    assert.equal(change.sharedPrefixes, 0, 'nothing before it matched either');
  });

  it('reports a later difference only after the earlier pieces matched', () => {
    const tracker = new PrefixTracker();
    tracker.compare('id', prefixPieces(body({ messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ] })));
    const change = tracker.compare('id', prefixPieces(body({ messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'REWRITTEN' },
    ] })));
    assert.equal(change.label, 'messages[1:assistant]');
    // Pieces before it: tools[0], system[0], messages[0] — three matched.
    assert.equal(change.sharedPrefixes, 3, 'the tool, system, and first message still matched');
  });

  it('reports a shrink, because the cached tail cannot be reused', () => {
    // A shorter prompt is a real miss even though nothing differs: the cache
    // holds more than this request asks for, and the extra cannot be used.
    const tracker = new PrefixTracker();
    tracker.compare('id', prefixPieces(body({ messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ] })));
    const change = tracker.compare('id', prefixPieces(body({ messages: [{ role: 'user', content: 'a' }] })));
    assert.equal(change.kind, 'shrunk');
    // tools, system, and the one message remain: the dropped piece is index 3.
    assert.equal(change.index, 3);
    assert.equal(change.after, '');
  });

  it('keeps identities separate', () => {
    const tracker = new PrefixTracker();
    tracker.compare('a', prefixPieces(body({ system: ['one'] })));
    // A different identity has no memory, so it is a first sighting even though
    // its pieces differ from the other identity's.
    assert.equal(tracker.compare('b', prefixPieces(body({ system: ['two'] }))), undefined);
  });

  it('compares against the immediately preceding request, not the largest', () => {
    // A prefix that grows and then shrinks back must be caught; comparing only
    // against a high-water mark would report "extension" and miss it.
    const tracker = new PrefixTracker();
    tracker.compare('id', prefixPieces(body({ messages: [{ role: 'user', content: 'a' }] })));
    tracker.compare('id', prefixPieces(body({ messages: [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    ] })));
    const change = tracker.compare('id', prefixPieces(body({ messages: [{ role: 'user', content: 'a' }] })));
    assert.equal(change.kind, 'shrunk');
  });

  it('does not fail on an undefined identity', () => {
    const tracker = new PrefixTracker();
    assert.equal(tracker.compare(undefined, prefixPieces(body())), undefined);
  });

  it('bounds what it quotes, so a huge message does not flood the log', () => {
    const tracker = new PrefixTracker();
    tracker.compare('id', prefixPieces({ system: [{ text: 'x'.repeat(5000) }], messages: [] }));
    const change = tracker.compare('id', prefixPieces({ system: [{ text: 'y'.repeat(5000) }], messages: [] }));
    assert.ok(change.before.length < 300);
    assert.ok(change.after.length < 300);
    assert.match(change.before, /…$/, 'a truncated excerpt says so');
  });

  it('evicts the oldest identity when the table is full', () => {
    const tracker = new PrefixTracker();
    // MAX_TRACKED is 64; the 66th identity must push the first one out rather
    // than growing without bound on a long uptime.
    for (let index = 0; index < 66; index += 1) {
      tracker.compare(`id-${index}`, prefixPieces(body()));
    }
    assert.ok(tracker.tracked.size <= 64);
    assert.equal(tracker.tracked.has('id-0'), false);
    assert.equal(tracker.tracked.has('id-65'), true);
  });
});

describe('PrefixTracker.snapshot', () => {
  it('describes each tracked prefix with bounded excerpts', () => {
    const tracker = new PrefixTracker();
    tracker.compare('id', prefixPieces({ tools: [{ name: 'bash', description: 'run' }], messages: [] }));
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.prefixes.length, 1);
    const [prefix] = snapshot.prefixes;
    assert.equal(prefix.identity, 'id');
    assert.deepEqual(prefix.pieces.map((piece) => piece.label), ['tools[0:bash]']);
    assert.equal(prefix.pieces[0].excerpt, 'run');
    assert.ok(prefix.totalChars > 0);
  });

  it('is empty before anything was seen', () => {
    assert.deepEqual(new PrefixTracker().snapshot(), { prefixes: [] });
  });

  it('forgets everything on reset', () => {
    const tracker = new PrefixTracker();
    tracker.compare('id', prefixPieces(body()));
    tracker.reset();
    assert.equal(tracker.tracked.size, 0);
    assert.deepEqual(tracker.snapshot().prefixes, []);
  });
});

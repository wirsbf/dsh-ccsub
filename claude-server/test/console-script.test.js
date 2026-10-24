/**
 * The console script, executed against a stub DOM.
 *
 * ## Why this exists
 *
 * The console ships as one inline script with no build step and no type check.
 * A missing binding or a helper called across a function boundary therefore
 * only surfaces when a real browser runs it — and the failure mode is a blank
 * page, not a broken cell. That has happened here once: a page-scoped helper was
 * called from another page's renderer, every panel came up empty, and no test
 * noticed because the tests only asserted on server-rendered markup.
 *
 * So this runs the script for real, with a DOM stub that records what was built,
 * and then feeds it a usage payload containing the cache fields. If the cache
 * rendering path references something that does not exist, this throws.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONSOLE_SCRIPT } from '../src/admin.js';

/** One recorded element. */
class StubElement {
  constructor(tagName) {
    // A real node exposes `nodeType`; the console's table helper uses it to tell
    // an element cell from a text cell, so the stub must carry it too.
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.className = '';
    this._text = '';
    this.style = {};
    this.attributes = {};
  }

  set textContent(value) {
    this._text = value === undefined || value === null ? '' : String(value);
    this.children = [];
  }

  get textContent() {
    // A real element's textContent concatenates its subtree; several assertions
    // read a panel this way.
    if (this.children.length === 0) return this._text;
    return this.children.map((child) => child.textContent).join('');
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === undefined || node === null) continue;
      this.children.push(typeof node === 'string' ? Object.assign(new StubElement('#text'), { _text: node }) : node);
    }
  }

  querySelector(selector) {
    return this.find((child) => matches(child, selector));
  }

  querySelectorAll(selector) {
    const found = [];
    this.walk((child) => {
      if (matches(child, selector)) found.push(child);
    });
    return found;
  }

  find(predicate) {
    let hit;
    this.walk((child) => {
      if (hit === undefined && predicate(child)) hit = child;
    });
    return hit;
  }

  walk(visit) {
    for (const child of this.children) {
      visit(child);
      child.walk(visit);
    }
  }

  /** Every descendant's text, for asserting a panel rendered something. */
  allText() {
    return this.textContent;
  }
}

/** Match the few selector shapes the console uses: `[data-x]` and `.class`. */
function matches(node, selector) {
  if (selector.startsWith('[') && selector.endsWith(']')) {
    return Object.hasOwn(node.attributes, selector.slice(1, -1));
  }
  if (selector.startsWith('.')) return String(node.className).split(/\s+/).includes(selector.slice(1));
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

/** A DOM stub with the elements a usage page expects to find. */
function stubDocument(ids) {
  const byId = new Map();
  const document = {
    createElement: (tag) => new StubElement(tag),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, null);
      return byId.get(id);
    },
    addEventListener: () => {},
    body: new StubElement('body'),
  };
  for (const id of ids) {
    const element = new StubElement('div');
    element.attributes.id = id;
    byId.set(id, element);
  }
  return { document, byId };
}

/**
 * Run the console script against a stub environment.
 * @param options.rootIds - element ids the script may look for.
 * @param options.usage - what `/admin/api/usage` resolves to.
 * @param options.now - the clock, so timestamps are deterministic.
 * @returns the stubbed document, so a caller can inspect the rendered panels.
 */
async function runConsole({ rootIds, usage }) {
  const { document, byId } = stubDocument(rootIds);
  const fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(usage) });

  // The script registers loaders and immediately runs them; a macrotask turn
  // lets those promise chains settle before assertions.
  const factory = new Function('window', 'document', 'fetch', 'setInterval', 'setTimeout', 'console', CONSOLE_SCRIPT);
  factory(
    { __ACCOUNT_NAMES__: {}, location: { pathname: '/admin/usage', href: '' }, addEventListener: () => {} },
    document,
    fetch,
    () => 0,
    (fn) => {
      if (typeof fn === 'function') fn();
      return 0;
    },
    console,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return byId;
}

/** A usage payload shaped like the server's. */
function usagePayload(overrides = {}) {
  return {
    since: 1_700_000_000_000,
    totals: {
      calls: 3,
      input_tokens: 20,
      output_tokens: 30,
      cache_creation_input_tokens: 45_000,
      cache_read_input_tokens: 3_000,
    },
    byModel: [{ model: 'claude-sonnet-5-5', calls: 3, input_tokens: 20, output_tokens: 30,
      cache_creation_input_tokens: 45_000, cache_read_input_tokens: 3_000, costUsd: 0.1 }],
    byUser: [{ userId: 'u1', label: 'Alice', calls: 3, input_tokens: 20, output_tokens: 30,
      cache_creation_input_tokens: 45_000, cache_read_input_tokens: 3_000, costUsd: 0.1 }],
    byAccount: [{ accountId: 'default', label: 'default', calls: 3, input_tokens: 20, output_tokens: 30,
      cache_creation_input_tokens: 45_000, cache_read_input_tokens: 3_000, costUsd: 0.1 }],
    byCacheIdentity: [
      { identity: 'aaaaaaaabbbbbbbb:ccccccccdddddddd', calls: 3, first: 1, extended: 1, reused: 1,
        rewritten: 1, wastedWrites: 1, highWater: 15_000 },
    ],
    costUsd: 0.1,
    unpricedModels: [],
    recent: [
      {
        at: 1_700_000_000_000,
        model: 'claude-sonnet-5-5',
        input_tokens: 8,
        output_tokens: 18,
        cache_creation_input_tokens: 15_000,
        cache_read_input_tokens: 2_406,
        durationMs: 500,
        cacheIdentity: 'aaaaaaaabbbbbbbb:ccccccccdddddddd',
        cacheVerdict: 'rewritten',
        reuseRatio: 0.138,
        shape: { systemHash: 'ccccccccdddddddd', toolsHash: 'aaaaaaaabbbbbbbb', systemBytes: 12_000,
          toolsCount: 18, messagesCount: 4 },
      },
    ],
    resetsOnRestart: true,
    ...overrides,
  };
}

describe('console script', () => {
  it('loads and runs without throwing', () => {
    // The original blank-page failure threw here, on the missing helper.
    return runConsole({
      rootIds: ['tokens-body', 'recent-body', 'by-user-body', 'by-account-body'],
      usage: usagePayload(),
    });
  });

  it('renders the cache reuse panel with the fields it promises', async () => {
    const byId = await runConsole({
      rootIds: ['tokens-body', 'recent-body', 'by-user-body', 'by-account-body'],
      usage: usagePayload(),
    });
    const text = byId.get('tokens-body').allText();
    assert.match(text, /Cache reuse by prefix/);
    assert.match(text, /Writes after reuse/);
    // The identity is shown shortened to six characters per half, both visible.
    assert.match(text, /aaaaaa:cccccc/);
  });

  it('renders the verdict column of the recent-calls table', async () => {
    const byId = await runConsole({
      rootIds: ['tokens-body', 'recent-body', 'by-user-body', 'by-account-body'],
      usage: usagePayload(),
    });
    const text = byId.get('recent-body').allText();
    // `rewritten` is the label for "the prefix was rebuilt rather than extended".
    assert.match(text, /rewritten/);
    assert.match(text, /2,406/);
  });

  it('does not render an identity cell as [object Object]', async () => {
    // The table helper renders strings via textContent; passing an element to it
    // used to produce this string in a cell.
    const byId = await runConsole({
      rootIds: ['tokens-body', 'recent-body', 'by-user-body', 'by-account-body'],
      usage: usagePayload(),
    });
    assert.doesNotMatch(byId.get('recent-body').allText(), /\[object Object\]/);
    assert.doesNotMatch(byId.get('tokens-body').allText(), /\[object Object\]/);
  });

  it('still renders when the payload predates the cache fields', async () => {
    // A server older than this console sends no cache fields at all; the page
    // must degrade to a table without those columns rather than fail.
    const legacy = usagePayload();
    delete legacy.byCacheIdentity;
    legacy.recent = legacy.recent.map((call) => {
      const copy = { ...call };
      delete copy.cacheIdentity;
      delete copy.cacheVerdict;
      delete copy.reuseRatio;
      delete copy.shape;
      return copy;
    });
    const byId = await runConsole({
      rootIds: ['tokens-body', 'recent-body', 'by-user-body', 'by-account-body'],
      usage: legacy,
    });
    assert.match(byId.get('tokens-body').allText(), /By model/);
  });
});

/**
 * Render the browser card outside the host.
 *
 * The card ships as one plain module with no build step, so a syntax check is
 * not enough: a missing `const t = props.t` or a malformed element tree only
 * shows up when the component actually renders. These tests run the module
 * against a fake `window.__ModuleLoader__` and a minimal `React.createElement`,
 * then walk the resulting tree.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../lib/client/index.js', import.meta.url), 'utf8');

/** A tiny createElement that tags elements so the tree can be walked. */
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null) };
}

/**
 * Build a React stub.
 * @param openBooleans - when true, boolean `useState` starts `true`, which is
 *   how the section's disclosure is opened for the render test.
 */
function reactStub(openBooleans = false) {
  return {
    createElement,
    useState: (initial) => {
      const value = typeof initial === 'function' ? initial() : initial;
      return [openBooleans && value === false ? true : value, () => {}];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
  };
}

const React = reactStub();

/** Collect every string in the rendered tree, invoking function components. */
function textOf(node, out = [], depth = 0) {
  if (node == null || depth > 25) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out, depth);
    return out;
  }
  // A function component is an element whose type is a function: render it with
  // its props, which is what React would do.
  if (typeof node.type === 'function') {
    textOf(node.type(node.props), out, depth + 1);
    return out;
  }
  textOf(node.children, out, depth);
  return out;
}

/** Load the client module under a stubbed browser environment. */
async function load(react = React) {
  let plugin;
  const window = {
    __ModuleLoader__: {
      load: (descriptor) => {
        plugin = descriptor.factory((id) => (id === 'react' ? react : {}));
      },
    },
  };
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  };
  new Function('window', 'document', source)(window, document);
  return plugin;
}

/**
 * Apply the plugin to a stub context and return what it registered.
 * @param react - the React stub to load the module with.
 * @returns the registered dictionaries (by locale), the slot component, and
 *   the copy resolver the host would hand the component.
 */
async function boot(react = React) {
  const plugin = await load(react);
  const dictionaries = new Map();
  const effects = [];
  const components = [];
  const ctx = {
    effect: (fn) => {
      effects.push(fn);
      return () => {};
    },
    locale: {
      register: (ns, dicts) => {
        for (const [locale, dict] of Object.entries(dicts)) dictionaries.set(locale, dict);
      },
      // The real service returns the key itself on a miss.
      bind: (ns) => (key) => dictionaries.get('en')?.[key] ?? key,
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (_options, component) => {
        components.push(component);
        return component;
      },
    },
  };
  plugin.apply(ctx);
  for (const effect of effects) effect();

  const en = dictionaries.get('en');
  const t = new Proxy((key) => en?.[key], {
    get: (_target, key) => (key === 'then' ? undefined : en?.[key]),
  });
  return { plugin, dictionaries, components, t, ns: 'settings.claude-sub' };
}

// ---------------------------------------------------------------------------
// A React stub that holds state and runs mount effects, so the parts of the
// card that only appear after a fetch (quota windows, the settings panel) can
// be exercised. Instances are keyed by render path, which is stable here
// because the card's tree shape does not depend on the fetched data.
// ---------------------------------------------------------------------------

function liveReact() {
  const stores = new Map();
  const instances = [];
  let current = null;
  let dirty = false;
  const stack = [];

  const React = {
    createElement,
    useState(initial) {
      const store = current;
      const index = store.cursor++;
      if (store.hooks.length <= index) {
        store.hooks.push(typeof initial === 'function' ? initial() : initial);
      }
      return [
        store.hooks[index],
        (next) => {
          const value = typeof next === 'function' ? next(store.hooks[index]) : next;
          if (Object.is(value, store.hooks[index])) return;
          store.hooks[index] = value;
          dirty = true;
        },
      ];
    },
    useEffect: (fn) => current.effects.push(fn),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  };

  /**
   * Render one node, collecting text and every host element.
   *
   * Each element records the class-bearing ancestors it was rendered inside, so
   * a test can assert that one bordered container is not nested in another.
   * Newly mounted components are queued in `out.mounted` so their effects run
   * exactly once, the way a real mount would.
   */
  function walk(node, out) {
    if (node == null) return;
    if (typeof node === 'string' || typeof node === 'number') {
      out.text.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return;
    }
    if (typeof node.type === 'function') {
      const name = node.type.name || 'anonymous';
      stack.push(name);
      const path = stack.join('/');
      let store = stores.get(path);
      const isNew = store === undefined;
      if (isNew) {
        store = { hooks: [], effects: [], name };
        stores.set(path, store);
        instances.push(store);
      }
      const previous = current;
      current = store;
      store.cursor = 0;
      let tree;
      try {
        tree = node.type(node.props);
      } finally {
        current = previous;
        stack.pop();
      }
      if (isNew) out.mounted.push(store);
      walk(tree, out);
      return;
    }
    out.elements.push({
      type: node.type,
      props: node.props,
      children: node.children,
      ancestors: out.stack.slice(),
    });
    if (typeof node.props.className === 'string') {
      out.stack.push(node.props.className);
      walk(node.children, out);
      out.stack.pop();
      return;
    }
    walk(node.children, out);
  }

  // A fetch chain needs more than one macrotask to settle (fetch, then
  // response.json(), then the state update), so drain a few turns each round.
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /**
   * Render until no state change or pending effect is outstanding.
   * @returns the text, elements, and hook stores of the settled render.
   */
  async function settle(component, props, rounds = 12) {
    let out = { text: [], elements: [], stack: [], mounted: [] };
    for (let round = 0; round < rounds; round++) {
      dirty = false;
      const mounted = [];
      out = { text: [], elements: [], stack: [], mounted };
      stack.length = 0;
      walk(createElement(component, props), out);
      await flush();
      // Run the mount effects of components that just appeared.
      let ran = false;
      for (const store of mounted) {
        const effects = store.effects;
        store.effects = [];
        for (const fn of effects) {
          fn();
          ran = true;
        }
      }
      await flush();
      // Keep going while either an effect started a request whose state update
      // has not landed yet, or a state update is already queued.
      if (!dirty && !ran) break;
    }
    return { text: out.text.join(' '), elements: out.elements, instances };
  }

  return { React, settle, instances };
}

/** Find rendered elements whose className contains `name`. */
function byClass(elements, name) {
  return elements.filter((element) => {
    const className = element.props.className;
    return typeof className === 'string' && className.split(/\s+/).includes(name);
  });
}

/** Find rendered elements of one tag. */
function byType(elements, type) {
  return elements.filter((element) => element.type === type);
}

const API = '/plugins/dsh-ccsub';

/**
 * Install canned host responses for the duration of one test.
 *
 * Every request resolves 200 with the body registered for its path; unknown
 * paths answer `{}`. Returns the list of URLs requested, so a test can assert
 * that a panel really loaded its form.
 */
function stubFetch(t, responses) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => responses[String(url)] ?? {} };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return seen;
}

/** A status body with everything the card reads. */
function statusBody(overrides = {}) {
  return {
    mode: 'direct',
    loginAvailable: true,
    grant: { configured: true, expiresAt: Date.UTC(2026, 9, 24, 12, 0, 0) },
    proxy: {
      active: true,
      valid: true,
      url: 'http://egress.internal:3128',
      allow: ['203.0.113.7'],
      requireEgressCheck: true,
    },
    claudeCliVersion: '2.1.34',
    models: [{}, {}, {}],
    compat: { compatible: true, piAiVersion: '0.88.4', adapterVersion: '0.2.2' },
    claudeServer: { url: '', bearerConfigured: false, bearerRecord: 'claude-server' },
    ...overrides,
  };
}

/** A settings form body with everything the panel reads. */
function settingsBody(overrides = {}) {
  return {
    mode: 'direct',
    claudeServer: { url: '', bearerRecord: 'claude-server', bearerConfigured: false },
    claudeCliVersion: 'auto',
    contextWindowOverride: 0,
    refreshSkewMs: 300000,
    quotaPollMs: 180000,
    quotaThrottlePercent: 90,
    proxy: { url: 'http://egress.internal:3128', egressAllow: [], requireEgressCheck: true },
    resolved: { claudeCliVersion: '2.1.34' },
    ...overrides,
  };
}

test('the client module loads and exposes apply/inject', async () => {
  const plugin = await load();
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
});

test('apply registers one section and both dictionaries', async () => {
  const { dictionaries, components } = await boot();
  assert.equal(components.length, 1);
  assert.equal(dictionaries.get('en').title, 'Claude Subscription');
  assert.equal(dictionaries.get('zh').title, 'Claude 订阅');
});

test('the card renders its copy', async (t) => {
  // The signed-out card is the sign-in form now, and the form is only what a
  // real status produces: before the first fetch resolves the card renders its
  // loading state, so this settles a live render rather than a static one.
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  stubFetch(t, {
    [`${API}/status`]: statusBody({
      mode: 'claude-server',
      grant: { configured: false },
      claudeServer: { url: '', valid: false, bearerConfigured: false },
      proxy: { active: false, valid: false, url: '', allow: [], requireEgressCheck: true },
    }),
    [`${API}/quota`]: { windows: [] },
  });
  const { text } = await settle(components[0], { t: copy });
  assert.match(text, /Sign in to Claude/);
  assert.match(text, /Server address/);
});

test('opening the route settings disclosure renders the panel', async () => {
  // Boolean state starts `true` here, which is the disclosure open. The panel
  // itself fetches its form in an effect and shows a placeholder until it
  // arrives, so this asserts the disclosure opened and the component rendered
  // rather than that every label is already on screen.
  const { components, t } = await boot(reactStub(true));
  const text = textOf(components[0]({ t })).join(' ');
  assert.match(text, /Hide route settings/);
  assert.match(text, /Loading…/);
});

test('every component that reads `t.*` binds it from props', async () => {
  // The settings panel used to read `t.*` without ever binding `t`, so opening
  // the disclosure threw a ReferenceError and the panel never rendered.
  await boot();
  const lines = source.split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {4}function ([A-Za-z0-9_]+)\(props\) \{/.exec(lines[i]);
    if (m !== null) starts.push({ name: m[1], at: i });
  }
  assert.ok(starts.length >= 3, 'expected the card, settings, and section components');
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : lines.length;
    const body = lines.slice(starts[i].at, end);
    if (!body.some((line) => /\bt\.[A-Za-z]/.test(line))) continue;
    const header = body.slice(0, 10).join('\n');
    assert.match(header, /const t = props\.t;/, `${starts[i].name} reads t.* but never binds it`);
  }
});

test('every copy key the components read exists in both dictionaries', async () => {
  const { dictionaries } = await boot();
  const en = dictionaries.get('en');
  const zh = dictionaries.get('zh');
  assert.ok(en && zh, 'both dictionaries must register');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());

  // Any `t.foo` in the source must be a key: a typo would otherwise render as
  // an empty label with nothing failing.
  const used = new Set([...source.matchAll(/\bt\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((key) => !(key in en));
  assert.deepEqual(missing, [], `copy keys missing from the dictionary: ${missing.join(', ')}`);

  // And no key should be dead weight in both directions.
  const unused = Object.keys(en).filter((key) => !used.has(key));
  assert.deepEqual(unused, [], `copy keys defined but never read: ${unused.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Redesign guards. These protect the structure the card is built around: one
// bordered card with flat sections, a status header carrying the sign-in state,
// meters that report their value as text, and a disclosure that still opens.
// ---------------------------------------------------------------------------

test('the card is one bordered card whose sections are not nested boxes', async (t) => {
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  stubFetch(t, { [`${API}/status`]: statusBody(), [`${API}/quota`]: { windows: [] } });
  const { elements } = await settle(components[0], { t: copy });

  assert.equal(byClass(elements, 'ccsub-card').length, 1, 'exactly one card element');

  // Two content sections signed in: quota and egress. The state moved to the
  // one-line strip and transport moved into the sign-in form, so a third
  // section would mean one of them crept back as a panel.
  const sections = byClass(elements, 'ccsub-section');
  assert.ok(sections.length >= 2, 'the card renders its content sections');
  assert.equal(byClass(elements, 'ccsub-strip').length, 1, 'the state is one strip, not a section');

  // The old design nested a bordered `.ccsub-section` inside another bordered
  // box. Sections are now flat children of the single card, so no section may
  // have another section among its ancestors.
  for (const section of sections) {
    const nested = section.ancestors.some((className) =>
      className.split(/\s+/).includes('ccsub-section'),
    );
    assert.equal(nested, false, 'a section must not sit inside another section');
  }
});

test('the state strip leads the card and collapses the state to one row', async (t) => {
  // Signed in, the state is a single line rather than the old tall panel: the
  // dot, the label, the backing fact, and the sign-out action share a row.
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  stubFetch(t, { [`${API}/status`]: statusBody(), [`${API}/quota`]: { windows: [] } });
  const { text, elements } = await settle(components[0], { t: copy });

  const strips = byClass(elements, 'ccsub-strip');
  assert.equal(strips.length, 1, 'exactly one state strip');

  const labels = byClass(elements, 'ccsub-strip-label');
  assert.equal(labels.length, 1, 'one state label');
  assert.match(text, /Signed in/);

  // The dot is decorative: the state is carried by the text beside it.
  const dots = byClass(elements, 'ccsub-dot');
  assert.equal(dots.length, 1, 'one state dot');
  assert.equal(dots[0].props['aria-hidden'], 'true');

  // The strip precedes every content section, so the state is read first.
  const stripAt = elements.indexOf(strips[0]);
  const quotaAt = elements.indexOf(byClass(elements, 'ccsub-section')[0]);
  assert.ok(stripAt < quotaAt, 'the state strip renders before the sections');
});

test('a signed-out card is a sign-in form, not a dashboard', async (t) => {
  // The whole point of the redesign: signed out, there is exactly one thing to
  // do, and no quota/egress panel reports on a route that cannot send.
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  stubFetch(t, {
    [`${API}/status`]: statusBody({
      mode: 'claude-server',
      grant: { configured: false },
      claudeServer: { url: '', valid: false, bearerConfigured: false },
      proxy: { active: false, valid: false, url: '', allow: [], requireEgressCheck: true },
    }),
    [`${API}/quota`]: { windows: [] },
  });
  const { text, elements } = await settle(components[0], { t: copy });

  assert.equal(byClass(elements, 'ccsub-signin').length, 1, 'the sign-in form renders');
  assert.equal(byClass(elements, 'ccsub-strip').length, 0, 'no state strip while signed out');

  // The form asks for the two things a claude-server connect needs.
  const inputs = byClass(elements, 'ccsub-input');
  assert.ok(inputs.length >= 2, 'address and token inputs are on the form');
  assert.match(text, /Server address/);
  assert.match(text, /Access token/);

  // Connect is the primary action, and the panel sections are absent.
  const primary = byClass(elements, 'ccsub-btn').filter((b) =>
    String(b.props.className).includes('primary'),
  );
  assert.ok(primary.length >= 1, 'connect is the primary action');
  assert.match(text, /Connect/);
  assert.equal(byClass(elements, 'ccsub-meter').length, 0, 'no quota meters before sign-in');
});

test('in claude-server mode the strip names the backend address', async (t) => {
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  stubFetch(t, {
    [`${API}/status`]: statusBody({
      mode: 'claude-server',
      grant: { configured: false },
      claudeServer: { url: 'http://10.0.0.12:4710', valid: true, bearerConfigured: true, bearerRecord: 'claude-server' },
    }),
    [`${API}/quota`]: { windows: [] },
  });
  const { text, elements } = await settle(components[0], { t: copy });

  assert.match(text, /10\.0\.0\.12:4710/);
  assert.equal(byClass(elements, 'ccsub-strip-fact').length, 1);

  // Disconnect, not sign-out: this route never held the grant.
  assert.match(text, /Disconnect/);
});

test('a working claude-server route does not report itself as signed out', async (t) => {
  // In claude-server mode this process holds no grant — the deployment does — so
  // `grant.configured` is false on a route that works perfectly. Reading the
  // state through that field alone announced "Not signed in" on every healthy
  // claude-server install and offered a browser sign-in the route never uses.
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  stubFetch(t, {
    [`${API}/status`]: statusBody({
      mode: 'claude-server',
      grant: { configured: false },
      claudeServer: { url: 'https://claude.example', valid: true, bearerConfigured: true },
      proxy: { active: false, valid: true, url: 'http://127.0.0.1:9077', allow: [], requireEgressCheck: true },
    }),
    [`${API}/quota`]: { windows: [] },
  });
  const { text, elements } = await settle(components[0], { t: copy });

  assert.doesNotMatch(text, /Not signed in/, 'a working backend is not a signed-out state');
  const labels = byClass(elements, 'ccsub-strip-label');
  assert.equal(labels.length, 1);
  assert.match(String(labels[0].children ?? ''), /Connected/);

  // The dot is the success tone, because the route can send.
  const dots = byClass(elements, 'ccsub-dot');
  assert.equal(dots.length, 1);
  assert.ok(String(dots[0].props.className).includes('ok'), 'a connected backend takes the success tone');

  // No local browser sign-in: its result would never be read by this route.
  assert.doesNotMatch(text, /Sign in with browser/);
});

test('in claude-server mode an unconfigured backend is reported as a sign-in form', async (t) => {
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  stubFetch(t, {
    [`${API}/status`]: statusBody({
      mode: 'claude-server',
      grant: { configured: false },
      claudeServer: { url: '', valid: false, bearerConfigured: false },
      proxy: { active: false, valid: false, url: '', allow: [], requireEgressCheck: true },
    }),
    [`${API}/quota`]: { windows: [] },
  });
  const { text } = await settle(components[0], { t: copy });

  assert.doesNotMatch(text, /Not signed in/, 'the misleading label does not come back');
  assert.match(text, /Sign in to Claude/, 'the sign-in form is what an unconfigured backend shows');
  assert.doesNotMatch(text, /Sign in with browser/, 'claude-server never offers the browser flow');
});

test('meters render each window with its percentage as text and a hidden bar', async (t) => {
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  stubFetch(t, {
    [`${API}/status`]: statusBody(),
    [`${API}/quota`]: {
      windows: [
        { kind: 'session', usedPercent: 42, resetsAt: Date.UTC(2026, 9, 24, 12, 0, 0) },
        { kind: 'weekly', usedPercent: 78 },
        { kind: 'weekly', scope: 'opus', usedPercent: 96 },
      ],
    },
  });
  const { text, elements } = await settle(components[0], { t: copy });

  // One row per window: name, percentage, bar, reset caption.
  assert.equal(byClass(elements, 'ccsub-meter').length, 3);
  assert.equal(byClass(elements, 'ccsub-meter-name').length, 3);
  assert.equal(byClass(elements, 'ccsub-meter-pct').length, 3);
  assert.equal(byClass(elements, 'ccsub-meter-track').length, 3);
  assert.equal(byClass(elements, 'ccsub-meter-reset').length, 3);

  // The value is text, so it survives a screen reader and a 320px column.
  // (The stub keeps children on the element, not in props, so read them from
  // the element itself.)
  const percentTexts = byClass(elements, 'ccsub-meter-pct').map((element) =>
    element.children.join(''),
  );
  assert.deepEqual(percentTexts, ['42% used', '78% used', '96% used']);

  // The bar itself is decorative, and its width carries the same value.
  for (const track of byClass(elements, 'ccsub-meter-track')) {
    assert.equal(track.props['aria-hidden'], 'true');
  }
  const fills = byClass(elements, 'ccsub-meter-fill');
  assert.deepEqual(
    fills.map((element) => element.props.style.width),
    ['42%', '78%', '96%'],
  );

  // Colour is not the only signal: warn at 70%, critical at 90%.
  const classes = fills.map((element) => element.props.className);
  assert.equal(classes[0].includes('warn'), false, '42% is not a warning');
  assert.ok(classes[1].includes('warn'), '78% is a warning');
  assert.ok(classes[2].includes('critical'), '96% is critical');

  assert.match(text, /Reset time unknown/);
});

test('the route-settings disclosure reports its state and opens the panel', async (t) => {
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle, instances } = runtime;
  const seen = stubFetch(t, {
    [`${API}/status`]: statusBody(),
    [`${API}/quota`]: { windows: [] },
    [`${API}/settings`]: settingsBody(),
  });

  const closed = await settle(components[0], { t: copy });
  const buttons = byClass(closed.elements, 'ccsub-disclosure-btn');
  assert.equal(buttons.length, 1, 'one disclosure button');
  assert.equal(buttons[0].props['aria-expanded'], 'false', 'collapsed by default');
  assert.equal(buttons[0].props['aria-controls'], 'ccsub-route-settings');
  assert.match(closed.text, /Route settings/);
  assert.match(closed.text, /Proxy, context window, timing/);

  // Flip the section's own disclosure state, the way a click would.
  const section = instances.find((store) => store.name === 'ClaudeSubscriptionSection');
  assert.ok(section, 'the section component rendered');
  section.hooks[0] = true;

  const open = await settle(components[0], { t: copy });
  assert.match(open.text, /Hide route settings/);
  assert.match(open.text, /Set-and-forget options for this route/);
  assert.match(open.text, /Save settings/);
  assert.equal(byClass(open.elements, 'ccsub-disclosure-btn')[0].props['aria-expanded'], 'true');
  assert.ok(
    seen.some((url) => url.endsWith('/settings')),
    'opening the panel fetched the settings form',
  );
});

test('an error that follows a failed read is announced with role="alert"', async (t) => {
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/status')) {
      return { ok: false, status: 500, json: async () => ({ error: 'host refused' }) };
    }
    return { ok: true, status: 200, json: async () => ({ windows: [] }) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const { text, elements } = await settle(components[0], { t: copy });
  assert.match(text, /host refused/);
  const alerts = elements.filter((element) => element.props.role === 'alert');
  assert.ok(alerts.length >= 1, 'the error line carries role="alert"');
});

test('every control has an accessible name and icons are hidden from AT', async (t) => {
  const runtime = liveReact();
  const { components, t: copy } = await boot(runtime.React);
  const { settle } = runtime;
  stubFetch(t, { [`${API}/status`]: statusBody(), [`${API}/quota`]: { windows: [] } });
  const { elements } = await settle(components[0], { t: copy });

  // A control is named either by a label pointing at its id or by aria-label.
  const labelled = new Set(
    elements
      .filter((element) => element.type === 'label' && typeof element.props.htmlFor === 'string')
      .map((element) => element.props.htmlFor),
  );
  for (const element of elements) {
    if (element.type !== 'input' && element.type !== 'select' && element.type !== 'textarea') continue;
    const named = typeof element.props['aria-label'] === 'string' || labelled.has(element.props.id);
    assert.ok(named, `a ${element.type} has no accessible name`);
  }

  // Decorative SVGs never enter the accessibility tree.
  const svgs = byType(elements, 'svg');
  assert.ok(svgs.length >= 1, 'the select uses an inline SVG glyph');
  for (const svg of svgs) {
    assert.equal(svg.props['aria-hidden'], 'true');
    assert.equal(svg.props.focusable, 'false');
  }
});

test('every class used in the markup has a rule in the injected stylesheet', async () => {
  // A renamed class whose CSS rule was not renamed is invisible to the render
  // tests and shows up only as an unstyled card in the browser, so check the
  // two sides against each other.
  const cssStart = source.indexOf('const CSS = `');
  const cssEnd = source.indexOf('`;', cssStart);
  assert.ok(cssStart > 0 && cssEnd > cssStart, 'the stylesheet string is present');
  const css = source.slice(cssStart, cssEnd);

  const styled = new Set([...css.matchAll(/\.(ccsub-[A-Za-z0-9_-]+)/g)].map((match) => match[1]));
  const ids = new Set([...source.matchAll(/id: '(ccsub-[A-Za-z0-9_-]+)'/g)].map((match) => match[1]));
  const outsideCss = source.slice(0, cssStart) + source.slice(cssEnd);
  const used = new Set([...outsideCss.matchAll(/ccsub-[A-Za-z0-9_-]+/g)].map((match) => match[0]));

  const unstyled = [...used].filter((name) => !styled.has(name) && !ids.has(name));
  assert.deepEqual(unstyled, [], `classes with no CSS rule: ${unstyled.join(', ')}`);

  // And no rule is dead weight.
  const unused = [...styled].filter((name) => !used.has(name));
  assert.deepEqual(unused, [], `CSS rules never used in markup: ${unused.join(', ')}`);
});

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

test('the card renders its copy', async () => {
  const { components, t } = await boot();
  const text = textOf(components[0]({ t })).join(' ');
  assert.match(text, /Claude Subscription/);
  assert.match(text, /Where the subscription lives/);
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

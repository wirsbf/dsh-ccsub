/**
 * The operator console: a single page for managing this server's subscription.
 *
 * ## Why this is not authenticated by the client bearer
 *
 * `/login/*` can mint or replace the Claude grant. A browser cannot send an
 * `Authorization` header on a top-level navigation, so a bearer-protected page
 * could not be opened at all. The page therefore has its own session: the
 * operator pastes the client bearer **into the form**, the server verifies it
 * once, and hands back an HttpOnly cookie. The bearer never appears in a URL,
 * a redirect, or a log line.
 *
 * ## Why the session is not a capability escalation
 *
 * A session cookie is worth exactly what the bearer is worth: both let the
 * holder call `/login/*`. The cookie is strictly weaker than the bearer — it is
 * scoped to this server's admin path, dies with the process, and cannot be
 * replayed against the relay. Nothing here reaches the Claude token; the token
 * stays inside the relay process and is never serialised into any response.
 *
 * ## What it deliberately does not do
 *
 * No token display, no grant download, no "reveal" affordance. The only
 * credential-shaped output is an expiry timestamp, which the relay already
 * reports through `/status`.
 *
 * @module claude-server/admin
 */

import { randomBytes } from 'node:crypto';

/** Cookie name for the console session. */
export const ADMIN_COOKIE = 'claude_server_admin';

/** How long one console session lasts. */
const SESSION_TTL_MS = 30 * 60_000;

/** Upper bound on concurrent sessions; the console is single-operator. */
const MAX_SESSIONS = 8;

/** Path prefix owned by the console. */
export const ADMIN_PREFIX = '/admin';

/**
 * In-memory console sessions.
 *
 * Sessions are process-local on purpose: a restart invalidates every console
 * login, which is the correct default for a credential-management surface.
 */
export class AdminSessions {
  #ttlMs;
  #sessions = new Map();

  /**
   * @param options - TTL override, mainly for tests.
   */
  constructor(options = {}) {
    this.#ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  }

  /** Drop expired sessions. */
  #sweep() {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }

  /**
   * Mint one session after the caller proved it holds the client bearer.
   * @returns the opaque session id.
   */
  create() {
    this.#sweep();
    if (this.#sessions.size >= MAX_SESSIONS) {
      // Evict the oldest rather than refusing: a stale tab must never lock the
      // operator out of revoking a grant.
      const oldest = [...this.#sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest !== undefined) this.#sessions.delete(oldest[0]);
    }
    const id = randomBytes(24).toString('hex');
    this.#sessions.set(id, { expiresAt: Date.now() + this.#ttlMs });
    return id;
  }

  /**
   * Whether a session id is live.
   * @param id - the cookie value.
   * @returns true when usable.
   */
  valid(id) {
    this.#sweep();
    const session = this.#sessions.get(String(id ?? ''));
    return session !== undefined && session.expiresAt > Date.now();
  }

  /** Revoke one session. */
  destroy(id) {
    this.#sessions.delete(String(id ?? ''));
  }
}

/** Parse one cookie value out of a Cookie header without a general parser. */
export function cookieOf(header, name) {
  if (typeof header !== 'string' || header.length === 0) return undefined;
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=');
    if (at < 0) continue;
    if (segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Render the console page.
 *
 * One self-contained document: no build step, no external asset, no framework.
 * The bearer input is the only field that can carry a secret, and it is
 * `type=password` with autocomplete disabled so a borrowed browser does not
 * offer to remember it.
 * @param options - values the page needs at render time.
 * @returns the HTML.
 */
export function renderAdminPage(options = {}) {
  const signedIn = options.signedIn === true;
  const mode = String(options.mode ?? 'unknown');
  const expiresAt = typeof options.expiresAt === 'number' ? options.expiresAt : null;
  const authed = options.authed === true;
  const notice = options.notice === undefined ? '' : String(options.notice);
  const error = options.error === undefined ? '' : String(options.error);

  // Everything interpolated below is either a server-controlled constant or a
  // number this server computed. The two message slots are escaped anyway, so a
  // future call site cannot turn one into markup by accident.
  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  const expiry = expiresAt === null ? '—' : new Date(expiresAt).toISOString().replace('T', ' ').replace(/\..*$/, ' UTC');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>claude-server · console</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem;
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0f1115; color: #e6e8ee;
  }
  @media (prefers-color-scheme: light) { body { background: #f6f7f9; color: #1c1f26; } }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.15rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
  .sub { margin: 0 0 1.5rem; opacity: .62; }
  section {
    border: 1px solid #2a2f3a; border-radius: 10px;
    padding: 1rem 1.1rem; margin: 0 0 1rem; background: #161a21;
  }
  @media (prefers-color-scheme: light) { section { border-color: #dfe3ea; background: #fff; } }
  h2 { font-size: .8rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; opacity: .55; margin: 0 0 .8rem; }
  dl { display: grid; grid-template-columns: 9rem 1fr; gap: .4rem .8rem; margin: 0; }
  dt { opacity: .6; }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .78rem; font-weight: 600; }
  .on { background: #14361f; color: #6ee7a0; }
  .off { background: #3a1d1d; color: #f6a3a3; }
  @media (prefers-color-scheme: light) {
    .on { background: #dcfce7; color: #15803d; }
    .off { background: #fee2e2; color: #b91c1c; }
  }
  label { display: block; margin: 0 0 .3rem; opacity: .7; }
  input[type=text], input[type=password] {
    width: 100%; padding: .55rem .65rem; border-radius: 7px;
    border: 1px solid #333a47; background: #0d1015; color: inherit; font: inherit;
  }
  @media (prefers-color-scheme: light) {
    input[type=text], input[type=password] { border-color: #cfd6e0; background: #fff; }
  }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-top: .7rem; }
  button {
    padding: .5rem .85rem; border-radius: 7px; border: 1px solid #3b4255;
    background: #232936; color: inherit; font: inherit; cursor: pointer;
  }
  button:hover { background: #2c3444; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.primary { background: #2f6df6; border-color: #2f6df6; color: #fff; }
  button.primary:hover { background: #3b78ff; }
  button.danger { border-color: #7f2b2b; color: #f6a3a3; }
  button.danger:hover { background: #2a1a1a; }
  @media (prefers-color-scheme: light) {
    button { border-color: #cfd6e0; background: #f1f3f7; }
    button:hover { background: #e6eaf1; }
    button.primary { background: #2f6df6; border-color: #2f6df6; color: #fff; }
    button.danger { border-color: #f0b4b4; color: #b91c1c; }
    button.danger:hover { background: #fdeaea; }
  }
  .hint { opacity: .55; font-size: .86rem; margin: .55rem 0 0; }
  .msg { margin: 0 0 1rem; padding: .6rem .8rem; border-radius: 7px; font-size: .9rem; }
  .msg.ok { background: #14361f; color: #6ee7a0; }
  .msg.err { background: #3a1d1d; color: #f6a3a3; }
  @media (prefers-color-scheme: light) {
    .msg.ok { background: #dcfce7; color: #15803d; }
    .msg.err { background: #fee2e2; color: #b91c1c; }
  }
  .meter { height: 6px; border-radius: 999px; background: #2a2f3a; overflow: hidden; margin: .35rem 0 .15rem; }
  @media (prefers-color-scheme: light) { .meter { background: #e3e7ee; } }
  .meter > span { display: block; height: 100%; border-radius: 999px; background: #2f6df6; }
  .meter > span.warn { background: #d97706; }
  .meter > span.over { background: #dc2626; }
  .use { display: grid; grid-template-columns: 8rem 1fr 7rem; gap: .5rem .8rem; align-items: center; }
  .use-label { opacity: .72; text-transform: capitalize; }
  .use-val { text-align: right; font-variant-numeric: tabular-nums; opacity: .85; }
  ul.models { list-style: none; margin: 0; padding: 0; display: grid; gap: .3rem; }
  ul.models li { display: flex; gap: .6rem; align-items: baseline; }
  ul.models code { flex: 1; }
  ul.models .pill { font-size: .7rem; }
  code { font: .86em ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>claude-server · console</h1>
  <p class="sub">Manage the Claude subscription this server holds.</p>
  ${notice === '' ? '' : `<p class="msg ok">${esc(notice)}</p>`}
  ${error === '' ? '' : `<p class="msg err">${esc(error)}</p>`}

  <section>
    <h2>State</h2>
    <dl>
      <dt>Signed in</dt>
      <dd><span class="pill ${signedIn ? 'on' : 'off'}">${signedIn ? 'yes' : 'no'}</span></dd>
      <dt>Access expires</dt>
      <dd>${signedIn ? esc(expiry) : '—'}</dd>
      <dt>Upstream mode</dt>
      <dd><code>${esc(mode)}</code></dd>
    </dl>
  </section>

  ${
    authed
      ? `<section>
    <h2>Subscription limits</h2>
    <div class="row" style="margin-top:0">
      <button id="refresh-usage">Refresh</button>
      <span class="hint" id="usage-age" style="margin:0"></span>
    </div>
    <div id="usage-body" style="margin-top:.8rem"><p class="hint" style="margin:0">Loading…</p></div>
  </section>

  <section>
    <h2>Models</h2>
    <div class="row" style="margin-top:0">
      <button id="refresh-models">Refresh</button>
      <span class="hint" id="models-count" style="margin:0"></span>
    </div>
    <div id="models-body" style="margin-top:.8rem"><p class="hint" style="margin:0">Loading…</p></div>
  </section>`
      : ''
  }

  ${
    authed
      ? `<section>
    <h2>Sign in to Claude</h2>
    <p class="hint" style="margin-top:0">
      Opens Anthropic's authorize page in a new tab. After you approve, the browser lands on a
      <code>localhost</code> address that is not served — copy that full address from the bar and paste it below.
    </p>
    <div class="row">
      <button class="primary" id="start">Start sign-in</button>
      <button id="cancel" disabled>Cancel pending</button>
    </div>
    <div id="stage" style="margin-top:.9rem"></div>
  </section>

  <section>
    <h2>Session</h2>
    <div class="row">
      <button id="forget">Sign out of console</button>
    </div>
    <p class="hint">Ends this browser session only. The Claude grant stays on the server.</p>
  </section>`
      : `<section>
    <h2>Unlock</h2>
    <p class="hint" style="margin-top:0">
      Paste this server's <code>CLIENT_BEARER</code>. It is verified once and exchanged for an
      <code>HttpOnly</code> session cookie; it is never stored in the page or echoed back.
    </p>
    <label for="bearer">Client bearer</label>
    <input id="bearer" type="password" autocomplete="off" spellcheck="false" placeholder="at least 24 characters">
    <div class="row">
      <button class="primary" id="unlock">Unlock</button>
    </div>
  </section>`
  }
</main>
<script>
(() => {
  const AUTHD = ${authed ? 'true' : 'false'};
  const stage = document.getElementById('stage');

  /** POST JSON to an admin endpoint; returns {ok, body}. */
  const post = async (path, payload) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      credentials: 'same-origin',
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  };

  const unlock = document.getElementById('unlock');
  if (unlock) {
    const input = document.getElementById('bearer');
    const go = async () => {
      unlock.disabled = true;
      const r = await post('/admin/session', { bearer: input.value });
      if (r.ok) location.reload();
      else {
        unlock.disabled = false;
        alert((r.body && r.body.error) || ('HTTP ' + r.status));
      }
    };
    unlock.addEventListener('click', () => void go());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void go(); });
    input.focus();
  }

  const forget = document.getElementById('forget');
  if (forget) {
    forget.addEventListener('click', async () => {
      await post('/admin/logout');
      location.reload();
    });
  }

  if (AUTHD) {
    // ---- subscription limits -------------------------------------------------
    const usageBody = document.getElementById('usage-body');
    const usageAge = document.getElementById('usage-age');

    // Anthropic reports limits two ways; the structured 'limits' array is the
    // current shape and the flat five_hour/seven_day buckets are the older one.
    // Read the array when it carries entries, else fall back, so the panel keeps
    // working across either response.
    const windowsOf = (usage) => {
      const out = [];
      if (Array.isArray(usage && usage.limits)) {
        for (const row of usage.limits) {
          if (!row || typeof row.percent !== 'number') continue;
          out.push({ label: row.kind || row.group || 'limit', percent: row.percent, resetsAt: row.resets_at || null });
        }
      }
      if (out.length === 0) {
        for (const [key, label] of [['five_hour', '5-hour'], ['seven_day', 'weekly']]) {
          const row = usage && usage[key];
          if (!row || typeof row.utilization !== 'number') continue;
          out.push({ label, percent: row.utilization, resetsAt: row.resets_at || null });
        }
      }
      return out;
    };

    const renderUsage = (usage) => {
      const rows = windowsOf(usage);
      if (rows.length === 0) {
        usageBody.innerHTML = '<p class="hint" style="margin:0">No limit windows reported.</p>';
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'use';
      for (const row of rows) {
        const label = document.createElement('span');
        label.className = 'use-label';
        label.textContent = row.label;

        const bar = document.createElement('div');
        bar.className = 'meter';
        const fill = document.createElement('span');
        const pct = Math.max(0, Math.min(100, row.percent));
        fill.style.width = pct + '%';
        if (pct >= 90) fill.className = 'over';
        else if (pct >= 70) fill.className = 'warn';
        bar.append(fill);

        const val = document.createElement('span');
        val.className = 'use-val';
        val.textContent = row.percent.toFixed(0) + '%' +
          (row.resetsAt ? ' · resets ' + new Date(row.resetsAt).toLocaleString() : '');

        wrap.append(label, bar, val);
      }
      usageBody.innerHTML = '';
      usageBody.append(wrap);
    };

    const loadUsage = async () => {
      usageAge.textContent = 'loading…';
      try {
        const r = await fetch('/admin/quota', { credentials: 'same-origin' });
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          usageBody.innerHTML = '';
          const p = document.createElement('p');
          p.className = 'msg err';
          p.style.margin = '0';
          p.textContent = (body && body.error) || ('HTTP ' + r.status);
          usageBody.append(p);
          usageAge.textContent = '';
          return;
        }
        renderUsage(body.usage);
        usageAge.textContent = 'updated ' + new Date().toLocaleTimeString();
      } catch (e) {
        usageAge.textContent = String(e.message || e);
      }
    };

    // ---- models --------------------------------------------------------------
    const modelsBody = document.getElementById('models-body');
    const modelsCount = document.getElementById('models-count');

    const loadModels = async () => {
      modelsCount.textContent = 'loading…';
      try {
        const r = await fetch('/admin/models', { credentials: 'same-origin' });
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          modelsBody.innerHTML = '';
          const p = document.createElement('p');
          p.className = 'msg err';
          p.style.margin = '0';
          p.textContent = (body && body.error) || ('HTTP ' + r.status);
          modelsBody.append(p);
          modelsCount.textContent = '';
          return;
        }
        const list = document.createElement('ul');
        list.className = 'models';
        for (const model of body.models || []) {
          const li = document.createElement('li');
          const code = document.createElement('code');
          code.textContent = model.id;
          li.append(code);
          if (model.displayName && model.displayName !== model.id) {
            const name = document.createElement('span');
            name.className = 'hint';
            name.style.margin = '0';
            name.textContent = model.displayName;
            li.append(name);
          }
          list.append(li);
        }
        modelsBody.innerHTML = '';
        modelsBody.append(list);
        modelsCount.textContent = (body.models || []).length + ' available';
      } catch (e) {
        modelsCount.textContent = String(e.message || e);
      }
    };

    document.getElementById('refresh-usage').addEventListener('click', () => void loadUsage());
    document.getElementById('refresh-models').addEventListener('click', () => void loadModels());
    void loadUsage();
    void loadModels();

    const start = document.getElementById('start');
    const cancel = document.getElementById('cancel');
    let currentId = null;

    const showPaste = (id, url) => {
      currentId = id;
      cancel.disabled = false;
      stage.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.marginTop = '0';
      p.textContent = 'If the tab did not open, use this link:';
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open authorize page';
      stage.append(p, a);

      const label = document.createElement('label');
      label.textContent = 'Paste the full callback address';
      label.style.marginTop = '.9rem';
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = 'http://localhost:53692/callback?code=…&state=…';
      const row = document.createElement('div');
      row.className = 'row';
      const submit = document.createElement('button');
      submit.className = 'primary';
      submit.textContent = 'Finish sign-in';
      const err = document.createElement('p');
      err.className = 'msg err';
      err.style.display = 'none';

      submit.addEventListener('click', async () => {
        submit.disabled = true;
        const r = await post('/admin/login/complete', { id: currentId, code: input.value });
        if (r.ok) location.reload();
        else {
          submit.disabled = false;
          err.style.display = 'block';
          err.textContent = (r.body && r.body.error) || ('HTTP ' + r.status);
        }
      });
      row.append(submit);
      stage.append(label, input, row, err);
      input.focus();
    };

    start.addEventListener('click', async () => {
      start.disabled = true;
      const r = await post('/admin/login/start');
      if (r.ok && r.body && r.body.url) {
        window.open(r.body.url, '_blank', 'noopener');
        showPaste(r.body.id, r.body.url);
      } else {
        start.disabled = false;
        alert((r.body && r.body.error) || ('HTTP ' + r.status));
      }
    });

    cancel.addEventListener('click', async () => {
      if (currentId) await post('/admin/login/cancel', { id: currentId });
      location.reload();
    });
  }
})();
</script>
</body>
</html>`;
}

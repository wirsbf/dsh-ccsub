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
import { ADMIN_STYLE } from './admin-style.js';

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
<style>${ADMIN_STYLE}</style>
</head>
<body>
<main>
  <header class="masthead">
    <h1><span class="mark" aria-hidden="true"></span>claude-server</h1>
    <p>Manage the Claude subscription this server holds.</p>
  </header>
  ${notice === '' ? '' : `<p class="msg ok">${esc(notice)}</p>`}
  ${error === '' ? '' : `<p class="msg err">${esc(error)}</p>`}

  <section class="card">
    <h2>State</h2>
    <dl class="facts">
      <dt>Signed in</dt>
      <dd><span class="pill ${signedIn ? 'on' : 'off'}">${signedIn ? 'signed in' : 'not signed in'}</span></dd>
      <dt>Access expires</dt>
      <dd>${signedIn ? esc(expiry) : '—'}</dd>
      <dt>Upstream mode</dt>
      <dd><code>${esc(mode)}</code></dd>
    </dl>
  </section>

  ${
    authed
      ? `<section class="card">
    <h2>Subscription limits<span class="actions"><span class="hint" id="usage-age" style="margin:0"></span><button class="small" id="refresh-usage">Refresh</button></span></h2>
    <div id="usage-body"><p class="empty">Loading…</p></div>
  </section>

  <section class="card">
    <h2>Models<span class="actions"><span class="hint" id="models-count" style="margin:0"></span><button class="small" id="refresh-models">Refresh</button></span></h2>
    <div id="models-body"><p class="empty">Loading…</p></div>
  </section>

  <section class="card">
    <h2>Token usage<span class="actions"><span class="hint" id="tokens-since" style="margin:0"></span><button class="small" id="refresh-usage-tokens">Refresh</button></span></h2>
    <div id="tokens-body"><p class="empty">Loading…</p></div>
    <p class="note">Counted from responses relayed by this process, and reset when it restarts.</p>
  </section>`
      : ''
  }

  ${
    authed
      ? `<section class="card">
    <h2>Sign in to Claude</h2>
    <p class="note" style="margin:0 0 var(--s-3)">
      Opens Anthropic's authorize page in a new tab. After you approve, the browser lands on a
      <code>localhost</code> address that is not served — copy that full address from the bar and paste it below.
    </p>
    <div class="row top">
      <button class="primary" id="start">Start sign-in</button>
      <button id="cancel" disabled>Cancel pending</button>
    </div>
    <div id="stage"></div>
  </section>

  <section class="card">
    <h2>Session</h2>
    <div class="row top">
      <button class="danger" id="forget">Sign out of console</button>
    </div>
    <p class="note">Ends this browser session only. The Claude grant stays on the server.</p>
  </section>`
      : `<section>
    <h2>Unlock</h2>
    <p class="note" style="margin:0 0 var(--s-3)">
      Paste this server's <code>CLIENT_BEARER</code>. It is verified once and exchanged for an
      <code>HttpOnly</code> session cookie; it is never stored in the page or echoed back.
    </p>
    <div class="field">
      <label for="bearer">Client bearer</label>
      <input id="bearer" type="password" autocomplete="off" spellcheck="false" placeholder="at least 24 characters">
    </div>
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

    /** Human-readable name for a limit window key. */
    const windowName = (label) =>
      String(label).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    const renderUsage = (usage) => {
      const rows = windowsOf(usage);
      if (rows.length === 0) {
        usageBody.innerHTML = '<p class="empty">No limit windows reported.</p>';
        return;
      }
      usageBody.innerHTML = '';
      for (const row of rows) {
        const box = document.createElement('div');
        box.className = 'window';

        const head = document.createElement('div');
        head.className = 'window-head';
        const name = document.createElement('span');
        name.className = 'window-name';
        name.textContent = windowName(row.label);
        const figure = document.createElement('span');
        figure.className = 'window-figure';
        figure.textContent = row.percent.toFixed(0) + '%';
        head.append(name, figure);

        const bar = document.createElement('div');
        bar.className = 'meter';
        // The meter is decorative; the figure above and the reset line below
        // carry the same information as text, so this needs no ARIA role.
        bar.setAttribute('aria-hidden', 'true');
        const fill = document.createElement('span');
        const pct = Math.max(0, Math.min(100, row.percent));
        fill.style.width = pct + '%';
        if (pct >= 90) fill.className = 'over';
        else if (pct >= 70) fill.className = 'warn';
        bar.append(fill);

        box.append(head, bar);

        if (row.resetsAt) {
          const reset = document.createElement('p');
          reset.className = 'window-reset';
          reset.textContent = 'Resets ' + new Date(row.resetsAt).toLocaleString();
          box.append(reset);
        }
        usageBody.append(box);
      }
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
        const models = body.models || [];
        if (models.length === 0) {
          modelsBody.innerHTML = '<p class="empty">The endpoint reported no models.</p>';
          modelsCount.textContent = '';
          return;
        }
        // A table rather than a list: the id and its display name are two
        // columns of the same fact, and aligning them makes a long catalog
        // scannable.
        const table = document.createElement('table');
        table.className = 'grid';
        const head = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const label of ['Model id', 'Name']) {
          const th = document.createElement('th');
          th.textContent = label;
          headRow.append(th);
        }
        head.append(headRow);
        const bodyEl = document.createElement('tbody');
        for (const model of models) {
          const tr = document.createElement('tr');
          const idCell = document.createElement('td');
          idCell.className = 'name';
          const code = document.createElement('code');
          code.textContent = model.id;
          idCell.append(code);
          const nameCell = document.createElement('td');
          nameCell.textContent =
            model.displayName && model.displayName !== model.id ? model.displayName : '—';
          tr.append(idCell, nameCell);
          bodyEl.append(tr);
        }
        table.append(head, bodyEl);
        modelsBody.innerHTML = '';
        modelsBody.append(table);
        modelsCount.textContent = models.length + ' available';
      } catch (e) {
        modelsCount.textContent = String(e.message || e);
      }
    };

    // ---- token accounting ----------------------------------------------------
    const tokensBody = document.getElementById('tokens-body');
    const tokensSince = document.getElementById('tokens-since');

    const num = (n) => (typeof n === 'number' ? n.toLocaleString() : '0');

    /** Build a table with a header row and rows of strings. */
    const makeTable = (headers, rows, numericFrom) => {
      const table = document.createElement('table');
      table.className = 'grid';
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      headers.forEach((label, index) => {
        const th = document.createElement('th');
        th.textContent = label;
        if (index >= numericFrom) th.className = 'num';
        headRow.append(th);
      });
      head.append(headRow);
      const body = document.createElement('tbody');
      for (const row of rows) {
        const tr = document.createElement('tr');
        row.forEach((value, index) => {
          const td = document.createElement('td');
          td.textContent = value;
          if (index >= numericFrom) td.className = 'num';
          else if (index === 0) td.className = 'name';
          tr.append(td);
        });
        body.append(tr);
      }
      table.append(head, body);
      return table;
    };

    const renderTokens = (data) => {
      tokensBody.innerHTML = '';
      const totals = data.totals || {};
      if (!totals.calls) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'No relayed calls since this process started.';
        tokensBody.append(p);
        return;
      }

      tokensBody.append(
        makeTable(
          ['Total', 'Calls', 'Input', 'Output', 'Cache read', 'Cache write'],
          [[
            'All models',
            num(totals.calls),
            num(totals.input_tokens),
            num(totals.output_tokens),
            num(totals.cache_read_input_tokens),
            num(totals.cache_creation_input_tokens),
          ]],
          1,
        ),
      );

      const models = data.byModel || [];
      if (models.length > 0) {
        const h = document.createElement('h3');
        h.className = 'subhead';
        h.textContent = 'By model';
        tokensBody.append(h);
        tokensBody.append(
          makeTable(
            ['Model', 'Calls', 'Input', 'Output', 'Cache read', 'Cache write'],
            models.map((row) => [
              row.model,
              num(row.calls),
              num(row.input_tokens),
              num(row.output_tokens),
              num(row.cache_read_input_tokens),
              num(row.cache_creation_input_tokens),
            ]),
            1,
          ),
        );
      }

      const recent = data.recent || [];
      if (recent.length > 0) {
        const h = document.createElement('h3');
        h.className = 'subhead';
        h.textContent = 'Recent calls';
        tokensBody.append(h);
        tokensBody.append(
          makeTable(
            ['Time', 'Model', 'Input', 'Output', 'Duration'],
            recent.slice(0, 10).map((call) => [
              new Date(call.at).toLocaleTimeString(),
              call.model || '(unknown)',
              num(call.input_tokens),
              num(call.output_tokens),
              call.durationMs === null ? '—' : (call.durationMs / 1000).toFixed(1) + 's',
            ]),
            2,
          ),
        );
      }
    };

    const loadTokens = async () => {
      tokensSince.textContent = 'loading…';
      try {
        const r = await fetch('/admin/usage', { credentials: 'same-origin' });
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          tokensBody.innerHTML = '';
          const p = document.createElement('p');
          p.className = 'msg err';
          p.style.margin = '0';
          p.textContent = (body && body.error) || ('HTTP ' + r.status);
          tokensBody.append(p);
          tokensSince.textContent = '';
          return;
        }
        renderTokens(body);
        tokensSince.textContent = 'since ' + new Date(body.since).toLocaleString();
      } catch (e) {
        tokensSince.textContent = String(e.message || e);
      }
    };

    document.getElementById('refresh-usage').addEventListener('click', () => void loadUsage());
    document.getElementById('refresh-models').addEventListener('click', () => void loadModels());
    document.getElementById('refresh-usage-tokens').addEventListener('click', () => void loadTokens());
    void loadUsage();
    void loadModels();
    void loadTokens();

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

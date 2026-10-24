/**
 * The operator console: the pages behind `/admin`.
 *
 * ## Why this is not authenticated by the client bearer
 *
 * The console can mint access tokens and replace the Claude grant. A browser
 * cannot send an `Authorization` header on a top-level navigation, so a
 * bearer-protected page could not be opened at all. The console therefore has
 * its own session: the operator pastes an admin token **into the form**, the
 * server verifies it once, and hands back an HttpOnly cookie. The token never
 * appears in a URL, a redirect, or a log line.
 *
 * ## Why one shell serves five pages
 *
 * These pages share a navigation rail, a type scale, and a set of table and card
 * primitives. Serving them from one renderer means the chrome cannot drift: a
 * change to the sidebar is a change to every page. Routing is server-side
 * because a session lives in a cookie and each page must be refused (or
 * redirected) before any markup is produced — a client-side router would have to
 * ship the authenticated shell to an unauthenticated caller and then hide it.
 *
 * ## What it deliberately does not do
 *
 * No grant display, no grant download, no "reveal" affordance for the Claude
 * token. The one credential-shaped output is a newly created user token, shown
 * exactly once because there is no way to show it twice: only its hash is
 * stored. Every other identity value on these pages is an id, a name, or a
 * timestamp.
 *
 * @module claude-server/admin
 */

import { randomBytes } from 'node:crypto';
import { ADMIN_STYLE } from './admin-style.js';
import { TOKEN_PREFIX } from './users.js';

/** Cookie name for the console session. */
export const ADMIN_COOKIE = 'claude_server_admin';

/** How long one console session lasts. */
const SESSION_TTL_MS = 30 * 60_000;

/** Upper bound on concurrent sessions; the console is single-operator. */
const MAX_SESSIONS = 8;

/** Path prefix owned by the console. */
export const ADMIN_PREFIX = '/admin';

/** Where an unlocked console lands. */
export const ADMIN_HOME = `${ADMIN_PREFIX}/overview`;

/**
 * The five pages, in navigation order.
 *
 * One list drives the sidebar, the active marker, and the redirect table, so a
 * new page cannot be reachable but unlisted (or listed but unserved).
 */
export const CONSOLE_PAGES = [
  { id: 'overview', path: `${ADMIN_PREFIX}/overview`, label: 'Overview' },
  { id: 'accounts', path: `${ADMIN_PREFIX}/accounts`, label: 'Accounts' },
  { id: 'account', path: `${ADMIN_PREFIX}/account`, label: 'Account' },
  { id: 'users', path: `${ADMIN_PREFIX}/users`, label: 'Users' },
  { id: 'usage', path: `${ADMIN_PREFIX}/usage`, label: 'Usage' },
  { id: 'models', path: `${ADMIN_PREFIX}/models`, label: 'Models' },
];

/** The page id for a path, or undefined. */
export function pageForPath(pathname) {
  return CONSOLE_PAGES.find((page) => page.path === pathname)?.id;
}

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
   * Mint one session after the caller proved it holds an admin credential.
   * @param identity - who unlocked, kept only for display on the pages.
   * @returns the opaque session id.
   */
  create(identity = {}) {
    this.#sweep();
    if (this.#sessions.size >= MAX_SESSIONS) {
      // Evict the oldest rather than refusing: a stale tab must never lock the
      // operator out of revoking a grant.
      const oldest = [...this.#sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest !== undefined) this.#sessions.delete(oldest[0]);
    }
    const id = randomBytes(24).toString('hex');
    this.#sessions.set(id, {
      expiresAt: Date.now() + this.#ttlMs,
      name: typeof identity.name === 'string' ? identity.name : 'admin',
      legacy: identity.legacy === true,
    });
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

  /**
   * The identity behind a live session, for the sidebar.
   * @param id - the cookie value.
   * @returns the display name, or undefined when the session is not live.
   */
  identityOf(id) {
    this.#sweep();
    const session = this.#sessions.get(String(id ?? ''));
    if (session === undefined || session.expiresAt <= Date.now()) return undefined;
    return { name: session.name, legacy: session.legacy };
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
 * Escape a value for interpolation into markup.
 *
 * Everything in this module is either a constant or a server-computed value, so
 * this is defence in depth: a future call site that passes an error message or a
 * user-supplied name cannot turn one into markup by accident.
 */
function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

/** A timestamp for display, or an em dash. */
function stamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  return `${new Date(value).toISOString().replace('T', ' ').replace(/\..*$/, '')} UTC`;
}

/** The mark plus product name, used by the shell and the lock page. */
function brandMarkup(home) {
  const tag = home === undefined ? 'div' : 'a';
  const href = home === undefined ? '' : ` href="${home}"`;
  return `<${tag} class="brand"${href}>
      <span class="mark" aria-hidden="true"></span>
      <span>
        <span class="brand-name">claude-server</span>
        <span class="brand-sub">operator console</span>
      </span>
    </${tag}>`;
}

/** Single-stroke icons, drawn at 16px, inheriting `currentColor`. */
const ICONS = {
  overview:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  accounts:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5h18"/><path d="M3 12h18"/><path d="M3 16.5h18"/><circle cx="6.5" cy="7.5" r="1"/><circle cx="6.5" cy="12" r="1"/><circle cx="6.5" cy="16.5" r="1"/></svg>',
  account:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>',
  users:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/><path d="M16 5.2a3 3 0 0 1 0 5.6"/><path d="M17.6 14.4A5.6 5.6 0 0 1 21.2 20"/></svg>',
  usage:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></svg>',
  models:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="M3 12.5 12 17l9-4.5"/><path d="M3 17.5 12 22l9-4.5"/></svg>',
  signout:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/></svg>',
};

/** The five page declarations, plus a title and subtitle for each page head. */
const PAGE_META = {
  overview: {
    title: 'Overview',
    subtitle: 'The state of the default subscription, and everything this server has served since it started.',
  },
  accounts: {
    title: 'Accounts',
    subtitle: 'The Claude subscriptions this server serves. Each has its own sign-in and quota.',
  },
  account: {
    title: 'Account',
    subtitle: 'Claude sign-in and grant state for the default account.',
  },
  users: {
    title: 'Users',
    subtitle: 'Tokens that may call the relay. Each can be revoked on its own.',
  },
  usage: {
    title: 'Usage',
    subtitle: 'Tokens consumed by relayed traffic since this process started.',
  },
  models: {
    title: 'Models',
    subtitle: 'The model catalog the default subscription can call.',
  },
};

/** The sidebar: one shell for every page so the chrome cannot drift. */
function sidebarMarkup(page, options) {
  const links = CONSOLE_PAGES.map((entry) => {
    const active = entry.id === page;
    return `<a class="nav-link" href="${entry.path}"${active ? ' aria-current="page"' : ''}${
      active ? '' : ` aria-label="${entry.label}"`
    }>${ICONS[entry.id]}<span>${entry.label}</span></a>`;
  }).join('\n      ');
  const identity = options.identity;
  const who =
    identity === undefined
      ? ''
      : `<span class="who" title="This console session">${esc(identity.name)}${identity.legacy ? ' · env bearer' : ''}</span>`;
  return `<aside class="sidebar">
    ${brandMarkup(ADMIN_HOME)}
    <nav class="nav" aria-label="Console pages">
      ${links}
    </nav>
    <div class="sidebar-foot">
      ${who}
      <button class="ghost small" id="signout" type="button">${ICONS.signout}Sign out of console</button>
    </div>
  </aside>`;
}

/**
 * The page shell: head, sidebar, content.
 *
 * `body` is the already-escaped markup for one page. Interpolating it here keeps
 * `<head>`, the stylesheet, the sidebar, and the script in exactly one place.
 * @param options - active page, page body, identity, and the inline script.
 */
function shell(page, body, options) {
  const title = PAGE_META[page].title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · claude-server</title>
<style>${ADMIN_STYLE}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="shell">
  ${sidebarMarkup(page, options)}
  <div class="workspace">
    <main class="content" id="main">
${body}
    </main>
  </div>
</div>
<script>${CONSOLE_SCRIPT}</script>
</body>
</html>`;
}

/** The page head: title, subtitle, and any page-level actions. */
function pageHead(page, actions = '') {
  const meta = PAGE_META[page];
  return `<div class="page-head">
      <div>
        <h1 class="page-title">${esc(meta.title)}</h1>
        <p class="page-sub">${esc(meta.subtitle)}</p>
      </div>
      ${actions === '' ? '' : `<div class="page-actions">${actions}</div>`}
    </div>`;
}

/** A card with a header row and a body. */
function card(title, body, options = {}) {
  const actions = options.actions === undefined ? '' : `<div class="actions">${options.actions}</div>`;
  return `<section class="card">
      <div class="card-head"><h2>${esc(title)}</h2>${actions}</div>
      <div class="card-body${options.flush === true ? ' flush' : ''}">${body}</div>
    </section>`;
}/** A two-column definition grid. */
function facts(rows) {
  return `<dl class="facts">${rows
    .map(([term, value]) => `<dt>${esc(term)}</dt><dd>${value}</dd>`)
    .join('')}</dl>`;
}

/** A stat tile. `id` is set when client-side code fills the value in. */
function tile({ label, value, meta, state = '', id }) {
  return `<div class="tile${state === '' ? '' : ` ${state}`}"${id === undefined ? '' : ` id="${id}"`}>
        <p class="tile-label">${esc(label)}</p>
        <p class="tile-value"${id === undefined ? '' : ` data-value`}>${esc(value)}</p>
        <p class="tile-meta"${id === undefined ? '' : ` data-meta`}>${esc(meta)}</p>
      </div>`;
}

/** A status pill. */
function pill(text, state = 'muted') {
  return `<span class="pill ${state}">${esc(text)}</span>`;
}

/**
 * The lock page.
 *
 * The first thing an operator sees, so it is a single focused card rather than a
 * form among cards. The only input that can carry a secret is `type=password`
 * with autocomplete disabled, so a borrowed browser does not offer to remember
 * it.
 * @param options - signed-in state and mode, for the status line.
 * @returns the HTML.
 */
export function renderLockPage(options = {}) {
  const signedIn = options.signedIn === true;
  const mode = String(options.mode ?? 'unknown');
  const notice = options.notice === undefined ? '' : String(options.notice);
  const error = options.error === undefined ? '' : String(options.error);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Unlock · claude-server</title>
<style>${ADMIN_STYLE}</style>
</head>
<body>
<div class="lock-shell">
  <main class="lock">
    ${brandMarkup(undefined)}
    <h1>Unlock the console</h1>
    <p class="lede">Paste an admin token. It is verified once and exchanged for an
      <code>HttpOnly</code> session cookie; it is never stored in the page or echoed back.</p>
    ${notice === '' ? '' : `<p class="msg ok">${esc(notice)}</p>`}
    ${error === '' ? '' : `<p class="msg err">${esc(error)}</p>`}
    <form id="unlock-form" method="post" action="${ADMIN_PREFIX}/api/session" autocomplete="off">
      <div class="field">
        <label for="bearer">Admin token</label>
        <input id="bearer" name="bearer" type="password" autocomplete="off" spellcheck="false"
               placeholder="${TOKEN_PREFIX}… or the CLIENT_BEARER" aria-describedby="bearer-hint">
        <p class="field-hint" id="bearer-hint">The <code>CLIENT_BEARER</code> from the server's environment, or a token issued to an admin.</p>
      </div>
      <p class="msg err" id="unlock-error" hidden></p>
      <div class="row">
        <button class="primary block" id="unlock" type="submit">Unlock</button>
      </div>
    </form>
    <p class="note" id="lock-state">${
      signedIn ? 'A Claude grant is stored on this server.' : 'This server is not signed in to Claude yet.'
    } Mode: <code>${esc(mode)}</code>.</p>
  </main>
</div>
<script>
(function () {
  'use strict';
  var form = document.getElementById('unlock-form');
  var input = document.getElementById('bearer');
  var button = document.getElementById('unlock');
  var errorBox = document.getElementById('unlock-error');
  if (!form) return;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    button.disabled = true;
    errorBox.hidden = true;
    fetch('${ADMIN_PREFIX}/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bearer: input.value }),
      credentials: 'same-origin'
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (body) {
        if (response.ok) {
          window.location.replace('${ADMIN_HOME}');
          return;
        }
        button.disabled = false;
        errorBox.hidden = false;
        errorBox.textContent = (body && body.error) || ('HTTP ' + response.status);
      });
    }).catch(function (error) {
      button.disabled = false;
      errorBox.hidden = false;
      errorBox.textContent = String(error && error.message ? error.message : error);
    });
  });
  input.focus();
})();
</script>
</body>
</html>`;
}

// --- page bodies -----------------------------------------------------------

function overviewBody(options) {
  const { signedIn, expiresAt, mode, cliVersion, users } = options;
  const enabled = Array.isArray(users) ? users.filter((user) => user.disabled !== true).length : 0;
  const total = Array.isArray(users) ? users.length : 0;
  const accountList = Array.isArray(options.accounts) ? options.accounts : [];
  const signedInAccounts = accountList.filter(
    (account) => account.signedIn === true && account.disabled !== true,
  ).length;
  return `${pageHead('overview', `<a class="hint" href="${ADMIN_PREFIX}/accounts">Manage accounts</a>`)}
      <div class="tiles">
        ${tile({
          // This tile describes the default account specifically. Saying so is
          // the whole point once a server can hold several: an operator looking
          // at a signed-out tile needs to know *which* subscription it means.
          label: 'Default account',
          value: signedIn ? 'Signed in' : 'Not signed in',
          meta: signedIn ? `Access expires ${stamp(expiresAt)}` : 'No grant is stored at GRANT_PATH',
          state: signedIn ? 'ok' : 'over',
        })}
        ${tile({
          label: 'Accounts',
          value: String(accountList.length),
          meta:
            accountList.length === 0
              ? 'Configured from the environment'
              : `${signedInAccounts} of ${accountList.length} signed in`,
        })}
        ${tile({
          label: 'Quota headroom',
          value: '—',
          meta: 'Waiting for the usage probe',
          state: '',
          id: 'tile-quota',
        })}
        ${tile({
          label: 'Users',
          value: String(total),
          meta: `${enabled} enabled · includes the env bearer`,
        })}
        ${tile({
          label: 'Relayed calls',
          value: '—',
          meta: 'Since this process started',
          id: 'tile-calls',
        })}
      </div>
      ${card(
        'Subscription limits',
        '<div id="usage-body" class="windows"><p class="empty">Loading…</p></div>',
        {
          actions: `<span class="hint" id="usage-age"></span><button class="small" id="refresh-usage" type="button">Refresh</button>`,
        },
      )}
      ${card(
        'Recent calls',
        '<div id="recent-body"><p class="empty">Loading…</p></div>',
        {
          actions: `<a class="hint" href="${ADMIN_PREFIX}/usage">All usage</a>`,
        },
      )}
      <p class="note">Upstream mode <code>${esc(mode)}</code> · claimed CLI version <code>${esc(cliVersion)}</code>.</p>`;
}

function accountBody(options) {
  const { signedIn, expiresAt, mode, cliVersion, identity } = options;
  return `${pageHead('account')}
      ${card(
        'Claude grant',
        facts([
          ['Signed in', signedIn ? pill('signed in', 'on') : pill('not signed in', 'off')],
          ['Access expires', esc(signedIn ? stamp(expiresAt) : '—')],
          ['Upstream mode', `<code>${esc(mode)}</code>`],
          ['Claimed CLI version', `<code>${esc(cliVersion)}</code>`],
        ]),
      )}
      ${card(
        'Sign in to Claude',
        `<p class="hint">Opens Anthropic's authorize page in a new tab. After you approve, the
          browser lands on a <code>localhost</code> address that is not served — copy that full
          address from the bar and paste it below, or paste the code and state.</p>
        <div class="row" id="login-actions">
          <button class="primary" id="start" type="button">Start sign-in</button>
          <button id="cancel" type="button" disabled>Cancel pending</button>
        </div>
        <div id="stage"></div>`,
      )}
      ${card(
        'Console session',
        facts([
          ['Unlocked as', esc(identity?.name ?? 'admin')],
          [
            'Credential',
            identity?.legacy === true
              ? 'The environment bearer (<code>CLIENT_BEARER</code>)'
              : 'A stored admin user',
          ],
        ]),
        {
          actions: `<button class="danger small" id="signout-account" type="button">${ICONS.signout}Sign out</button>`,
        },
      )}
      <p class="note">Signing out ends this browser session only. The Claude grant and every user token stay on the server.</p>`;
}

function usersBody(options) {
  const users = Array.isArray(options.users) ? options.users : [];
  const rows = users
    .map((user) => {
      const legacy = user.legacy === true;
      const name = `${esc(user.name)}${legacy ? ` ${pill('env bearer', 'accent')}` : ''}`;
      const role = `<code>${esc(user.role)}</code>`;
      const status = user.disabled === true ? pill('disabled', 'off') : pill('enabled', 'on');
      const actions = legacy
        ? '<span class="hint">set by the environment</span>'
        : `<button class="small" type="button" data-action="toggle" data-id="${esc(user.id)}" data-disabled="${
            user.disabled === true ? 'true' : 'false'
          }" aria-label="${user.disabled === true ? 'Enable' : 'Disable'} user ${esc(user.name)}">${
            user.disabled === true ? 'Enable' : 'Disable'
          }</button><button class="small danger" type="button" data-action="remove" data-id="${esc(
            user.id,
          )}" data-name="${esc(user.name)}" aria-label="Remove user ${esc(user.name)}">Remove</button>`;
      return `<tr data-user-row="${esc(user.id)}">
          <td class="strong">${name}</td>
          <td>${role}</td>
          <td>${accountCell(user, options.accounts)}</td>
          <td>${status}</td>
          <td class="when">${esc(stamp(user.createdAt))}</td>
          <td class="when">${esc(stamp(user.lastUsedAt))}</td>
          <td class="actions">${actions}</td>
        </tr>`;
    })
    .join('\n        ');
  return `${pageHead('users')}
      <div id="reveal-slot"></div>
      ${card(
        'Add user',
        `<p class="hint">A new token is shown once, immediately after it is created. Only a hash is
          stored, so it cannot be recovered later — issue a new one instead.</p>
        <form class="form-inline" id="add-user-form" autocomplete="off" style="margin-top:1rem">
          <div class="field">
            <label for="user-name">Name</label>
            <input id="user-name" name="name" type="text" maxlength="64" placeholder="alice" required>
          </div>
          <div class="field compact">
            <label for="user-role">Role</label>
            <select id="user-role" name="role" aria-describedby="role-hint">
              <option value="client" selected>client</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div class="field compact">
            <label for="user-account">Account</label>
            <select id="user-account" name="accountId" aria-describedby="account-hint">
              ${accountOptions(options.accounts)}
            </select>
          </div>
          <div class="form-submit">
            <button class="primary" id="add-user" type="submit">Create token</button>
          </div>
        </form>
        <p class="field-hint" id="role-hint"><code>client</code> may call the relay. <code>admin</code> may also unlock this console and manage users.</p>
        <p class="field-hint" id="account-hint">The subscription this token spends. A token only ever uses the account it is bound to.</p>
        <p class="msg err" id="users-error" hidden></p>`,
      )}
      <section class="card">
        <div class="card-head"><h2>Users</h2><div class="actions"><span class="hint" id="users-count">${users.length} total</span></div></div>
        <div class="card-body flush" id="users-table-body">
          ${
            users.length === 0
              ? '<p class="empty" style="padding:1rem">No users yet.</p>'
              : `<div class="table-wrap"><table class="data" id="users-table">
            <thead><tr>
              <th>Name</th><th>Role</th><th>Account</th><th>Status</th><th>Created</th><th>Last used</th>
              <th class="num">Actions</th>
            </tr></thead>
            <tbody>
        ${rows}
            </tbody>
          </table></div>`
          }
        </div>
      </section>`;
}

/**
 * The Accounts page: one row per Claude subscription this server serves.
 *
 * Sign-in is per account, so this page owns the "Sign in" button and renders the
 * authorize URL inline. The default account is the one at `GRANT_PATH`; it
 * cannot be renamed or removed because it is configuration, and the page says
 * so rather than offering controls that would be refused.
 */
/**
 * The Accounts page: one row per Claude subscription this server serves.
 *
 * The state column carries three distinct facts, not one: signed in, signed
 * out, and disabled. Collapsing the last two into "signed out" hid the reason a
 * working account stopped answering — an operator looking at a disabled account
 * would go hunting for a sign-in problem that does not exist.
 */
function accountsBody(options) {
  const accounts = Array.isArray(options.accounts) ? options.accounts : [];
  const users = Array.isArray(options.users) ? options.users : [];
  /** How many tokens spend this account. */
  const boundCount = (id) =>
    users.filter((user) => (user.accountId ?? null) === (id === 'default' ? null : id)).length;

  const rows = accounts
    .map((account) => {
      const isDefault = account.default === true;
      const disabled = account.disabled === true;
      const signedIn = account.signedIn === true && !disabled;
      const unreadable = account.error !== null && account.error !== undefined;

      const name = `<span class="strong">${esc(account.name)}</span>${
        isDefault ? ` ${pill('default', 'accent')}` : ''
      }`;

      // Disabled outranks the grant state: it is the reason nothing works.
      const state = disabled
        ? pill('disabled', 'warn')
        : unreadable
          ? pill('unreadable', 'off')
          : signedIn
            ? pill('signed in', 'on')
            : pill('signed out', 'off');
      // The second line under the state explains what that state means for a
      // request, which is the question the operator actually has.
      const stateNote = disabled
        ? 'its tokens are refused'
        : unreadable
          ? 'guard: grant file unreadable'
          : signedIn
            ? 'tokens may relay'
            : 'sign in to enable';
      const expires = signedIn
        ? `<span class="when">${esc(stamp(account.expiresAt))}</span>`
        : '<span class="dash">—</span>';
      const bound = boundCount(account.id);
      const tokens =
        bound === 0
          ? '<span class="dash">none</span>'
          : `<a class="link-quiet" href="/admin/users">${bound} token${bound === 1 ? '' : 's'}</a>`;

      const signIn =
        `<button class="small${disabled ? ' ghost' : ''}" type="button" data-action="signin" data-id="${esc(
          account.id,
        )}" aria-label="Sign in account ${esc(account.name)}"${disabled ? ' disabled' : ''}>Sign in</button>`;
      // The default account is GRANT_PATH: renaming it would imply a rename that
      // cannot happen, and removing it would strand the deployment's own grant.
      const actions = isDefault
        ? `${signIn}<span class="hint">fixed by GRANT_PATH</span>`
        : `<button class="small" type="button" data-action="rename" data-id="${esc(
            account.id,
          )}" data-name="${esc(account.name)}" aria-label="Rename account ${esc(account.name)}">Rename</button>` +
          signIn +
          `<button class="small danger" type="button" data-action="remove" data-id="${esc(
            account.id,
          )}" data-name="${esc(account.name)}" aria-label="Remove account ${esc(account.name)}">Remove</button>`;

      return `<tr data-account-row="${esc(account.id)}"${disabled ? ' class="row-muted"' : ''}>
          <td>${name}</td>
          <td><div class="state-cell">${state}<span class="state-note">${esc(stateNote)}</span></div></td>
          <td>${tokens}</td>
          <td class="when">${expires}</td>
          <td class="actions">${actions}</td>
        </tr>`;
    })
    .join('\n        ');

  // The create form is secondary once accounts exist: an operator with a
  // configured deployment comes here to sign in or rename, not to add another.
  const createForm = `<form class="form-inline" id="add-account-form" autocomplete="off">
          <div class="field">
            <label for="account-name">Name</label>
            <input id="account-name" name="name" type="text" maxlength="80" placeholder="Work subscription" required>
          </div>
          <div class="form-submit">
            <button class="primary" id="add-account" type="submit">Create account</button>
          </div>
        </form>
        <p class="msg err" id="accounts-error" hidden></p>`;

  return `${pageHead('accounts')}
      <div id="signin-slot"></div>
      <section class="card">
        <div class="card-head">
          <h2>Accounts</h2>
          <div class="actions">
            <span class="hint" id="accounts-count">${accounts.length} total</span>
            <button class="small" type="button" id="toggle-add-account" aria-expanded="false" aria-controls="add-account-panel">Add account</button>
          </div>
        </div>
        <div class="card-body flush">
          ${
            accounts.length === 0
              ? `<p class="empty" style="padding:var(--s-4)">No accounts yet. The default account appears once <code>GRANT_PATH</code> holds a grant.</p>`
              : `<div class="table-wrap"><table class="data" id="accounts-table">
            <thead><tr>
              <th>Name</th><th>State</th><th>Tokens</th><th>Token expires</th>
              <th class="num">Actions</th>
            </tr></thead>
            <tbody>
        ${rows}
            </tbody>
          </table></div>`
          }
        </div>
        <div class="card-panel" id="add-account-panel" hidden>
          <p class="hint panel-intro">A new account starts signed out. Sign it in from its row once it is created;
            each account refreshes and spends its own subscription independently.</p>
          ${createForm}
        </div>
      </section>
      <p class="note">A token is bound to one account and only ever spends that subscription.
        A signed-in account answers relayed requests; a signed-out or disabled one refuses them rather than
        borrowing another account's grant.</p>`;
}

function accountOptions(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (list.length === 0) return '<option value="" selected>default</option>';
  return list
    .map((account) => {
      const isDefault = account.default === true;
      const value = isDefault ? '' : account.id;
      const label = account.signedIn === true ? account.name : `${account.name} (signed out)`;
      return `<option value="${esc(value)}"${isDefault ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

/**
 * The account cell for one user.
 *
 * A user whose `accountId` is null spends the default account — that is what
 * every pre-accounts token does — so the cell names it rather than showing an
 * empty box the operator would have to interpret.
 * @param user - the user row.
 * @param accounts - the account list, when the page loaded one.
 * @returns escaped markup.
 */
function accountCell(user, accounts) {
  const id = user.accountId ?? null;
  if (id === null) return `<span class="hint">default</span>`;
  const list = Array.isArray(accounts) ? accounts : [];
  const found = list.find((account) => account.id === id);
  // A user may point at an account that was removed; showing the raw id is how
  // the operator finds which row to fix.
  if (found === undefined) return `<code class="bad">${esc(id)}</code>`;
  return esc(found.name);
}

function usageBody(options) {
  return `${pageHead('usage')}
      ${card(
        'Token accounting',
        '<div id="tokens-body"><p class="empty">Loading…</p></div>',
        {
          actions: `<span class="hint" id="tokens-since"></span><button class="small" id="refresh-usage-tokens" type="button">Refresh</button>`,
        },
      )}
      <p class="note">Counted from responses relayed by this process and reset when it restarts.</p>`;
}

function modelsBody(options) {
  return `${pageHead('models')}
      ${card('Model catalog', '<div id="models-body"><p class="empty">Loading…</p></div>', {
        actions: `<span class="hint" id="models-count"></span><button class="small" id="refresh-models" type="button">Refresh</button>`,
      })}`;
}

/**
 * Render one console page.
 *
 * The page id must be one of `CONSOLE_PAGES`; callers route through
 * `pageForPath`, so an unknown id is a programming error rather than a runtime
 * input this function has to render around.
 * @param options - the page id plus the values that page shows.
 * @returns the HTML.
 */
export function renderConsolePage(options = {}) {
  const page = options.page;
  const body =
    page === 'overview'
      ? overviewBody(options)
      : page === 'accounts'
        ? accountsBody(options)
        : page === 'account'
          ? accountBody(options)
          : page === 'users'
            ? usersBody(options)
            : page === 'usage'
              ? usageBody(options)
              : modelsBody(options);
  return shell(page, body, options);
}

// --- client behaviour ------------------------------------------------------

/**
 * The one inline script every console page loads.
 *
 * It is shared rather than per-page for the same reason the shell is: the five
 * pages use the same helpers, and a copied helper is a helper that drifts. Each
 * block is guarded by the presence of its root element, so a page pays nothing
 * for the behaviour it does not have.
 *
 * No template literals, no arrow functions required, no DOM building with
 * `innerHTML` from API data — every value goes through `textContent`.
 */
const CONSOLE_SCRIPT = `
(function () {
  'use strict';

  var post = function (path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      credentials: 'same-origin'
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    });
  };

  var send = function (path, method, payload) {
    return fetch(path, {
      method: method,
      headers: { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      credentials: 'same-origin'
    }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    });
  };

  var get = function (path) {
    return fetch(path, { credentials: 'same-origin' }).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    });
  };

  var problem = function (result, what) {
    if (result.status === 401) {
      window.location.replace('/admin');
      return what + ': the console session expired';
    }
    return (result.body && result.body.error) || (what + ': HTTP ' + result.status);
  };

  var num = function (n) {
    return typeof n === 'number' ? n.toLocaleString() : '0';
  };

  var table = function (headers, rows, numericFrom) {
    var node = document.createElement('table');
    node.className = 'data';
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    headers.forEach(function (label, index) {
      var th = document.createElement('th');
      th.textContent = label;
      if (index >= numericFrom) th.className = 'num';
      headRow.append(th);
    });
    head.append(headRow);
    var body = document.createElement('tbody');
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      row.forEach(function (value, index) {
        var td = document.createElement('td');
        td.textContent = value;
        if (index >= numericFrom) td.className = 'num';
        else if (index === 0) td.className = 'strong';
        tr.append(td);
      });
      body.append(tr);
    });
    node.append(head, body);
    return node;
  };

  var showError = function (box, message) {
    box.hidden = false;
    box.textContent = message;
  };

  var signOut = function () {
    return post('/admin/api/logout').then(function () {
      window.location.replace('/admin');
    });
  };

  var signOutButton = document.getElementById('signout');
  if (signOutButton) signOutButton.addEventListener('click', function () { void signOut(); });
  var signOutAccount = document.getElementById('signout-account');
  if (signOutAccount) signOutAccount.addEventListener('click', function () { void signOut(); });

  // ---- Overview: quota windows, headline tiles ----------------------------
  var usageBody = document.getElementById('usage-body');
  var usageAge = document.getElementById('usage-age');
  var tileQuota = document.getElementById('tile-quota');
  var tileCalls = document.getElementById('tile-calls');
  var recentBody = document.getElementById('recent-body');

  var windowsOf = function (usage) {
    var out = [];
    if (usage && Array.isArray(usage.limits)) {
      usage.limits.forEach(function (row) {
        if (!row || typeof row.percent !== 'number') return;
        out.push({ label: row.kind || row.group || 'limit', percent: row.percent, resetsAt: row.resets_at || null });
      });
    }
    if (out.length === 0) {
      [['five_hour', '5-hour'], ['seven_day', 'weekly']].forEach(function (pair) {
        var row = usage && usage[pair[0]];
        if (!row || typeof row.utilization !== 'number') return;
        out.push({ label: pair[1], percent: row.utilization, resetsAt: row.resets_at || null });
      });
    }
    return out;
  };

  var windowName = function (label) {
    return String(label).replace(/_/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
  };

  var stateOf = function (pct) {
    if (pct >= 90) return 'over';
    if (pct >= 70) return 'warn';
    return '';
  };

  var renderUsage = function (usage) {
    if (!usageBody) return;
    var rows = windowsOf(usage);
    usageBody.textContent = '';
    if (rows.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No limit windows reported.';
      usageBody.append(empty);
      return;
    }
    rows.forEach(function (row) {
      var box = document.createElement('div');
      box.className = 'window';
      var head = document.createElement('div');
      head.className = 'window-head';
      var name = document.createElement('span');
      name.className = 'window-name';
      name.textContent = windowName(row.label);
      var figure = document.createElement('span');
      figure.className = 'window-figure';
      var pct = Math.max(0, Math.min(100, row.percent));
      var state = stateOf(pct);
      if (state === 'over') figure.className = 'window-figure critical';
      else if (state === 'warn') figure.className = 'window-figure hot';
      figure.textContent = row.percent.toFixed(0) + '% used';
      head.append(name, figure);
      var bar = document.createElement('div');
      bar.className = 'meter';
      bar.setAttribute('aria-hidden', 'true');
      var fill = document.createElement('span');
      fill.style.width = pct + '%';
      if (state !== '') fill.className = state;
      bar.append(fill);
      box.append(head, bar);
      if (row.resetsAt) {
        var reset = document.createElement('p');
        reset.className = 'window-reset';
        reset.textContent = 'Resets ' + new Date(row.resetsAt).toLocaleString();
        box.append(reset);
      }
      usageBody.append(box);
    });
  };

  var renderQuotaTile = function (usage) {
    if (!tileQuota) return;
    var rows = windowsOf(usage);
    var value = tileQuota.querySelector('[data-value]');
    var meta = tileQuota.querySelector('[data-meta]');
    if (rows.length === 0) {
      value.textContent = '—';
      meta.textContent = 'No limit windows reported';
      return;
    }
    var peak = rows.slice().sort(function (a, b) { return b.percent - a.percent; })[0];
    var pct = Math.max(0, Math.min(100, peak.percent));
    value.textContent = pct.toFixed(0) + '%';
    meta.textContent = 'Highest window: ' + windowName(peak.label);
    tileQuota.className = 'tile ' + stateOf(pct);
  };

  var loadUsage = function () {
    if (!usageBody) return;
    if (usageAge) usageAge.textContent = 'loading…';
    get('/admin/api/quota').then(function (result) {
      if (!result.ok) {
        usageBody.textContent = '';
        var p = document.createElement('p');
        p.className = 'msg err';
        p.textContent = problem(result, 'Quota');
        usageBody.append(p);
        if (usageAge) usageAge.textContent = '';
        return;
      }
      renderUsage(result.body && result.body.usage);
      renderQuotaTile(result.body && result.body.usage);
      if (usageAge) {
        usageAge.textContent = (result.body && result.body.cached ? 'cached ' : 'updated ') +
          new Date((result.body && result.body.at) || Date.now()).toLocaleTimeString();
      }
    }).catch(function (error) {
      if (usageAge) usageAge.textContent = String(error && error.message ? error.message : error);
    });
  };

  // ---- Usage page: totals, by model, recent calls -------------------------
  var tokensBody = document.getElementById('tokens-body');
  var tokensSince = document.getElementById('tokens-since');

  var renderRecent = function (data) {
    if (recentBody && data && Array.isArray(data.recent)) {
      recentBody.textContent = '';
      if (data.recent.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No relayed calls since this process started.';
        recentBody.append(empty);
      } else {
        var wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        wrap.append(table(
          ['Time', 'Model', 'Input', 'Output', 'Duration'],
          data.recent.slice(0, 6).map(function (call) {
            return [
              new Date(call.at).toLocaleTimeString(),
              call.model || '(unknown)',
              num(call.input_tokens),
              num(call.output_tokens),
              call.durationMs === null ? '—' : (call.durationMs / 1000).toFixed(1) + 's'
            ];
          }),
          2
        ));
        recentBody.append(wrap);
      }
    }
    if (tileCalls && data && data.totals) {
      tileCalls.querySelector('[data-value]').textContent = num(data.totals.calls);
      tileCalls.querySelector('[data-meta]').textContent = 'Since ' + new Date(data.since).toLocaleString();
    }
  };

  var renderTokens = function (data) {
    if (tokensBody) {
      tokensBody.textContent = '';
      var totals = data.totals || {};
      if (!totals.calls) {
        var p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'No relayed calls since this process started.';
        tokensBody.append(p);
      } else {
        var section = document.createElement('div');
        section.className = 'table-wrap';
        section.append(table(
          ['Total', 'Calls', 'Input', 'Output', 'Cache read', 'Cache write'],
          [[
            'All models',
            num(totals.calls),
            num(totals.input_tokens),
            num(totals.output_tokens),
            num(totals.cache_read_input_tokens),
            num(totals.cache_creation_input_tokens)
          ]],
          1
        ));
        tokensBody.append(section);

        var models = data.byModel || [];
        if (models.length > 0) {
          var h = document.createElement('h3');
          h.className = 'subhead';
          h.style.margin = '1.25rem 0 0.5rem';
          h.textContent = 'By model';
          var wrap = document.createElement('div');
          wrap.className = 'table-wrap';
          wrap.append(table(
            ['Model', 'Calls', 'Input', 'Output', 'Cache read', 'Cache write'],
            models.map(function (row) {
              return [
                row.model,
                num(row.calls),
                num(row.input_tokens),
                num(row.output_tokens),
                num(row.cache_read_input_tokens),
                num(row.cache_creation_input_tokens)
              ];
            }),
            1
          ));
          tokensBody.append(h, wrap);
        }

        var recent = data.recent || [];
        if (recent.length > 0) {
          var rh = document.createElement('h3');
          rh.className = 'subhead';
          rh.style.margin = '1.25rem 0 0.5rem';
          rh.textContent = 'Recent calls';
          var rwrap = document.createElement('div');
          rwrap.className = 'table-wrap';
          rwrap.append(table(
            ['Time', 'Model', 'Input', 'Output', 'Duration'],
            recent.slice(0, 10).map(function (call) {
              return [
                new Date(call.at).toLocaleTimeString(),
                call.model || '(unknown)',
                num(call.input_tokens),
                num(call.output_tokens),
                call.durationMs === null ? '—' : (call.durationMs / 1000).toFixed(1) + 's'
              ];
            }),
            2
          ));
          tokensBody.append(rh, rwrap);
        }
      }
    }
    if (tokensSince && data) tokensSince.textContent = 'since ' + new Date(data.since).toLocaleString();
  };

  var loadTokens = function (quiet) {
    if (!tokensBody && !recentBody && !tileCalls) return;
    if (tokensSince && !quiet) tokensSince.textContent = 'loading…';
    get('/admin/api/usage').then(function (result) {
      if (!result.ok) {
        var box = tokensBody || recentBody;
        if (box) {
          box.textContent = '';
          var p = document.createElement('p');
          p.className = 'msg err';
          p.textContent = problem(result, 'Usage');
          box.append(p);
        }
        return;
      }
      renderTokens(result.body);
      renderRecent(result.body);
    }).catch(function (error) {
      if (tokensSince) tokensSince.textContent = String(error && error.message ? error.message : error);
    });
  };

  // ---- Models page --------------------------------------------------------
  var modelsBody = document.getElementById('models-body');
  var modelsCount = document.getElementById('models-count');

  var loadModels = function () {
    if (!modelsBody) return;
    modelsCount.textContent = 'loading…';
    get('/admin/api/models').then(function (result) {
      if (!result.ok) {
        modelsBody.textContent = '';
        var p = document.createElement('p');
        p.className = 'msg err';
        p.textContent = problem(result, 'Models');
        modelsBody.append(p);
        modelsCount.textContent = '';
        return;
      }
      var models = (result.body && result.body.models) || [];
      modelsBody.textContent = '';
      if (models.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'The endpoint reported no models.';
        modelsBody.append(empty);
        modelsCount.textContent = '';
        return;
      }
      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      var node = document.createElement('table');
      node.className = 'data';
      var head = document.createElement('thead');
      var headRow = document.createElement('tr');
      ['Model id', 'Name'].forEach(function (label) {
        var th = document.createElement('th');
        th.textContent = label;
        headRow.append(th);
      });
      head.append(headRow);
      var body = document.createElement('tbody');
      models.forEach(function (model) {
        var tr = document.createElement('tr');
        var idCell = document.createElement('td');
        idCell.className = 'mono strong';
        idCell.textContent = model.id;
        var nameCell = document.createElement('td');
        nameCell.textContent = model.displayName && model.displayName !== model.id ? model.displayName : '—';
        tr.append(idCell, nameCell);
        body.append(tr);
      });
      node.append(head, body);
      wrap.append(node);
      modelsBody.append(wrap);
      modelsCount.textContent = models.length + ' available';
    }).catch(function (error) {
      modelsCount.textContent = String(error && error.message ? error.message : error);
    });
  };

  // ---- Users page ---------------------------------------------------------
  var usersBodyEl = document.getElementById('users-table-body');
  var usersCount = document.getElementById('users-count');
  var usersError = document.getElementById('users-error');
  var revealSlot = document.getElementById('reveal-slot');
  var addForm = document.getElementById('add-user-form');

  var stampOf = function (value) {
    if (typeof value !== 'number' || !value) return '—';
    return new Date(value).toISOString().replace('T', ' ').replace(/\\..*$/, '') + ' UTC';
  };

  var renderUsers = function (users) {
    if (!usersBodyEl) return;
    usersBodyEl.textContent = '';
    if (users.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.style.padding = '1rem';
      empty.textContent = 'No users yet.';
      usersBodyEl.append(empty);
      if (usersCount) usersCount.textContent = '0 total';
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    var node = document.createElement('table');
    node.className = 'data';
    node.id = 'users-table';
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Name', 'Role', 'Status', 'Created', 'Last used', 'Actions'].forEach(function (label, index) {
      var th = document.createElement('th');
      th.textContent = label;
      if (index === 5) th.className = 'num';
      headRow.append(th);
    });
    head.append(headRow);
    var body = document.createElement('tbody');
    users.forEach(function (user) {
      var tr = document.createElement('tr');
      var nameCell = document.createElement('td');
      nameCell.className = 'strong';
      nameCell.textContent = user.name;
      if (user.legacy) {
        var badge = document.createElement('span');
        badge.className = 'pill accent';
        badge.textContent = 'env bearer';
        badge.style.marginLeft = '0.5rem';
        nameCell.append(' ', badge);
      }
      var roleCell = document.createElement('td');
      var roleCode = document.createElement('code');
      roleCode.textContent = user.role;
      roleCell.append(roleCode);
      var statusCell = document.createElement('td');
      var status = document.createElement('span');
      status.className = 'pill ' + (user.disabled ? 'off' : 'on');
      status.textContent = user.disabled ? 'disabled' : 'enabled';
      statusCell.append(status);
      var createdCell = document.createElement('td');
      createdCell.className = 'when';
      createdCell.textContent = stampOf(user.createdAt);
      var usedCell = document.createElement('td');
      usedCell.className = 'when';
      usedCell.textContent = stampOf(user.lastUsedAt);
      var actionsCell = document.createElement('td');
      actionsCell.className = 'actions';
      if (user.legacy) {
        var fixed = document.createElement('span');
        fixed.className = 'hint';
        fixed.textContent = 'set by the environment';
        actionsCell.append(fixed);
      } else {
        // Both this renderer and the server-rendered table emit the same
        // data-action contract, and one delegated listener below serves both.
        // Attaching a listener per button would leave the server-rendered rows
        // dead whenever the refresh request fails.
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'small';
        toggle.textContent = user.disabled ? 'Enable' : 'Disable';
        toggle.setAttribute('data-action', 'toggle');
        toggle.setAttribute('data-id', user.id);
        toggle.setAttribute('data-disabled', user.disabled ? 'true' : 'false');
        toggle.setAttribute('aria-label', (user.disabled ? 'Enable user ' : 'Disable user ') + user.name);
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'small danger';
        remove.textContent = 'Remove';
        remove.setAttribute('data-action', 'remove');
        remove.setAttribute('data-id', user.id);
        remove.setAttribute('data-name', user.name);
        remove.setAttribute('aria-label', 'Remove user ' + user.name);
        actionsCell.append(toggle, remove);
      }
      tr.append(nameCell, roleCell, statusCell, createdCell, usedCell, actionsCell);
      body.append(tr);
    });
    node.append(head, body);
    wrap.append(node);
    usersBodyEl.append(wrap);
    if (usersCount) usersCount.textContent = users.length + ' total';
  };

  var loadUsers = function () {
    if (!usersBodyEl) return;
    get('/admin/api/users').then(function (result) {
      if (!result.ok) {
        showError(usersError, problem(result, 'Users'));
        return;
      }
      renderUsers((result.body && result.body.users) || []);
    });
  };

  var revealToken = function (user, token) {
    if (!revealSlot) return;
    revealSlot.textContent = '';
    var panel = document.createElement('section');
    panel.className = 'reveal';
    panel.setAttribute('role', 'status');
    var title = document.createElement('h2');
    title.textContent = 'New token for ' + user.name;
    var warning = document.createElement('p');
    warning.textContent = 'This is the only time this token is shown. Only a hash is stored, so it cannot be recovered later. Copy it now.';
    var line = document.createElement('div');
    line.className = 'token-line';
    var code = document.createElement('code');
    code.className = 'token';
    code.textContent = token;
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'primary';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy the token for ' + user.name);
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Copied'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(token).then(done, function () { selectToken(); });
      } else {
        selectToken();
      }
      function selectToken() {
        var range = document.createRange();
        range.selectNodeContents(code);
        var selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        copy.textContent = 'Selected — press Ctrl+C';
      }
    });
    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ghost';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', function () { revealSlot.textContent = ''; });
    line.append(code, copy);
    var row = document.createElement('div');
    row.className = 'row';
    row.append(dismiss);
    panel.append(title, warning, line, row);
    revealSlot.append(panel);
    panel.scrollIntoView({ block: 'nearest' });
    copy.focus();
  };

  var patchUser = function (id, patch) {
    return send('/admin/api/users/' + encodeURIComponent(id), 'PATCH', patch).then(function (result) {
      if (!result.ok) {
        showError(usersError, problem(result, 'Update'));
        return;
      }
      usersError.hidden = true;
      return loadUsers();
    });
  };

  var armRemove = function (button, name) {
    if (button.dataset.armed === 'true') {
      send('/admin/api/users/' + encodeURIComponent(button.dataset.id), 'DELETE').then(function (result) {
        if (!result.ok) {
          showError(usersError, problem(result, 'Remove'));
          return;
        }
        usersError.hidden = true;
        return loadUsers();
      });
      return;
    }
    // Two-step confirmation rather than window.confirm: a browser dialog blocks
    // the page, cannot be styled, and looks identical to a popup.
    button.dataset.armed = 'true';
    button.textContent = 'Confirm remove';
    button.setAttribute('aria-label', 'Confirm removing user ' + name);
    var reset = function () {
      if (button.dataset.armed !== 'true') return;
      button.dataset.armed = 'false';
      button.textContent = 'Remove';
      button.setAttribute('aria-label', 'Remove user ' + name);
    };
    setTimeout(reset, 5000);
    button.addEventListener('blur', reset, { once: true });
  };

  // One delegated listener for both renderers. Both the server-rendered table
  // and the one rebuilt after a change carry the same data-action contract, so
  // a row cannot be interactive in one path and dead in the other.
  if (usersBodyEl) {
    usersBodyEl.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
      if (button === null) return;
      if (button.dataset.action === 'toggle') {
        void patchUser(button.dataset.id, { disabled: button.dataset.disabled !== 'true' });
        return;
      }
      if (button.dataset.action === 'remove') {
        armRemove(button, button.dataset.name || 'this user');
      }
    });
  }

  if (addForm) {
    var addButton = document.getElementById('add-user');
    var nameInput = document.getElementById('user-name');
    var roleInput = document.getElementById('user-role');
    addForm.addEventListener('submit', function (event) {
      event.preventDefault();
      addButton.disabled = true;
      usersError.hidden = true;
      var accountSelect = document.getElementById('user-account');
      post('/admin/api/users', {
        name: nameInput.value,
        role: roleInput.value,
        accountId: accountSelect && accountSelect.value ? accountSelect.value : null
      }).then(function (result) {
        addButton.disabled = false;
        if (!result.ok) {
          showError(usersError, problem(result, 'Create'));
          return;
        }
        nameInput.value = '';
        revealToken(result.body.user, result.body.token);
        return loadUsers();
      }).catch(function (error) {
        addButton.disabled = false;
        showError(usersError, String(error && error.message ? error.message : error));
      });
    });
  }

  // ---- Account page: the authorization-code sign-in ----------------------
  var start = document.getElementById('start');
  var cancel = document.getElementById('cancel');
  var stage = document.getElementById('stage');
  var currentId = null;

  var showPaste = function (id, url) {
    currentId = id;
    cancel.disabled = false;
    stage.textContent = '';
    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.marginTop = '0.75rem';
    hint.textContent = 'If the tab did not open, use this link:';
    var link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open the authorize page';
    stage.append(hint, link);

    var field = document.createElement('div');
    field.className = 'field';
    field.style.marginTop = '0.9rem';
    var label = document.createElement('label');
    label.setAttribute('for', 'callback');
    label.textContent = 'Paste the full callback address';
    var input = document.createElement('input');
    input.id = 'callback';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'http://localhost:53692/callback?code=…&state=…';
    field.append(label, input);

    var row = document.createElement('div');
    row.className = 'row';
    var submit = document.createElement('button');
    submit.className = 'primary';
    submit.type = 'button';
    submit.textContent = 'Finish sign-in';
    var err = document.createElement('p');
    err.className = 'msg err';
    err.hidden = true;

    submit.addEventListener('click', function () {
      submit.disabled = true;
      post('/admin/api/login/complete', { id: currentId, code: input.value }).then(function (result) {
        if (result.ok) {
          window.location.reload();
          return;
        }
        submit.disabled = false;
        showError(err, (result.body && result.body.error) || ('HTTP ' + result.status));
      });
    });
    row.append(submit);
    stage.append(field, row, err);
    input.focus();
  };

  if (start) {
    start.addEventListener('click', function () {
      start.disabled = true;
      post('/admin/api/login/start').then(function (result) {
        if (result.ok && result.body && result.body.url) {
          window.open(result.body.url, '_blank', 'noopener');
          showPaste(result.body.id, result.body.url);
          return;
        }
        start.disabled = false;
        window.alert((result.body && result.body.error) || ('HTTP ' + result.status));
      });
    });
  }

  if (cancel) {
    cancel.addEventListener('click', function () {
      var id = currentId;
      if (id) post('/admin/api/login/cancel', { id: id }).then(function () { window.location.reload(); });
      else window.location.reload();
    });
  }

  // ---- wire up whatever this page has ------------------------------------
  [
    ['refresh-usage', loadUsage],
    ['refresh-models', loadModels],
    ['refresh-usage-tokens', function () { void loadTokens(false); }]
  ].forEach(function (pair) {
    var node = document.getElementById(pair[0]);
    if (node) node.addEventListener('click', pair[1]);
  });


  // ---- accounts ----------------------------------------------------------
  // One row per subscription. Sign-in is per account, so the authorize URL is
  // rendered inline under the table rather than on the single Account page.
  var accountsBodyEl = document.getElementById('accounts-table-body');
  var accountsTable = document.getElementById('accounts-table');
  var accountsCount = document.getElementById('accounts-count');
  var accountsError = document.getElementById('accounts-error');
  var signinSlot = document.getElementById('signin-slot');

  var showAccountsError = function (message) {
    if (!accountsError) return;
    accountsError.textContent = message;
    accountsError.hidden = false;
  };

  var reloadAccounts = function () { window.location.reload(); };

  // The create form starts folded: with accounts configured, the reason to open
  // this page is to sign one in or rename it, not to add another.
  var toggleAddAccount = document.getElementById('toggle-add-account');
  var addAccountPanel = document.getElementById('add-account-panel');
  if (toggleAddAccount && addAccountPanel) {
    toggleAddAccount.addEventListener('click', function () {
      var open = addAccountPanel.hidden;
      addAccountPanel.hidden = !open;
      toggleAddAccount.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        var nameInput = document.getElementById('account-name');
        if (nameInput) nameInput.focus();
      }
    });
  }

  var addAccountForm = document.getElementById('add-account-form');
  if (addAccountForm) {
    addAccountForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (accountsError) accountsError.hidden = true;
      var input = document.getElementById('account-name');
      var name = input ? input.value.trim() : '';
      if (!name) return;
      post('/admin/api/accounts', { name: name }).then(function (result) {
        if (!result.ok) {
          showAccountsError((result.body && result.body.error) || ('HTTP ' + result.status));
          return;
        }
        reloadAccounts();
      });
    });
  }

  if (accountsTable) {
    accountsTable.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
      if (button === null) return;
      var action = button.dataset.action;
      var id = button.dataset.id;
      if (action === 'remove') {
        var label = button.dataset.name || id;
        if (!window.confirm('Remove the account "' + label + '"? Its stored grant is deleted and its users stop working.')) return;
        fetch('/admin/api/accounts/' + encodeURIComponent(id), {
          method: 'DELETE',
          credentials: 'same-origin'
        }).then(function (response) {
          return response.json().catch(function () { return null; }).then(function (body) {
            if (!response.ok) {
              showAccountsError((body && body.error) || ('HTTP ' + response.status));
              return;
            }
            reloadAccounts();
          });
        });
        return;
      }
      if (action === 'rename') {
        var current = button.dataset.name || '';
        var next = window.prompt('Rename account', current);
        if (next === null) return;
        if (!next.trim()) return;
        fetch('/admin/api/accounts/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name: next.trim() })
        }).then(function (response) {
          return response.json().catch(function () { return null; }).then(function (body) {
            if (!response.ok) {
              showAccountsError((body && body.error) || ('HTTP ' + response.status));
              return;
            }
            reloadAccounts();
          });
        });
        return;
      }
      if (action === 'signin') {
        button.disabled = true;
        post('/admin/api/login/start', { accountId: id }).then(function (result) {
          if (!result.ok) {
            button.disabled = false;
            showAccountsError((result.body && result.body.error) || ('HTTP ' + result.status));
            return;
          }
          renderAccountSignin(id, result.body);
        });
      }
    });
  }

  /**
   * Show the authorize URL for one account's sign-in attempt.
   * The attempt id is held in the closure rather than a hidden field so a
   * reload cannot submit a stale one.
   */
  var renderAccountSignin = function (accountId, started) {
    if (!signinSlot) return;
    signinSlot.textContent = '';
    var card = document.createElement('section');
    card.className = 'card';
    var head = document.createElement('div');
    head.className = 'card-head';
    var h2 = document.createElement('h2');
    h2.textContent = 'Sign in account';
    head.append(h2);
    var bodyEl = document.createElement('div');
    bodyEl.className = 'card-body';

    var hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Open this URL, approve the subscription, then paste the callback URL below.';
    var link = document.createElement('p');
    var anchor = document.createElement('a');
    anchor.href = started.url;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.textContent = started.url;
    link.append(anchor);

    var field = document.createElement('div');
    field.className = 'field';
    var label = document.createElement('label');
    label.setAttribute('for', 'account-callback');
    label.textContent = 'Callback URL';
    var input = document.createElement('input');
    input.id = 'account-callback';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'http://localhost:53692/callback?code=…&state=…';
    field.append(label, input);

    var row = document.createElement('div');
    row.className = 'row';
    var submit = document.createElement('button');
    submit.className = 'primary';
    submit.type = 'button';
    submit.textContent = 'Finish sign-in';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    var err = document.createElement('p');
    err.className = 'msg err';
    err.hidden = true;
    row.append(submit, cancel);

    var startedId = started.id;
    submit.addEventListener('click', function () {
      submit.disabled = true;
      post('/admin/api/login/complete', { id: startedId, code: input.value }).then(function (result) {
        if (result.ok) {
          window.location.reload();
          return;
        }
        submit.disabled = false;
        err.textContent = (result.body && result.body.error) || ('HTTP ' + result.status);
        err.hidden = false;
      });
    });
    cancel.addEventListener('click', function () {
      post('/admin/api/login/cancel', { id: startedId }).then(function () { renderAccountSigninClose(); });
    });
    bodyEl.append(hint, link, field, row, err);
    card.append(head, bodyEl);
    signinSlot.append(card);
  };

  /** Drop the inline sign-in card without reloading the page. */
  var renderAccountSigninClose = function () {
    if (signinSlot) signinSlot.textContent = '';
  };

  if (usageBody) loadUsage();
  if (tokensBody || recentBody || tileCalls) loadTokens(true);
  if (modelsBody) loadModels();
})();
`;

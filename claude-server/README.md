# claude-server

Holds one Claude Pro/Max subscription grant and answers requests on behalf of
local DSH clients, each presenting its own token.

## Why it exists

A subscription token can only be refreshed in one place. Anthropic rotates the
refresh token on every refresh, so two processes refreshing the same grant
invalidate each other — whichever writes last wins, and the other is locked out.
This server is the single owner: it signs in once, refreshes on its own, and
never hands the token out. Clients present a bearer instead.

Two consequences worth knowing:

- The token never travels to the other machines, so a compromised client costs
  quota rather than the credential.
- The egress address is the server's, so every request presents the same source
  regardless of where the client runs.

## Users

Every caller presents a token this server issued. There are two roles:

| Role | Relay | Console |
|---|---|---|
| `client` | yes | no |
| `admin` | yes | yes — can manage users and replace the Claude grant |

Issue and revoke tokens on the **Users** page of the console (`/admin/users`).
A new token is shown **once**, immediately after creation, and cannot be
recovered later: only `sha256(token)` is stored, so the file can check a token
but never reproduce one. Lost a token? Remove the user and issue a new one.

`CLIENT_BEARER` from the environment still works and is shown in the console as
the immutable **Legacy bearer** row. It is the admin bootstrap — it cannot be
disabled, renamed, or removed without editing the environment — which is why the
server still refuses to start without it.

Users live in `users.json`, mode `0600`, written by atomic rename on the same
volume as the grant. A missing file means "no users yet"; a corrupt one stops
stored users from authenticating but leaves the legacy bearer working, so a bad
user file cannot lock the operator out of the relay.

## Install and run

```bash
cp .env.local.example .env.local
# fill in CLIENT_BEARER (openssl rand -base64 36)
docker compose --env-file .env.local up -d --build
```

Two shapes, chosen by the env file:

| Env file | Mode | Egress |
|---|---|---|
| `.env.local.example` | `proxy` | through `claude-gate:9077` on `claude-stealth` |
| `.env.server.example` | `direct` | the host's own address |

`proxy` mode refuses to start without a usable proxy URL; there is no silent
direct fallback, because that would make the observable egress depend on whether
the proxy happened to be reachable.

## Sign in (authorization-code mode)

Nothing listens on the redirect URI. The flow is:

1. `POST /login/start` → `{ id, url }`
2. Open `url` in any browser on any machine, authorize
3. The browser lands on `http://localhost:53692/callback?code=…` — the page will
   not load, which is expected. Copy the address bar, or just the `code` value.
4. `POST /login/complete { id, code }` where `code` is either the full redirect
   URL, `code#state`, or a bare code

All three shapes are accepted; the official CLI requires the `code#state` form.
The PKCE verifier doubles as the OAuth `state`, so a code from another attempt is
rejected.

Every `/login/*` route requires an **admin** token, and the console's own
sign-in page uses the same flow through a session. An unauthenticated login
endpoint would let anyone on the network bind their own account to this server,
and a plain `client` token must not be enough either: minting a grant is an
administrative act.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness and whether a grant exists |
| `GET /status` | admin | Mode, sign-in state, expiry |
| `POST /login/start` | admin | Begin an attempt; returns the authorize URL |
| `POST /login/complete` | admin | Exchange a pasted code for a grant |
| `POST /login/cancel` | admin | Discard a pending attempt |
| everything else | any live user | Relayed to Anthropic |

`/healthz` is deliberately unauthenticated and reports nothing sensitive.

### Console

The console is a browser surface, so it cannot use a bearer header on a
top-level navigation. It has its own session instead: the operator pastes an
admin token into the unlock form, the server verifies it once, and replies with
an HttpOnly, `SameSite=Strict`, `Path=/admin` cookie. The token never appears
in a URL, a redirect, or a log line.

Pages (all redirect to unlock without a session):

| Page | Contents |
|---|---|
| `/admin` | Unlock form, or a redirect to the overview |
| `/admin/overview` | Sign-in state, quota windows, user count, relayed calls |
| `/admin/account` | Claude sign-in, grant state, console session |
| `/admin/users` | Add, disable, and remove users |
| `/admin/usage` | Token accounting for relayed traffic |
| `/admin/models` | The model catalog this subscription can call |

JSON API behind the session (all under `/admin/api/`, all `401` JSON when the
session is absent):

| Route | Purpose |
|---|---|
| `POST /admin/api/session` | Unlock; admin tokens only |
| `POST /admin/api/logout` | End the session |
| `GET /admin/api/status` | Mode, sign-in state, expiry, CLI version |
| `GET /admin/api/quota` | Quota windows (cached for 5 minutes) |
| `GET /admin/api/models` | Model catalog |
| `GET /admin/api/usage` | Token accounting |
| `GET /admin/api/users` | List users (never includes tokens or hashes) |
| `POST /admin/api/users` | Create a user; the only place a token is revealed |
| `PATCH /admin/api/users/<id>` | Rename, disable, or change the role |
| `DELETE /admin/api/users/<id>` | Remove a user |
| `POST /admin/api/login/start` | Begin a Claude sign-in |
| `POST /admin/api/login/complete` | Exchange a pasted code |
| `POST /admin/api/login/cancel` | Discard a pending attempt |

The console's pages load no external asset: styles and script are inline, and
the response carries `default-src 'none'` with `frame-ancestors 'none'`.

## What it changes on the wire

The client's bearer is replaced with the real access token, and the Claude Code
identity is rebuilt (`claude-cli/…` User-Agent, `x-app: cli`, the two OAuth
betas, `x-stainless-*`). The rebuild is idempotent, so a client that already did
it is unaffected — that redundancy is intentional, since either side may be
updated independently.

The request body is relayed untouched except for one case: identity strings in
the `system` array (`DeepSeek Harness`) are replaced with neutral wording when a
client did not already do it. The `messages` array is never rewritten — a user
may legitimately be discussing those words — and filesystem paths are preserved,
because a workspace path is functional input.

Responses are relayed byte for byte, including `content-encoding` and
`content-length`. This is why the transport uses `undici.request` rather than
`fetch`: `fetch` decodes the body and drops the encoding header, which would hand
clients a header set a direct connection never produces.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CLIENT_BEARER` | *required* | The bearer clients present. ≥24 chars; the server refuses to start without it |
| `UPSTREAM_MODE` | `proxy` | `proxy` or `direct` |
| `PROXY_URL` | — | Required in `proxy` mode |
| `LISTEN_PORT` | `4710` | |
| `GRANT_PATH` | `/data/grant.json` | Written 0600 via atomic rename |
| `USERS_PATH` | `users.json` beside `GRANT_PATH` | User directory; 0600, atomic rename. Created on first user, never at boot |
| `CLAUDE_CLI_VERSION` | `2.1.303` | Version claimed on the wire |
| `STAINLESS_RUNTIME_VERSION` | `v22.19.0` | Pinned, not read from the process |
| `SANITIZE_BODY` | `true` | Identity-string replacement in `system` |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

`STAINLESS_RUNTIME_VERSION` is pinned on purpose. Deriving it from
`process.version` would make the claimed runtime change with the image while the
`claude-cli/…` User-Agent beside it stayed fixed — a self-contradiction on the
wire.

## Tests

```bash
node --test 'test/*.test.js'
```

Note the glob: the bare directory form is not a test pattern. `undici@8` needs
Node ≥ 22.19, so run this on a modern Node even though the server itself only
needs what `package.json` declares.

104 checks, none of which contact Anthropic: the identity and sanitisation rules
are unit-tested, the user directory is exercised against a real temp file, the
console's authentication boundary is asserted over HTTP, and the relay runs end
to end against a local stub upstream in `direct` mode.

One check asserts the grant file is `0600`; it is skipped on Windows, where the
POSIX mode does not exist.

## Layout

```
src/
  index.js       Entry point: wiring and shutdown
  config.js      Environment validation; refuses half-configured startup
  server.js      Routes: relay, console pages, console JSON API
  auth.js        Roles: relay user vs console admin; constant-time comparison
  users.js       The user directory: hashed tokens, roles, atomic writes
  identity.js    withClaudeIdentity, ensureBaseBetas
  upstream.js    Path mapping, ?beta=true
  grant.js       Atomic grant write, single-flight refresh
  admin.js       Console shell, pages, and the inline client script
  admin-style.js The console stylesheet (tokens, dark and light)
  oauth.js       PKCE, code exchange, refresh, pasted-input parsing
  login.js       Pending attempts: TTL and single use
  sanitize.js    Body identity replacement (rule order is semantic)
  transport.js   proxy/direct, raw byte relay via undici.request
```

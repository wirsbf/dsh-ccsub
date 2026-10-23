# claude-server

Holds one Claude Pro/Max subscription grant and answers requests on behalf of
local DSH clients that hold no credential of their own.

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

Every `/login/*` route requires the client bearer. An unauthenticated login
endpoint would let anyone on the network bind their own account to this server.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness and whether a grant exists |
| `GET /status` | bearer | Mode, sign-in state, expiry |
| `POST /login/start` | bearer | Begin an attempt; returns the authorize URL |
| `POST /login/complete` | bearer | Exchange a pasted code for a grant |
| `POST /login/cancel` | bearer | Discard a pending attempt |
| everything else | bearer | Relayed to Anthropic |

`/healthz` is deliberately unauthenticated and reports nothing sensitive.

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

28 checks, none of which contact Anthropic: the identity and sanitisation rules
are unit-tested, and the relay is exercised end to end against a local stub
upstream in `direct` mode.

## Layout

```
src/
  index.js       Entry point: wiring and shutdown
  config.js      Environment validation; refuses half-configured startup
  server.js      Routes plus the relay
  auth.js        Client bearer, constant-time comparison
  identity.js    withClaudeIdentity, ensureBaseBetas
  upstream.js    Path mapping, ?beta=true
  grant.js       Atomic grant write, single-flight refresh
  oauth.js       PKCE, code exchange, refresh, pasted-input parsing
  login.js       Pending attempts: TTL and single use
  sanitize.js    Body identity replacement (rule order is semantic)
  transport.js   proxy/direct, raw byte relay via undici.request
```

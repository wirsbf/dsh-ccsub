# dsh-ccsub — Claude Subscription route for DSH

Registers one `LlmAdapter` route, **`claude-sub`**, that sends model requests to
Anthropic using a **Claude Pro/Max subscription** obtained through the official
browser OAuth flow. Ships a settings card with the subscription's rate-limit
windows and an **egress guard** that makes a proxy mandatory for every request
the route makes.

## What it does

| Capability | How |
|---|---|
| Browser OAuth (PKCE) sign-in | pi-ai's official Anthropic flow, driven through `ctx.authorization` |
| Automatic token refresh | pi-ai's refresh, run inside `ctx.credentials.modifyRecord()` so the read‑decide‑write spans a network round trip **under a lock that holds across processes** |
| Quota panel (5h / weekly + reset countdown) | `GET /api/oauth/usage`, both the modern `limits` array and the legacy `five_hour`/`seven_day*` shapes |
| Route + model catalog | The real pi-ai Anthropic catalog, re-keyed onto `claude-sub` |
| Egress protection | Mandatory proxy, optional egress-IP allowlist, User-Agent rewrite |

## Service requirements

Only `llm` is a hard requirement (`export const inject = ['llm']`). The web
server and authorization services are attached with nested `ctx.inject(...)`
inside `apply`, so:

- in a **headless or TUI profile** the `claude-sub` model route still works —
  it simply has no settings card and no browser sign-in;
- a service that is missing or mounts late never blocks activation, and the
  callbacks run as soon as each service appears.

`/status` reports `loginAvailable` from
`authorization.describe(key) !== undefined`, so a mounted authorization service
that never received our flow reads as **not** available rather than offering a
sign-in button that would fail with `NO_FLOW`.

## Why a separate route instead of reusing `anthropic`

`dsh-llm-pi-ai` builds request headers as `requestHeaders(profile.headers)`,
which merges `attributionHeaders()` **last** and filters profile headers whose
names collide case-insensitively with the reserved attribution names. On the
shared `anthropic` route the harness User-Agent therefore always wins, and a
subscription identity cannot be kept self-consistent. Profile configuration
cannot fix this, and `requestHeaders` is module-private (not exported), so a
`PiAiAdapter` subclass cannot either. Registering our own route is the fix.

## ⚠️ Deliberate deviation from the adapter contract

`LlmAdapter` documents:

> Every provider HTTP request must include `attributionHeaders()`; prove the
> headers are added in the wire request or library header hook.

**This route intentionally does not.** A subscription request is authenticated
as the Claude Code client and carries
`You are Claude Code, Anthropic's official CLI for Claude.` as its leading
system block. Sending harness attribution in the same request would make the two
identities contradict each other, which is precisely the situation this plugin
exists to avoid. `lib/egress.js` rewrites `user-agent` to
`claude-cli/<version>` as the final step before dispatch, so the identity on the
wire is self-consistent by construction.

This is a knowing, documented trade-off — not an oversight.

## Egress protection

Three guarantees, in priority order:

1. **The proxy is mandatory.** Every request goes through the one configured
   proxy. There is no fall-back-to-direct path: a missing or unreachable proxy
   **fails the request** rather than leaking the host's real address. This
   applies to the quota probe too, so a usage call can never be the one that
   leaks.
2. **The egress allowlist is opt-in but enforced.** When `proxy.egressAllow` is
   non-empty, the observed egress IP must match or the request is refused.
   `proxy.requireEgressCheck: true` additionally refuses when the egress cannot
   be verified at all.
3. **The User-Agent is restored** immediately before the socket write, below the
   header merge that would otherwise clobber it.

> **Caveat, by construction:** the browser step of the sign-in runs in *your*
> browser and uses *its* network settings. This plugin cannot control or verify
> that hop. The guard covers every request the plugin itself makes.

### The proxy must actually reach Anthropic

The default is `http://127.0.0.1:9077`, the **Claude-specific** proxy. This is
not a stylistic choice — measured against the general proxy on `9076`:

| Target | via 9076 | via 9077 |
|---|---|---|
| `api.ipify.org` (egress probe) | 200 | 200 |
| `github.com` | 200 | — |
| `api.openai.com` | 401 | — |
| **`api.anthropic.com`** | **ECONNRESET** | 404 (HTTP-level) |
| **`claude.ai`** | **ECONNRESET** | — |
| **`platform.claude.com`** (token) | **ECONNRESET** | 400 (HTTP-level) |

9076 carries general traffic and the egress probe fine, but resets the
connection for every Anthropic host. Pointing the route at it yields a
green-looking plugin (`/egress` reports an IP, `/status` lists models) in which
**no request can ever succeed**. If a future setup routes Anthropic through the
general proxy instead, change `proxy.url`; the guard cannot detect this on its
own, because the reset happens below HTTP.

### Which gateway each request takes

| Request | Transport | Guarded? |
|---|---|---|
| Model requests (`/v1/messages`) | `fetch` injected into pi-ai's transport | yes |
| Quota probe (`/api/oauth/usage`) | `guard.fetch` directly | yes |
| OAuth token exchange + refresh | pi-ai's bare global `fetch`, **redirected** to the guard for the token endpoint only | yes, via `guardTokenEndpoint()` |
| Browser authorize page | your browser, not this process | **no — out of reach** |

The third row is the subtle one. pi-ai's `postJson` calls `globalThis.fetch`,
and neither `Models.login` nor `oauth.refresh` accepts a transport, so the token
exchange would otherwise ride whatever proxy the process happened to install
while skipping the mandatory-proxy enforcement, the allowlist, and the identity
rewrite. `guardTokenEndpoint()` patches the global **once**, redirecting only
`platform.claude.com/v1/oauth/token` and passing every other request in the
process — including other plugins' — through untouched, and restores it on
disposal.

## Configuration

```yaml
proxy:
  url: 'http://127.0.0.1:9077'   # the Claude-specific proxy; mandatory in practice
  egressAllow: []                # empty disables the comparison, not the proxy
  requireEgressCheck: false
  egressUrl: 'https://api.ipify.org?format=json'
claudeCliVersion: '2.1.283'
refreshSkewMs: 300000
quotaPollMs: 180000
```

## Install

Install the **package directory** through the harness plugin manager
(`plugin_manager` → `install_bundle`, target = this directory). The manager owns
the profile's `package.json` and bundle list; do not edit them by hand.

Because the manager installs this package as a **link** to the source directory,
Node resolves its dependencies from *here*, not from the profile. The real
runtime dependencies (`@earendil-works/pi-ai`, `undici`, `@deepseek-ai/schemastery`)
are declared in `package.json`; `@deepseek-ai/cordis`, `dsh-credentials`,
`dsh-llm`, and `dsh-llm-pi-ai` are peer dependencies supplied by the harness.

Authoring directly in the linked directory means edits take effect on the next
host restart (a replaced package needs a fresh module generation). Pack and
install a tarball instead when you want an immutable artifact:

```bash
mkdir -p /tmp/ccsub-pack/package
cp -r package.json cordis.patch.yml icon.svg README.md lib locale /tmp/ccsub-pack/package/
(cd /tmp/ccsub-pack && tar czf dsh-ccsub-<version>.tgz package)
```

> The `package/` prefix matters: a tarball without it makes pnpm flatten the
> files into the install root, and the `exports` paths then 404.

## Configuration surface

| Endpoint | Purpose |
|---|---|
| `GET /plugins/dsh-ccsub/status` | Route, grant, proxy, CLI version, model list |
| `GET /plugins/dsh-ccsub/quota` | Rate-limit windows (needs a grant) |
| `GET /plugins/dsh-ccsub/egress` | Live egress-IP observation through the proxy |
| `POST /plugins/dsh-ccsub/login` | Start the browser sign-in; returns a poll view |
| `POST /plugins/dsh-ccsub/login/poll` | Next notice or question from the flow |
| `POST /plugins/dsh-ccsub/login/answer` | Answer the flow's question |
| `POST /plugins/dsh-ccsub/login/cancel` | Cancel an in-flight sign-in |
| `POST /plugins/dsh-ccsub/logout` | Delete the stored grant |

## Layout

```
lib/
  index.js          Host plugin: route registration + HTTP surface
  adapter.js        The claude-sub LlmAdapter (PiAiAdapter + guarded transport)
  egress.js         Mandatory-proxy guard, allowlist, UA rewrite
  auth/
    store.js        ctx.credentials-backed CredentialStore + AuthContext
    claude.js       Sign-in, refresh-under-lock, usage parsing
    flow.js         ctx.authorization flow (pi-ai events → seam vocabulary)
    bridge.js       Host-side sign-in conversation for the settings card
  client/index.js   Browser settings card
```

## Credits

Reuses [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)
for the Anthropic Messages translation, the subscription request shape, the
official OAuth flow, and the model catalog. The usage-endpoint response shapes
were cross-checked against `dsh-plugin-subscriptions`.

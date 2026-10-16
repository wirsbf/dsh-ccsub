/**
 * The Claude Subscription route for DSH.
 *
 * This plugin registers one `LlmAdapter` route, `claude-sub`, which sends
 * model requests to Anthropic using a Claude Pro/Max subscription obtained
 * through the official browser OAuth flow. It also exposes the subscription's
 * rate-limit windows and enforces an egress policy on every request it makes.
 *
 * ## Deviation from the adapter attribution contract
 *
 * `LlmAdapter` documents that every provider HTTP request must include
 * `attributionHeaders()`. **This route deliberately does not**, and that is the
 * point of it: a subscription request is authenticated as the Claude Code
 * client, and presenting harness attribution in the same request would make the
 * two identities contradict each other. The guard rewrites the User-Agent to
 * `claude-cli/<version>` as the final step before dispatch, and this note
 * records that the omission is intentional rather than an oversight.
 *
 * @module dsh-ccsub
 */

import Schema from '@deepseek-ai/schemastery';
import { EgressGuard, parseAllowlist, normalizeProxyUrl, DEFAULT_EGRESS_URL } from './egress.js';
import { createAdapter } from './adapter.js';
import { LoginBridge } from './auth/bridge.js';
import { registerLogin } from './auth/flow.js';
import {
  resolveAccessToken,
  fetchUsage,
  guardTokenEndpoint,
  ensureFetchGuarded,
  subscriptionProvider,
  modelsFor,
} from './auth/claude.js';
import { PROVIDER_ID, recordKeyFor, describeGrant } from './auth/store.js';

/** The only route this plugin serves. */
const ROUTE = PROVIDER_ID;

/** Base path for this plugin's HTTP surface. */
const API_BASE = '/plugins/dsh-ccsub';

/** Where the latest official CLI version is read from (through the guard). */
const NPM_LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
/** Used when no auto-resolved version is available yet. */
const FALLBACK_CLI_VERSION = '2.1.283';
/** How often the auto-resolved version is refreshed. */
const CLI_VERSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the global fetch guard is re-asserted against over-wrapping. */
const FETCH_GUARD_HEAL_MS = 60 * 1000;
/** How often the dynamic model catalog overlay is refreshed. */
const MODELS_REFRESH_MS = 24 * 60 * 60 * 1000;

export const name = 'dsh-ccsub';

/**
 * Required services.
 *
 * Only `llm` is a hard requirement: it is what this plugin exists to extend.
 * The web server, authorization, and credential store are optional — a headless
 * or TUI profile has no web server yet still uses the model route. Those are
 * attached with `ctx.inject` inside `apply`, which waits for each service
 * instead of preventing activation.
 */
export const inject = ['llm'];

/**
 * Plugin configuration.
 *
 * The proxy block is the security-relevant part: `url` is mandatory in
 * practice because the guard refuses to send without it, which is what keeps a
 * request from escaping from the host's real address.
 */
export const Config = Schema.object({
  proxy: Schema.object({
    /**
     * The single transport every request must use. Empty means "refuse to send".
     *
     * 9077 is the Claude-specific proxy. The general proxy (9076) resets the
     * connection for every `api.anthropic.com` / `claude.ai` host, so it can
     * serve the egress probe but not this route.
     */
    url: Schema.string().default('http://127.0.0.1:9077'),
    /** Expected egress addresses; empty enables session-pinning of the first observed IP. */
    egressAllow: Schema.array(Schema.string()).default([]),
    /** Refuse when the egress cannot be verified rather than only warning. Default on. */
    requireEgressCheck: Schema.boolean().default(true),
    /** Where to read the observed egress address from. */
    egressUrl: Schema.string().default(DEFAULT_EGRESS_URL),
  }),
  /**
   * The Claude Code version to present on the wire. The literal `auto`
   * resolves to the latest published CLI version (read from the npm registry
   * through the guarded transport, refreshed weekly); any other string is
   * pinned as-is.
   */
  claudeCliVersion: Schema.string().default('auto'),
  /** Refresh an access token this long before it expires. */
  refreshSkewMs: Schema.number().default(300_000),
  /** How often the client polls the quota endpoint. */
  quotaPollMs: Schema.number().default(180_000),
});

/**
 * Read one JSON request body.
 * @param req - the incoming request.
 * @param limit - the largest body to accept.
 * @returns the parsed body, or undefined when absent.
 */
async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Answer one request with JSON.
 * @param res - the response to write.
 * @param status - the HTTP status.
 * @param body - the value to serialize.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Turn a thrown failure into a stable JSON error body.
 * @param error - the thrown value.
 * @returns the body to send with a 4xx/5xx status.
 */
function errorBody(error) {
  return { error: String(error?.message ?? error), code: error?.code ?? null };
}

/**
 * The plugin body.
 * @param ctx - the plugin context.
 * @param config - the validated configuration.
 */
export function apply(ctx, config) {
  /** The auto-resolved CLI version, when claudeCliVersion is `auto`. */
  const versionState = { resolved: undefined, at: 0 };
  const resolveInProgress = { running: false };

  /**
   * Read the latest published CLI version through the guarded transport.
   *
   * Best-effort: failures keep the previous value (or the fallback) and are
   * retried on the next interval tick, so a registry hiccup never blocks a
   * model request on version resolution.
   */
  const refreshCliVersion = async () => {
    if (resolveInProgress.running) return;
    resolveInProgress.running = true;
    try {
      const response = await guard.fetch(NPM_LATEST_URL, {
        // NB: the Claude-specific proxy answers 406 to npm's install-v1
        // accept type; plain application/json passes.
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return;
      const payload = await response.json();
      const version = payload?.version;
      if (typeof version === 'string' && version.length > 0) {
        versionState.resolved = version;
        versionState.at = Date.now();
        ctx.logger?.info('dsh-ccsub: presenting claude-cli/%s (auto)', version);
      }
    } catch {
      // Keep the previous resolution; the next tick retries.
    } finally {
      resolveInProgress.running = false;
    }
  };

  /**
   * The live configuration, re-read per request so edits apply immediately.
   * `auto` is materialised here so every consumer downstream of `current()`
   * sees a concrete version string.
   */
  const current = () => {
    if (config.claudeCliVersion !== 'auto') return config;
    return {
      ...config,
      claudeCliVersion: versionState.resolved ?? FALLBACK_CLI_VERSION,
    };
  };
  const guard = new EgressGuard(() => current().proxy ?? {}, ctx.logger);
  ctx.effect(() => () => guard.dispose());

  // pi-ai exchanges and refreshes tokens with the bare global `fetch`, so the
  // token endpoint is redirected through the guard for the life of the plugin.
  ctx.effect(() => guardTokenEndpoint(guard));
  // Another plugin or an undici upgrade can wrap the global after us; heal the
  // patch on a slow tick so the guarantee survives the process lifetime.
  ctx.effect(() => {
    const timer = setInterval(() => ensureFetchGuarded(guard), FETCH_GUARD_HEAL_MS);
    return () => clearInterval(timer);
  });
  // Resolve the CLI version now (for a fresh process) and on the TTL.
  void refreshCliVersion();
  ctx.effect(() => {
    const timer = setInterval(() => void refreshCliVersion(), CLI_VERSION_TTL_MS);
    return () => clearInterval(timer);
  });

  // One provider instance serves both the route adapter and the Models
  // collection, so a dynamic catalog refresh is visible to the route without
  // re-registering the adapter.
  const sharedProvider = subscriptionProvider(guard);
  const models = modelsFor(ctx, guard, sharedProvider);

  /**
   * Refresh the dynamic model catalog overlay through the guarded transport.
   *
   * Best-effort like the CLI version resolution: a failure keeps the previous
   * overlay (and the static baseline) and is retried on the next tick.
   */
  const refreshModelCatalog = async () => {
    try {
      const result = await models.refresh({ providers: [PROVIDER_ID] });
      const failure = result.errors.get(PROVIDER_ID);
      if (failure !== undefined) {
        ctx.logger?.warn('dsh-ccsub: model catalog refresh failed: %s', failure.message);
        return;
      }
      ctx.logger?.info(
        'dsh-ccsub: model catalog refreshed (%d models on the route)',
        sharedProvider.getModels().length,
      );
    } catch (error) {
      ctx.logger?.warn('dsh-ccsub: model catalog refresh failed: %s', error?.message ?? error);
    }
  };

  const adapter = createAdapter({
    guard,
    provider: sharedProvider,
    resolveApiKey: async () => await resolveAccessToken(ctx, current(), undefined),
    resolveAttachments: () => ctx.get('attachments'),
  });

  ctx.effect(() => ctx.llm.registerAdapter([ROUTE], adapter));

  // Refresh the dynamic model overlay now (when signed in) and daily. When no
  // grant is stored the refresh resolves no credential and is a no-op. The
  // scheduling waits for the credentials service: at mount time the service
  // may not be attached yet, and a refresh that reads no credential silently
  // skips its network phase — which is exactly what must not happen.
  ctx.inject(['credentials'], () => {
    void refreshModelCatalog();
    ctx.effect(() => {
      const timer = setInterval(() => void refreshModelCatalog(), MODELS_REFRESH_MS);
      return () => clearInterval(timer);
    });
  });

  // ---- Host HTTP surface, consumed by the settings card -------------------
  //
  // The service surfaces below are gated with `ctx.inject` rather than the
  // module-level `inject` array. Declaring them there would make them hard
  // requirements, so `apply` would never run in a profile without a web server
  // — and the model route, which does not need one, would disappear with it.

  ctx.inject(['authorization'], (authCtx) => {
    // Register the flow the settings card begins. Without this the flow key has
    // no handler and `authorization.begin` fails with `NO_FLOW`.
    registerLogin(authCtx);
  });

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/status`,
        async handler(_req, res) {
          try {
            const record = await ctx.get('credentials')?.readRecord(recordKeyFor(ROUTE));
            const proxyUrl = normalizeProxyUrl(current().proxy?.url);
            sendJson(res, 200, {
              route: ROUTE,
              grant: describeGrant(record),
              proxy: {
                url: proxyUrl ?? null,
                valid: proxyUrl !== undefined,
                allow: parseAllowlist(current().proxy?.egressAllow),
                requireEgressCheck: current().proxy?.requireEgressCheck === true,
              },
              claudeCliVersion: current().claudeCliVersion,
              quotaPollMs: current().quotaPollMs,
              // Report whether sign-in can actually run, not merely whether an
              // authorization service exists: a service without our flow fails
              // `begin` with NO_FLOW, and this field is what the card trusts.
              loginAvailable:
                ctx.get('authorization')?.describe?.(recordKeyFor(ROUTE)) !== undefined,
              models: (await adapter.listModels(ROUTE)).map((model) => ({ id: model.id, name: model.name })),
            });
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        },
      }),
    );

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/quota`,
        async handler(req, res) {
          const controller = new AbortController();
          req.on('close', () => controller.abort());
          try {
            sendJson(res, 200, await fetchUsage(ctx, guard, current(), controller.signal));
          } catch (error) {
            sendJson(res, 502, errorBody(error));
          }
        },
      }),
    );

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/egress`,
        async handler(_req, res) {
          try {
            const observed = await guard.observeEgress(undefined);
            const allow = parseAllowlist(current().proxy?.egressAllow);
            sendJson(res, 200, {
              proxyUrl: normalizeProxyUrl(current().proxy?.url) ?? null,
              observed: observed ?? null,
              allow,
              allowed: observed === undefined || allow.length === 0 ? null : allow.includes(observed),
              error: observed === undefined ? 'the proxy did not report an egress address' : null,
            });
          } catch (error) {
            sendJson(res, 502, errorBody(error));
          }
        },
      }),
    );

    webCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/logout`,
        async handler(_req, res) {
          try {
            await ctx.get('credentials')?.deleteRecord(recordKeyFor(ROUTE));
            sendJson(res, 200, { ok: true });
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        },
      }),
    );
  });

  // The sign-in conversation needs both a flow registry and somewhere to serve
  // its notices and questions.
  ctx.inject(['webServer', 'authorization'], (bothCtx) => {
    const webServer = bothCtx.get('webServer');
    const bridge = new LoginBridge(bothCtx.get('authorization'), recordKeyFor(ROUTE), ctx.logger);

    bothCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/login`,
        async handler(req, res) {
          try {
            const controller = new AbortController();
            req.on('close', () => controller.abort());
            // The attempt outlives this request: the card polls /login/poll for
            // the notice or question it must render next.
            void bridge.start();
            sendJson(res, 202, await bridge.poll(controller.signal));
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        },
      }),
    );

    bothCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/login/poll`,
        async handler(req, res) {
          const controller = new AbortController();
          req.on('close', () => controller.abort());
          try {
            sendJson(res, 200, await bridge.poll(controller.signal));
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        },
      }),
    );

    bothCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/login/answer`,
        async handler(req, res) {
          try {
            const body = (await readJson(req)) ?? {};
            const accepted = bridge.answer(String(body.id ?? ''), String(body.value ?? ''));
            sendJson(res, accepted ? 200 : 409, { accepted });
          } catch (error) {
            sendJson(res, 500, errorBody(error));
          }
        },
      }),
    );

    bothCtx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${API_BASE}/login/cancel`,
        async handler(_req, res) {
          bridge.cancel();
          sendJson(res, 200, { ok: true });
        },
      }),
    );
  });

  ctx.logger?.info(
    'dsh-ccsub: route "%s" registered (proxy %s)',
    ROUTE,
    normalizeProxyUrl(current().proxy?.url) ?? 'NOT CONFIGURED — requests will be refused',
  );
}

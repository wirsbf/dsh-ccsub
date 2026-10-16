/**
 * The sign-in flow registered on `ctx.get('authorization')`.
 *
 * pi-ai's Anthropic login drives a browser redirect and a loopback callback,
 * and races that callback against a manually pasted code. The seam's session
 * only speaks `notify` and `prompt`, so this module restates pi-ai's events in
 * that vocabulary — carrying `prompt.signal` through, because that signal is
 * how the losing half of the race is withdrawn.
 *
 * @module dsh-ccsub/auth/flow
 */

import { recordKeyFor } from './store.js';
import { loginWithBrowser } from './claude.js';

/**
 * Restate one pi-ai prompt in the seam's vocabulary.
 *
 * `manual_code` becomes plain text: the distinction pi-ai draws — a code
 * copied from a browser rather than a value the human knows — changes nothing
 * a rendered prompt needs to express.
 * @param prompt - what pi-ai asked.
 * @returns the neutral prompt to put to the human.
 */
export function restatePrompt(prompt) {
  const signal = prompt.signal === undefined ? {} : { signal: prompt.signal };
  switch (prompt.type) {
    case 'select':
      return { ...signal, kind: 'select', message: prompt.message, options: prompt.options };
    case 'secret':
      return {
        ...signal,
        kind: 'secret',
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      };
    default:
      return {
        ...signal,
        kind: 'text',
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      };
  }
}

/**
 * Relay one pi-ai event to the authorization session.
 *
 * The `auth_url` case matters most: the browser must be opened by the human,
 * and the plugin cannot reach into their browser's proxy settings — so the
 * URL is surfaced rather than fetched.
 * @param event - the pi-ai event.
 * @param session - the seam's session.
 */
export function relayEvent(event, session) {
  switch (event.type) {
    case 'auth_url':
      session.notify({
        message: event.instructions ?? 'Open this page to sign in to your Claude subscription.',
        url: event.url,
      });
      return;
    case 'device_code':
      session.notify({
        message: 'Enter this code on the verification page to finish signing in.',
        url: event.verificationUri,
        code: event.userCode,
      });
      return;
    case 'progress':
      session.notify({ message: event.message });
      return;
    default:
      session.notify({ message: 'Signing in…' });
  }
}

/**
 * Register the sign-in flow.
 *
 * Registration is unconditional on configuration: the route has to be signed
 * into before a profile is worth adding, so the flow exists from mount.
 *
 * The flow owns its write, and pi-ai's `Models.login()` is that writer: it
 * persists the grant through this plugin's credential store, which is the same
 * serialized `ctx.get('credentials')` path a refresh takes. Nothing is copied back
 * out and written twice.
 * @param ctx - the plugin context carrying `ctx.get('authorization')`.
 */
export function registerLogin(ctx) {
  const authorization = ctx.get('authorization');
  if (authorization === undefined) {
    ctx.logger?.warn(
      'dsh-ccsub: no authorization service is mounted, so the browser sign-in is unavailable; the route still reads an existing grant',
    );
    return;
  }
  ctx.effect(() =>
    authorization.registerFlow({
      key: recordKeyFor('claude-sub'),
      label: 'Claude Subscription',
      methods: [{ id: 'oauth', label: 'Sign in with your browser' }],
      async run(session) {
        await loginWithBrowser(ctx, {
          signal: session.signal,
          notify: (event) => relayEvent(event, session),
          prompt: (prompt) => session.prompt(restatePrompt(prompt)),
        });
      },
    }),
  );
}

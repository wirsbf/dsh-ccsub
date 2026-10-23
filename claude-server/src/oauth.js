/**
 * The OAuth half: authorization URL, code exchange, and refresh.
 *
 * These are the same four operations pi-ai performs, restated so this server
 * depends on nothing but Node. The constants (client id, token URL, redirect
 * URI, scope set) are Anthropic's public OAuth parameters, not pi-ai internals,
 * so restating them costs no fidelity — and it keeps the server image small.
 *
 * ## Authorization-code mode
 *
 * The official CLI and pi-ai both run a browser redirect *and* a paste-prompt at
 * the same time, first one wins. This server does the same thing without a
 * callback listener at all: it returns the authorize URL, and the operator
 * pastes back either the full redirect URL or `code#state`. Nothing listens on
 * the redirect URI — it only has to *look* right to the authorize page.
 *
 * @module claude-server/oauth
 */

import { createHash, randomBytes } from 'node:crypto';
import { CLIENT_ID, REDIRECT_URI, SCOPES, TOKEN_URL } from './grant.js';

/** Where the authorize page lives. */
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';

/** Base64url without padding, matching the PKCE spec. */
function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate one PKCE pair.
 *
 * `verifier` doubles as the OAuth `state`, which is what the official client
 * does — it means a pasted code can be bound to this attempt by echoing the
 * same string back.
 * @returns the verifier and its S256 challenge.
 */
export function generatePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Build the authorize URL for one attempt.
 * @param challenge - the S256 challenge.
 * @param state - echoed back on the redirect; use the verifier.
 * @returns the URL to open.
 */
export function authorizeUrl(challenge, state) {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Extract a code and state from whatever the operator pasted.
 *
 * Three shapes are accepted, because all three occur in practice: the full
 * redirect URL from the address bar, the `code#state` form the official CLI
 * prints, and a bare code.
 * @param input - the pasted text.
 * @returns the code and an optional state.
 * @throws {Error} when no code can be found.
 */
export function parseAuthorizationInput(input) {
  const value = String(input ?? '').trim();
  if (value.length === 0) throw new Error('no authorization code was provided');
  try {
    const url = new URL(value);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code !== null) return { code, state: state ?? undefined };
  } catch {
    // Not a URL; fall through.
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    if (code) return { code, state: state || undefined };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    const code = params.get('code');
    if (code !== null) return { code, state: params.get('state') ?? undefined };
  }
  return { code: value };
}

/**
 * POST to the token endpoint and normalize the reply.
 * @param body - the form body.
 * @param fetchImpl - the transport to use.
 * @param signal - caller cancellation.
 * @returns the normalized grant.
 */
async function postToken(body, fetchImpl, signal) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`the token endpoint answered ${response.status}: ${text.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`the token endpoint returned invalid JSON: ${String(error)}`);
  }
  const access = payload?.access_token;
  const refresh = payload?.refresh_token;
  const expiresIn = payload?.expires_in;
  if (typeof access !== 'string' || access.length === 0) {
    throw new Error('the token endpoint returned no access_token');
  }
  if (typeof refresh !== 'string' || refresh.length === 0) {
    throw new Error('the token endpoint returned no refresh_token');
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    throw new Error('the token endpoint returned no usable expires_in');
  }
  return {
    type: 'oauth',
    access,
    refresh,
    // Refresh five minutes early, as the official client does.
    expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
  };
}

/**
 * Exchange an authorization code for a grant.
 * @param code - the code from the redirect.
 * @param verifier - this attempt's PKCE verifier.
 * @param fetchImpl - the transport to use.
 * @param signal - caller cancellation.
 * @returns the grant to store.
 */
export async function exchangeCode(code, verifier, fetchImpl, signal) {
  return await postToken(
    {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state: verifier,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
    fetchImpl,
    signal,
  );
}

/**
 * Refresh an existing grant.
 *
 * The reply carries a new refresh token; the caller must persist it, because
 * the old one is no longer valid.
 * @param refreshToken - the current refresh token.
 * @param fetchImpl - the transport to use.
 * @param signal - caller cancellation.
 * @returns the replacement grant.
 */
export async function refreshGrant(refreshToken, fetchImpl, signal) {
  return await postToken(
    {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    },
    fetchImpl,
    signal,
  );
}

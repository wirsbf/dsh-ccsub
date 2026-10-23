/**
 * Client authentication: who may use this server's subscription.
 *
 * The server listens on an interface reachable by other machines, so it must
 * refuse unknown callers before doing any work. The credential it checks is a
 * bearer that this server's operator minted — not the Claude token. A leaked
 * bearer costs subscription quota; it cannot be used to obtain the Claude
 * credential, which never leaves this process.
 *
 * Comparison is constant-time over equal-length buffers. Length is compared
 * first, which does leak the length of the secret — an acceptable trade, since
 * a length oracle on a long random string is not a practical attack and the
 * alternative (padding every candidate) hides nothing an attacker cannot
 * already infer from a successful guess.
 *
 * @module claude-server/auth
 */

import { timingSafeEqual } from 'node:crypto';

/** The scheme the client must use. */
const SCHEME = 'bearer';

/**
 * Extract the bearer value from an Authorization header.
 * @param header - the raw header value, or undefined.
 * @returns the token, or undefined when the header is absent or not a bearer.
 */
export function bearerOf(header) {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  if (value.length === 0) return undefined;
  const space = value.indexOf(' ');
  if (space < 0) return undefined;
  const scheme = value.slice(0, space).toLowerCase();
  if (scheme !== SCHEME) return undefined;
  const token = value.slice(space + 1).trim();
  return token.length === 0 ? undefined : token;
}

/**
 * Constant-time comparison of two strings.
 * @param presented - what the caller sent.
 * @param expected - what is configured.
 * @returns true when they match.
 */
export function secretsMatch(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (presented.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A configured client secret plus the check the HTTP layer runs.
 */
export class ClientAuth {
  #expected;

  /**
   * @param expected - the bearer this server accepts.
   * @throws {Error} when the secret is missing or too short to be meaningful.
   */
  constructor(expected) {
    if (typeof expected !== 'string' || expected.trim().length === 0) {
      throw new Error(
        'CLIENT_BEARER is not configured; this server refuses to run without a client credential because it listens beyond loopback',
      );
    }
    const value = expected.trim();
    if (value.length < 24) {
      throw new Error(
        `CLIENT_BEARER is only ${value.length} characters; use at least 24 random characters so a network attacker cannot guess it`,
      );
    }
    this.#expected = value;
  }

  /**
   * Check one Authorization header.
   * @param header - the raw header value.
   * @returns true when the caller may proceed.
   */
  check(header) {
    const token = bearerOf(header);
    if (token === undefined) return false;
    return secretsMatch(token, this.#expected);
  }
}

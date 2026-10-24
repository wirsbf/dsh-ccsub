/**
 * Client authentication: who may use this server's subscription, and who may
 * administer it.
 *
 * The server listens on an interface reachable by other machines, so it must
 * refuse unknown callers before doing any work. The credential it checks is a
 * bearer that this server's operator issued — not the Claude token. A leaked
 * bearer costs subscription quota; it cannot be used to obtain the Claude
 * credential, which never leaves this process.
 *
 * ## Two questions, not one
 *
 * The relay only needs "is this a live user of any role". The console needs
 * "is this an admin", because the console can issue more users and replace the
 * Claude grant. Keeping the two questions separate is what makes a `client`
 * token a relay credential rather than an administrative one: a user who can
 * call models cannot mint users or overwrite the grant.
 *
 * ## The environment bearer is still here
 *
 * `CLIENT_BEARER` is the bootstrap credential. It cannot be removed from a
 * running deployment without editing its environment, so it is synthesized as a
 * permanent `legacy` admin rather than migrated away. The alternative — a
 * migration that deletes the env value — would make an upgrade a one-way door
 * and would strand any deployment whose users file never got created.
 *
 * ## Constant time
 *
 * Every secret comparison is `timingSafeEqual` over equal-length buffers, for
 * the environment bearer and for stored token hashes alike. The token hash is
 * also compared against every active row rather than stopping at a match, and
 * disabled rows still take part, so the comparison work does not reveal which
 * user (if any) a guessed token belongs to.
 *
 * @module claude-server/auth
 */

import { timingSafeEqual } from 'node:crypto';
import { LEGACY_USER_ID, LEGACY_USER_NAME } from './users.js';

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
 * The configured bootstrap bearer plus the checks the HTTP layer runs.
 */
export class ClientAuth {
  #expected;
  #users;

  /**
   * @param expected - the bearer this server accepts.
   * @param options - `users`, the user directory, when multi-user support is mounted.
   * @throws {Error} when the secret is missing or too short to be meaningful.
   */
  constructor(expected, options = {}) {
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
    this.#users = options.users;
  }

  /** The identity the environment bearer maps to. */
  get legacyIdentity() {
    return {
      id: LEGACY_USER_ID,
      name: LEGACY_USER_NAME,
      role: 'admin',
      legacy: true,
      // The bootstrap bearer predates accounts, so it spends the default
      // account — the same one every pre-accounts token resolves to.
      accountId: null,
    };
  }

  /**
   * Whether a header carries the environment bearer.
   *
   * Kept synchronous and bearer-only: it is the bootstrap credential, and this
   * is the check that must keep working when the user file is missing or
   * corrupt.
   * @param header - the raw header value.
   * @returns true when the caller presented the configured bearer.
   */
  check(header) {
    const token = bearerOf(header);
    if (token === undefined) return false;
    return secretsMatch(token, this.#expected);
  }

  /**
   * Resolve any presented credential to an identity.
   *
   * The environment bearer is checked first because it is the one credential
   * that cannot be revoked, and its comparison is the cheapest. A stored user is
   * only consulted when the header is not the environment bearer.
   * @param header - the raw header value.
   * @returns the identity, or undefined when the credential is not valid.
   */
  async identify(header) {
    const token = bearerOf(header);
    if (token === undefined) return undefined;
    if (this.#users === undefined) return this.check(header) ? this.legacyIdentity : undefined;
    // Run both checks rather than short-circuiting on the environment bearer:
    // an early return would make a wrong token's timing depend on whether it
    // happened to be the bootstrap credential.
    const legacy = secretsMatch(token, this.#expected);
    const stored = await this.#users.verify(token);
    if (legacy) return this.legacyIdentity;
    return stored;
  }

  /**
   * Whether a header carries a credential allowed to use the relay.
   *
   * Any live user of either role qualifies: the relay is the product, and a
   * `client` role exists precisely to be usable without being administrative.
   * @param header - the raw header value.
   * @returns the identity, or undefined.
   */
  async checkUser(header) {
    return await this.identify(header);
  }

  /**
   * Whether a header carries an administrative credential.
   *
   * This is the console gate. A `client` token must get nothing here: the
   * console can create users and replace the Claude grant, so treating every
   * relay credential as administrative would let any relay user escalate.
   * @param header - the raw header value.
   * @returns the identity, or undefined unless it is an enabled admin.
   */
  async checkAdmin(header) {
    const identity = await this.identify(header);
    if (identity === undefined) return undefined;
    return identity.role === 'admin' ? identity : undefined;
  }
}

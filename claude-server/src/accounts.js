/**
 * The account directory: more than one Claude subscription served by one process.
 *
 * Before this module the server had exactly one grant, at `GRANT_PATH`. That is
 * still the shape of the **default** account: an upgraded deployment keeps
 * serving `grant.json` untouched, and every token issued earlier keeps working
 * because it resolves to that account. Additional accounts live beside it, one
 * grant file each.
 *
 * ## Why one `GrantStore` per account
 *
 * A grant refresh is not idempotent: `refreshAnthropicToken()` returns a new
 * refresh token and the old one stops working, so two concurrent refreshes of
 * the same grant lose a rotation. `GrantStore` already collapses concurrent
 * refreshes inside one instance, so the directory holds **one store per
 * account** and never shares a store between two account ids. Refreshes of
 * different accounts are independent; refreshes of the same account are still a
 * single flight.
 *
 * ## Why the default account keeps the legacy path
 *
 * Moving an existing grant during an upgrade is a write that can fail halfway:
 * the deployment would come up with no grant at all, and the operator would have
 * to sign in again to recover a file that was already there. The default
 * account therefore **is** `GRANT_PATH`, by path, and needs no migration step.
 * Only accounts created after the upgrade get a file of their own.
 *
 * @module claude-server/accounts
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GrantStore } from './grant.js';

/** The schema version of `accounts.json`. */
export const ACCOUNTS_VERSION = 1;

/**
 * The id of the account that owns the legacy `GRANT_PATH` file.
 *
 * Reserved: it cannot be created through the API, cannot be removed, and its
 * grant path is fixed by configuration rather than by this file. That is what
 * makes an upgrade free of data movement.
 */
export const DEFAULT_ACCOUNT_ID = 'default';

/** The display name of the synthesized default account. */
export const DEFAULT_ACCOUNT_NAME = 'Default account';

/** An account problem the HTTP layer can map to a status code. */
export class AccountsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AccountsError';
    this.code = code;
  }
}

/** Ids are opaque, url-safe, and short enough to be readable in a UI. */
const ID_PATTERN = /^[a-z0-9_]{1,40}$/;

/** A name is display text: no control characters, bounded length. */
function normalizeName(value) {
  if (typeof value !== 'string') {
    throw new AccountsError('the account name must be a string', 'INVALID_NAME');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AccountsError('the account name must not be empty', 'INVALID_NAME');
  }
  if (trimmed.length > 80) {
    throw new AccountsError('the account name must be at most 80 characters', 'INVALID_NAME');
  }
  // Control characters would let a name break the console markup or a log line.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new AccountsError('the account name must not contain control characters', 'INVALID_NAME');
  }
  return trimmed;
}

/** Validate a stored record, or report the file as corrupt. */
function normalizeStoredAccount(record, index) {
  if (record === null || typeof record !== 'object') {
    throw new AccountsError(`accounts.json entry ${index} is not an object`, 'ACCOUNTS_CORRUPT');
  }
  const { id, name, createdAt, lastUsedAt, disabled } = record;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new AccountsError(`accounts.json entry ${index} has no usable id`, 'ACCOUNTS_CORRUPT');
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    // The default account is configuration, not a file entry. A record claiming
    // its id would point two accounts at the same grant.
    throw new AccountsError('accounts.json claims the reserved default id', 'ACCOUNTS_CORRUPT');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new AccountsError(`accounts.json entry ${index} has no name`, 'ACCOUNTS_CORRUPT');
  }
  return {
    id,
    name,
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    lastUsedAt: typeof lastUsedAt === 'number' ? lastUsedAt : null,
    disabled: disabled === true,
  };
}

/** The public view of an account: what the console renders. */
function publicAccount(account) {
  return {
    id: account.id,
    name: account.name,
    createdAt: account.createdAt,
    lastUsedAt: account.lastUsedAt,
    disabled: account.disabled === true,
    default: account.id === DEFAULT_ACCOUNT_ID,
  };
}

/**
 * The durable account directory plus one `GrantStore` per account.
 *
 * Reads are memoized until a mutation or an explicit `invalidate()`; writes are
 * atomic (temp file plus rename) and serialized in-process so two mutations
 * cannot interleave into a lost update.
 */
export class AccountDirectory {
  #path;
  #grantsDir;
  #legacyGrantPath;
  #refreshSkewMs;
  #logger;
  #cache;
  #stores = new Map();
  #mutationChain = Promise.resolve();
  /**
   * Bookkeeping writes still in flight.
   *
   * `accessToken` records `lastUsedAt` without making the caller wait, because a
   * request that already has a token must not fail on a timestamp. The cost is
   * that the write can land after the caller is done with the directory, so it
   * is tracked here and awaited by `drain()`.
   */
  #pendingBookkeeping = new Set();

  /**
   * @param options - `path` (`accounts.json`), `grantsDir` (one file per
   *   non-default account), `legacyGrantPath` (`GRANT_PATH`), `refreshSkewMs`,
   *   and a logger.
   * @throws {AccountsError} when a path is missing.
   */
  constructor(options = {}) {
    if (typeof options.path !== 'string' || options.path.trim().length === 0) {
      throw new AccountsError('the account directory needs a file path', 'ACCOUNTS_PATH_MISSING');
    }
    if (typeof options.grantsDir !== 'string' || options.grantsDir.trim().length === 0) {
      throw new AccountsError('the account directory needs a grants directory', 'ACCOUNTS_PATH_MISSING');
    }
    if (typeof options.legacyGrantPath !== 'string' || options.legacyGrantPath.trim().length === 0) {
      throw new AccountsError('the account directory needs the legacy grant path', 'ACCOUNTS_PATH_MISSING');
    }
    this.#path = options.path;
    this.#grantsDir = options.grantsDir;
    this.#legacyGrantPath = options.legacyGrantPath;
    this.#refreshSkewMs = options.refreshSkewMs;
    this.#logger = options.logger;
    this.#cache = undefined;
  }

  /** The absolute path of `accounts.json`. */
  get path() {
    return this.#path;
  }

  /**
   * Normalize an account id to the canonical form used as a map key.
   *
   * The relay and the user file both express "the default account" as `null`,
   * while configuration and the console use the literal id. Collapsing them
   * here means every other method can compare one value.
   * @param id - the account id, or null/undefined for the default.
   * @returns the canonical id string.
   */
  static key(id) {
    if (id === null || id === undefined || id === '') return DEFAULT_ACCOUNT_ID;
    return String(id);
  }

  /**
   * Where one account's grant lives.
   *
   * The default account resolves to `GRANT_PATH` so an upgraded deployment needs
   * no data movement; every other account gets a file named after its id.
   * @param id - the account id, or null/undefined for the default.
   * @returns the absolute grant path.
   */
  grantPath(id) {
    const key = AccountDirectory.key(id);
    if (key === DEFAULT_ACCOUNT_ID) return this.#legacyGrantPath;
    if (!ID_PATTERN.test(key)) {
      throw new AccountsError('that is not a usable account id', 'INVALID_ACCOUNT_ID');
    }
    return join(this.#grantsDir, `${key}.json`);
  }

  /**
   * The grant store for one account, created on first use.
   *
   * Stores are memoized so the refresh single-flight inside `GrantStore` covers
   * every caller of the same account.
   * @param id - the account id, or null/undefined for the default.
   * @returns the store.
   */
  store(id) {
    const key = AccountDirectory.key(id);
    let store = this.#stores.get(key);
    if (store === undefined) {
      store = new GrantStore({
        path: this.grantPath(key),
        refreshSkewMs: this.#refreshSkewMs,
        logger: this.#logger,
      });
      this.#stores.set(key, store);
    }
    return store;
  }

  /**
   * Read `accounts.json`, memoized.
   *
   * A missing file is not an error: it is what a deployment upgraded from the
   * single-account shape looks like, and the default account is synthesized for
   * it.
   * @returns the parsed directory.
   * @throws {AccountsError} `ACCOUNTS_CORRUPT` when the file exists but is unusable.
   */
  async #read() {
    if (this.#cache !== undefined) return this.#cache;
    let text;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#cache = { version: ACCOUNTS_VERSION, accounts: [] };
        return this.#cache;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AccountsError(
        `the account file at ${this.#path} is not valid JSON: ${String(error)}`,
        'ACCOUNTS_CORRUPT',
      );
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) {
      throw new AccountsError(`the account file at ${this.#path} has no accounts array`, 'ACCOUNTS_CORRUPT');
    }
    this.#cache = {
      version: ACCOUNTS_VERSION,
      accounts: parsed.accounts.map((record, index) => normalizeStoredAccount(record, index)),
    };
    return this.#cache;
  }

  /** Replace `accounts.json` with the current in-memory directory, atomically. */
  async #write() {
    const snapshot = {
      version: ACCOUNTS_VERSION,
      accounts: (this.#cache?.accounts ?? []).map((account) => ({ ...account })),
    };
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${process.pid}.${Date.now()}.accounts.tmp`);
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }

  /**
   * Apply one mutation, serialized against every other mutation.
   * @param mutate - receives the directory and returns the result.
   * @returns the mutation's result.
   */
  async #mutate(mutate) {
    const run = this.#mutationChain.then(async () => {
      const directory = await this.#read();
      const result = await mutate(directory);
      this.#cache = directory;
      await this.#write();
      return result;
    });
    // Keep the chain alive after a rejection: one failed mutation must not
    // poison every later one.
    this.#mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  /**
   * Every account, the default one first.
   *
   * `signedIn` and `expiresAt` are reported here rather than by a second call so
   * the console can render the list from one response.
   * @returns the public accounts, with their grant state.
   */
  async list() {
    const directory = await this.#read();
    const stored = [...directory.accounts].sort((a, b) => a.createdAt - b.createdAt);
    const ids = [DEFAULT_ACCOUNT_ID, ...stored.map((account) => account.id)];
    const out = [];
    for (const id of ids) {
      const account =
        id === DEFAULT_ACCOUNT_ID
          ? { id, name: DEFAULT_ACCOUNT_NAME, createdAt: null, lastUsedAt: null, disabled: false }
          : stored.find((candidate) => candidate.id === id);
      if (account === undefined) continue;
      let grant;
      let error;
      try {
        grant = await this.store(id).read();
      } catch (caught) {
        error = String(caught?.message ?? caught);
      }
      out.push({
        ...publicAccount(account),
        signedIn: grant !== undefined && error === undefined,
        expiresAt: typeof grant?.expires === 'number' ? grant.expires : null,
        error: error ?? null,
      });
    }
    return out;
  }

  /**
   * Resolve one account for authorization, or refuse.
   * @param id - the account id.
   * @returns the public account.
   * @throws {AccountsError} `UNKNOWN_ACCOUNT` or `ACCOUNT_DISABLED`.
   */
  async require(id) {
    const key = AccountDirectory.key(id);
    if (key === DEFAULT_ACCOUNT_ID) {
      return { ...publicAccount({ id: key, name: DEFAULT_ACCOUNT_NAME, createdAt: null, lastUsedAt: null, disabled: false }) };
    }
    const directory = await this.#read();
    const account = directory.accounts.find((candidate) => candidate.id === key);
    if (account === undefined) {
      throw new AccountsError('that account does not exist', 'UNKNOWN_ACCOUNT');
    }
    if (account.disabled === true) {
      throw new AccountsError('that account is disabled', 'ACCOUNT_DISABLED');
    }
    return publicAccount(account);
  }

  /**
   * Add one account and its (not yet authorized) grant slot.
   * @param options - `name`.
   * @returns the public account.
   */
  async create({ name } = {}) {
    const cleanName = normalizeName(name);
    const created = { id: '', name: cleanName, createdAt: Date.now(), lastUsedAt: null, disabled: false };
    await this.#mutate((directory) => {
      do {
        created.id = `acct_${randomBytes(5).toString('hex')}`;
      } while (directory.accounts.some((account) => account.id === created.id));
      directory.accounts.push(created);
      return undefined;
    });
    await mkdir(this.#grantsDir, { recursive: true, mode: 0o700 });
    this.#logger?.info('added account %s (%s)', created.id, created.name);
    return publicAccount(created);
  }

  /**
   * Change one account's display name or disabled flag.
   * @param id - the account id.
   * @param patch - `name` and/or `disabled`.
   * @returns the updated public account.
   * @throws {AccountsError} `DEFAULT_ACCOUNT` for the reserved id, `UNKNOWN_ACCOUNT` when absent.
   */
  async update(id, patch = {}) {
    const key = AccountDirectory.key(id);
    if (key === DEFAULT_ACCOUNT_ID) {
      throw new AccountsError(
        'the default account is configured by the environment, not by this file',
        'DEFAULT_ACCOUNT',
      );
    }
    const nextName = patch.name === undefined ? undefined : normalizeName(patch.name);
    const nextDisabled = patch.disabled === undefined ? undefined : patch.disabled === true;
    return await this.#mutate((directory) => {
      const account = directory.accounts.find((candidate) => candidate.id === key);
      if (account === undefined) {
        throw new AccountsError('that account does not exist', 'UNKNOWN_ACCOUNT');
      }
      if (nextName !== undefined) account.name = nextName;
      if (nextDisabled !== undefined) account.disabled = nextDisabled;
      this.#logger?.info(
        'updated account %s (disabled=%s)',
        account.id,
        account.disabled === true ? 'yes' : 'no',
      );
      return publicAccount(account);
    });
  }

  /**
   * Remove one account and delete its grant file.
   *
   * Disabling is the reversible move; removal is for an account the operator is
   * done with. The default account cannot be removed — it is `GRANT_PATH`.
   * @param id - the account id.
   * @returns true when an account was removed.
   * @throws {AccountsError} `DEFAULT_ACCOUNT` for the reserved id.
   */
  async remove(id) {
    const key = AccountDirectory.key(id);
    if (key === DEFAULT_ACCOUNT_ID) {
      throw new AccountsError(
        'the default account cannot be removed; unset GRANT_PATH instead',
        'DEFAULT_ACCOUNT',
      );
    }
    const removed = await this.#mutate((directory) => {
      const at = directory.accounts.findIndex((candidate) => candidate.id === key);
      if (at < 0) return false;
      directory.accounts.splice(at, 1);
      return true;
    });
    if (!removed) return false;
    // Forget the memoized store so a later account reusing this id cannot serve
    // the removed account's cached token.
    this.#stores.delete(key);
    try {
      await unlink(this.grantPath(key));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#logger?.warn('removed account %s but could not delete its grant: %s', key, String(error));
      }
    }
    this.#logger?.info('removed account %s', key);
    return true;
  }

  /**
   * The access token for one account, refreshing when near expiry.
   * @param id - the account id.
   * @param refresh - the refresh implementation.
   * @returns the bearer token.
   * @throws {AccountsError} `ACCOUNT_DISABLED` / `UNKNOWN_ACCOUNT`.
   * @throws {GrantError} `NOT_SIGNED_IN` when that account has no grant.
   */
  async accessToken(id, refresh) {
    await this.require(id);
    const key = AccountDirectory.key(id);
    const store = this.store(key);
    const token = await store.accessToken(refresh);
    // Record freshness for the console's per-account ordering. Best effort: a
    // failed bookkeeping write must not fail a request that already has a token.
    if (key !== DEFAULT_ACCOUNT_ID) {
      const bookkeeping = this.#touch(key);
      this.#pendingBookkeeping.add(bookkeeping);
      void bookkeeping.finally(() => this.#pendingBookkeeping.delete(bookkeeping));
    }
    return token;
  }

  /** Note that an account's grant was used, for the console's ordering. */
  async #touch(id) {
    try {
      await this.#mutate((directory) => {
        const account = directory.accounts.find((candidate) => candidate.id === id);
        if (account !== undefined) account.lastUsedAt = Date.now();
        return undefined;
      });
    } catch {
      // Bookkeeping only.
    }
  }

  /**
   * Wait for bookkeeping writes to settle.
   *
   * Called by the server's dispose so a `lastUsedAt` write cannot outlive the
   * server and land on a directory the caller is removing.
   */
  async drain() {
    await Promise.allSettled([...this.#pendingBookkeeping]);
  }

  /** Forget the memoized directory file so the next read hits disk. */
  invalidate() {
    this.#cache = undefined;
  }
}

/**
 * How much room an account has in its short window, as a routing score.
 *
 * The 5-hour window is what interrupts a conversation, so it outranks the
 * weekly one: a session that starts on an account with 95% of its five-hour
 * budget already spent will be cut off within the hour, and switching then
 * throws away every cached token in the conversation.
 *
 * The score is `remaining percent`, and when two accounts are equally roomy the
 * one that resets *sooner* wins, because its room is about to be replenished
 * rather than spent.
 * @param usage - the upstream usage payload for this account.
 * @returns the score, or undefined when the payload has no session window.
 */
export function sessionHeadroom(usage) {
  const limits = Array.isArray(usage?.limits) ? usage.limits : [];
  const session = limits.find((row) => row?.kind === 'session');
  const percent = session === undefined ? undefined : Number(session.percent);
  if (!Number.isFinite(percent)) return undefined;
  // `resets_at` is the moment the window refills; earlier is better at equal
  // headroom because less of the current budget has to last.
  const resetsAt = session.resets_at === undefined ? undefined : Date.parse(session.resets_at);
  return {
    remaining: Math.max(0, 100 - percent),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
  };
}

/**
 * Order accounts best-first for starting a new conversation.
 *
 * Signed-in, enabled accounts only: a signed-out or disabled account cannot
 * serve a request at all, so including it would just move the failure later.
 * Accounts with unknown headroom rank after known ones but ahead of exhausted
 * ones — an account whose usage probe has not run yet is a guess, while an
 * account at 100% is a certainty.
 * @param accounts - rows from `list()`.
 * @param headroomOf - maps an account id to `sessionHeadroom` output (or undefined).
 * @returns the account ids, best first.
 */
export function rankForNewSession(accounts, headroomOf) {
  const rows = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (account.signedIn !== true || account.disabled === true) continue;
    const headroom = headroomOf(account.id);
    rows.push({
      id: account.id,
      remaining: headroom === undefined ? undefined : headroom.remaining,
      resetsAt: headroom === undefined ? undefined : headroom.resetsAt,
    });
  }
  rows.sort((a, b) => {
    // An account whose headroom is known and *positive* outranks an unknown
    // one; an unknown one still outranks a known-empty one, because unknown is
    // merely a guess while empty is a certainty. Treating unknown as simply
    // "last" would push it behind an account that cannot serve at all.
    const aRoom = a.remaining !== undefined && a.remaining > 0;
    const bRoom = b.remaining !== undefined && b.remaining > 0;
    if (aRoom !== bRoom) return aRoom ? -1 : 1;
    // Neither has known room. An unknown account is a better bet than one known
    // to be empty, so unknown goes first.
    const aKnown = a.remaining !== undefined;
    const bKnown = b.remaining !== undefined;
    if (aKnown !== bKnown) return aKnown ? 1 : -1;
    if (a.remaining !== undefined && b.remaining !== undefined && a.remaining !== b.remaining) {
      return b.remaining - a.remaining;
    }
    // Equal room: prefer the window that refills soonest.
    const ar = a.resetsAt ?? Infinity;
    const br = b.resetsAt ?? Infinity;
    if (ar !== br) return ar - br;
    return a.id.localeCompare(b.id);
  });
  return rows.map((row) => row.id);
}

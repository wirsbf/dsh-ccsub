/**
 * The account directory: more than one subscription served by one process.
 *
 * These tests pin the two properties that make multi-account safe: two accounts
 * never share a grant, and an upgraded deployment keeps serving `GRANT_PATH` as
 * the default account without moving a file.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ACCOUNTS_VERSION,
  AccountDirectory,
  AccountsError,
  DEFAULT_ACCOUNT_ID,
} from '../src/accounts.js';

/** A quiet logger: these tests assert state, not log output. */
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** A scratch directory with the three paths the directory needs. */
async function makeDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-accounts-'));
  const options = {
    path: join(dir, 'accounts.json'),
    grantsDir: join(dir, 'accounts'),
    legacyGrantPath: join(dir, 'grant.json'),
    refreshSkewMs: 300_000,
    logger: quietLogger,
  };
  return {
    dir,
    options,
    directory: new AccountDirectory(options),
    close: async () => await rm(dir, { recursive: true, force: true }),
  };
}

/** A grant that will not refresh during a test. */
const noRefresh = async () => {
  throw new Error('this test must not refresh');
};

/** A grant-shaped object with a chosen access token. */
function grant(access) {
  return { type: 'oauth', access, refresh: `r-${access}`, expires: Date.now() + 3600_000 };
}

describe('account directory', () => {
  const cleanups = [];
  after(async () => {
    for (const close of cleanups) await close();
  });

  /** Register a scratch directory for cleanup. */
  async function scratch() {
    const made = await makeDirectory();
    cleanups.push(made.close);
    return made;
  }

  it('serves the legacy grant as the default account without moving it', async () => {
    // An upgrade must not write anything to reach this state: the default
    // account IS GRANT_PATH, which is what a pre-accounts deployment has.
    const { directory, options } = await scratch();
    assert.equal(directory.grantPath(DEFAULT_ACCOUNT_ID), options.legacyGrantPath);

    const listed = await directory.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, DEFAULT_ACCOUNT_ID);
    assert.equal(listed[0].default, true);
    assert.equal(listed[0].signedIn, false);

    // No accounts.json is created just by reading.
    await assert.rejects(stat(options.path), { code: 'ENOENT' });
  });

  it('reports the default account as signed in once GRANT_PATH holds a grant', async () => {
    const { directory, options } = await scratch();
    await writeFile(options.legacyGrantPath, JSON.stringify(grant('legacy-token')));

    const listed = await directory.list();
    assert.equal(listed[0].signedIn, true);
    assert.equal(typeof listed[0].expiresAt, 'number');
    assert.equal(await directory.accessToken(DEFAULT_ACCOUNT_ID, noRefresh), 'legacy-token');
  });

  it('treats a null or absent account id as the default account', async () => {
    // Every token issued before accounts existed carries no accountId, so the
    // resolver must read that absence as "default" rather than refuse it.
    const { directory, options } = await scratch();
    await writeFile(options.legacyGrantPath, JSON.stringify(grant('legacy-token')));
    assert.equal(await directory.accessToken(null, noRefresh), 'legacy-token');
    assert.equal(await directory.accessToken(undefined, noRefresh), 'legacy-token');
  });

  it('gives each new account its own grant file', async () => {
    const { directory } = await scratch();
    const first = await directory.create({ name: 'Work' });
    const second = await directory.create({ name: 'Personal' });

    assert.notEqual(first.id, second.id);
    assert.notEqual(directory.grantPath(first.id), directory.grantPath(second.id));
    assert.equal(first.default, false);

    // Neither is signed in yet: a new account starts empty and is signed in
    // through the console's sign-in flow.
    const listed = await directory.list();
    const stored = listed.filter((account) => account.id !== DEFAULT_ACCOUNT_ID);
    assert.deepEqual(stored.map((account) => account.signedIn), [false, false]);
  });

  it('keeps each account on its own token, never borrowing another grant', async () => {
    // The whole point: a token bound to account A must spend A's subscription.
    const { directory } = await scratch();
    const first = await directory.create({ name: 'Work' });
    const second = await directory.create({ name: 'Personal' });
    await directory.store(DEFAULT_ACCOUNT_ID).write(grant('token-default'));
    await directory.store(first.id).write(grant('token-first'));
    await directory.store(second.id).write(grant('token-second'));

    assert.equal(await directory.accessToken(DEFAULT_ACCOUNT_ID, noRefresh), 'token-default');
    assert.equal(await directory.accessToken(first.id, noRefresh), 'token-first');
    assert.equal(await directory.accessToken(second.id, noRefresh), 'token-second');
  });

  it('refuses an account that is signed out instead of falling back to another', async () => {
    // Falling back would silently spend the wrong subscription, which is worse
    // than refusing: the operator would see one account's quota drain while
    // believing another was in use.
    const { directory } = await scratch();
    await directory.store(DEFAULT_ACCOUNT_ID).write(grant('token-default'));
    const empty = await directory.create({ name: 'Signed out' });
    await assert.rejects(directory.accessToken(empty.id, noRefresh), { code: 'NOT_SIGNED_IN' });
  });

  it('refuses a disabled account', async () => {
    const { directory } = await scratch();
    const account = await directory.create({ name: 'Paused' });
    await directory.store(account.id).write(grant('token'));
    await directory.update(account.id, { disabled: true });
    await assert.rejects(directory.accessToken(account.id, noRefresh), { code: 'ACCOUNT_DISABLED' });
    // Re-enabling restores it.
    await directory.update(account.id, { disabled: false });
    assert.equal(await directory.accessToken(account.id, noRefresh), 'token');
  });

  it('refuses an unknown account', async () => {
    const { directory } = await scratch();
    await assert.rejects(directory.accessToken('acct_nonexistent', noRefresh), {
      code: 'UNKNOWN_ACCOUNT',
    });
    await assert.rejects(directory.require('acct_nonexistent'), { code: 'UNKNOWN_ACCOUNT' });
  });

  it('protects the default account from rename and removal', async () => {
    const { directory } = await scratch();
    await assert.rejects(directory.update(DEFAULT_ACCOUNT_ID, { name: 'x' }), {
      code: 'DEFAULT_ACCOUNT',
    });
    await assert.rejects(directory.remove(DEFAULT_ACCOUNT_ID), { code: 'DEFAULT_ACCOUNT' });
  });

  it('deletes an account grant file when the account is removed', async () => {
    const { directory } = await scratch();
    const account = await directory.create({ name: 'Temporary' });
    await directory.store(account.id).write(grant('token'));
    const path = directory.grantPath(account.id);
    assert.ok(await stat(path).then(() => true).catch(() => false));

    assert.equal(await directory.remove(account.id), true);
    assert.equal(await stat(path).then(() => true).catch(() => false), false);
    // A removed account cannot be spent even though its store was memoized.
    await assert.rejects(directory.accessToken(account.id, noRefresh), {
      code: 'UNKNOWN_ACCOUNT',
    });
  });

  it('survives a reopen: accounts persist across processes', async () => {
    const { directory, options } = await scratch();
    const created = await directory.create({ name: 'Persisted' });
    await directory.update(created.id, { name: 'Renamed' });

    const reopened = new AccountDirectory(options);
    const listed = await reopened.list();
    const found = listed.find((account) => account.id === created.id);
    assert.equal(found.name, 'Renamed');
    assert.equal(found.default, false);
  });

  it('writes accounts.json owner-only and versioned', async () => {
    // The file names the subscriptions this server spends; it is not secret
    // like a grant, but it is deployment state that should not be world-readable.
    const { directory, options } = await scratch();
    await directory.create({ name: 'Checked' });
    const mode = (await stat(options.path)).mode & 0o777;
    assert.equal(mode, 0o600);
    const parsed = JSON.parse(await readFile(options.path, 'utf8'));
    assert.equal(parsed.version, ACCOUNTS_VERSION);
    assert.equal(parsed.accounts.length, 1);
  });

  it('rejects names that are empty, overlong, or control-bearing', async () => {
    const { directory } = await scratch();
    for (const name of ['', '   ', 'x'.repeat(81), 'bad\u0000name', 'bad\nname']) {
      await assert.rejects(directory.create({ name }), { code: 'INVALID_NAME' }, `name ${JSON.stringify(name)}`);
    }
  });

  it('reports a corrupt accounts file rather than serving an empty list', async () => {
    // An empty list would look like "this deployment has one account"; the
    // truth is that its account file is unreadable, and the operator has to see
    // that difference.
    const { directory, options } = await scratch();
    await writeFile(options.path, '{ not json');
    await assert.rejects(directory.list(), { code: 'ACCOUNTS_CORRUPT' });
  });

  it('refuses a file that claims the reserved default id', async () => {
    const { directory, options } = await scratch();
    await writeFile(
      options.path,
      JSON.stringify({
        version: ACCOUNTS_VERSION,
        accounts: [{ id: DEFAULT_ACCOUNT_ID, name: 'Impostor', createdAt: 1 }],
      }),
    );
    await assert.rejects(directory.list(), { code: 'ACCOUNTS_CORRUPT' });
  });

  it('records last use for a non-default account without failing the request', async () => {
    const { directory } = await scratch();
    const account = await directory.create({ name: 'Busy' });
    await directory.store(account.id).write(grant('token'));
    assert.equal(await directory.accessToken(account.id, noRefresh), 'token');
    // The bookkeeping write is asynchronous; give it a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const listed = await directory.list();
    const found = listed.find((entry) => entry.id === account.id);
    assert.equal(typeof found.lastUsedAt, 'number');
  });

  it('exposes AccountsError codes stably', async () => {
    const { directory } = await scratch();
    const error = await directory.remove(DEFAULT_ACCOUNT_ID).catch((caught) => caught);
    assert.ok(error instanceof AccountsError);
    assert.equal(error.code, 'DEFAULT_ACCOUNT');
  });
});

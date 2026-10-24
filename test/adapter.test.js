/**
 * The profile handed to the shared pi-ai adapter.
 *
 * These pin the one field whose default is actively harmful for this product:
 * `cacheRetention`. pi-ai defaults to `short` (five minutes), which is shorter
 * than any realistic gap between turns here, so the prefix expires and the next
 * turn pays a full cache write (1.25x) instead of a cache read (0.1x).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { profileFor } from '../lib/adapter.js';

/** A provider-shaped stub; `profileFor` reads only the id and catalog. */
const provider = { id: 'claude-sub', models: [] };

describe('profileFor', () => {
  it('asks for the one-hour cache by default', () => {
    // The default has to be long: `short` expires between turns and turns every
    // interruption into a cache write, which is the cost this route exists to
    // avoid.
    const profile = profileFor(provider, {});
    assert.equal(profile.cacheRetention, 'long');
  });

  it('honours an explicit retention setting', () => {
    assert.equal(profileFor(provider, { cacheRetention: 'short' }).cacheRetention, 'short');
    assert.equal(profileFor(provider, { cacheRetention: 'none' }).cacheRetention, 'none');
    assert.equal(profileFor(provider, { cacheRetention: 'long' }).cacheRetention, 'long');
  });

  it('carries every field the adapter dereferences', () => {
    // A missing field here is a crash on the first request, not a warning.
    const profile = profileFor(provider, {});
    for (const key of [
      'provider',
      'displayName',
      'piProvider',
      'headers',
      'modelErrors',
      'configuredMaxTokens',
      'streamIdleTimeoutMs',
      'maxRequestImageBytes',
      'requestImagePixelBudget',
      'requestImageMaxBytes',
      'retryPolicy',
    ]) {
      assert.ok(key in profile, `profile must carry ${key}`);
    }
  });

  it('passes caller limits through when given', () => {
    const profile = profileFor(provider, {
      streamIdleTimeoutMs: 12_345,
      maxRequestImageBytes: 987,
    });
    assert.equal(profile.streamIdleTimeoutMs, 12_345);
    assert.equal(profile.maxRequestImageBytes, 987);
  });
});

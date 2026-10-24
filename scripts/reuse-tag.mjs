#!/usr/bin/env node
/**
 * Print the tag an earlier attempt of this workflow run created, if any.
 *
 * Exists as its own script so the git calls stay out of
 * `release-version.mjs`, which the tests import as a pure module. All the
 * decision logic is `reuseTagOf`; this only reads the repository.
 *
 * Usage: node scripts/reuse-tag.mjs <run-id>
 *
 * @module dsh-ccsub/scripts/reuse-tag
 */

import { execFileSync } from 'node:child_process';
import { reuseTagOf } from './release-version.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

const runId = process.argv[2] ?? '';
const tags = git('tag', '--list', 'v*')
  .split('\n')
  .filter(Boolean)
  .map((tag) => ({ tag, message: git('tag', '--list', '--format=%(contents)', tag) }));

process.stdout.write(reuseTagOf(tags, runId) ?? '');

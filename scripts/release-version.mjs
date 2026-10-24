#!/usr/bin/env node
/**
 * Decide the version one push to `main` releases.
 *
 * The rule is the one the operator asked for: the patch digit advances on its
 * own, the minor digit only when a human says so.
 *
 *   package.json == latest tag   → patch bump (0.2.2 → 0.2.3)
 *   package.json >  latest tag   → that is the human's bump; release it as-is
 *   no tag yet                   → release package.json unchanged
 *
 * So a writer raises the minor by editing the root `package.json` (nothing
 * else) and pushing. The release run then publishes exactly that version
 * instead of adding another patch on top.
 *
 * `claude-server/package.json` is not a second source of truth: `--apply`
 * writes the decided version into it too, so a release number names the plugin
 * tarball and the server image alike. Edit the root manifest only.
 *
 * @module dsh-ccsub/scripts/release-version
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compareParsed, parseVersion } from '../lib/semver.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Manifests that carry the release version; the first is the source of truth. */
export const MANIFESTS = ['package.json', 'claude-server/package.json'];

/**
 * Strip the tag prefix and parse.
 * @param {string} tag - a tag such as `v0.2.2`, or `''` when none exists.
 * @returns the parsed version, or undefined when there is no usable tag.
 */
function parseTag(tag) {
  const text = String(tag ?? '').trim();
  if (text === '') return undefined;
  const parsed = parseVersion(text);
  return Number.isFinite(parsed.major) ? parsed : undefined;
}

/**
 * Version to release, given the manifest and the newest tag.
 *
 * Patch is automatic; minor and major are the writer's, signalled by pushing a
 * `package.json` whose version is ahead of the newest tag.
 * @param {string} current - the version in the root `package.json`.
 * @param {string} [latestTag] - the newest release tag, `v`-prefixed, or `''`.
 * @param {string} [forced] - a version to release instead of deciding one, for
 *   completing a release whose tag exists but whose artifacts do not.
 * @returns {{version: string, kind: 'initial'|'manual'|'patch'|'explicit', previous: string, warning?: string}}
 * @throws {Error} when the manifest version is not a version at all.
 */
export function nextVersion(current, latestTag, forced) {
  const manifest = parseVersion(current);
  if (!Number.isFinite(manifest.major)) {
    throw new Error(`package.json version is not a version: ${JSON.stringify(current)}`);
  }
  if (forced !== undefined && String(forced).trim() !== '') {
    const wanted = String(forced).trim().replace(/^v/, '');
    const parsed = parseVersion(wanted);
    if (!Number.isFinite(parsed.major)) throw new Error(`--version is not a version: ${JSON.stringify(forced)}`);
    return { version: wanted, kind: 'explicit', previous: String(latestTag ?? '').trim() };
  }
  const tag = parseTag(latestTag);

  // No tag: this is the first release, and it ships whatever the manifest says.
  if (tag === undefined) return { version: current.trim(), kind: 'initial', previous: '' };

  const order = compareParsed(manifest, tag);
  if (order > 0) return { version: current.trim(), kind: 'manual', previous: latestTag };

  // `order === 0` is the ordinary case: the manifest still names the last
  // release, so this push adds a patch.
  //
  // `order < 0` means the manifest was reset below a tag that already exists —
  // a revert, or a branch that dropped the bump commit. Releasing the lower
  // number would make the tag list non-monotonic and strand clients on a
  // version that only sorts backwards, so the tag wins and the patch advances
  // from it.
  const version = `${tag.major}.${tag.minor}.${tag.patch + 1}`;
  if (order < 0) {
    return {
      version,
      kind: 'patch',
      previous: latestTag,
      warning: `package.json is ${current}, below the newest tag ${latestTag}; releasing ${version} instead`,
    };
  }
  return { version, kind: 'patch', previous: latestTag };
}

/**
 * Rewrite only the `version` value, leaving the rest of the manifest byte-identical.
 *
 * A `JSON.parse`/`JSON.stringify` round trip would also reorder nothing today
 * but would silently normalise spacing, and a release commit that reformats a
 * whole file hides the one-line change it was supposed to make.
 * @param {string} text - the manifest source.
 * @param {string} version - the version to write.
 * @returns the rewritten source.
 * @throws {Error} when the manifest has no `version` field.
 */
export function withVersion(text, version) {
  const pattern = /("version"\s*:\s*")[^"]*(")/;
  if (!pattern.test(text)) throw new Error('manifest has no version field');
  return text.replace(pattern, `$1${version}$2`);
}

/**
 * The tag an earlier attempt of *this same run* created, if any.
 *
 * `github.run_id` survives "re-run all jobs", so stamping it into the release
 * commit makes the question decidable: a tag whose commit carries this run's id
 * was produced by the attempt being retried, and that attempt already decided
 * the version and pushed the tag. Nothing else in git history says "same run
 * again" — a new push and a re-run look identical from the outside.
 *
 * @param {Array<{tag: string, message: string}>} tags - tags and their commit messages.
 * @param {string} runId - the current workflow run id.
 * @returns {string|undefined} the tag to complete, without its `v` prefix.
 */
export function reuseTagOf(tags, runId) {
  const id = String(runId ?? '').trim();
  if (id === '') return undefined;
  // The id must end the marker: `Release-Run: 1001` is a prefix of
  // `Release-Run: 10011`, and a substring test would make run 1001 adopt run
  // 10011's release.
  const marker = `Release-Run: ${id}`;
  const bounded = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  for (const { tag, message } of tags) {
    if (bounded.test(String(message))) return String(tag).trim().replace(/^v/, '');
  }
  return undefined;
}

/**
 * What a release run should do.
 *
 * Deciding "manifest versus newest tag" alone is wrong for a re-run. A
 * successful release run creates its own bump commit and tags it, so on a re-run
 * the newest tag is the one that run published: a plain re-read of history
 * would decide a patch above it and publish a release nobody asked for. The
 * workflow therefore detects the earlier attempt's tag with `reuseTagOf` and
 * passes it here as `reuseTag`.
 *
 * @param {object} input
 * @param {string} input.current - version in the root package.json.
 * @param {string} [input.latestTag] - newest tag in history, `v`-prefixed.
 * @param {string} [input.reuseTag] - a version whose tag exists and whose
 *   artifacts still need publishing; completes that release.
 * @param {string} [input.forced] - an explicit version from the operator.
 * @returns {{version: string, kind: string, previous: string, reuse: boolean, warning?: string}}
 * @throws {Error} when a version cannot be determined.
 */
export function decideRelease({ current, latestTag = '', reuseTag, forced }) {
  // The operator naming a version wins outright: this is the way to rebuild a
  // release whose tag exists but whose artifacts are missing.
  if (forced !== undefined && String(forced).trim() !== '') {
    return { ...nextVersion(current, latestTag, forced), reuse: false };
  }

  if (reuseTag !== undefined && String(reuseTag).trim() !== '') {
    const version = String(reuseTag).trim().replace(/^v/, '');
    if (!Number.isFinite(parseVersion(version).major)) {
      throw new Error(`reuse-tag is not a version: ${JSON.stringify(reuseTag)}`);
    }
    return { version, kind: 'existing', previous: String(latestTag ?? '').trim(), reuse: true };
  }

  return { ...nextVersion(current, latestTag), reuse: false };
}

/** Read a manifest, or undefined when it does not exist. */
async function readManifest(path) {
  try {
    return await readFile(join(ROOT, path), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * CLI entry point.
 * @param {string[]} argv - arguments after the script name.
 */
async function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const apply = argv.includes('--apply');
  const latestTag = flag('latest-tag') ?? '';
  const forced = flag('version');
  const reuseTag = flag('reuse-tag');

  const rootSource = await readManifest(MANIFESTS[0]);
  if (rootSource === undefined) throw new Error(`${MANIFESTS[0]} not found`);

  const current = /"version"\s*:\s*"([^"]*)"/.exec(rootSource)?.[1];
  const decided = decideRelease({ current, latestTag, reuseTag, forced });
  if (decided.warning !== undefined) process.stderr.write(`warning: ${decided.warning}\n`);

  // A reused tag means the manifests already carry this version; rewriting them
  // would be a no-op at best and a dirty tree on a tagged commit at worst.
  if (apply && !decided.reuse) {
    for (const path of MANIFESTS) {
      const source = await readManifest(path);
      // A manifest that does not exist is not an error: this repository has two
      // today, and the release should not break if one is ever split out.
      if (source === undefined) continue;
      await writeFile(join(ROOT, path), withVersion(source, decided.version), 'utf8');
    }
  }

  process.stdout.write(`${JSON.stringify({ ...decided, applied: apply && !decided.reuse, tag: `v${decided.version}` })}\n`);
}

// Importable for tests; only runs when executed directly.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

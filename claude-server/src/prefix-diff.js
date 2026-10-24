/**
 * Why a cached prefix stopped matching.
 *
 * ## The problem this answers
 *
 * `shape.js` can say that two requests cached under different prefixes, and the
 * ledger can say a call paid to rewrite a prefix it had already cached. Neither
 * can say *which part* changed. "system hash is different" is true of every
 * mismatch and identifies none of them, so the operator is left reading the
 * harness source to guess.
 *
 * ## How it narrows it down
 *
 * A prompt is a sequence of named pieces — each system block, each tool schema,
 * each message — and Anthropic caches a prefix of that sequence. So when a
 * prefix stops matching, the useful fact is the **first piece that differs**
 * from the previous request under the same identity. Everything before it still
 * hit; that piece is what moved.
 *
 * Pieces are identified by name and position (`system[2]`, `tools[#7:bash]`,
 * `messages[4]`), and compared by digest. Two requests whose first difference is
 * `system[1]` have a different story from two whose first difference is
 * `messages[30]`, and the log line says which.
 *
 * This is a diagnostic for one operator chasing one bug, so it is bounded and
 * opt-in: at most {@link MAX_TRACKED} identities are held, each keeps only
 * digests and short excerpts, and it never grows a piece's text past
 * {@link EXCERPT_CHARS} into the log.
 *
 * @module claude-server/prefix-diff
 */

import { createHash } from 'node:crypto';

/** How many distinct prefixes to keep a memory of. */
const MAX_TRACKED = 64;

/** How much of a differing piece to quote in the log. */
const EXCERPT_CHARS = 240;

/**
 * The pieces of one request, for a caller that wants to inspect a suspicious
 * conversation rather than just be told which piece moved.
 *
 * Re-exported from `prefixPieces` below; kept separate so the comparison path
 * and the inspection path cannot drift apart.
 */
export function describePieces(body) {
  return prefixPieces(body);
}

/** A digest of one piece, short enough to read and long enough to compare. */
function hashOf(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Flatten a request body into the ordered pieces that the cache covers.
 *
 * The order is the one Anthropic caches in: tools, then system blocks, then
 * messages. A breakpoint sits after each, so a cache read that stops after the
 * tools means the first system block differed — which is exactly what the
 * position in this list encodes.
 * @param body - the parsed request body.
 * @returns the pieces, in cache order.
 */
export function prefixPieces(body) {
  const pieces = [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  tools.forEach((tool, index) => {
    // Named, because "the 7th tool" means nothing to a reader; `bash` does.
    const name = typeof tool?.name === 'string' ? tool.name : `#${index}`;
    pieces.push({ label: `tools[${index}:${name}]`, hash: hashOf(tool), text: tool?.description ?? '' });
  });
  const system = Array.isArray(body?.system) ? body.system : body?.system === undefined ? [] : [body.system];
  system.forEach((block, index) => {
    pieces.push({ label: `system[${index}]`, hash: hashOf(block), text: block?.text ?? String(block ?? '') });
  });
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  messages.forEach((message, index) => {
    pieces.push({
      label: `messages[${index}:${message?.role ?? '?'}]`,
      hash: hashOf(message),
      text: typeof message?.content === 'string' ? message.content : '',
    });
  });
  return pieces;
}

/** Quote a piece's text for a log line, bounded and whitespace-collapsed. */
function excerptOf(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`;
}

/**
 * Remembers each prefix's pieces so the next request can be compared to it.
 *
 * One instance per server. `compare` is the only method that matters: it returns
 * the first differing piece, or nothing when the new request is a strict
 * extension of the remembered one (which is the healthy case, and the common
 * one, so it must not be expensive).
 */
export class PrefixTracker {
  constructor() {
    /** identity → { labels: string[], hashes: string[], texts: string[] } */
    this.tracked = new Map();
  }

  /**
   * Compare a request against the last one seen under its identity.
   *
   * @param identity - the cache identity from `shape.js`.
   * @param pieces - this request's pieces, from {@link prefixPieces}.
   * @returns `{kind, index, label, before, after, sharedPrefixes}`, or undefined
   *   when nothing was tracked yet or the request extends the known prefix.
   *   `kind` is `changed` when a piece differs in place and `shrunk` when this
   *   request has fewer pieces than the one remembered.
   */
  compare(identity, pieces) {
    if (identity === undefined) return undefined;
    const previous = this.tracked.get(identity);

    // Always remember the latest shape: the useful comparison is with the
    // immediately preceding turn, not with the largest prompt ever seen, because
    // a prefix that grows and then shrinks back is the case worth catching.
    this.remember(identity, pieces);

    if (previous === undefined) return undefined;

    const limit = Math.min(previous.labels.length, pieces.length);
    for (let index = 0; index < limit; index += 1) {
      if (previous.hashes[index] === pieces[index].hash) continue;
      return {
        kind: 'changed',
        index,
        label: pieces[index].label,
        before: excerptOf(previous.texts[index]),
        after: excerptOf(pieces[index].text),
        sharedPrefixes: index,
      };
    }
    // Every shared position matched. A shorter request is a real mismatch —
    // the cached tail is now past the end of this prompt, so the cache cannot
    // be reused even though nothing differs.
    if (pieces.length < previous.labels.length) {
      return {
        kind: 'shrunk',
        index: pieces.length,
        label: previous.labels[pieces.length],
        before: excerptOf(previous.texts[pieces.length]),
        after: '',
        sharedPrefixes: pieces.length,
      };
    }
    // A strict extension: the healthy case, nothing to report.
    return undefined;
  }

  /** Store one request's pieces, evicting the oldest identity when full. */
  remember(identity, pieces) {
    const entry = {
      labels: pieces.map((piece) => piece.label),
      hashes: pieces.map((piece) => piece.hash),
      texts: pieces.map((piece) => piece.text),
    };
    // Re-insert so iteration order is recency order for the eviction below.
    this.tracked.delete(identity);
    this.tracked.set(identity, entry);
    while (this.tracked.size > MAX_TRACKED) {
      const oldest = this.tracked.keys().next().value;
      this.tracked.delete(oldest);
    }
  }

  /**
   * What each tracked prefix is made of, for an operator inspecting one.
   *
   * Every piece carries a bounded excerpt so a reader can recognise the
   * conversation — a subagent's persona, a tool schema, a message — without the
   * response becoming a prompt dump. The excerpt is the same bound the log uses,
   * so what is shown here and what is logged cannot disagree.
   * @returns `{ prefixes: [{ identity, pieces, totalChars }] }`.
   */
  snapshot() {
    const prefixes = [];
    for (const [identity, entry] of this.tracked) {
      const pieces = entry.labels.map((label, index) => ({
        label,
        hash: entry.hashes[index],
        chars: String(entry.texts[index] ?? '').length,
        excerpt: excerptOf(entry.texts[index]),
      }));
      prefixes.push({
        identity,
        pieces,
        // The size of the cacheable prefix: what a miss would have to rewrite.
        totalChars: pieces.reduce((sum, piece) => sum + piece.chars, 0),
      });
    }
    return { prefixes };
  }

  /** Forget everything (exposed for tests and for a reset). */
  reset() {
    this.tracked.clear();
  }
}

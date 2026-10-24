/**
 * Token accounting for relayed model traffic.
 *
 * ## Why this observes the stream instead of parsing a response
 *
 * The relay forwards Anthropic's bytes untouched. Accounting therefore cannot
 * consume the response; it watches the same chunks the client receives and only
 * reads the `usage` fields Anthropic already includes. Nothing here changes a
 * byte, delays a chunk, or can fail a request: every entry point swallows its
 * own errors and reports nothing further.
 *
 * ## What it counts
 *
 * A streaming response reports usage twice: `message_start` carries the input
 * side (input, cache creation, cache read) and `message_delta` carries the
 * cumulative output count. A non-streaming response carries one `usage` object.
 * Both shapes are read here, so accounting works whether or not the caller
 * asked for a stream.
 *
 * ## Why the counter is in memory only
 *
 * The server runs with a read-only root filesystem and a single writable volume
 * that exists to hold the grant. Adding a second writable path for statistics
 * would mean a second thing to back up, corrupt and migrate, for data that is
 * only interesting while the process is up. Counts reset on restart, which is
 * stated wherever they are surfaced.
 *
 * @module claude-server/usage
 */

import { costOf } from './pricing.js';

/** How many recent calls to keep for inspection. */
const MAX_RECENT = 50;

/**
 * How many tokens a cache write may exceed the prompt's growth by before it is
 * treated as a rewrite rather than an extension.
 *
 * Anthropic caches at block boundaries, not token boundaries, so a write is
 * always somewhat larger than the exact growth. This margin is far below one
 * block, which keeps the classification honest for a real rewrite (thousands of
 * tokens) while not flagging the normal block granularity.
 */
const WASTE_MARGIN = 1024;

/** Default bound on a pending SSE frame, in characters. */
const DEFAULT_FRAME_LIMIT = 256 * 1024;

/** Fields Anthropic reports on a usage object. */
const COUNTERS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
];

/** Shape a fresh accumulator. */
export function emptyTotals() {
  return {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

/** Add one usage object's fields into a totals bucket, ignoring absent ones. */
function accumulate(totals, usage) {
  if (usage === null || typeof usage !== 'object') return;
  for (const field of COUNTERS) {
    const value = usage[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      totals[field] += value;
    }
  }
}

/** True when every counter is still zero. */
function isEmpty(totals) {
  return COUNTERS.every((field) => totals[field] === 0);
}

/**
 * Incremental reader for one response body.
 *
 * SSE frames can split across chunk boundaries at any byte, so the observer
 * buffers until it sees a blank line and only then parses the complete events.
 * The buffer is bounded: a body that never produces a frame terminator (or a
 * non-SSE body) must not grow without limit in a 1 GB container.
 */
export class UsageObserver {
  /**
   * @param options - `limit` bounds the pending-frame buffer in characters.
   */
  constructor(options = {}) {
    this.frameLimit = options.limit ?? DEFAULT_FRAME_LIMIT;
    this.buffer = '';
    this.inputUsage = undefined;
    this.deltaUsage = undefined;
    this.model = undefined;
    this.sawStream = false;
    this.abandoned = false;
  }

  /**
   * Feed one decoded chunk. Never throws.
   * @param chunk - a Buffer or string of response bytes.
   */
  observe(chunk) {
    if (this.abandoned) return;
    try {
      this.#consume(String(chunk));
    } catch {
      // Accounting must never break a response.
      this.abandoned = true;
      this.buffer = '';
    }
  }

  #consume(text) {
    this.buffer += text;
    if (this.buffer.length > this.frameLimit) {
      // Give up on this response rather than buffer without bound. Counts stay
      // at whatever was read before this point.
      this.abandoned = true;
      this.buffer = '';
      return;
    }
    // Frames end at a blank line. Anthropic emits `\n\n`; `\r\n\r\n` is accepted
    // too so a rewriting proxy cannot hide the events.
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (match === null) break;
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.#frame(frame);
    }
  }

  /** Parse one complete SSE frame. */
  #frame(frame) {
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    if (payload.length === 0 || payload === '[DONE]') return;
    try {
      this.#event(JSON.parse(payload));
    } catch {
      // A malformed frame is skipped; the next one may still be readable.
    }
  }

  /** Read usage out of one parsed event, or a whole non-streaming body. */
  #event(event) {
    if (event === null || typeof event !== 'object') return;
    if (event.type === 'message_start') {
      this.sawStream = true;
      if (typeof event.message?.model === 'string') this.model = event.message.model;
      if (event.message?.usage !== undefined) this.inputUsage = event.message.usage;
      return;
    }
    if (event.type === 'message_delta') {
      if (event.usage !== undefined) this.deltaUsage = event.usage;
      return;
    }
    if (event.type === 'error') return;
    // A non-streaming response is a single JSON object with top-level `usage`.
    if (!this.sawStream && event.usage !== undefined && typeof event.usage === 'object') {
      if (typeof event.model === 'string') this.model = event.model;
      this.inputUsage = event.usage;
    }
  }

  /**
   * Signal end of stream, then return the accounting.
   *
   * A non-streaming response is one JSON document with no SSE framing at all, so
   * it never produces a blank-line terminator and the buffer still holds the
   * whole body here. Flushing at end-of-stream is what makes the non-streaming
   * shape readable.
   * @returns counters plus the model id, or undefined when nothing was reported.
   */
  finish() {
    if (!this.abandoned && this.buffer.length > 0) {
      const remainder = this.buffer;
      this.buffer = '';
      // An unterminated frame is normally incomplete, but at end-of-stream it is
      // all there is: try it as a frame, then as a bare JSON document.
      if (remainder.includes('data:')) this.#frame(remainder);
      else {
        try {
          this.#event(JSON.parse(remainder));
        } catch {
          // Not JSON either; nothing to account for.
        }
      }
    }
    return this.result();
  }

  /**
   * The accounting for this response.
   *
   * `message_delta.usage.output_tokens` is cumulative for the whole message, so
   * it replaces rather than adds to whatever `message_start` reported.
   * @returns counters plus the model id, or undefined when nothing was reported.
   */
  result() {
    const totals = emptyTotals();
    if (this.inputUsage !== undefined) accumulate(totals, this.inputUsage);
    if (this.deltaUsage !== undefined) {
      for (const field of COUNTERS) {
        const value = this.deltaUsage[field];
        if (field === 'output_tokens' && typeof value === 'number') {
          totals.output_tokens = value;
        } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          totals[field] += value;
        }
      }
    }
    if (isEmpty(totals)) return undefined;
    return { ...totals, calls: 1, model: this.model };
  }
}

/**
 * The process-wide accounting ledger.
 *
 * One instance per server. Every relayed model call contributes one entry, and
 * the totals are what the console shows.
 */
export class UsageLedger {
  constructor() {
    this.totals = emptyTotals();
    this.byModel = new Map();
    // Who and which subscription the traffic belongs to. Both dimensions are
    // kept because they answer different questions: `byUser` is "who spent
    // this", `byAccount` is "which subscription paid for it".
    this.byUser = new Map();
    this.byAccount = new Map();
    this.recent = [];
    this.since = Date.now();
    this.costUsd = 0;
    /** Model ids the price table does not know, so the console can say so. */
    this.unpricedModels = new Set();
    /**
     * Per cache-identity state, for the reuse analysis.
     *
     * Cache identity is the (tools, system) pair a request caches under. One
     * entry per identity holds the highest prompt size that identity has ever
     * had cached, which is the baseline the next call is compared against: a
     * call whose prompt is not larger than that baseline *should* have read it
     * all back, so a read below it is a miss that needs explaining.
     */
    this.byCacheIdentity = new Map();
    /**
     * Per-session cache history, keyed by the conversation fingerprint.
     *
     * A `(tools, system)` pair is not a conversation: two chats, a reviewer
     * running distinct reviews, and a title generator can all share one. Judging
     * each against the pair's pooled high-water mark made every shorter prompt
     * look like a shrink and every different one look like a rewrite, which
     * inflated the waste figure and pointed at the wrong subsystem. The verdict
     * is therefore decided per session; the identity bucket only aggregates.
     */
    this.bySession = new Map();
  }

  /**
   * Classify one call's cache behaviour against its identity's own history.
   *
   * The three outcomes are deliberately distinct, because they call for
   * different fixes:
   *
   * - `first` — nothing cached under this identity yet. A write is expected.
   * - `extended` — the prompt grew past the previous high-water mark. A write of
   *   the new tail is expected; the part up to the old mark should have been a
   *   read, so a read near zero here is a real miss.
   * - `reused` — the prompt did not grow, so the whole thing should have been a
   *   read. Any write at all here is the costly case: the prefix was already
   *   cached and was paid for again.
   *
   * @param identity - the (tools, system) cache identity, or undefined.
   * @param promptTokens - this call's total prompt size (input + cache read + cache write).
   * @param readTokens - of that, how much came from cache.
   * @param writeTokens - of that, how much was written to cache.
   * @returns {{verdict: string, identity?: string, previousHigh?: number, reuseRatio?: number}}
   */
  classifyCache(identity, sessionKey, promptTokens, readTokens, writeTokens) {
    if (identity === undefined) return { verdict: 'unknown' };
    const bucket = this.byCacheIdentity.get(identity) ?? {
      calls: 0,
      first: 0,
      extended: 0,
      reused: 0,
      rewritten: 0,
      wastedWrites: 0,
      highWater: 0,
    };
    // The bar this call is measured against is its own conversation's, because
    // only that conversation's earlier prompt is actually in the cache.
    const session = sessionKey === undefined ? undefined : this.bySession.get(sessionKey);
    const previousHigh = session?.highWater ?? 0;
    // Share of the prompt that came back from cache. Only meaningful once
    // something was cached, which is why `first` reports none.
    const reuseRatio = promptTokens > 0 ? readTokens / promptTokens : undefined;

    // How much *new* content this call brought, relative to the largest prefix
    // this identity has already cached. Everything up to `previousHigh` was
    // already cacheable and should have been read.
    const growth = Math.max(0, promptTokens - previousHigh);
    // A write is expected to cover the growth and little else. Anthropic caches
    // in blocks, so a write a couple of blocks larger than the growth is normal;
    // one that dwarfs it means the prefix was rebuilt instead of extended, which
    // is the expensive case worth naming.
    const wasted = writeTokens > growth + WASTE_MARGIN;

    let verdict;
    if (session === undefined) verdict = 'first';
    else if (promptTokens <= previousHigh) verdict = 'reused';
    else verdict = wasted ? 'rewritten' : 'extended';

    // What the cache holds after this call: everything read back plus everything
    // just written. Input tokens are beyond the last breakpoint and are not part
    // of it, so they are excluded — counting the whole prompt here would make the
    // bar rise on every call and hide real misses.
    const cachedAfter = readTokens + writeTokens;
    // The mark only advances: a shorter prompt can still be a hit on the longer
    // cached prefix, and letting the bar drift down would turn every later call
    // into an "extension" and make misses invisible.
    const nextHigh = Math.max(previousHigh, cachedAfter);
    // Advance this conversation's own bar, and keep the identity bucket as a
    // pure aggregate: `highWater` there is the largest single session's, which
    // is what "how big does this prefix get" asks.
    if (sessionKey !== undefined) {
      this.bySession.set(sessionKey, { highWater: nextHigh });
    }
    bucket.calls += 1;
    bucket[verdict] += 1;
    // The number that matters: a write that bought little or no new prefix.
    if ((verdict === 'reused' || verdict === 'rewritten') && writeTokens > 0) bucket.wastedWrites += 1;
    bucket.highWater = Math.max(bucket.highWater, nextHigh);
    bucket.sessions = this.bySession.size;
    this.byCacheIdentity.set(identity, bucket);

    return { verdict, identity, previousHigh, reuseRatio };
  }

  /**
   * Record one completed call.
   * @param entry - counters, model id, and timing for a single request.
   */
  record(entry) {
    if (entry === undefined) return;
    this.totals.calls += 1;
    accumulate(this.totals, entry);
    const model = typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : undefined;

    // The API-equivalent value of this one call. Unknown models contribute no
    // figure but are named, so the console can say which ones it could not price
    // rather than quietly under-reporting the total.
    const cost = costOf(entry, model);
    if (cost === undefined) {
      if (model !== undefined) this.unpricedModels.add(model);
    } else {
      this.costUsd += cost;
    }

    if (model !== undefined) {
      const bucket = this.byModel.get(model) ?? emptyTotals();
      bucket.calls += 1;
      accumulate(bucket, entry);
      bucket.costUsd = (bucket.costUsd ?? 0) + (cost ?? 0);
      this.byModel.set(model, bucket);
    }

    // Attribute the call. A missing identity (older embedders, the bootstrap
    // bearer before users existed) is bucketed as `legacy` rather than dropped:
    // dropping it would make per-user totals not add up to the whole.
    const userKey = typeof entry.userId === 'string' && entry.userId.length > 0 ? entry.userId : 'legacy';
    const userName = typeof entry.userName === 'string' && entry.userName.length > 0 ? entry.userName : userKey;
    const accountKey =
      typeof entry.accountId === 'string' && entry.accountId.length > 0 ? entry.accountId : 'default';
    // `label` is the human-readable name; `key` stays the id. The console shows
    // the label and falls back to the id only when no name is known.
    const bucket = this.byUser.get(userKey) ?? { label: userName, ...emptyTotals(), costUsd: 0 };
    bucket.label = userName;
    bucket.calls += 1;
    accumulate(bucket, entry);
    bucket.costUsd += cost ?? 0;
    this.byUser.set(userKey, bucket);

    const accountBucket = this.byAccount.get(accountKey) ?? { label: accountKey, ...emptyTotals(), costUsd: 0 };
    // The relay knows the account id; the console maps it to a name.
    accountBucket.calls += 1;
    accumulate(accountBucket, entry);
    accountBucket.costUsd += cost ?? 0;
    this.byAccount.set(accountKey, accountBucket);

    // Cache diagnostics. The shape travels with the entry from the relay, which
    // is the only place the request body exists; see `shape.js` for why these
    // fields are digests rather than the text.
    const shape = entry.shape;
    const identity = entry.cacheIdentity;
    const inputTokens = entry.input_tokens ?? 0;
    const readTokens = entry.cache_read_input_tokens ?? 0;
    const writeTokens = entry.cache_creation_input_tokens ?? 0;
    const promptTokens = inputTokens + readTokens + writeTokens;
    const cache = this.classifyCache(
      identity,
      entry.sessionKey,
      promptTokens,
      readTokens,
      writeTokens,
    );

    this.recent.unshift({
      at: Date.now(),
      model: model ?? null,
      input_tokens: inputTokens,
      output_tokens: entry.output_tokens ?? 0,
      cache_creation_input_tokens: writeTokens,
      cache_read_input_tokens: readTokens,
      durationMs: entry.durationMs ?? null,
      // The identity a row groups under, and whether this call's cache
      // behaviour was expected. `first`/`extended` writes are normal; a write
      // under `reused` is the expensive anomaly.
      cacheIdentity: identity ?? null,
      cacheVerdict: cache.verdict,
      reuseRatio: cache.reuseRatio ?? null,
      shape: shape ?? null,
    });
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
  }

  /**
   * A snapshot for display.
   * @returns totals, per-model breakdown, and the recent calls.
   */
  snapshot() {
    return {
      since: this.since,
      totals: { ...this.totals },
      byModel: [...this.byModel.entries()]
        .map(([model, totals]) => ({ model, ...totals }))
        .sort(
          (a, b) =>
            b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens),
        ),
      // Per-user and per-account attribution. Sorted by value rather than by
      // key so the expensive rows surface first, which is what an operator
      // looking at this page wants to see.
      byUser: [...this.byUser.entries()]
        .map(([userId, bucket]) => ({ userId, ...bucket }))
        .sort((a, b) => b.costUsd - a.costUsd),
      byAccount: [...this.byAccount.entries()]
        .map(([accountId, bucket]) => ({ accountId, ...bucket }))
        .sort((a, b) => b.costUsd - a.costUsd),
      /** API-equivalent USD for all priced traffic. */
      costUsd: this.costUsd,
      /** Models the price table could not price; their tokens are not counted. */
      unpricedModels: [...this.unpricedModels],
      /**
       * Cache reuse, grouped by the (tools, system) pair its prefix belongs to.
       *
       * The point of grouping: a subagent has a restricted tool set and its own
       * persona, so it caches under a different identity and its misses are not
       * the main conversation's. Summing them together is what makes a working
       * cache look broken.
       */
      byCacheIdentity: [...this.byCacheIdentity.entries()]
        .map(([identity, bucket]) => ({ identity, ...bucket }))
        .sort((a, b) => b.calls - a.calls),
      recent: [...this.recent],
      // Stated wherever the numbers appear: this is process memory, so a
      // restart starts from zero.
      resetsOnRestart: true,
    };
  }

  /** Forget everything (exposed for tests). */
  reset() {
    this.totals = emptyTotals();
    this.byModel.clear();
    this.byUser.clear();
    this.byAccount.clear();
    this.byCacheIdentity.clear();
    this.recent = [];
    this.since = Date.now();
    this.costUsd = 0;
    this.unpricedModels.clear();
  }
}

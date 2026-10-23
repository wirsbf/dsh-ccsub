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

/** How many recent calls to keep for inspection. */
const MAX_RECENT = 50;

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
    this.recent = [];
    this.since = Date.now();
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
    if (model !== undefined) {
      const bucket = this.byModel.get(model) ?? emptyTotals();
      bucket.calls += 1;
      accumulate(bucket, entry);
      this.byModel.set(model, bucket);
    }
    this.recent.unshift({
      at: Date.now(),
      model: model ?? null,
      input_tokens: entry.input_tokens ?? 0,
      output_tokens: entry.output_tokens ?? 0,
      cache_creation_input_tokens: entry.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: entry.cache_read_input_tokens ?? 0,
      durationMs: entry.durationMs ?? null,
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
    this.recent = [];
    this.since = Date.now();
  }
}

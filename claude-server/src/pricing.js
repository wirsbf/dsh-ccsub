/**
 * Model prices and cost computation.
 *
 * ## What "cost" means here
 *
 * This server holds a **subscription** grant, not an API key, so nothing in
 * this file is money that gets billed. The figure is the *API-equivalent* value
 * of the traffic: what the same tokens would have cost on pay-as-you-go
 * pricing. That is the only way to compare a heavy user against a light one on
 * a flat-rate plan, and it is why every surface that shows a dollar figure says
 * "API equivalent" beside it.
 *
 * ## Why the table is local
 *
 * Neither `/v1/models` nor pi-ai publishes prices — the model catalog lists
 * capabilities, limits and lifecycle, and nothing about rates. So the numbers
 * are maintained here, keyed by model family and generation.
 *
 * ## Cache multipliers
 *
 * Anthropic prices cache traffic as fixed multiples of a model's base input
 * rate rather than as independent numbers, so the multipliers live in one place
 * instead of being baked into every row:
 *
 * - cache **read**:     0.1x  (the 90% saving that makes caching worth keeping)
 * - cache **write** 5m: 1.25x (the default TTL)
 * - cache **write** 1h: 2x    (not used by this server, recorded for clarity)
 *
 * @module claude-server/pricing
 */

/** Cache read is a tenth of the input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;

/** A 5-minute cache write costs a quarter more than plain input. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Prices in USD per million tokens, `[input, output]`.
 *
 * Ordered most specific first: the lookup takes the first entry whose pattern
 * matches, so `claude-opus-5-5` is tested before `claude-opus-5` and both before
 * `claude-opus`. A dated snapshot (`claude-sonnet-4-5-20250929`) matches its
 * undated family entry because the patterns are prefix-anchored.
 *
 * Sources: platform.claude.com model pages and the pricing page, read
 * 2026-10-24. When a price changes upstream this table is the one place to fix.
 */
const PRICE_TABLE = [
  // Fable is the flagship line: double Opus per token.
  { pattern: /^claude-fable-5/, input: 10, output: 50 },
  // Opus 5.5 dropped to Sonnet-class input pricing.
  { pattern: /^claude-opus-5-5/, input: 4, output: 20 },
  { pattern: /^claude-opus-5/, input: 4, output: 20 },
  { pattern: /^claude-opus-4-[678]/, input: 5, output: 25 },
  { pattern: /^claude-opus-4-5/, input: 5, output: 25 },
  { pattern: /^claude-opus/, input: 5, output: 25 },
  // Sonnet 5.5 is cheaper than 4.x.
  { pattern: /^claude-sonnet-5-5/, input: 2, output: 10 },
  { pattern: /^claude-sonnet-5/, input: 3, output: 15 },
  { pattern: /^claude-sonnet-4/, input: 3, output: 15 },
  { pattern: /^claude-sonnet/, input: 3, output: 15 },
  // Haiku 5.5 is an order of magnitude below Haiku 4.5.
  { pattern: /^claude-haiku-5/, input: 0.1, output: 0.5 },
  { pattern: /^claude-haiku-4/, input: 1, output: 5 },
  { pattern: /^claude-haiku/, input: 1, output: 5 },
];

/**
 * The price row for one model id.
 * @param model - the model id, e.g. `claude-sonnet-5-5`.
 * @returns the row, or undefined when the model is unknown.
 */
export function priceFor(model) {
  if (typeof model !== 'string' || model.length === 0) return undefined;
  return PRICE_TABLE.find((row) => row.pattern.test(model));
}

/**
 * The API-equivalent cost of one contribution, in USD.
 *
 * Unknown models return `undefined` rather than zero: a zero would silently
 * understate a bill, while an absent figure is honest about not knowing.
 * @param usage - counters with `input_tokens`, `output_tokens`, and the two
 *   cache counters.
 * @param model - the model the tokens were spent on.
 * @returns the cost in USD, or undefined when the model has no price.
 */
export function costOf(usage, model) {
  const price = priceFor(model);
  if (price === undefined) return undefined;
  const input = number(usage?.input_tokens);
  const output = number(usage?.output_tokens);
  const cacheRead = number(usage?.cache_read_input_tokens);
  const cacheWrite = number(usage?.cache_creation_input_tokens);
  // Per-token rates derived from the per-million table.
  const inputRate = price.input / 1_000_000;
  const outputRate = price.output / 1_000_000;
  return (
    input * inputRate +
    output * outputRate +
    cacheRead * inputRate * CACHE_READ_MULTIPLIER +
    cacheWrite * inputRate * CACHE_WRITE_MULTIPLIER
  );
}

/** A counter value, or 0 for anything that is not a positive finite number. */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Round a cost for display, keeping small figures meaningful.
 * @param value - the cost in USD.
 * @returns a string with four decimals below a dollar, two above.
 */
export function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

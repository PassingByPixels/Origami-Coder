// What a sub-agent SPENT, in dollars (t-ru1i84).
//
// The engine rides token counts per child (`origami_task_tokens`, acpTaskTokens.ts) and
// the model each child runs on, but a price only when the provider itself reported one.
// So the figure here is derived on this side — and acpTaskTokens.ts's `cost` deliberately
// is NOT: that field is the provider's own number and must stay it. `costUsd` is a second,
// separately named field precisely so a reader can tell a measured price from a computed
// one, and so neither can silently stand in for the other.
//
// THE PRICES ARE THE ENGINE'S OWN CATALOGUE, read-only. `provider/catalog-cache.ts` writes
// the built provider catalogue to <data>/cache/provider-catalog-<key>.json, and every model
// row in it carries `cost: { input, output, cache: { read, write } }` in USD per MILLION
// tokens. Nothing is bundled here: a rate compiled into a release goes stale in silence and
// then reads as fact. No catalogue, no price, no figure — the row prints nothing, which is
// the same answer labyrinthPrices.ts gives for the same reason.
//
// A LOCAL MODEL IS NOT A FREE MODEL WITH A PRICE OF ZERO. The catalogue writes 0/0 for
// every lmstudio/vllm row, so an all-zero price is read as "unpriced" and blanks the figure
// rather than printing `$0.0000`, which would claim a measurement.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskTokens } from '../acpTaskTokens';

export interface ModelPrice {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const MILLION = 1_000_000;

/** How long a parsed catalogue is trusted before the directory is read again. The file
 *  only changes when the engine rebuilds its catalogue, which is rare. */
export const PRICE_CACHE_MS = 60_000;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function priceOf(cost: unknown): ModelPrice | undefined {
  if (!cost || typeof cost !== 'object') return undefined;
  const c = cost as { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } };
  const price: ModelPrice = {
    input: num(c.input),
    output: num(c.output),
    cacheRead: num(c.cache?.read),
    cacheWrite: num(c.cache?.write),
  };
  // All zeroes is the local/self-hosted row, not a free lunch worth printing.
  return price.input || price.output || price.cacheRead || price.cacheWrite ? price : undefined;
}

/** `{ catalog: { providers: [{ id, models: { <id>: { cost } } }] } }` — the shape
 *  catalog-cache.ts writes — flattened to `provider/model`. Anything unreadable in there
 *  is skipped, never thrown: a bad catalogue must cost a figure, not a session. */
export function pricesFromCatalog(json: unknown): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  const providers = (json as { catalog?: { providers?: unknown } })?.catalog?.providers;
  if (!Array.isArray(providers)) return out;
  for (const p of providers) {
    const id = (p as { id?: unknown })?.id;
    const models = (p as { models?: unknown })?.models;
    if (typeof id !== 'string' || !models || typeof models !== 'object') continue;
    for (const [modelId, row] of Object.entries(models as Record<string, unknown>)) {
      const price = priceOf((row as { cost?: unknown })?.cost);
      if (price) out.set(`${id}/${modelId}`.toLowerCase(), price);
    }
  }
  return out;
}

/** The engine's data root, as @origami/core's Global.Path resolves it (xdg-basedir, which
 *  falls back to ~/.local/share on every platform including Windows). Mirrored rather than
 *  imported: this package does not depend on the engine's sources. */
export function catalogDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'origami', 'cache');
}

let cached: { at: number; prices: Map<string, ModelPrice> } | undefined;

/** Test seam — the module remembers a catalogue between calls. */
export function resetSubagentCost(): void {
  cached = undefined;
  childModels.clear();
}

/** The newest provider-catalog file's prices. Every failure path is an empty map. */
export function catalogPrices(dir = catalogDir(), now = Date.now()): Map<string, ModelPrice> {
  if (cached && now - cached.at < PRICE_CACHE_MS) return cached.prices;
  let prices = new Map<string, ModelPrice>();
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('provider-catalog-') && f.endsWith('.json'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files[0]) prices = pricesFromCatalog(JSON.parse(fs.readFileSync(files[0], 'utf8')));
  } catch { /* no catalogue, no price — the figure is simply absent */ }
  cached = { at: now, prices };
  return prices;
}

/** `provider/model` as the rider spells it, matched case-insensitively. An OpenRouter id
 *  carries its own slash (`openrouter/qwen/qwen3.7-max`), so the exact key is tried first
 *  and a suffix match only after it. */
export function priceFor(prices: ReadonlyMap<string, ModelPrice>, model: string | undefined): ModelPrice | undefined {
  const want = (model || '').trim().toLowerCase();
  if (!want) return undefined;
  const exact = prices.get(want);
  if (exact) return exact;
  for (const [key, price] of prices) if (key.endsWith(`/${want}`)) return price;
  return undefined;
}

/** USD for one child's counters.
 *
 *  REASONING TOKENS ARE BILLED AS OUTPUT by every provider in the catalogue, and cached
 *  reads/writes have their own rates, so the four counters map to three prices. `input` is
 *  taken to EXCLUDE the cached reads counted beside it, which is how the providers report
 *  it; if a provider ever double-counted there, this would over-charge rather than silently
 *  lose the cache line. undefined — not 0 — when nothing is priced. */
export function costUsd(tokens: TaskTokens | undefined, price: ModelPrice | undefined): number | undefined {
  if (!tokens || !price) return undefined;
  const spend =
    (tokens.input ?? 0) * price.input +
    ((tokens.output ?? 0) + (tokens.reasoning ?? 0)) * price.output +
    (tokens.cacheRead ?? 0) * price.cacheRead +
    (tokens.cacheWrite ?? 0) * price.cacheWrite;
  return spend > 0 ? spend / MILLION : undefined;
}

const childModels = new Map<string, string>();

/** The tokens rider and the model arrive on DIFFERENT messages — the model on the task
 *  tool's result, the counters on their own empty chunk — so the pairing is remembered
 *  here rather than guessed at either site. */
export function rememberChildModel(childSessionId: string | undefined, model: string | undefined): void {
  if (childSessionId && model) childModels.set(childSessionId, model);
}

/** The child's rider with `costUsd` added, or the rider untouched when its model is
 *  unknown or unpriced. Returns undefined for an absent rider so the caller's own
 *  "did any tokens arrive" test keeps working. */
export function pricedTokens(childSessionId: string | undefined, tokens: TaskTokens | undefined, dir?: string): TaskTokens | undefined {
  if (!tokens) return undefined;
  const model = childSessionId ? childModels.get(childSessionId) : undefined;
  const usd = costUsd(tokens, priceFor(catalogPrices(dir), model));
  return usd === undefined ? tokens : { ...tokens, costUsd: usd };
}

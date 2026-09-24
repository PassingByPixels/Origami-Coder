// The Labyrinth's price table, host side — the user's own $/Mtok figures, persisted in
// workspaceState like the pane's column widths.
//
// A separate leaf, not two more cases inline: every field off the wire is re-checked before storage
// and anything unrecognised is dropped. No bundled price list — a rate baked into a release goes
// stale silently and reads as fact; an empty table just shows no figure, which is honest.

/** One model's prices. Dollars per MILLION tokens; `cachedPercent` is a percent
 *  of input, absent meaning the provider default the webview applies. */
export interface ModelPrice {
  input?: number;
  output?: number;
  cachedPercent?: number;
}
/** Keyed by the engine's own `providerID/modelID`. */
export type PriceTable = Record<string, ModelPrice>;

export const LABYRINTH_PRICES_KEY = 'origami.labyrinthModelPrices';

/** A finite, non-negative number, or nothing. A negative price is not a price,
 *  and NaN would poison every total computed from it. */
function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The table as it may be stored: unknown keys dropped, unusable numbers dropped, a model with no
 *  usable field dropped entirely — so an empty row can never persist and read as "priced at zero".
 */
export function sanitisePrices(raw: unknown): PriceTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PriceTable = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!model || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const entry: ModelPrice = {};
    const input = money(v['input']);
    const output = money(v['output']);
    const cachedPercent = money(v['cachedPercent']);
    if (input !== undefined) entry.input = input;
    if (output !== undefined) entry.output = output;
    if (cachedPercent !== undefined) entry.cachedPercent = cachedPercent;
    if (Object.keys(entry).length > 0) out[model] = entry;
  }
  return out;
}

/** The message types this leaf owns, in DashboardPanel's dispatch idiom. */
export const LABYRINTH_PRICES_MESSAGE_TYPES = new Set(['requestLabyrinthPrices', 'saveLabyrinthPrices']);

export interface PricesHost {
  read(): unknown;
  write(next: PriceTable): void;
  post(message: Record<string, unknown>): void;
}

/**
 * Read or write the table, then echo it back, so the panel shows what was actually stored, not what
 *  it hoped to store.
 */
export function handleLabyrinthPricesMessage(host: PricesHost, message: Record<string, unknown>): void {
  if (message['type'] === 'saveLabyrinthPrices') {
    const next = sanitisePrices(message['prices']);
    host.write(next);
    host.post({ type: 'labyrinthPrices', prices: next });
    return;
  }
  host.post({ type: 'labyrinthPrices', prices: sanitisePrices(host.read()) });
}

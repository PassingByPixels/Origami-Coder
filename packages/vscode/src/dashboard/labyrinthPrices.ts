// The Labyrinth's PRICE TABLE, host side — the user's own $/Mtok figures per
// model, persisted in workspaceState exactly the way the pane's column widths
// are (DashboardPanel's `resizeLabyrinthColumn`), because the two are the same
// kind of thing: a per-workspace preference the webview cannot keep itself.
//
// A separate leaf rather than two more cases inline, for the reason the
// architecture ratchet exists: DashboardPanel.ts carries the wiring, never the
// decisions. The decisions here are all about NOT trusting the wire — a webview
// message is JSON that crossed a boundary, so every field is re-checked before
// it is stored, and anything unrecognised is dropped rather than persisted.
//
// There is deliberately NO BUNDLED PRICE LIST. A rate baked into a release goes
// stale silently and is then presented as fact; an empty table simply produces
// no currency figure at all, which is honest.

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
 * The table as it may be STORED: unknown keys dropped, unusable numbers
 * dropped, and a model left with no usable field dropped entirely — so an empty
 * row can never persist and then read as "priced at zero".
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
 * Read or write the table, then ECHO it back. The echo is what makes the panel
 * show what was actually stored rather than what it hoped to store — a value
 * the sanitiser refused must not stay on screen.
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

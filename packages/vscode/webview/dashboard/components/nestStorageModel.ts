// nestStorageModel.ts — what the Nests view's Storage card prints and sends
// (t-s9jr6u, mock round 4 "Storage section", round 5 "edit, then Apply").
//
// Reads the engine's own reply shapes (L4a nest_storage / nest_retention, as
// src/dashboard/nestContract.ts mirrors them; t-sc093o): a webview file cannot
// import from src/.
// Pure, so every rule the card follows is a unit test with nothing rendered.

export type NestClass = 'chats' | 'subagents' | 'toolOutput' | 'journal' | 'artifacts';
export type NestWindowClass = Exclude<NestClass, 'journal'>;
/** Days a body is kept. null = everything. The engine refuses 0 and raises
 *  anything under 7 to 7. */
export type NestWindow = number | null;

export interface NestStorageStats {
  classes: Record<NestClass, number>;
  /** Journal events per part (engine `journalEventsPerPart`); 1 or less = compact. */
  perPart: number;
  journalCompact: boolean;
  /** When the host got the reply (ms); the engine sends only how long it took. */
  measuredAt: number;
}
export type NestWindows = Record<NestWindowClass, NestWindow>;

/** Table order; the swatch class names the --og-* colour in the card's CSS. */
export const CLASSES: ReadonlyArray<{ key: NestClass; label: string }> = [
  { key: 'chats', label: 'Chats' },
  { key: 'subagents', label: 'Sub-agent chats' },
  { key: 'toolOutput', label: 'Tool output' },
  { key: 'journal', label: 'Journal' },
  { key: 'artifacts', label: 'Artifacts' },
];

/** The Keep choices, longest first. The value is what `nest_retention` takes. */
export const WINDOWS: ReadonlyArray<{ value: NestWindow; label: string }> = [
  { value: null, label: 'Everything' },
  { value: 90, label: '90 days' },
  { value: 30, label: '30 days' },
  { value: 14, label: '14 days' },
  { value: 7, label: '7 days' },
];

/** A new desk starts with these (Config's "Keep on a new desk"). */
export const NEW_DESK_WINDOWS: NestWindows = { chats: 30, subagents: 14, toolOutput: 7, artifacts: 90 };

export function windowLabel(w: NestWindow | undefined): string {
  return WINDOWS.find((o) => o.value === w)?.label ?? (typeof w === 'number' ? `${w} days` : 'Everything');
}

/** A <select> carries strings: 'all' is null, the rest are day counts. */
export function windowFromOption(raw: string): NestWindow {
  return raw === 'all' ? null : Number(raw);
}
export function windowOption(w: NestWindow): string {
  return w === null ? 'all' : String(w);
}

/** "30 · 14 · 7 · 90 days" — chats, sub-agent chats, tool output, artifacts. */
export function windowsShort(w: NestWindows): string {
  const days = [w.chats, w.subagents, w.toolOutput, w.artifacts].map((v) => (v === null ? 'all' : String(v)));
  return `${days.join(' · ')} days`;
}

/** The card's size words (mock round 4): "1.2 GB" from 1 GB up, else whole MB;
 *  under 1 MB whole KB (t-vb87lt: a small artifact store read "0 MB"). */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const gb = bytes / 1073741824;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`;
}

export function totalBytes(stats: NestStorageStats): number {
  return CLASSES.reduce((sum, c) => sum + (stats.classes[c.key] || 0), 0);
}

/** Only the classes whose chosen window differs from the stored one. */
export function dirtyWindows(stored: NestWindows, chosen: Partial<NestWindows>): Partial<NestWindows> {
  const out: Partial<NestWindows> = {};
  for (const k of Object.keys(chosen) as NestWindowClass[]) if (chosen[k] !== stored[k]) out[k] = chosen[k];
  return out;
}

/** The dirty foot: "1 change not applied. Chats: 30 days → 14 days." */
export function dirtySummary(stored: NestWindows, dirty: Partial<NestWindows>): string {
  const keys = Object.keys(dirty) as NestWindowClass[];
  if (!keys.length) return '';
  const first = CLASSES.find((c) => c.key === keys[0])!;
  const head = `${keys.length} change${keys.length === 1 ? '' : 's'} not applied.`;
  return `${head} ${first.label}: ${windowLabel(stored[keys[0]!])} → ${windowLabel(dirty[keys[0]!])}.`;
}

/** Reads the host's `nestStorageData` reply: `stats` is the engine's
 *  nest_storage result, `measuredAt` the host's clock. Anything malformed is absent. */
export function readStats(raw: unknown, measuredAt: unknown = 0): NestStorageStats | null {
  const r = raw as { classes?: Record<string, unknown>; journalEventsPerPart?: unknown } | null;
  if (!r || typeof r.classes !== 'object' || !r.classes) return null;
  const classes = {} as Record<NestClass, number>;
  for (const c of CLASSES) {
    const v = r.classes[c.key];
    classes[c.key] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  }
  const perPart = typeof r.journalEventsPerPart === 'number' && Number.isFinite(r.journalEventsPerPart) ? r.journalEventsPerPart : 0;
  return { classes, perPart, journalCompact: perPart <= 1, measuredAt: typeof measuredAt === 'number' ? measuredAt : 0 };
}

export function readWindows(raw: unknown): NestWindows | null {
  const w = (raw as { windows?: Record<string, unknown> } | null)?.windows;
  if (!w || typeof w !== 'object') return null;
  const pick = (k: NestWindowClass): NestWindow => (typeof w[k] === 'number' ? (w[k] as number) : null);
  return { chats: pick('chats'), subagents: pick('subagents'), toolOutput: pick('toolOutput'), artifacts: pick('artifacts') };
}

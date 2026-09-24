// storageSplit.ts — the pure formatting behind StorageCard.svelte, split out so
// it is testable with no DOM (the cacheRatio.ts precedent).

/** The engine's `storage_stats` answer. Mirrors `StorageRetention.Stats` in the
 *  engine; the card renders it and nothing more. */
export interface StorageStats {
  fileBytes: number;
  journalBytes: number;
  messageBytes: number;
  parts: { total: number; toolOutput: number; images: number; other: number };
  counts: { events: number; messages: number; parts: number; sessions: number };
  method: string;
  measuredMs: number;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Bytes as the card shows them. A negative or non-finite figure is a defect
 *  upstream, so it renders as an em dash rather than as a plausible "0 B". */
export function formatBytes(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${UNITS[unit]}`;
}

/** One line for a dry run or a completed prune. Says PARTS, not sessions or
 *  messages, because parts are the only thing a prune touches. */
export function pruneSummary(result: unknown): string {
  const value = (result ?? {}) as { parts?: unknown; bytes?: unknown; olderThanDays?: unknown };
  const parts = typeof value.parts === 'number' ? value.parts : 0;
  const days = typeof value.olderThanDays === 'number' ? value.olderThanDays : 0;
  if (parts === 0) return `Nothing to prune older than ${days} days.`;
  return `${parts} tool ${parts === 1 ? 'part' : 'parts'} older than ${days} days, ${formatBytes(value.bytes)} of payload.`;
}

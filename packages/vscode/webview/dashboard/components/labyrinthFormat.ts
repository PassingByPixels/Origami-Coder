// How a step's values PRINT on the map and in the inspector. Split out of
// labyrinthLayout.ts (which is at its architecture cap) so that file is purely
// geometry; these are re-exported from it, so no consumer's import changed.
//
// The rule every one of these keeps: an absent value renders as nothing, never
// as "undefined" and never as a fabricated 0 that would read as a measurement.

/** `undefined` in, `undefined` out — a missing duration must never print as 0. */
export function formatDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Local wall-clock HH:MM:SS. `undefined` for a step with no timestamp. */
export function formatClock(epochMs: number | undefined): string | undefined {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return undefined;
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** SVG has no text-overflow; long titles are clipped here instead. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** The marker's short caption: `read` reads better on a strip than a full title. */
export function stepCaption(step: { tool?: string; title: string }): string {
  return step.tool ? `${step.tool}` : step.title;
}

/**
 * The thread row's one-line label, truncated as a WHOLE to the column's budget.
 *
 * Truncating only the title (what this replaced) meant a long tool name — an
 * MCP id runs to 40+ characters — pushed the line clean past the viewBox, where
 * the SVG viewport cut it off mid-word with no ellipsis to say it had. The cap
 * has to cover the prefix, because the prefix is what overflows.
 */
export function threadLabel(step: { kind: string; tool?: string; title: string }, max: number): string {
  const head = step.tool ? `${step.kind}: ${step.tool}` : step.kind;
  return truncate(`${head} — ${step.title}`, max);
}

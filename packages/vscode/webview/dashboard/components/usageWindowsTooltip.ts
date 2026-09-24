// usageWindowsTooltip.ts — the Claude plan pill's hover tooltip: one line per
// reported window (5h/7d/30d…), not only the one the pill's own percentage
// came from. Extracted out of passthroughUsagePill.ts at that file's
// architecture cap. WEBVIEW-ONLY, no host mirror: the host side never renders
// a tooltip, so there is nothing on the other side to drift from (see
// src/claudeCode/usagePill.ts's comment by `rateLimitPillOf`, which mirrors
// only the WIRE shape, `PillWindow` below).

/** One reported window, as the tooltip wants it. Structurally compatible with
 *  `PillWindow` in src/claudeCode/usagePill.ts — the wire shape — without
 *  importing it (TS6059; see passthroughUsagePill.ts's header comment). */
export interface PillWindow {
  readonly label: string;
  readonly pct: number;
  readonly resetsAt: number;
}

/** `resetsAt` as words a tooltip line can end with: a time today, a weekday
 *  and time inside the next six days, or a bare date further out. Matches the
 *  three shapes an owner actually sees: "resets 19:00", "resets Mon 19:00",
 *  "resets 1 Oct". `0`/unreported reads as "resets unknown" — a lane can be
 *  reported with no future reset (a private-beta lane still at 0%), and that
 *  is a fact worth showing, not an error to hide.
 */
function resetWhen(resetsAtMs: number, now: number): string {
  if (!resetsAtMs) return 'unknown';
  const reset = new Date(resetsAtMs);
  const time = reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (reset.toDateString() === new Date(now).toDateString()) return time;
  const daysAhead = Math.floor((resetsAtMs - now) / 86_400_000);
  if (daysAhead >= 0 && daysAhead <= 6) return `${reset.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return reset.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * The pill's hover tooltip: one line per window, `"7d · 98% · resets Mon 19:00"`.
 * Every window is shown — not only the one the pill's own percentage came
 * from — so a 73% five-hour lane sitting next to a maxed-out monthly one
 * reads as two lines rather than one confident, misleading number.
 */
export function windowsTooltipText(windows: readonly PillWindow[], now: number): string {
  return windows.map((w) => `${w.label} · ${w.pct}% · resets ${resetWhen(w.resetsAt, now)}`).join('\n');
}

/** A `passthroughMeter`/`providerUsageData` `windows` payload, filtered to entries
 *  this build can actually type — an untyped or malformed entry (a stale client, a
 *  renamed field) is DROPPED rather than crashing the picker or being coerced into
 *  a wrong number. Shared by both message handlers in ModelPicker.svelte so the
 *  wire-safety rule lives once. */
export function parsePillWindows(v: unknown): PillWindow[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (w): w is PillWindow =>
      !!w && typeof w === 'object' && typeof (w as PillWindow).label === 'string'
      && typeof (w as PillWindow).pct === 'number' && typeof (w as PillWindow).resetsAt === 'number',
  );
}

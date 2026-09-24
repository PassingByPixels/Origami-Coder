// usagePill.ts — the plan-headroom readout for a passthrough cell: how much of the window is spent,
// and how long until it rolls over.
// Separate from sessionFacts.ts because the countdown text goes stale: the wire carries `resetsAt`
// and the percentage, and the text is built at render time against the caller's clock, on the same
// lazy-not-polled events the meter already re-renders for.
// The span ladder mirrors src/dashboard/providerUsage.ts `usageLine`, copied rather than imported
// (this module must stay free of disk for its jsdom test suite) and guarded by a drift test.

import type { ClaudeEvent } from './protocol';

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

export interface RateLimitPill {
  /** The raw CLI status ('allowed_warning', 'rejected'…). Kept rather than
   *  folded into the label because the transcript line fires once per CHANGE of
   *  it, and a percentage that ticks every turn is not a change worth a line. */
  status: string;
  /** The window this reading is about — "7d", "5h". NOT in the pill text any
   *  more (phase 2 gave that slot to the house usage wording); it rides the
   *  tooltip, which is where "which limit is this?" is answered. */
  window: string;
  /** Whole percent of the window spent, or -1 when the CLI did not say. */
  pct: number;
  /** Epoch MILLIseconds the window rolls over, or 0 when unreported. The CLI
   *  writes `resetsAt` in SECONDS; converted once, here, so nothing downstream
   *  has to remember which unit it is holding. */
  resetsAt: number;
  title: string;
  /** Every window this reading carries, `pct`/`window`/`resetsAt` included —
   *  the tooltip's source, so a plan with a 5h AND a 7d lane (and a monthly one
   *  where the account reports it) shows all of them, not only the tightest.
   *  A live `rate_limit_event` only ever names the ONE lane that fired, so this
   *  is a single-entry array there; the account-wide read (planUsageParse.ts)
   *  fills it with every lane the body reported a percentage for. */
  windows: readonly PillWindow[];
}

/** One lane, as the tooltip wants it — a subset of `RateLimitPill` without the
 *  fields that only make sense for the TOP lane (`status`, `title`). */
export interface PillWindow {
  readonly label: string;
  readonly pct: number;
  readonly resetsAt: number;
}

// NUMBER_WORD moved to planWindowLength.ts with the length reader that shares
// it, when this file reached its architecture cap.
import { NUMBER_WORD } from './planWindowLength';

/** `seven_day` → `7d`, `five_hour` → `5h`, `seven_day_opus` → `7d opus`.
 *  A type we cannot parse is shown as the CLI wrote it rather than dropped: an
 *  unnameable limit is still a limit, and silence would read as "no limit". */
export function windowLabel(rateLimitType: string): string {
  const parts = rateLimitType.split('_').filter(Boolean);
  const n = NUMBER_WORD[parts[0] ?? ''];
  const unit = parts[1] ?? '';
  if (!n || !unit) return rateLimitType.replace(/_/g, ' ');
  return [`${n}${unit[0]}`, ...parts.slice(2)].join(' ');
}

/**
 * The composer's pill text, built against the caller's clock. Empty when the CLI reported no
 *  percentage. The ladder (d+h, then h+m, then m) matches providerUsage.usageLine's, so a plan's
 *  headroom and an OAuth provider's quota read the same way. A reset already past reads "resetting
 *  now", never a negative countdown.
 */
export function usagePillText(pct: number, resetsAtMs: number, now: number): string {
  if (pct < 0) return '';
  const used = `${pct}% used`;
  if (!resetsAtMs) return used;
  const seconds = Math.round((resetsAtMs - now) / 1000);
  if (seconds <= 0) return `${used} · resetting now`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const span = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `${used} · resets in ${span}`;
}

/** A `rate_limit_event` → the pill, or null when there is nothing to say.
 *  `status: 'allowed'` is the ordinary state and earns no badge — a meter that
 *  is always on screen stops being read. */
export function rateLimitPillOf(ev: ClaudeEvent): RateLimitPill | null {
  if (ev.type !== 'rate_limit_event') return null;
  const info = (ev.rate_limit_info ?? {}) as Record<string, unknown>;
  const status = str(info.status);
  if (!status || status === 'allowed') return null;
  const win = windowLabel(str(info.rateLimitType));
  const pct = typeof info.utilization === 'number' ? Math.round(info.utilization * 100) : -1;
  const resetsAt = typeof info.resetsAt === 'number' && info.resetsAt > 0 ? info.resetsAt * 1000 : 0;
  const title = [
    `Claude subscription — ${pct >= 0 ? `${pct}% of ` : ''}your ${win} limit used (${status.replace(/_/g, ' ')}).`,
    'This chat runs on your plan, so there is no per-turn charge to show.',
    resetsAt ? `Resets ${new Date(resetsAt).toLocaleString()}.` : '',
  ].filter(Boolean).join(' ');
  // A `rate_limit_event` only ever names the ONE lane that fired — the CLI does
  // not send its other lanes alongside a warning — so this is a single entry,
  // never the full ladder planPillOf reads off the account-wide body.
  const windows = pct >= 0 ? [{ label: win, pct, resetsAt }] : [];
  return { status, window: win, pct, resetsAt, title, windows };
}

// The tooltip's per-window formatter (`windowsTooltipText`) lives ONLY in the
// webview mirror, passthroughUsagePill.ts: nothing on the host renders the
// tooltip, and duplicating a formatter neither side calls here would just be
// bytes against this file's architecture cap. `PillWindow` above is the one
// shape both sides need — the wire's shape — and that is what is mirrored.

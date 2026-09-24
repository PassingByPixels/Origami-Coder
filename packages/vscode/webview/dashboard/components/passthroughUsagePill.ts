// passthroughUsagePill.ts — the Claude plan's headroom, written the way this
// extension writes every other subscription readout.
//
// MIRRORED, not imported. `tsconfig.webview.json` pins rootDir to `webview/`,
// so a .ts leaf under here may not import from src/ AT ALL — not even
// `import type` (TS6059; the rule and its one exception for .svelte files are
// in docs/WORKING_ON_ORIGAMI_CODER.md Part 5). The host copy is
// src/claudeCode/usagePill.ts; claudeCodeUsagePill.test.ts reads BOTH files and
// fails on drift, which is the obligation the house pattern attaches to a
// mirror (permissionOptions.ts and collabKinds.ts are the same trade).
//
// WHY THE WEBVIEW FORMATS IT AT ALL. The host could send a finished sentence —
// it does exactly that for the OAuth providers (providerUsage.ts). It cannot
// here, because the two reads arrive on different schedules: an OAuth quota is
// pulled on demand when the picker opens, so its text is fresh by construction,
// while `rate_limit_event` is PUSHED once per turn and then goes quiet. A
// countdown formatted at push time would read "resets in 5h 12m" for as long as
// the chat sits idle. So the wire carries the two numbers and this recomputes.
//
// THERE IS NO TIMER. `usagePillText` is called from a `$derived` whose clock
// input is bumped on the events the picker already re-renders for — a meter
// post, a turn ending, the menu opening. A ticking countdown in a composer is
// motion the user did not ask for, and it would re-render every chat cell in
// grid mode once a second.

/**
 * `"92% used · resets in 3d 4h"`.
 *
 * `''` when the CLI reported no percentage — an empty slot is honest, and a
 * bare "resets in 3d" without the number it qualifies is not.
 *
 * The span ladder (d+h, then h+m, then m) is providerUsage.usageLine's,
 * verbatim, so a Claude plan and an OpenAI subscription read the same in the
 * same slot. A reset already past is "resetting now", never "resets in -3m".
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

// The multi-window tooltip (`windowsTooltipText`) lives in its own leaf,
// usageWindowsTooltip.ts — this file was at its architecture cap, and that
// formatter has no host counterpart to mirror (see usagePill.ts's comment by
// `rateLimitPillOf`), so it does not owe this file the mirror trade the
// function above does.

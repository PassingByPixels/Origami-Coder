// subagentTokens.ts — what a sub-agent's token spend LOOKS like on a 240px row.
//
// A MIRROR of src/acpTaskTokens.ts's shape, declared again because the webview
// cannot import extension-host code (tsconfig.webview pins rootDir), and read
// by the drift guard in __tests__/acpTaskMeta.test.ts so the two field lists
// cannot part company silently.
//
// Pure and DOM-free: the boundaries that bite (999 -> 1.0k, 99_950 -> 100k,
// a count of exactly 0) are checked without a render.

/** Mirror of src/acpTaskTokens.ts's `TaskTokens`. */
export interface SubagentTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** USD, as the engine reported it — never derived on this side. */
  cost?: number;
  /** t-ru1i84. USD the HOST derived from the provider catalogue's list price
   *  (src/dashboard/subagentCost.ts). A separate field from `cost`: one is a
   *  provider's measurement, the other is arithmetic, and the row says which. */
  costUsd?: number;
  /** Model calls behind the sums above. */
  steps?: number;
  /** The LAST step's context — not a sum. See `tokensTotalText`. */
  context?: number;
}

// TOKEN_LABELS and tokensTitle live in subagentTokensTitle.ts — extracted when the
// derived-cost field arrived and this file was at 99/100. Re-exported so every existing
// importer still reads them from here.
export { TOKEN_LABELS, tokensTitle } from './subagentTokensTitle';
import { costText } from './subagentTokensTitle';
export { costText };

/** `812` / `12.4k` / `1.2M`. Three characters of number at most, because this
 *  sits on a row that already carries a name, an age and three controls.
 *
 *  Rounds BEFORE choosing the unit: `99_990` rounds to `100.0k`, which must
 *  print as `100k` and not `100.0k`, and `999_999` must become `1.0M` rather
 *  than `1000.0k`. The one decimal is dropped whenever it is a zero. */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return String(Math.round(n));
  for (const [unit, div] of [['k', 1e3], ['M', 1e6], ['B', 1e9]] as const) {
    const scaled = Math.round((n / div) * 10) / 10;
    if (scaled < 1000 || div === 1e9) return `${trim(scaled)}${unit}`;
  }
  return '';
}

/** `12.4` stays, `100.0` becomes `100` — a trailing `.0` is a wasted column. */
function trim(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * The compact `in / out` the row prints, or '' for "say nothing". BLANK IS A
 * REAL ANSWER: with no rider there is no spend, and `0 / 0` would claim one, so
 * both halves must be present (a partial rider still shows in the TITLE).
 */
export function tokensText(t: SubagentTokens | undefined): string {
  if (!t || t.input === undefined || t.output === undefined) return '';
  return `${compactCount(t.input)} / ${compactCount(t.output)}`;
}

/**
 * `<sum> tokens · <n> steps · <last step> context` — the row's spend figure
 * (t-f9jxl1) in the ONE VOCABULARY it shares with the chat's context pill
 * (t-ffziaz): a child's 38k was a SUM over two steps, a chat's 19k was ONE
 * step's context, and the step count is what joins them.
 *
 * Same fail-open rule as `tokensText`. The trailing parts are dropped when
 * absent: an older engine reports neither, and `1 step` would be a claim. The
 * derived cost (t-ru1i84) is last and goes the same way — a model with no price in
 * the catalogue leaves the figure off rather than printing `$0.0000`.
 */
export function tokensTotalText(t: SubagentTokens | undefined): string {
  if (!t || t.input === undefined || t.output === undefined) return '';
  const parts = [`${compactCount(t.input + t.output)} tokens`];
  // The cost sits SECOND, not last. The drawer row is 240px and ellipsises: the figure
  // put at the end of `… · 14 steps · 61.2k context · $1.17` was the first thing clipped
  // off, which is the one number a reader opened the drawer for.
  const cost = costText(t.costUsd);
  if (cost) parts.push(cost);
  if (t.steps !== undefined && t.steps > 0) parts.push(`${t.steps} step${t.steps === 1 ? '' : 's'}`);
  if (t.context !== undefined && t.context > 0) parts.push(`${compactCount(t.context)} context`);
  return parts.join(' · ');
}


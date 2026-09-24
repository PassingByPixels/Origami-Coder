// The FULL breakdown a sub-agent's spend gets in a `title=`, and the field order it
// prints in. EXTRACTED from subagentTokens.ts (99/100) so the derived-cost field could
// land without the cap moving; subagentTokens.ts re-exports both names, so nothing that
// imports them had to change.
//
// This is the surface a reader goes to BECAUSE the compact figure rounded, so the counts
// here are exact and only the fields that actually arrived appear.

import type { SubagentTokens } from './subagentTokens';

/** The fields, in breakdown order, with the words the title uses. The
 *  KEYS are the mirrored half; the labels are this side's own. */
export const TOKEN_LABELS: ReadonlyArray<readonly [keyof SubagentTokens, string]> = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['reasoning', 'Reasoning'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
  ['cost', 'Cost'],
  // Named "Est. cost", never "Cost": it is this side's arithmetic over the catalogue's
  // list price, not a bill. Both can appear — they are different claims.
  ['costUsd', 'Est. cost'],
  ['steps', 'Steps'],
  ['context', 'Last step context'], // the tooltip has room to say which context
];

/** `$0.0123` under a dollar, `$1.23` over it: four decimals are what a child's spend
 *  actually looks like, and carrying them past $1 reads as false precision. */
export function costText(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return '';
  return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`;
}

/** The full breakdown, for the row's `title=`. Only the fields that actually
 *  arrived, exact counts, and '' when nothing did. */
export function tokensTitle(t: SubagentTokens | undefined): string {
  if (!t) return '';
  const parts: string[] = [];
  for (const [key, label] of TOKEN_LABELS) {
    const value = t[key];
    if (value === undefined) continue;
    if (key === 'cost') parts.push(`${label} $${value.toFixed(4)}`);
    else if (key === 'costUsd') parts.push(`${label} ${costText(value)}`);
    else parts.push(`${label} ${value.toLocaleString('en-US')}`);
  }
  return parts.join(' · ');
}

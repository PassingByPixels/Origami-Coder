// money.ts — how a dollar figure is written in the composer.
//
// Lifted out of InputBar.svelte when the cost badge became its own component
// (SpendBadge.svelte) but the monthly-cap banner stayed behind: two callers, so
// the formatter belongs to neither. Sub-dollar amounts get four decimals
// because a single turn is routinely worth less than a cent, and "$0.00" for
// three different turns is the same as showing nothing.

export function fmtUsd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

// The exported atlas's HEADER STRIP — what the run cost, in the Flock idiom.
//
// Every number here comes from `usageBreakdown`, the SAME pure module the live
// pane's LabyrinthUsageStrip.svelte reads, so the artifact and the pane cannot
// disagree about a run's spend. Its honesty rules ride along unchanged:
//
//  - a step whose message recorded no usage contributes NOTHING, never a 0;
//  - a sum that is provably short is printed with a leading `≥` and says why,
//    off the one `approximate` flag rather than a second judgement of its own;
//  - a category the run never recorded gets no cell at all, so an absent
//    measurement can never read as a measured zero.
//
// Nothing in here is run content — the values are numbers and the caveats are
// this module's own sentences — so there is no escaping to do. The one place
// run content could reach a strip (a branch title) is deliberately not shown:
// the per-branch breakdown lives in the ledger drawer, not the header.
//
// Colours are `var(--og-*)` only; the export's resolver concretes them.

import { formatDuration } from './labyrinthFormat';
import { formatCost, formatTokenCount, usageBreakdown, type UsageStep, type UsageTotal } from './labyrinthUsage';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The usage bag plus the two clocks the wall-time cell needs. `HtmlStep` fits. */
export type StripStep = UsageStep & { startedAt?: number; endedAt?: number };

/** Wall clock across the run, or nothing when its clock cannot carry the claim. */
export function runWall(steps: readonly { startedAt?: number; endedAt?: number }[]): string | undefined {
  const starts = steps.map((s) => s.startedAt).filter(num);
  if (starts.length < 2) return undefined;
  const ends = steps.map((s) => s.endedAt ?? s.startedAt).filter(num);
  const span = Math.max(...ends) - Math.min(...starts);
  return span > 0 ? formatDuration(span) : undefined;
}

/** One headline cell; `unit` is the quiet suffix beside the number. */
function cell(label: string, value: string, unit = '', cls = ''): string {
  const small = unit ? `<small>${unit}</small>` : '';
  return `<div class="cell ${cls}"><span class="l">${label}</span><span class="v">${value}${small}</span></div>`;
}

/**
 * The proportion bar — one segment per category the run actually recorded.
 * Label and colour travel WITH the value: a category filtered out for being
 * zero must not shift the next one's legend onto the wrong swatch.
 */
function bar(total: UsageTotal): string {
  const parts: Array<[label: string, cssVar: string, value: number]> = [
    ['prefill', '--og-chat', total.input ?? 0],
    ['reasoning', '--og-accent-2', total.reasoning ?? 0],
    ['output', '--og-success', total.output ?? 0],
    ['cache read', '--og-text-muted', total.cacheRead ?? 0],
  ];
  const shown = parts.filter(([, , v]) => v > 0);
  const sum = shown.reduce((n, [, , v]) => n + v, 0);
  if (sum <= 0) return '';
  const segs = shown
    .map(([, v, n]) => `<i style="background:var(${v});width:${((n / sum) * 100).toFixed(3)}%"></i>`)
    .join('');
  const legend = shown
    .map(([label, v, n]) =>
      `<span><span class="sw" style="background:var(${v})"></span>${label} ${n.toLocaleString()}</span>`)
    .join('');
  return `<div class="cell bars"><div class="bar">${segs}</div><div class="barleg">${legend}</div></div>`;
}

/**
 * The whole strip, or '' when the run recorded nothing AND nothing is known to
 * be missing — an empty strip claiming "0 tokens" would be a measurement that
 * was never taken.
 */
export function usageStrip(steps: readonly StripStep[], truncated: boolean): string {
  const spend = usageBreakdown(steps, { truncated });
  const run = spend.run;
  if (run.counted === 0 && !run.approximate) return '';

  const headline = formatTokenCount(run.tokens);
  const cost = formatCost(run.cost);
  const wall = runWall(steps);
  const cells = [
    headline ? cell('Run total', `${run.approximate ? '≥' : ''}${headline}`, 'tok', 'total') : '',
    num(run.input) ? cell('Prefill', formatTokenCount(run.input)!, 'in') : '',
    num(run.output) ? cell('Output', formatTokenCount(run.output)!, 'out') : '',
    num(run.reasoning) ? cell('Reasoning', run.reasoning.toLocaleString()) : '',
    num(run.cacheRead) ? cell('Cache read', run.cacheRead.toLocaleString()) : '',
    cost ? cell('Cost', cost) : '',
    wall ? cell('Wall', wall) : '',
    cell('Steps', steps.length.toLocaleString(), `/ ${run.counted.toLocaleString()} measured`),
    bar(run),
  ].join('');

  // ONE flag drives both the `≥` above and this line — two sources for one
  // truth is how a headline ends up confident while the caveat says otherwise.
  const floor = run.approximate
    ? `<div class="floor">≥ Approximate — a floor, not the run's real spend`
      + `${spend.caveats.length ? `: ${spend.caveats.join('; ')}` : ''}.</div>`
    : '';
  return `<div class="strip">${cells}</div>${floor}`;
}

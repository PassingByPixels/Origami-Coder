<script lang="ts">
  // WHAT THE RUN REALLY COST, as a two-row table.
  //
  // The raw token total is the number least like the bill: a cache read bills
  // at a tenth of a fresh input token, so a run that was 81% cached charges for
  // a fifth of what the raw figure says. So the top row carries the three
  // figures that MEAN something together — raw, the hit rate that discounts it,
  // and the INPUT EQUIVALENTS (`input + 0.1 x cache_read`) it discounts to —
  // read left to right as a sentence, with `real` last and strongest because it
  // is the one the reader takes away.
  //
  // The row under it is the raw components those three were computed from. Both
  // rows are VALUE THEN LABEL, on one column rhythm, tabular figures, quiet
  // rules between the cells (owner's UAT): a table, not a row of pills. The
  // cells no longer stack label-over-value — that layout aligned the labels and
  // left the numbers, which are the thing being compared, ragged.
  //
  // ONE EXCEPTION to the module's absent-vs-zero rule, and it is deliberate: a
  // reasoning count of 0 takes no cell. Every provider that does not report
  // reasoning separately sends it as 0 on every turn, so the cell was nearly
  // always a zero that meant "not applicable" rather than "measured none". The
  // other four keep the rule — a measured 0 is a fact and is printed — and the
  // inspector still shows a step's own reasoning count either way.
  //
  // Extracted from LabyrinthUsageStrip.svelte at its architecture cap.
  // Colours are theme vars ONLY.
  import { formatCost, formatTokenCount, type UsageTotal } from './labyrinthUsage';
  import { cacheHitRatio, formatPercent, inputEquivalents, type Indicative } from './labyrinthCost';

  let { run, quote }: { run: UsageTotal; quote: Indicative | undefined } = $props();

  let real = $derived(formatTokenCount(inputEquivalents(run)));
  let raw = $derived(formatTokenCount(run.tokens));
  let cached = $derived(formatPercent(cacheHitRatio(run)));
  let runCost = $derived(formatCost(run.cost));
  /** Absent components are OMITTED, never zeroed — a 0 reads as a measurement.
   *  Reasoning is the one count whose 0 is dropped as well; see above. */
  let raws = $derived(
    ([['in', run.input], ['out', run.output], ['reasoning', run.reasoning || undefined],
      ['cache read', run.cacheRead], ['cache write', run.cacheWrite]] as Array<[string, number | undefined]>)
      .filter(([, n]) => n !== undefined) as Array<[string, number]>,
  );
</script>

<div class="spend-head">
  <span class="spend-label">Run spend</span>
  {#if raw}<span class="spend-raw">{raw} raw</span>{/if}
  {#if cached}<span class="spend-raw">{cached} cached</span>{/if}
  {#if real}
    <span class="spend-total" class:approx={run.approximate}>{run.approximate ? '≥' : ''}{real} real</span>
  {/if}
  {#if !real && !raw}<span class="spend-none">no usage recorded</span>{/if}
  {#if runCost}<span class="spend-cost">{runCost}</span>{/if}
  <!-- The user's OWN prices, so it is labelled an estimate and never a bill.
       `priced < models` means a model that ran has no price, so it is a floor. -->
  {#if quote}
    <span class="spend-quote" title="From the prices you entered — not a bill"
      >{quote.priced < quote.models ? '≥' : '~'}{formatCost(quote.amount)} indicative</span>
  {/if}
</div>

{#if raws.length > 0}
  <div class="spend-parts">
    {#each raws as [label, n] (label)}
      <span class="raw-cell"><span class="raw-v">{n.toLocaleString()}</span> <span class="raw-l">{label}</span></span>
    {/each}
  </div>
{/if}

<style>
  /* One rhythm for both rows: equal min-width and equal padding, so the cells
     of the second row land under the cells of the first wherever the counts
     allow it. They do not always — the rows carry three figures and four or
     five — and no attempt is made to fake the alignment where they cannot. */
  .spend-head, .spend-parts { display: flex; align-items: baseline; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
  .spend-head > *, .spend-parts > * { min-width: 94px; padding: 1px 9px; border-left: 1px solid var(--og-border); }
  .spend-head > :first-child, .spend-parts > :first-child { padding-left: 0; border-left: none; }
  .spend-parts { margin-top: 3px; }
  .spend-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); }
  /* The figure the reader takes away, so it is the one that carries weight. */
  .spend-total { font-size: 12px; font-weight: 600; color: var(--og-text); }
  .spend-total.approx { color: var(--og-warning); }
  .spend-raw { font-size: 11px; color: var(--og-text-muted); }
  .spend-cost { font-size: 11px; color: var(--og-text-secondary); }
  .spend-quote { font-size: 11px; color: var(--og-accent-2); }
  .spend-none { font-size: 11px; font-style: italic; color: var(--og-text-muted); }
  .raw-cell { font-size: 11px; color: var(--og-text-secondary); white-space: nowrap; }
  .raw-l { text-transform: uppercase; letter-spacing: 0.05em; font-size: 9px; color: var(--og-text-muted); }
</style>

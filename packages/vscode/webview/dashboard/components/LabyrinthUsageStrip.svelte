<script lang="ts">
  // WHAT THE RUN SPENT — one bounded strip above the map, never on it. Thread's
  // geometry is not touched by any of this (asserted byte-for-byte in
  // labyrinthPane.test.ts) and corridor's density is untouched, because the
  // strip lives outside the canvas and scrolls within its own max-height.
  //
  // Every number here comes from usageBreakdown, which sums only what the
  // engine recorded. A run that recorded nothing renders NOTHING — an empty
  // strip claiming "0 tokens" would be a measurement we never took.
  //
  // ONE GRANULARITY IN THE CHIP ROW. The row used to print `main` — the TRUNK's
  // rollup — as a flat sibling of the per-agent buckets, which are a SECOND
  // complete partition of the same steps. Read as a total the row therefore
  // double counted the whole run (on a real run `main` == `build` + `compaction`
  // exactly). The row is now the agent buckets alone, which sum to the headline;
  // the delegated cut is drawn below it as an explicit "of which", never as an
  // addend. Overlapping rollups must never be flat siblings.
  //
  // The headline itself is LabyrinthSpendHeadline.svelte and the models row is
  // LabyrinthSpendModels.svelte — both extracted at this file's cap.
  import { usageBreakdown, formatTokenCount, type UsageStep, type UsageTotal } from './labyrinthUsage';
  import { indicativeCost, modelsUsed, type PriceTable } from './labyrinthCost';
  import type { HighlightTarget } from './labyrinthHighlight';
  import LabyrinthSpendHeadline from './LabyrinthSpendHeadline.svelte';
  import LabyrinthSpendModels from './LabyrinthSpendModels.svelte';

  let {
    steps, truncated = false, prices = {}, onOpenSession, onHighlight,
  }: {
    steps: readonly UsageStep[];
    truncated?: boolean;
    prices?: PriceTable;
    /** Open a DELEGATED run in its own right. Absent = the chips stay static. */
    onOpenSession?: (sessionId: string) => void;
    /** Point at the part of the map a chip is about; null when the pointer
     *  leaves it. Absent = the chips highlight nothing. */
    onHighlight?: (target: HighlightTarget | null) => void;
  } = $props();

  /** Hover AND focus, so a chip reached by keyboard lights what a pointer does. */
  const over = (target: HighlightTarget) => ({
    onmouseenter: () => onHighlight?.(target), onmouseleave: () => onHighlight?.(null),
    onfocus: () => onHighlight?.(target), onblur: () => onHighlight?.(null),
  });

  let spend = $derived(usageBreakdown(steps, { truncated }));
  // Nothing recorded and nothing known to be missing: there is genuinely
  // nothing to say, so the strip does not appear at all.
  let shown = $derived(spend.run.counted > 0 || spend.run.approximate);
  let models = $derived(modelsUsed(steps));
  let quote = $derived(indicativeCost(models, prices));

  /** A bucket's chip text, or nothing at all when it recorded no tokens. */
  function chip(total: UsageTotal): string | undefined {
    const n = formatTokenCount(total.tokens);
    if (!n) return undefined;
    return total.approximate ? `≥${n}` : n;
  }
  /** The child session a delegated chip opens, when the spawn named one. */
  const childOf = (first: number): string | undefined => steps[first]?.childSessionId;
</script>

{#if shown}
  <div class="lab-spend">
    <LabyrinthSpendHeadline run={spend.run} {quote} />

    <div class="spend-rows">
      {#each spend.agents as a (a.agent)}
        {#if chip(a.total)}
          <span class="spend-chip" title="Everything this agent spent across the run — hover to see where on the map" {...over({ kind: 'agent', agent: a.agent })}>
            {a.agent} <b>{chip(a.total)}</b>
          </span>
        {/if}
      {/each}
    </div>

    <!-- A SUBSET of the row above, not an addition to it: these steps are
         already inside their agent's bucket. The wording is what stops the two
         rows being read as one sum. -->
    {#if spend.branches.some((b) => chip(b.total))}
      <div class="spend-rows">
        <span class="spend-of">of which delegated</span>
        {#each spend.branches as b (b.first)}
          {#if chip(b.total)}
            {#if onOpenSession && childOf(b.first)}
              <button class="spend-chip branch open" title={`Open this delegated run: ${b.title}`} {...over({ kind: 'branch', first: b.first })}
                onclick={() => onOpenSession?.(childOf(b.first)!)}>⤷ {b.title} <b>{chip(b.total)}</b></button>
            {:else}
              <span class="spend-chip branch" title={`Delegated: ${b.title}`} {...over({ kind: 'branch', first: b.first })}>⤷ {b.title} <b>{chip(b.total)}</b></span>
            {/if}
          {/if}
        {/each}
      </div>
    {/if}

    <LabyrinthSpendModels {steps} {models} />

    <!-- ONE flag drives both the ≥ above and this line. Two sources for one
         truth is how a headline ends up confident while the caveat says
         otherwise. -->
    {#if spend.run.approximate}
      <div class="spend-warn">
        APPROXIMATE — this is a floor, not the run's real spend{spend.caveats.length ? `: ${spend.caveats.join('; ')}` : ''}.
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Bounded and scrollable: 25 delegated branches must not push the map off
     the panel. The strip owns its own overflow, the canvas keeps its space. */
  .lab-spend { margin: 10px 12px 0; padding: 7px 10px; border: 1px solid var(--og-border); border-radius: 4px; background: var(--og-surface); flex-shrink: 0; max-height: 132px; overflow-y: auto; }
  .spend-rows { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; margin-top: 5px; }
  .spend-of { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-muted); }
  .spend-chip { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--og-btn-bg); color: var(--og-text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; border: 1px solid transparent; font-family: inherit; }
  .spend-chip b { color: var(--og-text); font-weight: 600; }
  .spend-chip.branch { color: var(--og-text-muted); }
  /* A chip that OPENS something says so before it is clicked — the pointer and
     a hover border, never colour alone. */
  .spend-chip.open { cursor: pointer; }
  .spend-chip.open:hover { border-color: var(--og-accent); color: var(--og-text); }
  .spend-warn { margin-top: 5px; font-size: 10px; line-height: 1.45; color: var(--og-warning); }
</style>

<script lang="ts">
  // The two cards above the chart: the run's USER PROMPTS on the left, and what
  // the run DID — a count and a bar per tool category — on the right.
  //
  // THE GRID STRETCHES, and that is the owner's second caveat made structural.
  // In the mock the two cards were `align-items: start`, so the shorter prompt
  // card left a block of dead surface under it whenever the run had few turns
  // and many steps. Here the row stretches (the CSS default, restored by simply
  // not overriding it), each card is a flex column, and the prompt LIST is the
  // element that grows — scrolling inside its own card once the turns outrun the
  // height rather than pushing the card past its neighbour.
  //
  // jsdom has no layout engine, so the absence of that gap is an EYEBALL check
  // on a real browser render; what a test can hold is that the list is the
  // growing element and that the bars are proportional, which is what the
  // fixtures below assert.
  // Colours are theme vars ONLY.
  import { categoryVar, type Category } from './labyrinthCategory';
  import { formatClock } from './labyrinthFormat';
  import type { CompactionFacts } from './labyrinthLanes';
  import { formatTokenCount } from './labyrinthUsage';

  export interface PromptCard { ordinal: number; title: string; when?: string }
  /** A projected `compaction` step — the run event that emptied the cache. */
  export interface CompactionCard { ordinal: number; startedAt?: number; compaction?: CompactionFacts }

  let {
    prompts, categories, headline, subhead, onSelect, onHover, hovered = null, compactions = [],
  }: {
    prompts: readonly PromptCard[];
    /** Every compaction the run recorded. Empty = the run never compacted. */
    compactions?: readonly CompactionCard[];
    categories: readonly { category: Category; count: number }[];
    /** The big number — steps drawn. */
    headline: string;
    /** What that number is, plus failures and span. */
    subhead: string;
    onSelect: (ordinal: number) => void;
    /** The category the pointer is on; null on leave. Absent = the bars are inert. */
    onHover?: (category: Category | null) => void;
    hovered?: Category | null;
  } = $props();

  // The widest bar is the busiest category, so the row that dominates the run
  // reads as full. Proportional to the MAX, never to the total: shares of a
  // total collapse into invisible slivers the moment one category dominates.
  // A BANNER, never a category bar: a compaction is an EVENT, not work. Its
  // numbers print only when ONE compaction ran (with two, "it" is ambiguous)
  // and only when the run recorded them — an absent one renders nothing.
  let when = $derived(compactions.map((c) => formatClock(c.startedAt)).filter(Boolean).join(', '));
  let facts = $derived(compactions.length === 1 ? compactions[0]!.compaction : undefined);

  let max = $derived(categories.reduce((n, c) => Math.max(n, c.count), 0));
  const pct = (count: number): number => (max > 0 ? (count / max) * 100 : 0);
  const over = (category: Category) => (onHover
    ? {
      onmouseenter: () => onHover(category), onmouseleave: () => onHover(null),
      onfocus: () => onHover(category), onblur: () => onHover(null),
    }
    : {});
</script>

<div class="fl-grid">
  <section class="fl-panel">
    <div class="fl-panel-head">User prompts — {prompts.length} {prompts.length === 1 ? 'turn' : 'turns'}</div>
    <!-- The GROWING element. Its card is the same height as the one beside it,
         and the overflow is spent here rather than left as dead space. -->
    <div class="fl-prompts">
      {#each prompts as p (p.ordinal)}
        <button class="fl-prompt" onclick={() => onSelect(p.ordinal)} title={p.title}>
          <span class="fl-prompt-text">{p.title}</span>
          {#if p.when}<span class="fl-prompt-when">{p.when}</span>{/if}
        </button>
      {:else}
        <div class="fl-none">This run recorded no user prompt.</div>
      {/each}
    </div>
  </section>

  <section class="fl-panel">
    <div class="fl-panel-head">Step activity</div>
    <div class="fl-big">{headline}</div>
    <div class="fl-big-cap">{subhead}</div>
    {#if compactions.length}
      <div class="fl-compacted" title="A compaction rewrites the context, so the prefill after it is billed fresh.">Context compacted {compactions.length === 1 ? 'once' : `${compactions.length} times`}{when ? ` at ${when}` : ''}{formatTokenCount(facts?.contextBefore) ? ` · ${formatTokenCount(facts?.contextBefore)} of context before it` : ''}{formatTokenCount(facts?.summaryTokens) ? ` · ${formatTokenCount(facts?.summaryTokens)} summary` : ''}</div>
    {/if}
    <div class="fl-bars">
      {#each categories as c (c.category)}
        <div class="fl-bar-row" class:dim={hovered !== null && hovered !== c.category} {...over(c.category)}>
          <span class="fl-bar-name">{c.category}</span>
          <!-- display:block on the fill is load-bearing: width does not apply to
               an inline span, and without it the track renders empty. -->
          <span class="fl-bar-track"><span class="fl-bar-fill" data-category={c.category}
            style="width: {pct(c.count)}%; background: {categoryVar(c.category)};"></span></span>
          <span class="fl-bar-count">{c.count}</span>
        </div>
      {/each}
    </div>
  </section>
</div>

<style>
  /* No align-items: the default STRETCH is the fix — see the header. */
  .fl-grid { flex: 0 0 auto; display: grid; grid-template-columns: minmax(200px, 28%) 1fr; gap: 14px; }
  .fl-panel { display: flex; flex-direction: column; min-height: 0; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 10px 12px; }
  .fl-panel-head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; margin-bottom: 8px; }
  .fl-prompts { flex: 1; min-height: 0; max-height: 220px; overflow-y: auto; }
  .fl-prompt { display: block; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--og-border); padding: 6px 0; cursor: pointer; font-family: inherit; color: var(--og-text); }
  .fl-prompt:last-of-type { border-bottom: none; }
  .fl-prompt:hover .fl-prompt-text { color: var(--og-chat); }
  .fl-prompt-text { display: block; font-size: 11.5px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; }
  .fl-prompt-when { display: block; font-size: 10px; color: var(--og-text-muted); margin-top: 3px; font-variant-numeric: tabular-nums; }
  .fl-none { font-size: 11px; font-style: italic; color: var(--og-text-muted); }
  .fl-big { font-size: 26px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  .fl-big-cap { font-size: 11px; color: var(--og-text-secondary); margin-top: 4px; }
  .fl-compacted { margin-top: 8px; font-size: 10.5px; line-height: 1.4; color: var(--og-accent); border-left: 2px solid var(--og-accent); padding-left: 7px; }
  .fl-bars { margin-top: 12px; display: flex; flex-direction: column; gap: 7px; }
  .fl-bar-row { display: grid; grid-template-columns: 100px 1fr 30px; align-items: center; gap: 8px; font-size: 11px; }
  /* Same answer as the chart's own: fade what the hover is NOT about. */
  .fl-bar-row.dim { opacity: 0.35; }
  .fl-bar-name { color: var(--og-text-secondary); }
  .fl-bar-track { display: block; height: 7px; background: var(--og-surface-alt); border-radius: 3px; overflow: hidden; }
  .fl-bar-fill { display: block; height: 100%; border-radius: 3px; }
  .fl-bar-count { text-align: right; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
</style>

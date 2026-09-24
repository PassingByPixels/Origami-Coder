<script lang="ts">
  // The context gauge's hover card. The gauge itself is untouched — same ring,
  // same %, same click-to-compact; this only replaces the long `title`
  // paragraph, and only when the engine actually sent a composition.
  //
  // Its own component rather than more markup in InputBar.svelte: the composer
  // is at 1114 of its 1230 cap and a card is a card, not composer state.
  import { breakdownRows, fmtTokens, usedOf, type ContextComposition } from './contextComposition';
  import { TREND_H, TREND_W, trendPoints } from './contextTrendLine';

  let { composition, contextWindow = 0, trend = undefined }:
    { composition: ContextComposition; contextWindow?: number; trend?: readonly number[] } = $props();

  let used = $derived(usedOf(composition));
  // t-ru1i84. '' against a host that sends no series, and the {#if} below then draws no
  // sparkline at all — an empty 18px box would read as a flat, idle conversation.
  let spark = $derived(trendPoints(trend));
  let rows = $derived(breakdownRows(composition, contextWindow));
</script>

<!-- aria-hidden: the gauge keeps a `title` for assistive tech on the no-composition
     path, and on this path its aria-label carries the same total in words. This is
     the picture of it. -->
<div class="ctx-card" aria-hidden="true">
  <div class="ctx-card-head">
    <span class="ctx-card-title">Context</span>
    <span class="ctx-card-total">{fmtTokens(used)}{contextWindow > 0 ? ` / ${fmtTokens(contextWindow)}` : ''}</span>
  </div>
  {#if spark}
    <svg class="ctx-card-spark" viewBox="0 0 {TREND_W} {TREND_H}" preserveAspectRatio="none" role="presentation">
      <polyline class="ctx-card-sparkline" points={spark} />
    </svg>
  {/if}
  <div class="ctx-card-bar">
    {#each rows as row (row.id)}
      <span class="ctx-card-seg is-{row.kind}" style="width: {row.pct}%"></span>
    {/each}
  </div>
  {#each rows as row (row.id)}
    <div class="ctx-card-row" class:is-headroom={row.kind === 'headroom'}>
      <span class="ctx-card-dot is-{row.kind}"></span>
      <span class="ctx-card-label">{row.label}</span>
      <span class="ctx-card-value">{fmtTokens(row.tokens)}</span>
    </div>
  {/each}
  <!-- Never dropped: the provider reports the total alone, so the split is the
       engine's own attribution and must say so where the numbers are read. -->
  <div class="ctx-card-note">Estimated split of the last step</div>
</div>

<style>
  .ctx-card {
    width: 232px;
    text-align: left;
    padding: 9px 11px;
    border-radius: 7px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    color: var(--og-text);
    font: 11px/1.3 system-ui, sans-serif;
  }
  .ctx-card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .ctx-card-title { font-size: 12px; font-weight: 700; color: var(--og-text); }
  .ctx-card-total { font-variant-numeric: tabular-nums; color: var(--og-accent-2); }
  /* Where the conversation is heading, over the card's full width, above the bar that
     says where it stands. No axis and no labels: the shape is the whole message. */
  .ctx-card-spark { display: block; width: 100%; height: 18px; margin-bottom: 4px; }
  .ctx-card-sparkline { fill: none; stroke: var(--og-chat); stroke-width: 1.25; stroke-linejoin: round; stroke-linecap: round; }
  /* One track, one segment per part, each as wide as its share of the window. */
  .ctx-card-bar {
    display: flex;
    height: 6px;
    margin-bottom: 9px;
    border-radius: 3px;
    overflow: hidden;
    background: var(--og-btn-hover);
  }
  .ctx-card-seg { height: 100%; }
  .ctx-card-seg.is-overhead, .ctx-card-dot.is-overhead { background: var(--og-text-muted); }
  .ctx-card-seg.is-content, .ctx-card-dot.is-content { background: var(--og-chat); }
  .ctx-card-seg.is-headroom, .ctx-card-dot.is-headroom { background: var(--og-border); }
  .ctx-card-row { display: flex; align-items: center; gap: 7px; padding: 2px 0; }
  .ctx-card-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; }
  .ctx-card-label { flex: 1 1 auto; color: var(--og-text-secondary); }
  .ctx-card-value { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--og-text); }
  .ctx-card-row.is-headroom .ctx-card-label,
  .ctx-card-row.is-headroom .ctx-card-value { color: var(--og-text-muted); }
  .ctx-card-note { margin-top: 7px; color: var(--og-text-muted); font-size: 10px; }
</style>

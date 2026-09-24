<script lang="ts">
  // t-qlgav5 — the dock's whole-item window, arrows and every item's own
  // markup. EXTRACTED from SidebarDock.svelte (which sat at its 235-line cap
  // before this ticket): the paging state, the measure/resize wiring and the
  // per-item button are all ONE seam — Svelte scopes a component's CSS to
  // the file that writes its own markup, so `.dock-track` / `.dock-arrow` /
  // `.dock-item` / `.dock-badge` moved here with it. SidebarDock.svelte keeps
  // the pill (still the History popup's anchor), the toggle state and the
  // message wire.
  //
  // Windowed rather than scrolled: dock items are fixed at 26px (t-qhzy4k;
  // unlike a connection tile they never stretch), so there is nothing for a
  // scroll-snap track to solve — sidebarDockFit.ts's arithmetic alone decides
  // how many show and where the window starts.
  import { tip } from '../shared/WarmTooltip.svelte';
  import { type DockItem, type DockKey } from './sidebarDockItems';
  import { dockFit, dockPageStart, type DockFit } from './sidebarDockFit';

  interface Props {
    /** The pill SidebarDock.svelte renders around this — its measured width
     *  is the whole fit calculation's input. */
    pillEl: HTMLElement | undefined;
    items: DockItem[];
    on: Record<DockKey, boolean>;
    frontDeskCount: number;
    /** Unopened artifact arrivals (t-rz4555) — the dock's second badge. */
    artifactsCount?: number;
    onActivate: (key: DockKey) => void;
  }
  let { pillEl, items, on, frontDeskCount, artifactsCount = 0, onActivate }: Props = $props();
  /** One badge rule for two counters, so a third never grows an {#if} chain. */
  const badge = (key: DockKey): number =>
    key === 'frontdesk' ? frontDeskCount : key === 'artifacts' ? artifactsCount : 0;

  // 0, not items.length: the mount-time $effect below corrects it before
  // paint (same shape as ConnectionCarousel.svelte's fitTiles(0) initial —
  // a state initializer must not read a PROP, or Svelte warns it captured
  // only that prop's value at mount).
  let fit = $state<DockFit>({ count: 0, arrows: false });
  // Raw, unclamped — only `page()` writes it, from a click handler, never
  // from the measure effect below. An effect that both reads and writes the
  // SAME state is exactly the loop Svelte's own effect guard exists to catch
  // (hit it here first): a resize shrinking `fit.count` is instead handled
  // by clamping a DERIVED start, so nothing needs writing back.
  let pageStart = $state(0);
  const clampedStart = $derived(Math.max(0, Math.min(pageStart, items.length - fit.count)));
  const visibleItems = $derived(items.slice(clampedStart, clampedStart + fit.count));

  function measure(): void {
    if (!pillEl) return;
    fit = dockFit(pillEl.clientWidth, items.length);
  }
  // Re-measure whenever the pill exists or the item count changes; a resize
  // does the rest (see the svelte:window below).
  $effect(() => { void pillEl; void items.length; measure(); });

  function page(dir: number): void {
    pageStart = dockPageStart(clampedStart, dir, items.length, fit.count);
  }
</script>

<svelte:window onresize={measure} />

{#if fit.arrows}
  <button class="dock-arrow" type="button" aria-label="Previous dock items" disabled={clampedStart === 0} onclick={() => page(-1)}>&lsaquo;</button>
{/if}
<div class="dock-track">
  {#each visibleItems as item (item.key)}
    <button
      class="dock-item"
      class:is-on={on[item.key]}
      type="button"
      aria-label={item.label}
      aria-pressed={item.toggle ? on[item.key] : undefined}
      use:tip={item.label}
      onclick={() => onActivate(item.key)}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {#each item.paths as d}<path {d} />{/each}
      </svg>
      {#if badge(item.key) > 0}
        <span class="dock-badge" aria-label={`${badge(item.key)} waiting`}>{badge(item.key)}</span>
      {/if}
    </button>
  {/each}
</div>
{#if fit.arrows}
  <button class="dock-arrow" type="button" aria-label="Next dock items" disabled={clampedStart + fit.count >= items.length} onclick={() => page(1)}>&rsaquo;</button>
{/if}

<style>
  /* space-between so a full, arrow-less row still spans the pill exactly as
     it always has; when arrows claim their own width the same rule just
     spreads a smaller window across what is left. */
  .dock-track {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    flex: 1 1 auto;
    min-width: 0;
  }
  /* Same look as .conn-arrow (ConnectionCarousel.svelte) — one paging idiom
     for both carousels in this panel. */
  .dock-arrow {
    flex: 0 0 auto;
    width: 20px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    font-family: inherit;
  }
  .dock-arrow:hover:not(:disabled) { background: var(--og-btn-hover); color: var(--og-text); }
  .dock-arrow:disabled { opacity: 0.4; cursor: default; }
  /* 26px, not 30 (t-qhzy4k): the `.chat-action` buttons this row replaced were
     25px and the connection squares beside it are 26 — the sidebar's own scale. */
  .dock-item {
    position: relative;
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: var(--og-text-secondary);
    cursor: pointer;
    font-family: inherit;
    transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), background 160ms ease,
      color 160ms ease, border-color 160ms ease;
  }
  /* The hover pop stays INSIDE the pill (t-qhzy4k). The old lift
     (translateY(-2px) + scale(1.08)) left the hovered tile 1.8px from the
     pill's 1px border and its fill painted across the rounded corner — the
     Artifacts item, last in the row, is where that showed. Scale alone
     overhangs 0.8px against 5px of padding. Measured, not guessed. */
  .dock-item:hover {
    background: var(--og-btn-hover);
    color: var(--og-text);
    border-color: var(--og-border);
    transform: scale(1.06);
  }
  .dock-item:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  /* An open section reads as on in the BORDER as well as the fill, so the
     state is not carried by a tone alone. Change 31's ::after adds a small
     underline dot on top of that — no extra node, so it survives a re-render. */
  .dock-item.is-on { background: var(--og-btn-hover); color: var(--og-text); border-color: var(--og-accent); }
  .dock-item.is-on::after { content: ''; position: absolute; bottom: 2px; left: 50%; width: 3px; height: 3px; border-radius: 50%; background: var(--og-chat); transform: translateX(-50%); }
  .dock-item svg { width: 15px; height: 15px; display: block; }
  .dock-badge {
    position: absolute;
    top: -3px;
    right: -3px;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    border-radius: 8px;
    background: var(--og-error);
    color: var(--og-error-text);
    font-size: 9px;
    line-height: 15px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  @media (prefers-reduced-motion: reduce) {
    .dock-item { transition: background 160ms ease, color 160ms ease; }
    .dock-item:hover { transform: none; }
  }
</style>

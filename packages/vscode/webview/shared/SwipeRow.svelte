<script lang="ts">
  // SWIPE-TO-DELETE — one row, shared by the sidebar's chat list and the
  // Labyrinth run index (Mock-Redesign/CHANGES.md change 2, react-bits
  // Micro/SwipeRow).
  //
  // WHY ONE COMPONENT: the two lists had two × buttons with two different
  // delete semantics behind them, and "the rows behave the same" is a promise
  // two copies of a gesture cannot keep — the same reason ConnectionPill.svelte
  // exists. The CALLER keeps its own semantics: `onAction` is whatever its old
  // × did (close the chat; arm the Labyrinth's confirm), and this file decides
  // only WHEN it fires.
  //
  // Markup is the reference's: clip > (rail > block > action) + surface +
  // toggle + live region. The surface is the caller's row content. The block
  // is pinned at the right edge and slides left to COVER the row once the
  // swipe passes the action width, so a long swipe reads as a deliberate
  // delete rather than a wider reveal.
  //
  // The × is gone on purpose. The hidden `toggle` is what keeps the action
  // keyboard-reachable, and the live region is what tells a screen reader the
  // reveal happened — a gesture with no keyboard path would be a regression
  // dressed as a redesign.
  import type { Snippet } from 'svelte';
  import {
    SWIPE_ACTION_W, commitPoint, decideOpen, locks, mapExtent, settleEase, velocity,
  } from './swipeRow';

  interface Props {
    /** Spoken name of the action — the toggle's and the button's aria-label. */
    actionLabel: string;
    /** The word on the red panel. */
    actionText?: string;
    /** Extra class on the action button, so a caller's existing selector (and
     *  the tests that use it) still names its delete control. */
    actionClass?: string;
    /** What the row's old × did. */
    onAction: () => void;
    /** A tap on an OPEN row closes it; a tap on a closed one is the caller's
     *  (open the chat). True while the row is open, so the caller can ignore
     *  the click it is about to receive. */
    onTapWhileOpen?: () => void;
    /** False = this row has no delete at all (a Labyrinth collab header). It
     *  renders as bare content rather than an un-swipable wrapper: a gesture
     *  that reveals nothing teaches the user the list is broken. */
    enabled?: boolean;
    children: Snippet;
  }
  let { actionLabel, actionText = 'Delete', actionClass = '', onAction, onTapWhileOpen, enabled = true, children }: Props = $props();

  let rowEl: HTMLDivElement | undefined = $state();
  let surfaceEl: HTMLDivElement | undefined = $state();
  let railEl: HTMLDivElement | undefined = $state();
  let blockEl: HTMLDivElement | undefined = $state();
  let actionEl: HTMLButtonElement | undefined = $state();

  let open = $state(false);
  // Published as `data-swiping` on the root. A caller whose row is ALSO a
  // native HTML5 drag source (the chat list reorders that way) reads it in its
  // own `dragstart` and preventDefaults, because once Chromium starts a drag
  // it stops delivering pointermove and the swipe dies mid-gesture. Measured:
  // three pointermoves reach the row and then nothing. The horizontal lock
  // happens on the first of those, so this flag is already true by the time
  // dragstart fires — horizontal is a swipe, vertical is a reorder.
  let locked = $state(false);
  let phase = $state<'' | 'committing' | 'collapsing'>('');
  let announce = $state('');

  const D = SWIPE_ACTION_W;
  let ex = 0;       // revealed px
  let spread = 0;   // 0..1 — the block's expansion past the action width
  let rowW = 360;
  let grip: { id: number; x0: number; y0: number; grabX: number; ex0: number; locked: boolean; samples: Array<[number, number]> } | null = null;
  let suppressClick = false;

  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function render(): void {
    if (!surfaceEl || !railEl || !blockEl || !actionEl) return;
    surfaceEl.style.transform = `translateX(${-ex}px)`;
    railEl.style.transform = `translateX(${Math.max(0, D - ex)}px)`;
    const covered = spread * Math.max(0, ex - D);
    blockEl.style.transform = `translateX(${-covered}px)`;
    // Counter-translate the glyph so it stays centred on the row while the
    // block grows over it, instead of riding off the left edge.
    actionEl.style.transform = `translateX(${spread * (covered - (rowW - D) / 2)}px)`;
  }

  function setSpread(on: boolean): void {
    const next = on ? 1 : 0;
    if (spread === next) return;
    spread = next;
    const t = reduced() ? 'none' : 'transform 300ms cubic-bezier(0.23, 1, 0.32, 1)';
    if (blockEl) blockEl.style.transition = t;
    if (actionEl) actionEl.style.transition = t;
    render();
  }

  function settle(toOpen: boolean, v: number): void {
    open = toOpen;
    ex = toOpen ? D : 0;
    setSpread(false);
    announce = toOpen ? `${actionLabel} revealed` : '';
    const ease = `transform ${settleEase(v, reduced())}`;
    if (surfaceEl) surfaceEl.style.transition = ease;
    if (railEl) railEl.style.transition = ease;
    render();
  }

  // A full swipe: slide the surface right off, pin the height so the collapse
  // animates from a real pixel value, collapse, THEN do the caller's delete.
  // The delete goes last so the row never blinks out before it has moved.
  function commit(): void {
    suppressClick = true;
    phase = 'committing';
    setSpread(true);
    ex = rowW;
    if (surfaceEl) surfaceEl.style.transition = 'transform 200ms cubic-bezier(0.23, 1, 0.32, 1)';
    render();
    setTimeout(() => {
      if (rowEl) rowEl.style.height = `${rowEl.getBoundingClientRect().height}px`;
      void rowEl?.offsetHeight;
      phase = 'collapsing';
      setTimeout(() => onAction(), 200);
    }, 200);
  }

  function down(e: PointerEvent): void {
    if (e.button !== 0 || phase) return;
    if ((e.target as HTMLElement).closest('.og-sw-action')) return;
    rowW = rowEl?.clientWidth || rowW;
    if (surfaceEl) surfaceEl.style.transition = 'none';
    if (blockEl) blockEl.style.transition = 'none';
    if (actionEl) actionEl.style.transition = 'none';
    grip = { id: e.pointerId, x0: e.clientX, y0: e.clientY, grabX: 0, ex0: 0, locked: false, samples: [] };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function move(e: PointerEvent): void {
    if (!grip || e.pointerId !== grip.id) return;
    if (!grip.locked) {
      if (!locks(e.clientX - grip.x0, e.clientY - grip.y0)) return;
      grip.locked = true;
      locked = true;
      grip.grabX = e.clientX;
      grip.ex0 = open ? D : 0;
    }
    ex = mapExtent(grip.ex0 + (grip.grabX - e.clientX), rowW);
    render();
    setSpread(ex >= commitPoint(rowW));
    grip.samples.push([performance.now(), ex]);
    if (grip.samples.length > 4) grip.samples.shift();
  }

  function up(e: PointerEvent): void {
    if (!grip || e.pointerId !== grip.id) return;
    const g = grip;
    release();
    if (!g.locked) {
      // A tap with no drag: close an open row, and let a closed one through to
      // whatever the caller put under it.
      if (open) { suppressClick = true; settle(false, 0); }
      return;
    }
    if (ex >= commitPoint(rowW)) { commit(); return; }
    const v = velocity(g.samples);
    suppressClick = true;
    settle(decideOpen(ex, v), v);
  }

  function release(): void {
    grip = null;
    locked = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  }

  function onClickCapture(e: MouseEvent): void {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (open && !(e.target as HTMLElement).closest('.og-sw-action')) {
      e.preventDefault();
      e.stopPropagation();
      settle(false, 0);
      onTapWhileOpen?.();
    }
  }
</script>

{#if !enabled}
  {@render children()}
{:else}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="og-sw"
  class:is-open={open}
  data-phase={phase || undefined}
  bind:this={rowEl}
  data-swiping={locked ? '1' : undefined}
  onclickcapture={onClickCapture}
>
  <div class="og-sw-clip">
    <div class="og-sw-rail" bind:this={railEl}>
      <div class="og-sw-block" bind:this={blockEl}>
        <button
          class="og-sw-action {actionClass}"
          type="button"
          aria-label={actionLabel}
          bind:this={actionEl}
          onclick={(e) => { e.preventDefault(); e.stopPropagation(); onAction(); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" />
          </svg>
          <span class="og-sw-word">{actionText}</span>
        </button>
      </div>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="og-sw-surface" bind:this={surfaceEl} onpointerdown={down}>{@render children()}</div>
    <button
      class="og-sw-toggle"
      type="button"
      aria-label={actionLabel}
      aria-expanded={open}
      onclick={(e) => { e.preventDefault(); e.stopPropagation(); settle(!open, 0); }}
    >{actionText}</button>
    <span class="og-sw-sr" aria-live="polite">{announce}</span>
  </div>
</div>
{/if}

<style>
  .og-sw {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    touch-action: pan-y;
    transition: height 200ms cubic-bezier(0.23, 1, 0.32, 1),
                margin 200ms cubic-bezier(0.23, 1, 0.32, 1),
                opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  .og-sw[data-phase='collapsing'] {
    height: 0 !important;
    min-height: 0;
    margin: 0;
    opacity: 0;
    pointer-events: none;
  }
  /* The caller's row is a flex container, so the clip must GROW to the full
     row width; left to itself it shrinks to its content and leaves a gap at
     the right edge that the delete panel never reaches. */
  .og-sw-clip {
    position: relative;
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    background: var(--og-btn-bg);
  }
  .og-sw-rail { position: absolute; inset: 0; background: var(--og-btn-bg); }
  .og-sw-block {
    position: absolute;
    top: 0;
    left: calc(100% - 84px);
    width: 100%;
    height: 100%;
    background: var(--og-error);
  }
  .og-sw-action {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 84px;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--og-error-text);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .og-sw-action svg { width: 15px; height: 15px; }
  .og-sw-surface {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
    background: var(--og-surface);
  }
  .og-sw.is-open .og-sw-surface { user-select: none; }
  /* Keyboard-reachable, invisible until focused — then a real pill. */
  .og-sw-toggle {
    position: absolute;
    top: 50%;
    right: 12px;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    border: 0;
    overflow: hidden;
    clip-path: inset(50%);
    background: transparent;
    color: var(--og-text);
    font: inherit;
  }
  .og-sw-toggle:focus-visible {
    width: auto;
    height: 22px;
    padding: 0 10px;
    border-radius: 11px;
    overflow: visible;
    clip-path: none;
    background: color-mix(in srgb, var(--og-text) 14%, transparent);
    font-size: 11px;
    transform: translateY(-50%);
    z-index: 2;
  }
  .og-sw-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>

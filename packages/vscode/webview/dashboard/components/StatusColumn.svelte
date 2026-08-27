<script lang="ts">
  // One BLOCK of the Folds board (contract §6, regridded by §11.1). The head says
  // what the block holds — label, count, and a one-line subtitle — because a bare
  // "Pending" leaves the reader guessing between an unspec'd idea and a queued
  // worktree. Content is a snippet, so the block knows nothing about
  // ticket-vs-fold cards; the pane decides what goes in.
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    subtitle: string;
    count: number;
    /** 'blocked' tints the head amber — the one column that means "look at me". */
    tone?: string;
    /** Set on the block that accepts a dragged ticket id (contract §11.4). */
    ondropticket?: (id: string) => void;
    action?: Snippet;
    children?: Snippet;
  }
  let { label, subtitle, count, tone = '', ondropticket, action, children }: Props = $props();

  // A native HTML5 drop needs preventDefault on BOTH dragover and drop, or the
  // browser handles the payload itself and the drop never reaches us. The payload
  // is a bare ticket id: the PANE decides whether that id may be queued, so a
  // stray drag from anywhere else lands as a no-op, never as a launch.
  let over = $state(false);
  function dragOver(e: DragEvent): void { if (!ondropticket) return; e.preventDefault(); over = true; }
  function drop(e: DragEvent): void {
    over = false;
    if (!ondropticket) return;
    e.preventDefault();
    const id = e.dataTransfer?.getData('text/plain') ?? '';
    if (id) ondropticket(id);
  }
</script>

<!-- Named region, not a bare <section>: a block that takes a drop has to say what
     it is, both for a screen reader and for Svelte's a11y check. -->
<section class="am-scol" class:blocked={tone === 'blocked'} class:dragover={over}
  aria-label={label}
  ondragover={dragOver} ondragleave={() => (over = false)} ondrop={drop}>
  <div class="am-scol-head">
    <div class="am-scol-top">
      <span class="am-scol-name">{label}</span>
      <span class="am-scol-count">{count}</span>
      {@render action?.()}
    </div>
    <div class="am-scol-sub">{subtitle}</div>
  </div>
  <div class="am-scol-body">{@render children?.()}</div>
</section>

<style>
  /* A grid CELL now, not a flex column: the block fills its share of the 2x3
     board and scrolls its OWN body, so min-width/height must be 0 or the cell
     refuses to shrink and the grid overflows the pane. */
  .am-scol {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    background: var(--og-surface, rgba(255, 255, 255, 0.03));
  }
  /* The drop target says so while a ticket is over it — an invisible target is
     indistinguishable from a broken one. */
  .am-scol.dragover { border-color: var(--og-accent, #3b6ea5); box-shadow: inset 0 0 0 2px var(--og-accent, #3b6ea5); }
  .am-scol-head {
    flex: none;
    padding: 7px 9px 6px;
    border-bottom: 1px solid var(--og-border, rgba(255, 255, 255, 0.08));
  }
  .am-scol.blocked .am-scol-name { color: #e6a23c; }
  .am-scol-top { display: flex; align-items: center; gap: 6px; }
  .am-scol-name { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .am-scol-count {
    font-variant-numeric: tabular-nums; font-size: 10px; border-radius: 8px; padding: 0 6px;
    background: var(--og-border, rgba(255, 255, 255, 0.12));
  }
  .am-scol-sub { font-size: 10px; opacity: 0.55; line-height: 1.3; margin-top: 2px; }
  .am-scol-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 7px;
  }
</style>

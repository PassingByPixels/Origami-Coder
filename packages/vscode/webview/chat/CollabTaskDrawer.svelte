<script lang="ts">
  // The task board as a slide-out drawer, in the idiom the chat's run-time
  // todo overlay already uses: a panel on the right edge, riding off toward
  // it and leaving a pull-tab behind. A full-width band cost the transcript
  // height on every collab, whether the room had tasks or not.
  //
  // The idiom is copied from TodoStrip.svelte, not factored into a shared
  // component: a checklist and a persistent board have different lifetimes
  // and data flows, so sharing one component would trade thirty lines of
  // CSS for permanent coupling.
  import CollabDrawerTab from './CollabDrawerTab.svelte';
  import TaskBoard from './TaskBoard.svelte';
  import type { CollabCostTotal, LedgerEntry, TaskEntry } from '../../src/acpExtTypes';

  interface Props {
    /** ABSENT on an older engine — "this build has no board", not "no tasks". */
    tasks?: TaskEntry[];
    costTotals?: CollabCostTotal[];
    ledger?: LedgerEntry[];
    ledgerLoaded: boolean;
    archived: boolean;
    onAdd: (title: string) => void;
    onUpdate: (taskId: string, action: 'accept' | 'reopen', extra: { note?: string }) => void;
    /** Fired when the drawer OPENS — the per-turn ledger is fetched then rather
     *  than on every poll, since nothing shows it while the drawer is shut. */
    onExpand: () => void;
  }
  let { tasks, costTotals, ledger, ledgerLoaded, archived, onAdd, onUpdate, onExpand }: Props = $props();

  // Plain component state: it lasts as long as the pane does, and nothing
  // persists past the tab. The drawer is closed by default, but the tab
  // stays on screen, so a shut drawer still shows the board exists.
  let open = $state(false);

  /** Count of tasks not yet accepted. Accepted tasks are done work, not work
   *  owed, so they are excluded; zero shows no number at all. */
  const liveCount = $derived((tasks ?? []).filter((t) => t.state !== 'accepted').length);

  function toggle() {
    open = !open;
    if (open) onExpand();
  }
</script>

<!-- Outer box holds position; inner box holds the collapse transform, so
     the two transforms never fight (same split as ChatPane's overlay). -->
<aside class="ctd-overlay" aria-label="Task board">
  <div class="ctd" class:collapsed={!open}>
    <CollabDrawerTab {open} count={liveCount} onToggle={toggle} />
    <div class="ctd-panel">
      <TaskBoard {tasks} {costTotals} {ledger} {ledgerLoaded} {archived} {open} onToggle={toggle} {onAdd} {onUpdate} />
    </div>
  </div>
</aside>

<style>
  /* The overlay box. `.collab` is position:relative, so this floats over the
     stream rather than taking height from it.

     IT IS A POSITIONING BOX AND NOTHING ELSE (the lone-pill bug). The lift, the
     scroll container and the hit area used to live here — on the part that does
     NOT move — so a collapsed drawer left all three behind: a ghost panel of
     shadow around a transparent box, and an invisible 280px-wide column that
     swallowed clicks, drag-selection and the wheel events the stream's own
     follow reads (collabStreamFollow.ts). They now live on `.ctd-panel`, which
     is the thing that actually slides and actually scrolls. */
  .ctd-overlay {
    position: absolute;
    top: 50%;
    right: 8px;
    transform: translateY(-50%);
    width: min(280px, 88%);
    /* Clip the collapsed panel as it slides off the right edge (no horizontal
       scrollbar). `clip` is the one x-value that leaves y visible, so the
       pull-tab is never cut off by its own container. */
    overflow-x: clip;
    z-index: 6;
    /* The box is transparent — so it must not be hit-testable either. `.ctd`
       below takes the events back, and `.ctd` MOVES with the panel, which is
       what shrinks the live area to the tab when the drawer is shut. */
    pointer-events: none;
  }

  /* The drawer proper: a transparent positioning shell with a left gutter for
     the tab. The visible panel is .ctd-panel, which slides off toward the docked
     (right) edge, leaving only the tab. The board stays MOUNTED throughout —
     hidden by the slide, never dropped — so reopening is instant. */
  .ctd {
    position: relative;
    padding-left: 16px;
    transition: transform 0.22s ease;
    pointer-events: auto;
  }
  .ctd.collapsed {
    /* Slide right by the drawer's width minus the 16px tab gutter. */
    transform: translateX(calc(100% - 16px));
  }

  /* The visible panel, and now the only thing that is lifted or scrolls — see
     the overlay's note. No --og-* shadow var exists anywhere in this codebase,
     so a neutral black lift is the established convention (ChatPane's todo
     overlay, SlashDropdown and HistoryDropdown all carry the same one). */
  .ctd-panel {
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-left: 4px solid var(--og-accent);
    border-radius: 6px;
    overflow: hidden;
    overflow-y: auto;
    max-height: 72vh;
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.42);
  }

  /* The board is a floating panel here, not a band in a column: its own
     full-width bottom rule would draw a line across the drawer's foot. */
  .ctd-panel :global(.tb) {
    border-bottom: none;
  }

</style>

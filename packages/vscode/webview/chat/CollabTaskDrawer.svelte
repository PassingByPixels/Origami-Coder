<script lang="ts">
  // The task board as a SLIDE-OUT DRAWER (M4.2 UAT), in the idiom the chat's
  // run-time todo overlay already established: a panel floating on the right
  // edge of the pane, vertically centred, that rides off toward that edge and
  // leaves a pull-tab behind.
  //
  // WHY: the board used to be a full-width band between the controls and the
  // stream. It cost the transcript a slice of height on every collab, whether or
  // not the room had a single task on it. A drawer costs 16px of tab.
  //
  // THE IDIOM IS COPIED, NOT FACTORED. TodoStrip.svelte owns the same pull-tab
  // and the same `translateX(calc(100% - 16px))` collapse, and ChatPane.svelte
  // owns the overlay box those sit in. Generalising the two into one component
  // would mean one file serving a per-turn checklist and a persistent task board
  // — two lifetimes, two data flows, one set of props pulling in both
  // directions. The geometry is thirty lines of CSS; the coupling would be
  // permanent.
  //
  // The BOARD itself is TaskBoard.svelte, mounted whole: its rows, its Add row,
  // its Accept/Reopen transitions and its ledger footer are untouched by the
  // move. What changed hands is only WHO owns the fold — see its header.
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

  // Plain component state, so it lasts exactly as long as the pane does: the
  // drawer is mounted unconditionally, and a collab tab left open all afternoon
  // keeps whatever the user chose. Nothing is persisted past the tab, because a
  // drawer is a glance, not a setting.
  //
  // CLOSED by default. The tab is always on screen, so an unopened drawer still
  // says the board is there — which a hidden panel with no handle would not.
  let open = $state(false);

  /** What the tab says it is holding. ACCEPTED tasks are closed and are not
   *  work owed, so they are not counted — a handle claiming "6" on a board with
   *  nothing left to do is the same lie as claiming "0" on an engine that has
   *  no board. Zero prints no number at all. */
  const liveCount = $derived((tasks ?? []).filter((t) => t.state !== 'accepted').length);

  function toggle() {
    open = !open;
    if (open) onExpand();
  }
</script>

<!-- The outer box holds the POSITION (right edge, vertically centred); the inner
     one carries the collapse transform, so the two transforms never fight. Same
     split ChatPane's .todo-overlay / .todo-overlay-inner takes. -->
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

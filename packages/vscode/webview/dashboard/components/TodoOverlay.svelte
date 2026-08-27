<script lang="ts">
  // The live task list as a RIGHT-edge overlay: a panel that slides in over the
  // chat while the agent works and slides out a short linger after turn end.
  //
  // EXTRACTED from ChatPane.svelte, which was 3 lines OVER its 2630-line cap
  // when the scroll-stick and the sub-agent drawer landed. The ratchet's remedy
  // is a module, not a raise — and this was the seam worth taking, because the
  // pane now mounts a matching drawer on the LEFT (SubagentDrawer.svelte) and
  // the two are peers. The pane keeps only WHEN the overlay is up; the geometry
  // is here.
  //
  // NOT factored together with SubagentDrawer: one is a per-turn checklist that
  // dies with the turn, the other a roster of live sub-agents. Two lifetimes,
  // two data flows — the idiom is thirty lines of CSS and the coupling would be
  // permanent. Same call CollabTaskDrawer.svelte's own comment already records.
  //
  // The outer <aside> holds the centred position; the inner div carries the fly
  // transform, so the two transforms do not fight.
  import { fly } from 'svelte/transition';
  import TodoStrip from './TodoStrip.svelte';

  interface TodoView {
    id: number;
    content: string;
    activeForm: string;
    status: 'pending' | 'in_progress' | 'completed';
  }

  interface Props {
    todos: TodoView[];
    source: string;
    /** Owned by the PARENT (persisted per session), so the choice survives this
     *  overlay being unmounted and remounted on the next turn. */
    collapsed: boolean;
    onToggleCollapse: () => void;
  }
  let { todos, source, collapsed, onToggleCollapse }: Props = $props();
</script>

<aside class="todo-overlay">
  <div class="todo-overlay-inner" transition:fly={{ x: 200, duration: 200 }}>
    <TodoStrip {todos} {source} collapsible {collapsed} {onToggleCollapse} />
  </div>
</aside>

<style>
  /* Floats on the right edge, vertically centred, with its own scroll; the
     capped height keeps it clear of the composer below. */
  .todo-overlay {
    position: absolute;
    top: 50%;
    right: 8px;
    transform: translateY(-50%);
    width: min(280px, 88%);
    max-height: 72%;
    overflow-y: auto;
    /* Clip the collapsed drawer as it slides off the right edge (no horizontal
       scrollbar); vertical scroll for long lists is unchanged. */
    overflow-x: clip;
    z-index: 6;
    border-radius: 8px;
  }
  /* Passthrough wrapper that carries the fly transform (keeps it off the outer
     aside, whose transform does the vertical centring). */
  .todo-overlay-inner {
    width: 100%;
  }
  /* Neutralise TodoStrip's own sticky float + margins inside the overlay (the
     overlay already positions it), and shrink the type a touch so more fits. */
  .todo-overlay :global(.todo-strip) {
    position: static;
    margin: 0;
  }
  .todo-overlay :global(.todo-header),
  .todo-overlay :global(.todo-item) {
    font-size: 10.5px;
  }
  /* Taller overlay → let long todo text wrap to more lines instead of
     truncating to a single ellipsised line. */
  .todo-overlay :global(.todo-content) {
    white-space: normal;
  }
</style>

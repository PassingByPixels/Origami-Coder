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
  import TodoTabs from './TodoTabs.svelte';
  import { activeTab, tabTitles, todoTabs, type SubagentTodoList } from './todoTabs';
  import { completedKeys, hiddenSet } from '../panes/todoClear';
  // The row shape is the pane's own `TodoInfo`, imported rather than re-declared.
  import type { TodoInfo as TodoView } from '../panes/chatMessage';

  interface Props {
    todos: TodoView[];
    source: string;
    /** Owned by the PARENT (persisted per session), so the choice survives this
     *  overlay being unmounted and remounted on the next turn. */
    collapsed: boolean;
    onToggleCollapse: () => void;
    /** The lists this chat's SUB-AGENTS are keeping, joined in the pane. A
     *  sub-agent's `todowrite` never reaches the wire as a tool call, so these
     *  arrive by a different road entirely — src/dashboard/subagentTodos.ts. */
    subagents?: SubagentTodoList[];
    /** Which tab is showing, and how to change it. Owned by the PANE, like
     *  `collapsed`: this overlay is unmounted and remounted every turn. */
    selectedTab?: string;
    onSelectTab?: (id: string) => void;
    /** "Clear completed" (t-h8gv8w): the keys each list has hidden, and the
     *  report of a click on the SELECTED one. Owned by the PANE for
     *  `selectedTab`'s reason — this overlay remounts every turn. Pure webview
     *  state; the host is told nothing, so the phone gets it free. */
    hidden?: Record<string, string[]>;
    onClearCompleted?: (listId: string, keys: string[]) => void;
  }
  let { todos, source, collapsed, onToggleCollapse, subagents = [], selectedTab = 'main', onSelectTab, hidden, onClearCompleted }: Props = $props();

  const tabs = $derived(todoTabs(todos, subagents));
  const shown = $derived(activeTab(tabs, selectedTab));
  const titles = $derived(tabTitles(subagents));
</script>

<!-- t-l1d0yq: `collapsed` also drives pointer-events (see style below). -->
<aside class="todo-overlay" class:collapsed>
  <div class="todo-overlay-inner" transition:fly={{ x: 200, duration: 200 }}>
    <!-- t-fh4zpc — the tab strip goes to TodoStrip as the panel's FIRST ROW, not
         as its sibling, so ONE collapse hides both. Passed only when there is a
         CHOICE: one tab reading "Main" over the only list spends a panel line. -->
    {#snippet listtabs()}<TodoTabs {tabs} selected={shown.id} onSelect={(id) => onSelectTab?.(id)} {titles} />{/snippet}
    <!-- A sub-agent's list is somebody else's plan: shown, never edited from
         here, and its provenance is the tab, not the strip's own source line. -->
    <!-- The hidden set is read for the SELECTED tab alone: each list keeps its own. -->
    <TodoStrip todos={shown.todos} source={shown.id === 'main' ? source : ''} collapsible {collapsed} {onToggleCollapse} tabs={tabs.length > 1 && onSelectTab ? listtabs : undefined} hiddenKeys={hiddenSet(hidden, shown.id)} onClearCompleted={onClearCompleted ? () => onClearCompleted(shown.id, completedKeys(shown.todos)) : undefined} />
  </div>
</aside>

<style>
  /* A CHILD of ChatPane's .right-rail, which took the anchor, the width and the
     centring when the browser strip became this drawer's peer above it — two
     overlays both centred on the cell's middle would have overlapped. What is
     left here is the drawer's own height budget and its clip. `min-height: 0`
     because a flex item's default floor is its content, which would let a long
     list push the rail past the composer instead of scrolling inside it. */
  .todo-overlay {
    width: 100%;
    min-height: 0;
    overflow-y: auto;
    /* Clip the collapsed drawer as it slides off the right edge (no horizontal
       scrollbar); vertical scroll for long lists is unchanged. */
    overflow-x: clip;
    border-radius: 8px;
    /* The rail itself is click-through (it is mounted even when empty). */
    pointer-events: auto;
  }
  /* t-l1d0yq — collapsed: the rail's box still reserves the panel's height
     (only translated off-screen), so its overflow-y:auto made that leftover
     box its own scroll container, eating every wheel event over the former
     todo region. pointer-events:none drops it out of hit-testing; the
     pull-tab opts back in so it stays clickable. */
  .todo-overlay.collapsed { pointer-events: none; }
  .todo-overlay.collapsed :global(.todo-tab) { pointer-events: auto; }
  /* Passthrough wrapper carrying the fly transform, split from the aside
     (which does the centring + clip) so the two transforms don't fight. */
  .todo-overlay-inner { width: 100%; }
  /* Neutralise TodoStrip's own sticky float/margins; shrink type to fit more. */
  .todo-overlay :global(.todo-strip) { position: static; margin: 0; }
  .todo-overlay :global(.todo-header),
  .todo-overlay :global(.todo-item) { font-size: 10.5px; }
  /* t-qn0lpl — ONE LINE, ellipsised. This :global() used to say `white-space:
     normal`, letting a two-word task become two lines and growing the 22px row
     it sits in; the rhythm of the panel is the row height, and the full text is
     already on the row's own title. TodoRow.svelte declares the nowrap; this
     rule exists to state that the overlay does NOT overrule it. */
  .todo-overlay :global(.todo-content) { white-space: nowrap; }
</style>

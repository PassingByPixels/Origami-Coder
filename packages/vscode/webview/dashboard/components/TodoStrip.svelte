<script lang="ts">
  // Iter-25.11 (2026-05-21) — sticky live-todo strip rendered at the
  // top of ChatPane. Mirrors Claude Code's TodoWrite overlay: items
  // toggle pending → in_progress → completed in place as the agent
  // works. Pure display, no interactions.
  //
  // Mounted ABOVE the chat scroll container so it stays visible while
  // the chat history scrolls. Wire format defined by AcpCallbacks::
  // on_todo_snapshot in crates/acp/src/events.rs (iter-25.11).

  // The list arithmetic (what a depth means, who owns which children, the
  // status tally) is a pure leaf; one row's markup is another. This file keeps
  // the panel, the header, the drawer and the collapse.
  import type { Snippet } from 'svelte';
  import { annotate, counts } from './todoTree';
  import { autoCollapsed, visible } from './todoCollapse';
  import { hasCompleted, hiddenAfterClear } from '../panes/todoClear';
  import TodoRow from './TodoRow.svelte';
  import TodoClearButton from './TodoClearButton.svelte';
  import TodoProgressBar from './TodoProgressBar.svelte';
  // The row shape is the pane's own `TodoInfo` (panes/chatMessage.ts), imported
  // rather than re-declared here: it was the same five fields twice, and a
  // second copy is a second thing to forget when the wire gains a field.
  import type { TodoInfo as TodoView } from '../panes/chatMessage';

  interface Props {
    todos: TodoView[];
    source: string;
    /**
     * When true the header becomes a toggle: clicking it expands/collapses
     * the item list even when every todo is done. Used for the inline
     * end-of-turn snapshot so a finished one-liner can be re-opened to see
     * what the agent tracked. The live overlay leaves this false (it
     * auto-manages collapse via `allDone`).
     */
    interactive?: boolean;
    /**
     * Tweak 3 — when true the strip gains a click/keyboard tab that slides the
     * item list away and back. Used by the live run-time overlay. `collapsed` is
     * owned by the parent (persisted per-session) and mirrored back through
     * `onToggleCollapse`, so the choice survives the overlay re-mounting each turn.
     * The item list is only HIDDEN, never dropped — reopening shows it intact.
     */
    collapsible?: boolean;
    collapsed?: boolean;
    onToggleCollapse?: () => void;
    /**
     * t-fh4zpc — an optional first row INSIDE the panel box, drawn above the
     * header. TodoOverlay passes its list-tab strip here so the two are ONE UI
     * piece: the collapse moves the panel and the tabs go with it. Before this
     * the tabs were a sibling of the whole strip and stayed on screen after the
     * owner shut the panel. A snippet, not tab props: what a tab IS stays the
     * overlay's business (TodoTabs.svelte + todoTabs.ts), and this file keeps
     * owning only where the row sits.
     */
    tabs?: Snippet;
    /** t-h8gv8w — the rows "Clear completed" has hidden on THIS list, by
     *  todoClear.ts's content+status key. A view filter over the model's list:
     *  the header count still reads the true done/total, and a row the model
     *  reopens keys differently and comes straight back. */
    hiddenKeys?: ReadonlySet<string>;
    /** Report a click. Absent = no control at all (the inline end-of-turn
     *  snapshot has nothing to clear away from). */
    onClearCompleted?: () => void;
  }

  let { todos, source, interactive = false, collapsible = false, collapsed = false, onToggleCollapse, tabs, hiddenKeys, onClearCompleted }: Props = $props();

  // The list as DRAWN. The header's tally is computed from `todos`, the model's
  // own list, so hiding rows never moves the count the owner is reading.
  const shown = $derived(hiddenAfterClear(todos, hiddenKeys ?? new Set<string>()));

  // Local expand state — only consulted in `interactive` mode. Starts
  // collapsed so a completed snapshot reads as a tidy one-liner.
  let expanded = $state(false);

  // PER-ROW collapse, keyed by the row's id: what the user has said about a
  // container, and nothing else. A row with no entry falls back to the automatic
  // rule (a settled branch opens shut), so the default follows the work while a
  // click still wins. Deliberately NOT persisted and NOT lifted to the parent:
  // the drawer's own collapse is a per-session preference, this is a glance at a
  // list that is being rewritten every turn.
  let openOverride = $state<Record<number, boolean>>({});
  const toggle = (id: number, current: boolean) => (openOverride[id] = !current);

  // `source` surfaces only in the title-tooltip — the user mostly
  // cares whether items exist and what their status is. Provenance
  // matters for debugging, not foreground UI.
  const SOURCE_LABEL: Record<string, string> = {
    model_write: 'updated by agent',
    auto_seed: 'seeded from plan',
    session_restore: 'restored',
  };
</script>

<!-- The pull-tab handle, ONE snippet for both branches: the empty branch used to
     leave it out, so a Main tab with no list of its own could not close the drawer. -->
{#snippet handle()}
  <button
    class="todo-tab"
    aria-expanded={!collapsed}
    aria-label={collapsed ? 'Show task list' : 'Hide task list'}
    title={collapsed ? 'Show tasks' : 'Hide tasks'}
    onclick={onToggleCollapse}
  >
    <span class="todo-tab-glyph" aria-hidden="true">{collapsed ? '⟨' : '⟩'}</span>
  </button>
{/snippet}

{#if todos.length === 0}
  <!-- t-gyp8fj: the tabs belong to the PANEL, so a chat with no list of its own can
       still reach a child's. Drawer mode: same shape as the full branch (handle + panel). -->
  <div class="todo-strip empty" class:drawer={collapsible} class:collapsed={collapsible && collapsed}
    title="Todos will appear here when the agent starts tracking work">
    {#if collapsible}{@render handle()}{/if}
    <div class="todo-panel">
      {#if tabs}{@render tabs()}{/if}
      <span class="todo-empty">Todos: none yet</span>
    </div>
  </div>
{:else}
  <!-- LEAVES only: a row with children is a container, so it is neither a task
       to do nor a task done. Counting it as well would let the header sit at
       "3/5" with nothing outstanding. -->
  {@const cnt = counts(todos)}
  {@const allDone = cnt.completed === cnt.total}
  <!-- All done: un-pin the strip and collapse the list to a one-line summary; in
       `interactive` mode the header re-opens it. Drawer mode keeps the list MOUNTED
       (the collapsed state slides the panel off by CSS), so reopening is instant. -->
  {@const showList = collapsible ? true : (!allDone || (interactive && expanded))}
  <!-- Only a finished snapshot is re-expandable; a running list is never a button. -->
  {@const canToggle = interactive && allDone}
  <div
    class="todo-strip"
    class:done={allDone && !collapsible}
    class:drawer={collapsible}
    class:collapsed={collapsible && collapsed}
    title={SOURCE_LABEL[source] ?? source}
  >
    {#if collapsible}{@render handle()}{/if}
    <div class="todo-panel">
      {#if tabs}{@render tabs()}{/if}
      <div
        class="todo-header"
        class:clickable={canToggle}
        role={canToggle ? 'button' : undefined}
        tabindex={canToggle ? 0 : undefined}
        aria-expanded={canToggle ? expanded : undefined}
        onclick={canToggle ? () => (expanded = !expanded) : undefined}
        onkeydown={canToggle
          ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expanded = !expanded; } }
          : undefined}
      >
        {#if canToggle}
          <span class="todo-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        {/if}
        <span class="todo-icon">{allDone ? '✓' : '✦'}</span>
        <span class="todo-title">Todos</span>
        <span class="todo-counts">
          {cnt.completed}/{cnt.total} done
          {#if !allDone && cnt.in_progress > 0}· {cnt.in_progress} active{/if}
          {#if allDone}· complete{/if}
        </span>
        {#if onClearCompleted}
          <TodoClearButton disabled={!hasCompleted(shown)} onClear={onClearCompleted} />
        {/if}
      </div>
      <!-- The header's fraction as a bar, from `cnt` — the MODEL's tally, so "Clear completed" cannot run progress backwards. -->
      <TodoProgressBar completed={cnt.completed} total={cnt.total} />
      {#if showList}
      <!-- Depths are normalised for the WHOLE list at once (a row's legal depth
           depends on the row before it), so the rows are annotated here rather
           than each row working it out from its own field. -->
      {@const rows = annotate(shown)}
      <!-- A container's own flag: the user's click if there is one, otherwise the
           automatic rule (a settled branch opens shut). Carried ON the row so the
           filtered list still knows it — `visible` drops whole subtrees, so the
           row's index in the rendered list is not its index in the plan. -->
      {@const auto = autoCollapsed(rows)}
      {@const marked = rows.map((t, i) => ({ ...t, shut: (openOverride[t.id] ?? auto[i]) === true }))}
      <ul class="todo-list">
        {#each visible(marked, marked.map((m) => m.shut)) as t (t.id)}
          <TodoRow
            content={t.content}
            activeForm={t.activeForm}
            status={t.status}
            depth={t.depth}
            childDone={t.childDone}
            childTotal={t.childTotal}
            collapsed={t.shut}
            onToggle={() => toggle(t.id, t.shut)}
          />
        {/each}
      </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  .todo-strip {
    padding: 8px 12px;
    background: var(--og-surface, #1e1e2e);
    /* B4 — bolder, fully-enclosed panel so it reads as separate from
       the chat scroll underneath it (it's sticky and floats over the
       history). Thick accent rail on the left + full border + lift. */
    border: 1px solid var(--og-border, #45475a);
    border-left: 4px solid var(--og-accent, #89b4fa);
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    margin: 0 0 10px 0;
    position: sticky;
    top: 0;
    z-index: 5;
  }

  .todo-strip.empty {
    padding: 4px 12px;
    border-left-color: var(--og-muted, #6c7086);
    box-shadow: none;
  }
  .todo-strip.empty.drawer { padding: 0 0 0 16px; }
  .todo-strip.empty.drawer .todo-panel { border-left-color: var(--og-muted, #6c7086); }

  /* All todos complete — un-pin (stop the sticky float), drop the lift,
     and recede so a finished list scrolls away instead of hogging the top. */
  .todo-strip.done {
    position: static;
    padding: 4px 12px;
    box-shadow: none;
    border-left-color: var(--og-success, #a6e3a1);
    opacity: 0.72;
  }

  .todo-empty {
    font-size: 11px;
    color: var(--og-muted, #6c7086);
    font-style: italic;
  }

  .todo-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 12px;
    color: var(--og-text, #cdd6f4);
  }

  /* Interactive (re-expandable) header — clicking toggles the item list. */
  .todo-header.clickable {
    cursor: pointer;
    user-select: none;
  }
  .todo-header.clickable:hover {
    color: var(--og-accent, #89b4fa);
  }

  .todo-chevron {
    font-size: 10px;
    flex: 0 0 auto;
    color: var(--og-muted, #6c7086);
  }

  /* Tweak 1 — drawer mode. The strip becomes a transparent positioning shell
     with a left gutter for the pull-tab; the visual panel lives on .todo-panel
     and slides off toward the docked (right) edge when collapsed, leaving only
     the tab. The list stays mounted throughout (hidden by the slide, not
     dropped), so reopening is instant and preserves items. */
  .todo-strip.drawer {
    position: relative;
    padding: 0 0 0 16px;
    background: transparent;
    border: none;
    border-radius: 0;
    box-shadow: none;
    transition: transform 0.22s ease;
  }
  .todo-strip.drawer.collapsed {
    /* Slide right by the strip's width minus the 16px tab gutter: the panel
       rides off the edge, the tab stays on-screen (parent overlay clips the
       overflow with overflow-x: clip). */
    transform: translateX(calc(100% - 16px));
  }
  .todo-strip.drawer .todo-panel {
    padding: 8px 12px;
    background: var(--og-surface, #1e1e2e);
    border: 1px solid var(--og-border, #45475a);
    border-left: 4px solid var(--og-accent, #89b4fa);
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    transition: box-shadow 0.22s ease;
  }
  /* Collapsed: drop the panel's shadow so its blur doesn't bleed back into view
     at the docked edge once the panel has slid off (the transform moves the box
     but a box-shadow spreads in every direction, including back on-screen). */
  .todo-strip.drawer.collapsed .todo-panel {
    box-shadow: none;
  }
  /* The pull-tab handle — a rounded pill on the strip's chat-facing edge; a
     real <button> so it's keyboard-focusable and toggled with Enter/Space. */
  .todo-strip.drawer .todo-tab {
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 44px;
    padding: 0;
    color: var(--og-text, #cdd6f4);
    background: var(--og-surface, #1e1e2e);
    border: 1px solid var(--og-border, #45475a);
    border-radius: 5px 0 0 5px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }
  .todo-strip.drawer .todo-tab:hover {
    color: var(--og-accent, #89b4fa);
    border-color: var(--og-accent, #89b4fa);
  }
  .todo-tab-glyph {
    font-size: 11px;
    line-height: 1;
  }

  .todo-icon {
    font-size: 13px;
    opacity: 0.7;
    color: var(--og-accent, #89b4fa);
  }

  .todo-title {
    flex: 0 0 auto;
  }

  .todo-counts {
    font-size: 11px;
    font-weight: 400;
    color: var(--og-muted, #6c7086);
  }

  .todo-list {
    list-style: none;
    margin: 6px 0 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* One row's own rules (.todo-item, .todo-status-icon, .todo-content,
     .todo-child-count, .todo-active-form) moved to TodoRow.svelte with its
     markup. TodoOverlay.svelte reaches two of them through :global(), which is
     unscoped and so is unaffected by which component now declares them. */
</style>

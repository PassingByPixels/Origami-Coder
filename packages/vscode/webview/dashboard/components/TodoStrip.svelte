<script lang="ts">
  // Iter-25.11 (2026-05-21) — sticky live-todo strip rendered at the
  // top of ChatPane. Mirrors Claude Code's TodoWrite overlay: items
  // toggle pending → in_progress → completed in place as the agent
  // works. Pure display, no interactions.
  //
  // Mounted ABOVE the chat scroll container so it stays visible while
  // the chat history scrolls. Wire format defined by AcpCallbacks::
  // on_todo_snapshot in crates/acp/src/events.rs (iter-25.11).

  interface TodoView {
    id: number;
    content: string;
    activeForm: string;
    status: 'pending' | 'in_progress' | 'completed';
  }

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
  }

  let { todos, source, interactive = false, collapsible = false, collapsed = false, onToggleCollapse }: Props = $props();

  // Local expand state — only consulted in `interactive` mode. Starts
  // collapsed so a completed snapshot reads as a tidy one-liner.
  let expanded = $state(false);

  const STATUS_ICON: Record<TodoView['status'], string> = {
    pending: '☐',
    in_progress: '▶',
    completed: '✓',
  };

  function counts(items: TodoView[]) {
    let p = 0, i = 0, c = 0;
    for (const t of items) {
      if (t.status === 'pending') p++;
      else if (t.status === 'in_progress') i++;
      else c++;
    }
    return { pending: p, in_progress: i, completed: c };
  }

  // `source` surfaces only in the title-tooltip — the user mostly
  // cares whether items exist and what their status is. Provenance
  // matters for debugging, not foreground UI.
  const SOURCE_LABEL: Record<string, string> = {
    model_write: 'updated by agent',
    auto_seed: 'seeded from plan',
    session_restore: 'restored',
  };
</script>

{#if todos.length === 0}
  <div class="todo-strip empty" title="Todos will appear here when the agent starts tracking work">
    <span class="todo-empty">Todos: none yet</span>
  </div>
{:else}
  {@const cnt = counts(todos)}
  {@const allDone = cnt.completed === todos.length}
  <!-- When every item is done, un-pin the strip (drop the sticky float so
       it scrolls away with the history) and collapse the item list to a
       one-line summary — a finished checklist shouldn't keep hogging the
       top of the pane. In `interactive` mode the header is a toggle so a
       collapsed snapshot can be re-opened to show the items again. -->
  <!-- In collapsible (drawer) mode the item list is ALWAYS mounted — the
       collapsed state slides the panel off toward the edge (CSS) rather than
       dropping the list, so reopening is instant and preserves items. -->
  {@const showList = collapsible ? true : (!allDone || (interactive && expanded))}
  <!-- Only a finished (all-done) snapshot is re-expandable, so the header
       toggle affordance is offered only then; a still-running list is always
       expanded and isn't announced as a button. -->
  {@const canToggle = interactive && allDone}
  <div
    class="todo-strip"
    class:done={allDone && !collapsible}
    class:drawer={collapsible}
    class:collapsed={collapsible && collapsed}
    title={SOURCE_LABEL[source] ?? source}
  >
    {#if collapsible}
      <!-- The pull-tab handle. Rides with the strip on collapse so it lands
           flush at the docked edge; always present so a hidden drawer can be
           pulled back out. aria-expanded + aria-label carry the drawer state. -->
      <button
        class="todo-tab"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Show task list' : 'Hide task list'}
        title={collapsed ? 'Show tasks' : 'Hide tasks'}
        onclick={onToggleCollapse}
      >
        <span class="todo-tab-glyph" aria-hidden="true">{collapsed ? '⟨' : '⟩'}</span>
      </button>
    {/if}
    <div class="todo-panel">
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
          {cnt.completed}/{todos.length} done
          {#if !allDone && cnt.in_progress > 0}· {cnt.in_progress} active{/if}
          {#if allDone}· complete{/if}
        </span>
      </div>
      {#if showList}
      <ul class="todo-list">
        {#each todos as t (t.id)}
          <li class="todo-item {t.status}">
            <span class="todo-status-icon">{STATUS_ICON[t.status]}</span>
            <span class="todo-content">{t.content}</span>
            {#if t.status === 'in_progress' && t.activeForm}
              <span class="todo-active-form">— {t.activeForm}</span>
            {/if}
          </li>
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

  .todo-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 12px;
    color: var(--og-text, #cdd6f4);
    line-height: 1.4;
  }

  .todo-item.completed {
    color: var(--og-muted, #6c7086);
    text-decoration: line-through;
    text-decoration-color: var(--og-muted, #6c7086);
  }

  .todo-item.in_progress {
    color: var(--og-accent, #89b4fa);
    font-weight: 500;
  }

  .todo-status-icon {
    font-family: var(--vscode-editor-font-family, monospace);
    flex: 0 0 auto;
    width: 12px;
    display: inline-block;
  }

  .todo-content {
    flex: 1 1 auto;
    /* min-width:0 lets the flex item shrink below its content size so the
       ellipsis actually engages — without it a long todo overflows the strip
       (runs off-screen) instead of truncating. */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .todo-active-form {
    color: var(--og-muted, #6c7086);
    font-style: italic;
    font-size: 11px;
    /* Shrinkable + single-line. Previously `flex: 0 0 auto` with no truncation,
       so a long active-form pushed the row off-screen and wrapped in muted
       italic — reading as a big blank gap above the rest of the list. */
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

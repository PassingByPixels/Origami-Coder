<script lang="ts">
  // ONE row of the todo strip: the status glyph, the task text, its nesting
  // indent, and — on a row that has children — how many of them are done.
  //
  // EXTRACTED from TodoStrip.svelte, which had ONE line of slack (359/360) when
  // nesting landed. The ratchet's remedy is a module, not a raise, and the seam
  // was already there: the strip owns the panel, the header, the drawer and the
  // collapse; a row owns nothing but itself. The same split SubagentDrawer.svelte
  // took when its dismiss button landed in SubagentRow.svelte instead.
  //
  // The indent is an INLINE padding-left, not one CSS class per level: depth is
  // data with a known ceiling, and four hand-written rules that had to stay in
  // step with todoTree.ts's INDENT_PX would be a mirror with no drift guard. It
  // sits on the <li> and deliberately NOT on .todo-content, which is the
  // ellipsis flex cell — padding there is eaten by the truncation instead of
  // moving the row.
  import { INDENT_PX } from './todoTree';

  interface Props {
    content: string;
    activeForm: string;
    status: 'pending' | 'in_progress' | 'completed';
    /** Already normalised by todoTree's `annotate` — safe to multiply. */
    depth: number;
    childDone: number;
    childTotal: number;
    /** Whether this row's subtree is hidden. Only read when childTotal > 0. */
    collapsed?: boolean;
    onToggle?: () => void;
  }
  let { content, activeForm, status, depth, childDone, childTotal, collapsed = false, onToggle }: Props = $props();

  const STATUS_ICON: Record<Props['status'], string> = {
    pending: '☐',
    in_progress: '▶',
    completed: '✓',
  };
</script>

<li class="todo-item {status}" style="padding-left: {depth * INDENT_PX}px" data-depth={depth}>
  {#if childTotal > 0}
    <!-- A row with children is a CONTAINER: it shuts like a folder. The strip owns the flag (it drops the subtree), this owns the affordance. -->
    <button class="todo-twisty" aria-expanded={!collapsed} onclick={onToggle}
      aria-label={collapsed ? 'Expand sub-tasks' : 'Collapse sub-tasks'}>{collapsed ? '▸' : '▾'}</button>
  {/if}
  <span class="todo-status-icon">{STATUS_ICON[status]}</span>
  <span class="todo-content">{content}</span>
  {#if childTotal > 0}
    <!-- The row's OWN status stays whatever the model set it to. This counts its
         children (direct and transitive), so a branch that is half done is
         visible on the parent line rather than only in the rows under it. -->
    <span class="todo-child-count" title="{childDone} of {childTotal} sub-tasks done">{childDone}/{childTotal}</span>
  {/if}
  {#if status === 'in_progress' && activeForm}
    <span class="todo-active-form">— {activeForm}</span>
  {/if}
</li>

<style>
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

  /* The container twisty. Same muted weight as the chip: an affordance about the row,
     not another thing on it. A leaf has none — the depth indent lines the tree up. */
  .todo-twisty {
    flex: 0 0 auto;
    width: 10px;
    padding: 0;
    font-size: 9px;
    line-height: 1;
    color: var(--og-muted, #6c7086);
    background: none;
    border: none;
    cursor: pointer;
  }
  .todo-twisty:hover {
    color: var(--og-accent, #89b4fa);
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

  /* The sub-task tally. Same muted treatment as the header's own done-count so
     it reads as metadata about the row, not as another task on it. */
  .todo-child-count {
    flex: 0 0 auto;
    font-size: 10px;
    color: var(--og-muted, #6c7086);
    border: 1px solid var(--og-border, #45475a);
    border-radius: 8px;
    padding: 0 5px;
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

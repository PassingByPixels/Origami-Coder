<script lang="ts">
  // Phase 1 dashboard upgrade (2026-05-22) — webview consumer for the
  // Phase 6.5 task-shape decomposition. The runtime emits this on
  // every turn that's complex enough to be broken into sub-tasks; the
  // ACP wire ships it as `SessionUpdate::Plan` with
  // `_meta.origami_kind = "task_shape"`. acpClient.ts has long
  // parsed it and DashboardPanel.ts has forwarded it — but until now
  // ChatPane.svelte had no `case 'taskShape':` handler so it dropped
  // on the floor. Closes the TODO at DashboardPanel.ts:1035.
  //
  // Visual pattern mirrors TodoStrip.svelte deliberately so the two
  // sit comfortably next to each other in the chat header. The
  // distinction: Todos are the model's user-facing checklist (what
  // it's PROMISING to do); TaskShape is the harness's automatic
  // decomposition (what the harness THINKS the work breaks into).
  // Different provenance, same shape.

  interface SubTaskView {
    id: number;
    description: string;
    status: string; // pending | in_progress | done | blocked
  }

  interface Props {
    subTasks: SubTaskView[];
    source: string; // heuristic | model_declared | merged
    truncatedExtra: number;
  }

  let { subTasks, source, truncatedExtra }: Props = $props();

  const STATUS_ICON: Record<string, string> = {
    pending: '☐',
    in_progress: '▶',
    done: '✓',
    blocked: '✕',
  };

  function counts(items: SubTaskView[]) {
    let p = 0, i = 0, d = 0, b = 0;
    for (const t of items) {
      if (t.status === 'pending') p++;
      else if (t.status === 'in_progress') i++;
      else if (t.status === 'done') d++;
      else if (t.status === 'blocked') b++;
    }
    return { pending: p, in_progress: i, done: d, blocked: b };
  }

  const SOURCE_LABEL: Record<string, string> = {
    heuristic: 'harness-inferred',
    model_declared: 'declared by agent',
    merged: 'agent + harness',
  };
</script>

{#if subTasks.length > 0}
  {@const cnt = counts(subTasks)}
  <div class="taskshape-strip" title={SOURCE_LABEL[source] ?? source}>
    <div class="taskshape-header">
      <span class="taskshape-icon">◇</span>
      <span class="taskshape-title">Subtasks</span>
      <span class="taskshape-counts">
        {cnt.done}/{subTasks.length} done
        {#if cnt.in_progress > 0}· {cnt.in_progress} active{/if}
        {#if cnt.blocked > 0}· {cnt.blocked} blocked{/if}
      </span>
    </div>
    <ul class="taskshape-list">
      {#each subTasks as t (t.id)}
        <li class="taskshape-item {t.status}">
          <span class="taskshape-status-icon">{STATUS_ICON[t.status] ?? '·'}</span>
          <span class="taskshape-description">{t.description}</span>
        </li>
      {/each}
      {#if truncatedExtra > 0}
        <li class="taskshape-item truncated">
          <span class="taskshape-status-icon">…</span>
          <span class="taskshape-description">(+{truncatedExtra} more)</span>
        </li>
      {/if}
    </ul>
  </div>
{/if}

<style>
  .taskshape-strip {
    padding: 8px 12px;
    background: var(--og-surface, #1e1e2e);
    border-left: 3px solid var(--og-secondary, #f9e2af);
    border-radius: 4px;
    margin: 0 0 8px 0;
  }

  .taskshape-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 12px;
    color: var(--og-text, #cdd6f4);
  }

  .taskshape-icon {
    font-size: 13px;
    opacity: 0.7;
    color: var(--og-secondary, #f9e2af);
  }

  .taskshape-title {
    flex: 0 0 auto;
  }

  .taskshape-counts {
    font-size: 11px;
    font-weight: 400;
    color: var(--og-muted, #6c7086);
  }

  .taskshape-list {
    list-style: none;
    margin: 6px 0 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .taskshape-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 12px;
    color: var(--og-text, #cdd6f4);
    line-height: 1.4;
  }

  .taskshape-item.done {
    color: var(--og-muted, #6c7086);
    text-decoration: line-through;
    text-decoration-color: var(--og-muted, #6c7086);
  }

  .taskshape-item.in_progress {
    color: var(--og-secondary, #f9e2af);
    font-weight: 500;
  }

  .taskshape-item.blocked {
    color: var(--og-error, #f38ba8);
    font-style: italic;
  }

  .taskshape-item.truncated {
    color: var(--og-muted, #6c7086);
    font-style: italic;
  }

  .taskshape-status-icon {
    font-family: var(--vscode-editor-font-family, monospace);
    flex: 0 0 auto;
    width: 12px;
    display: inline-block;
  }

  .taskshape-description {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

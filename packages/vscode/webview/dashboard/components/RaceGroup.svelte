<script lang="ts">
  // Agent Manager race cluster header (S6c; Compare reworked S6d) — extracted from
  // AgentManagerPane (at its line cap). Siblings of one race group cluster under
  // this slim header; it carries the count, a Compare button, and — once any
  // sibling has been merged (a clean apply-to-main) — "Prune rest" to discard the
  // losing siblings. S6d: Compare no longer toggles an in-column numbers table
  // (Passing's UAT: it didn't let him SEE the difference); it posts amOpenCompare,
  // which opens a real side-by-side diff SCREEN in its own editor tab (one per
  // group, reused on re-click). The member CARDS still render in the pane.

  interface Sibling { id: string; name: string; mergedAt: number; adds: number; dels: number; state: string; agentName: string; model: string; }
  interface Props {
    base: string;
    count: number;
    repoRoot: string;
    groupId: string;
    siblings: Sibling[];
    post: (msg: Record<string, unknown>) => void;
  }
  let { base, count, repoRoot, groupId, siblings, post }: Props = $props();

  const groupMerged = (): boolean => siblings.some((s) => s.mergedAt > 0);
  function openCompare(): void {
    // Snapshot the siblings for the tab; the screen fetches live per-file diffs.
    post({ type: 'amOpenCompare', params: { root: repoRoot, groupId, base, siblings: siblings.map((s) => ({ id: s.id, name: s.name, state: s.state, agentName: s.agentName, model: s.model })) } });
  }
  function pruneRest(): void {
    // Keep the merged winner; discard every OTHER sibling (worktree AND branch).
    for (const s of siblings) {
      if (s.mergedAt > 0) continue;
      post({ type: 'amDelete', root: repoRoot, id: s.id, deleteBranch: true });
    }
  }
</script>

<div class="am-group">
  <span class="am-group-head" title="A multi-model race — these siblings ran the same task">⚡ race · {base} · {count}</span>
  <button class="am-group-compare"
    title="Compare two siblings' changes side-by-side in a new tab" onclick={openCompare}>Compare</button>
  {#if groupMerged()}
    <button class="am-group-prune" title="Discard the other variants' worktrees and branches — their work is gone"
      onclick={pruneRest}>Prune rest</button>
  {/if}
</div>

<style>
  .am-group {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 2px;
    padding: 2px 6px;
    border-left: 2px solid var(--og-accent, #3b6ea5);
  }
  .am-group-head { font-size: 11px; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .am-group-compare {
    background: transparent;
    color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.2));
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }
  .am-group-compare:hover { filter: brightness(1.2); }
  .am-group-prune {
    background: transparent;
    color: #ff9d9d;
    border: 1px solid rgba(192, 80, 80, 0.4);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }
  .am-group-prune:hover { background: rgba(192, 80, 80, 0.18); }
</style>

<script lang="ts">
  // The Labyrinth pane's two views, as two pills.
  //
  // Presentation only. The pane owns which one is picked, the same rule every
  // other Labyrinth control follows (LabyrinthMapToolbar.svelte).
  import type { LabyrinthView } from './labyrinthView';

  let { view, onView }: { view: LabyrinthView; onView: (v: LabyrinthView) => void } = $props();

  const PILLS: Array<{ id: LabyrinthView; label: string; title: string }> = [
    { id: 'labyrinth', label: 'Labyrinth', title: 'Review a past run as a map of its steps' },
    { id: 'glidepath', label: 'Glidepath', title: 'Plan usage against each connection’s own reset window' },
  ];
</script>

<div class="lab-head-pills">
  {#each PILLS as p (p.id)}
    <button class="lab-pill" class:active={view === p.id} title={p.title}
      aria-pressed={view === p.id} onclick={() => onView(p.id)}>{p.label}</button>
  {/each}
</div>

<style>
  .lab-head-pills { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .lab-pill { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text-secondary); border-radius: 4px; padding: 3px 12px; font-size: 11px; cursor: pointer; font-family: inherit; }
  .lab-pill:hover { color: var(--og-text); }
  .lab-pill.active { background: var(--og-accent); color: var(--og-text); border-color: var(--og-accent); }
</style>

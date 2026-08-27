<script lang="ts">
  // A COLLAB's member runs, under the one header that maps them merged.
  //
  // Extracted from LabyrinthRunIndex.svelte, which was at its architecture cap
  // when the price gear landed — the same split LabyrinthRunSearch.svelte took
  // out of it when the filter landed.
  //
  // Grouping adds a way in and never takes one away: a member's own map answers
  // "what did THIS agent do", which the merged map cannot. So every member stays
  // individually pickable, and the expander is a disclosure, not a filter.
  //
  // Presentation only — the parent owns the open set and the selection.
  // Colours are theme vars ONLY.
  import { whenLabel, type CollabRow } from './labyrinthCollabIndex';

  let {
    members, selected, open, onToggle, onSelect,
  }: {
    members: CollabRow[];
    selected: string | null;
    open: boolean;
    onToggle: () => void;
    onSelect: (sessionId: string) => void;
  } = $props();
</script>

<button class="lab-expand" aria-expanded={open} onclick={onToggle}>{open ? '-' : '+'} {members.length} member runs</button>
{#if open}
  {#each members as m (m.sessionId)}
    <button class="lab-run lab-member" class:selected={selected === m.sessionId} aria-current={selected === m.sessionId ? 'true' : undefined} onclick={() => onSelect(m.sessionId)}>
      <span class="lab-run-title">{m.agentSlug || m.title}</span>
      <span class="lab-run-meta">{#if m.updatedAt}<span>{whenLabel(m.updatedAt)}</span>{/if}</span>
    </button>
  {/each}
{/if}

<style>
  /* Repeated from LabyrinthRunIndex.svelte, not shared: Svelte scopes <style>
     per component, so a row that appears at two boundaries needs its rules at
     each of them. Every value is a theme var. */
  .lab-run { display: flex; flex-direction: column; gap: 3px; text-align: left; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 8px 9px; cursor: pointer; color: var(--og-text); font-family: inherit; }
  .lab-run:hover { border-color: var(--og-chat); }
  .lab-run.selected { border-color: var(--og-accent); background: var(--og-surface-alt); }
  .lab-run-title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lab-run-meta { display: flex; gap: 6px; align-items: center; font-size: 9px; color: var(--og-text-muted); }
  .lab-expand { align-self: flex-start; background: none; border: none; color: var(--og-text-muted); font-family: inherit; font-size: 9px; cursor: pointer; padding: 0 2px 2px 10px; }
  .lab-expand:hover { color: var(--og-text); }
  .lab-run.lab-member { margin-left: 12px; padding: 5px 8px; }
</style>

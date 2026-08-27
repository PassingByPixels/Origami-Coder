<script lang="ts">
  // The Folds selector, as CARDS. It replaces the pill bar: a pill was one per
  // registered PATH, so a repo checked out twice drew two of them, and it
  // carried working/blocked/queued counts that duplicated what the In progress
  // and Blocked columns already say two inches below. A card is one REPOSITORY
  // (every entry sharing a git common dir) and its face is deliberately lean —
  // the name and the branch its primary checkout is on, nothing else.
  //
  // Selecting a card fills the top strip's DETAIL pane (RepoDetail.svelte) with
  // that repository's checkouts and branches. 0.4.53 revealed them under the
  // card instead; UAT round 2 threw that out, so this file is now only the
  // strip of faces and nothing hangs off it.
  //
  // Selection itself posts NOTHING: which repo you are looking at is view state.
  // Only the ghost "+ Add repo" and a missing repo's unregister talk to the host.
  // Rename lives on the repo toolbar's pencil (RepoHeader), not on a card — a card
  // pencil shipped in round 4 and UAT round 5 removed it as noise.
  import type { RepoBoard } from './boardBuckets';
  import { groupRepos } from './repoGroups';

  interface Props {
    repos: RepoBoard[];
    displayNames: Record<string, string>;
    selected: string;
    onselect: (root: string) => void;
    post: (msg: Record<string, unknown>) => void;
  }
  let { repos, displayNames, selected, onselect, post }: Props = $props();

  let cards = $derived(groupRepos(repos));
  const label = (r: RepoBoard): string => displayNames[r.root] ?? r.name;
  /** A card is open when the pane's selected root is any entry of this card. */
  const isOpen = (c: { entries: RepoBoard[] }): boolean => c.entries.some((e) => e.root === selected);
</script>

<div class="am-cards">
  {#each cards as card (card.key)}
    {@const lead = card.lead}
    {@const open = isOpen(card)}
    <div class="am-repocard-wrap" class:missing={lead.missing}>
      <button class="am-repocard" class:on={open} aria-pressed={open}
        title={card.entries.map((e) => e.root).join('\n')}
        onclick={() => onselect(lead.root)}>
        <span class="am-repocard-name">{label(lead)}{lead.workspace ? ' (this window)' : ''}</span>
        {#if lead.missing}
          <span class="am-repocard-branch">folder missing from disk</span>
        {:else}
          <span class="am-repocard-branch">{lead.branch || 'detached'}</span>
        {/if}
      </button>
      {#if lead.missing}
        <button class="am-repocard-x" title="Unregister from the board — worktrees on disk are untouched"
          aria-label="Unregister {lead.name}" onclick={() => post({ type: 'amRemoveRepo', root: lead.root })}>✕</button>
      {/if}
    </div>
  {/each}
  <button class="am-repocard ghost" title="Register another repository — it does not need to be open in this window"
    onclick={() => post({ type: 'amAddRepo' })}>+ Add repo</button>
</div>

<style>
  /* TWO rows, filled COLUMN first (UAT round 3). One short row of cards floated
     in a pane tall enough for two, so the strip wasted the height it already
     had. An extra card now adds a COLUMN, never a third row, and `.am-strip`
     around it is still the element that scrolls — so the board below never
     moves. The two rows SHARE the strip's height (`1fr` each, never smaller
     than a card), which is what makes the pane read as two cards tall. */
  .am-cards {
    display: grid;
    grid-template-rows: repeat(2, minmax(min-content, 1fr));
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    gap: 8px;
    height: 100%;
  }
  .am-repocard-wrap { display: inline-flex; align-items: stretch; }
  .am-repocard-wrap.missing { opacity: 0.55; }
  .am-repocard {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 132px;
    padding: 4px 10px;
    background: var(--og-surface, rgba(255, 255, 255, 0.06));
    color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .am-repocard:hover { filter: brightness(1.15); }
  .am-repocard.on { border-color: var(--og-accent, #3b6ea5); background: var(--og-accent, #3b6ea5); }
  .am-repocard.ghost { border-style: dashed; background: transparent; justify-content: center; min-width: 0; }
  .am-repocard-name { font-size: 12px; font-weight: 600; white-space: nowrap; }
  .am-repocard-branch { font-size: 10px; opacity: 0.75; white-space: nowrap; }
  .am-repocard-x {
    align-self: center; margin-left: -6px; padding: 1px 5px; font-size: 11px;
    background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer;
    color: #ff9d9d;
  }
  .am-repocard-x:hover { border-color: #c05050; }
</style>

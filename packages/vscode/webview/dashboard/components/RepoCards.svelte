<script lang="ts">
  // The Folds selector, as CARDS. It replaces the pill bar: a pill was one per
  // registered PATH, so a repo checked out twice drew two of them, and it
  // carried working/blocked/queued counts that duplicated what the In progress
  // and Blocked columns already say two inches below. A card is one REPOSITORY
  // (every entry sharing a git common dir) and its face is deliberately lean —
  // the name, nothing else. The branch line came off in t-qn09vr (round-3
  // change 51): the primary's branch is already RepoDetail's own line.
  //
  // Selecting a card fills the top strip's DETAIL pane (RepoDetail.svelte) with
  // that repository's checkouts and branches. 0.4.53 revealed them under the
  // card instead; UAT round 2 threw that out, so this file is now only the
  // strip of faces and nothing hangs off it.
  //
  // Selection itself posts NOTHING: which repo you are looking at is view state.
  // Only the ghost "+ Add repo" and a missing repo's unregister talk to the host;
  // the unregister ✕ is RepoRemoveControl, so it asks with the toolbar's confirm.
  // Rename lives on the repo toolbar's pencil (RepoHeader), not on a card — a card
  // pencil shipped in round 4 and UAT round 5 removed it as noise.
  import type { RepoBoard } from './boardBuckets';
  import { groupRepos } from './repoGroups';
  import RepoCarousel from './RepoCarousel.svelte';
  import WorktreeDot from './WorktreeDot.svelte'; // t-ru1i84 — same host message as the composer's pill
  import RepoRemoveControl from './RepoRemoveControl.svelte';

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
  <RepoCarousel rows={2}>
    {#each cards as card (card.key)}
      {@const lead = card.lead}
      {@const open = isOpen(card)}
      <div class="am-repocard-wrap" class:missing={lead.missing}>
        <button class="am-repocard" class:on={open} aria-pressed={open}
          title={card.entries.map((e) => e.root).join('\n')}
          onclick={() => onselect(lead.root)}>
          <span class="am-repocard-name">{label(lead)}{lead.workspace ? ' (this window)' : ''}</span>
          <WorktreeDot dir={lead.root} counts />
        </button>
        {#if lead.missing}
          <RepoRemoveControl name={label(lead)} root={lead.root} post={post} card />
        {/if}
      </div>
    {/each}
    <button class="am-repocard ghost" title="Register another repository — it does not need to be open in this window"
      onclick={() => post({ type: 'amAddRepo' })}>+ Add repo</button>
  </RepoCarousel>
</div>

<style>
  /* A two-row grid of FIXED cards (t-qn09vr, round-3 change 50): every card is
     the same 156x52 object at the same size, so twice as many repos fit in
     the same strip and the eye stops measuring card widths against each
     other. Replaces the single stretched-height row from t-q8zufa/change 7. */
  .am-cards {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    height: 100%;
  }
  .am-repocard-wrap { display: inline-flex; align-items: stretch; }
  .am-repocard-wrap.missing { opacity: 0.55; }
  .am-repocard {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    width: 156px;
    height: 52px;
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
  .am-repocard.ghost { border-style: dashed; background: transparent; justify-content: center; }
  .am-repocard-name {
    font-size: 12px; font-weight: 600;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; line-height: 1.25;
  }
</style>

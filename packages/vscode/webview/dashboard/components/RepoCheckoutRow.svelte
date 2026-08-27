<script lang="ts">
  // ONE checkout of the selected repository, and the three things you do to it:
  // open a terminal in it, start a chat in it, or make it the primary — the
  // checkout that owns this repository's tickets, folds and apply.
  //
  // Split out of RepoDetail.svelte at UAT round 3, which read that pane as "busy
  // and disorganized". A row is now the SAME two lines every time — name +
  // badges, then branch — instead of a wrap that put those and three buttons on
  // three ragged lines lining up with nothing above or below them. A long name
  // or branch ellipsizes and keeps the full text in its tooltip.
  //
  // The three actions sit in ONE right-aligned cluster that fades in on hover or
  // on keyboard focus, so a row at rest is two lines of text and not five
  // controls. The PRIMARY row keeps its cluster on: it is the row you use most,
  // and it is what tells you the rows under it have actions at all.
  import type { WorktreeRowInfo } from './repoGroups';

  interface Props {
    /** The selected ENTRY's root. Every action is keyed by it — the same key the
     *  card's old reveal used, so the host routes unchanged. */
    root: string;
    /** This checkout, as the host read it. */
    wt: WorktreeRowInfo;
    post: (msg: Record<string, unknown>) => void;
  }
  let { root, wt, post }: Props = $props();
</script>

<div class="am-wtrow" class:is-primary={wt.primary}>
  <div class="am-wtline">
    <span class="am-wtrow-name" title={wt.path}>{wt.name}</span>
    {#if wt.primary}<span class="am-wtbadge primary">primary</span>{/if}
    {#if wt.fold}<span class="am-wtbadge fold">fold</span>{/if}
  </div>
  <div class="am-wtline">
    <span class="am-wtrow-branch" title={wt.branch}>{wt.branch || 'detached'}</span>
    <span class="am-wtrow-actions">
      <button class="am-wtact" title="Open a terminal in {wt.path}"
        onclick={() => post({ type: 'amWorktreeTerminal', root, path: wt.path })}>Terminal</button>
      <button class="am-wtact" title="Start a new chat with this worktree as its working directory"
        onclick={() => post({ type: 'amWorktreeChat', root, path: wt.path })}>Chat here</button>
      {#if !wt.primary}
        <button class="am-wtact" title="Make this checkout the primary — it takes over this repository's tickets, folds and apply"
          onclick={() => post({ type: 'amMakePrimary', root, path: wt.path })}>Make primary</button>
      {/if}
    </span>
  </div>
</div>

<style>
  /* Two FIXED lines on one alignment grid, never a wrap: the pane is under
     300px, so a wrapping row is a ragged row. `flex: none` because the pane is
     the scroller — a row must not be squeezed to fit instead. */
  .am-wtrow { flex: none; display: flex; flex-direction: column; gap: 1px; font-size: 10px; padding: 4px 4px 4px 6px; border-radius: 4px; }
  .am-wtrow:hover { background: var(--og-btn-bg, rgba(255, 255, 255, 0.05)); }
  /* The primary is marked TWICE and quietly: a raised ground and a 2px accent
     spine down its left edge. `--og-surface-alt` was the other candidate and it
     is DARKER than the pane in every theme — a recess, which reads as disabled. */
  .am-wtrow.is-primary {
    background: var(--og-btn-bg, rgba(255, 255, 255, 0.05));
    box-shadow: inset 2px 0 0 var(--og-accent, #3b6ea5);
  }
  .am-wtline { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .am-wtrow-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am-wtrow-branch { flex: 1 1 auto; min-width: 0; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am-wtbadge { flex: none; font-size: 9px; border-radius: 8px; padding: 0 5px; background: var(--og-border, rgba(255, 255, 255, 0.12)); }
  .am-wtbadge.primary { background: var(--og-accent, #3b6ea5); }
  /* The cluster stays in the DOM and stays FOCUSABLE: opacity ONLY, never
     `display: none` or `visibility: hidden`. So the layout cannot jump on hover,
     and a keyboard user who tabs into a row reveals it through :focus-within. */
  .am-wtrow-actions { flex: none; display: inline-flex; gap: 3px; margin-left: auto; opacity: 0; transition: opacity 0.1s ease; }
  .am-wtrow:hover .am-wtrow-actions,
  .am-wtrow:focus-within .am-wtrow-actions,
  .am-wtrow.is-primary .am-wtrow-actions { opacity: 1; }
  .am-wtact {
    background: transparent;
    color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    border-radius: 4px;
    padding: 0 4px;
    font: inherit;
    font-size: 9px;
    white-space: nowrap;
    cursor: pointer;
  }
  .am-wtact:hover { border-color: var(--og-accent, #3b6ea5); }
</style>

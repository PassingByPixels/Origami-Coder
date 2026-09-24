<script lang="ts">
  // One row of the Labyrinth's run index: the card you pick a run with,
  // and the control that deletes it. Extracted from LabyrinthRunIndex.svelte
  // to stay under its architecture cap; style rules came across verbatim.
  //
  // Delete is armed, never immediate: it is the only control here that
  // destroys stored data, so a first click only asks and a second,
  // differently-labelled button posts it. Confirm stays inline (not a
  // modal) since the index scrolls and a modal can't show which of forty rows you armed.
  //
  // A collab header gets no delete: its id names a group, not a session,
  // so deleting it would mean every member run — a separate action. The
  // host refuses a `collab:` id too, so the two agree.
  //
  // The × is gone (change 2): the row SWIPES left to reveal Delete, and the
  // swipe ARMS the same confirm the × used to. That is deliberate — a gesture
  // that destroys stored data outright would be a worse control than the
  // button it replaced, so the two-step stays. The action keeps the `lab-del`
  // class, because it is still that control.
  //
  // Presentation plus one armed state; the parent owns the wire, this
  // component only calls back. Colours are theme vars only.
  import SwipeRow from '../../shared/SwipeRow.svelte';
  import { whenLabel } from './labyrinthCollabIndex';
  import { healthLabel, runCacheHealth, type RunStatRow } from './labyrinthHealth';

  let {
    title, subtitle = '', folder = '', updatedAt = '', collab = false, selected = false,
    mark = '', markTitle = '', stat, onSelect, onDelete,
  }: {
    title: string;
    subtitle?: string;
    folder?: string;
    updatedAt?: string;
    collab?: boolean;
    selected?: boolean;
    /** The two letters marking a non-engine run — `CC` for a Claude Code
     *  transcript (History popup's same mark). Empty on an engine run, so titles still line up. */
    mark?: string;
    markTitle?: string;
    /** This run's counts, or nothing — an absent row draws no cell, not a 0%. */
    stat?: RunStatRow;
    onSelect: () => void;
    /** Absent = this row cannot be deleted (a collab header, or a surface that
     *  did not wire the control at all). */
    onDelete?: () => void;
  } = $props();

  let confirming = $state(false);
  const deletable = $derived(!!onDelete && !collab);
  function commit(): void {
    confirming = false;
    onDelete?.();
  }
</script>

<div class="lab-row">
  <SwipeRow enabled={deletable} actionLabel={`Delete ${title}`} actionText="Delete" actionClass="lab-del" onAction={() => (confirming = !confirming)}>
    {#snippet children()}
  <button class="lab-run" class:selected class:is-collab={collab} aria-current={selected ? 'true' : undefined} onclick={onSelect}>
    <span class="lab-run-title">{#if mark}<span class="lab-mark" title={markTitle}>{mark}</span>{/if}{title}</span>
    <span class="lab-run-meta">{#if subtitle}<span class="lab-agents">{subtitle}</span>{/if}{#if folder}<span class="lab-folder">{folder}</span>{/if}{#if updatedAt}<span>{whenLabel(updatedAt)}</span>{/if}{#if stat}<span class="lab-folder lab-health" class:warn={runCacheHealth(stat).warn} title="Share of prefill served from cache. A dash means this run cannot be read that way — the provider reported no cache tokens, or there were too few requests to mean anything.">cache {healthLabel(runCacheHealth(stat))}</span>{/if}</span>
  </button>
    {/snippet}
  </SwipeRow>
</div>
{#if confirming}
  <div class="lab-confirm" role="dialog" aria-label="Delete this chat?">
    <div class="lab-confirm-text">Delete this chat and its messages permanently? This cannot be undone.</div>
    <div class="lab-confirm-actions">
      <button class="lab-confirm-btn danger" onclick={commit}>Delete</button>
      <button class="lab-confirm-btn" onclick={() => (confirming = false)}>Cancel</button>
    </div>
  </div>
{/if}

<style>
  /* The row is the card PLUS its delete control, side by side — the card itself
     is a <button>, so the control cannot live inside it. */
  .lab-row { display: flex; align-items: stretch; gap: 4px; }
  /* Moved verbatim from LabyrinthRunIndex.svelte, with `flex`/`min-width` added
     so the card takes the row and a long title still ellipses. */
  .lab-run { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; text-align: left; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 8px 9px; cursor: pointer; color: var(--og-text); font-family: inherit; }
  .lab-run:hover { border-color: var(--og-chat); }
  .lab-run.selected { border-color: var(--og-accent); background: var(--og-surface-alt); }
  /* Dashed and dim, the language ControlStrip.svelte uses for the Claude Code
     square — a harness, not a connection we configured. Tone is never the only
     carrier: the two letters say it, and the title attribute says it in words. */
  .lab-mark { display: inline-block; margin-right: 5px; padding: 0 3px; font-size: 9px; font-weight: 600; letter-spacing: 0.04em; color: var(--og-text-muted); border: 1px dashed var(--og-border); border-radius: 3px; vertical-align: middle; }
  .lab-run-title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lab-run-meta { display: flex; gap: 6px; align-items: center; font-size: 9px; color: var(--og-text-muted); }
  .lab-folder { background: var(--og-btn-bg); border-radius: 3px; padding: 0 5px; color: var(--og-text-secondary); }
  /* A .lab-folder chip plus the WARNING tone — never tone alone: the number beside the word "cache" says it too. */
  .lab-health { font-variant-numeric: tabular-nums; } .lab-health.warn { color: var(--og-warning); }
  /* A seam down the edge, so a collab header is not read as just another run. */
  .lab-run.is-collab { border-left: 2px solid var(--og-accent-2); }
  .lab-agents { background: var(--og-accent-2); border-radius: 3px; padding: 0 5px; color: var(--og-text); }

  /* Muted until you reach for it: the row's job is to be picked, not deleted.
     The ARMED state is carried in the error tone AND in the confirm panel that
     opens under it — never in colour alone. */
  /* The delete control is SwipeRow.svelte's action now, and Svelte scopes CSS
     to the file that writes the markup, so its look lives there. */
  .lab-confirm { border: 1px solid var(--og-error); border-radius: 6px; padding: 8px 9px; display: flex; flex-direction: column; gap: 6px; background: var(--og-surface); }
  .lab-confirm-text { font-size: 11px; line-height: 1.5; color: var(--og-text); }
  .lab-confirm-actions { display: flex; gap: 6px; }
  .lab-confirm-btn { font-size: 11px; padding: 3px 9px; background: var(--og-btn-bg); color: var(--og-text-secondary); border: 1px solid var(--og-border); border-radius: 5px; cursor: pointer; font-family: inherit; }
  .lab-confirm-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  .lab-confirm-btn.danger { color: var(--og-error); border-color: var(--og-error); }
</style>

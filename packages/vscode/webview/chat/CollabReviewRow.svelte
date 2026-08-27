<script lang="ts">
  // The human's VERDICT on a finished task, offered where the work landed
  // (W3 wave 3, report 2.4).
  //
  // The flow rail already renders a `task_done` as `Crane → board · finished a
  // task`: the protocol knew the work was now waiting on a human, and the room
  // offered no way to be that human. The board drawer's Accept/Reopen was the
  // only answer, two clicks away behind a pull-tab.
  //
  // WHY `collab_review` AND NOT `collab_task_update`. Both run the same two
  // board transitions, but review is the VERDICT path: it accepts a verdict
  // only on a completed task, and it refuses a reject with no reason. The
  // reason is what makes the reopened row usable — without it the owner reads
  // "reopened task: write the migration" and knows only that the human was
  // unhappy, not what has to change.
  //
  // THE NOTE IS ASKED FOR BEFORE THE CALL, exactly as TaskBoard's own reopen
  // does it: the engine's refusal would arrive a round trip later, by which
  // time there is nothing on screen to correct.
  //
  // Approve takes no note at all here. `collab_review` allows one, but a field
  // nobody has to fill, on the button that CLOSES the task, is a step added to
  // the common path for a comment no agent is woken to read.

  interface Props {
    taskId: string;
    /** The SHORT name of whoever finished it — the row says whose work this is. */
    name: string;
    onReview: (taskId: string, verdict: 'approve' | 'reject', note?: string) => void;
  }
  let { taskId, name, onReview }: Props = $props();

  let rejecting = $state(false);
  let note = $state('');

  function reject() {
    const reason = note.trim();
    // Refused here as well as engine-side: an empty reason would take the whole
    // verdict with it, and the box would already have cleared.
    if (!reason) return;
    rejecting = false;
    note = '';
    onReview(taskId, 'reject', reason);
  }
</script>

<div class="cr-verdict">
  <span class="cr-ask">{name} is waiting on your verdict</span>
  <button class="cr-btn" onclick={() => onReview(taskId, 'approve', undefined)} title="Accept this result and close the task">Approve</button>
  <button class="cr-btn" class:is-open={rejecting} onclick={() => { rejecting = !rejecting; note = ''; }} title="Send it back with a reason the owner will read">Send back</button>
  {#if rejecting}
    <span class="cr-note">
      <input
        class="cr-input"
        placeholder="Why is it going back?"
        aria-label={`Why is it going back? (${name})`}
        bind:value={note}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); reject(); } }}
      />
      <button class="cr-btn" onclick={reject} disabled={!note.trim()}>Reject</button>
    </span>
  {/if}
</div>

<style>
  /* Sits directly under its own system row, indented to it: this is an action
     ON that line, not a new event in the transcript. */
  .cr-verdict {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    padding: 1px 2px 3px 14px;
    font-size: 10px;
  }
  /* The warning tone the task board already uses for "a human's attention is
     owed here", so the two surfaces say the same thing the same way. */
  .cr-ask { color: var(--og-warning); }
  .cr-btn {
    font-size: 10px;
    padding: 1px 8px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    flex: 0 0 auto;
  }
  .cr-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  .cr-btn.is-open { border-color: var(--og-accent); color: var(--og-accent); }
  .cr-btn:disabled { opacity: 0.45; cursor: default; border-color: var(--og-border); }

  .cr-note { display: flex; gap: 6px; flex: 1 1 100%; padding-top: 2px; }
  .cr-input {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: 11px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    padding: 2px 6px;
    outline: none;
  }
  .cr-input:focus { border-color: var(--og-accent); }
</style>

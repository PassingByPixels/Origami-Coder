<script lang="ts">
  // The composer's one-line answer to "where did my message go?", in two states.
  //
  // "interjecting…" — what is LEFT of QueuedChip.svelte after the queue it was
  // named for was retired: no queued text, no button, no ✕, because Enter IS the
  // gesture and a line handed to the host cannot be taken back. Not decoration:
  // the row waits for the host answer (interjectSplit.ts) and Enter clears the
  // composer at once, so the words would be nowhere for one round trip.
  //
  // The REASON — the same slot saying the opposite: this line is not on its way
  // in, and here is why (interjectHold.ts owns the sentence). A dead Send with
  // no word was the defect a picture attached mid-turn used to hit (t-4ahs3u).

  interface Props {
    /** At least one line is with the host, unanswered. */
    interjecting?: boolean;
    /** Why the last mid-turn Enter did not go into the turn. Empty = nothing to say. */
    reason?: string;
  }

  let { interjecting = false, reason = '' }: Props = $props();
</script>

{#if interjecting}
  <div class="interjecting-chip" title="Delivering this message into the running turn">
    <span class="chip-label">Interject</span>
    <span class="chip-text">interjecting…</span>
  </div>
{:else if reason}
  <div class="interjecting-chip held" title="This draft stays in the composer">
    <span class="chip-label">Waiting</span>
    <span class="chip-text">{reason}</span>
  </div>
{/if}

<style>
  /* From the retired chip, minus the queue's dashed edge: ACTIVE reads SOLID. */
  .interjecting-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 12px 4px;
    padding: 3px 8px;
    font-size: 11px;
    background: var(--og-surface);
    border: 1px solid var(--og-accent);
    border-radius: 4px;
    color: var(--og-text-muted);
  }
  .chip-label {
    font-weight: 600;
    color: var(--og-accent);
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.5px;
  }
  .chip-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The refusal reads as a NOTE, not as work in progress: no accent edge. Its
     sentence WRAPS — a reason cut off at the composer's width cannot be read,
     which is the defect again in smaller type. */
  .interjecting-chip.held { border-color: var(--og-border, rgba(255, 255, 255, 0.18)); }
  .interjecting-chip.held .chip-label { color: var(--og-text-muted); }
  .interjecting-chip.held .chip-text { overflow: visible; white-space: normal; }
</style>

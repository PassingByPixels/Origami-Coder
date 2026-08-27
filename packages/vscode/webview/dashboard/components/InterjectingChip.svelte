<script lang="ts">
  // "interjecting…" — the one thing the composer shows between the keypress and
  // the host's answer. What is LEFT of QueuedChip.svelte after the queue it was
  // named for was retired: no queued text, because Enter no longer parks a line
  // to fire later; no Interject button, because Enter is the gesture; no ✕,
  // because a line already handed to the host cannot be taken back.
  //
  // It is not decoration. The transcript row deliberately waits for the host to
  // answer (interjectSplit.ts), and Enter clears the composer immediately — so
  // without this the user's words would be nowhere on screen for the length of
  // one ext-method round trip, which is exactly the "did that send?" the whole
  // change was meant to remove.

  interface Props {
    /** At least one line is with the host, unanswered. */
    interjecting?: boolean;
  }

  let { interjecting = false }: Props = $props();
</script>

{#if interjecting}
  <div class="interjecting-chip" title="Delivering this message into the running turn">
    <span class="chip-label">Interject</span>
    <span class="chip-text">interjecting…</span>
  </div>
{/if}

<style>
  /* Carried over from the retired chip, minus the queue's dashed edge: this
     state reads as ACTIVE, so the accent border is SOLID. */
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
</style>

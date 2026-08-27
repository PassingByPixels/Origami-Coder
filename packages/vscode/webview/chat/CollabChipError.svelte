<script lang="ts">
  // ONE chip's last-turn failure badge — extracted from CollabRosterChip.svelte
  // (W3 wave 3) when the error RING and the per-agent controls landed on the
  // same 175-line file. Its markup and its whole style block moved here
  // together, unchanged.
  //
  // WHY THE BADGE SURVIVES THE RING. F13's complaint is that a failure was ONLY
  // this 14px `!`, not that the badge is wrong: the ring now says THAT the last
  // turn failed and the stream says it out loud, while this still carries the
  // reason, in full, on demand. Three surfaces, one fact, no duplication —
  // each answers a different question.
  //
  // It draws for an ARCHIVED room and for a REMOVED participant too, unlike the
  // supervision controls beside it: a past failure stays true after the room
  // closes, where a Stop for a room that takes no posts would be a dead button.

  interface Props {
    /** The SHORT name — the label has to say whose failure this is. */
    name: string;
    text: string;
  }
  let { name, text }: Props = $props();

  let expanded = $state(false);
</script>

<button
  class="chip-error"
  title={text}
  aria-label={`Last error for ${name}`}
  onclick={() => (expanded = !expanded)}
>!</button>
{#if expanded}
  <span class="chip-error-text">{text}</span>
{/if}

<style>
  .chip-error {
    background: var(--og-error);
    color: var(--og-bg);
    border: none;
    border-radius: 999px;
    width: 14px;
    height: 14px;
    line-height: 1;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
    padding: 0;
  }
  /* Full row: an engine failure is a sentence, not a chip caption. */
  .chip-error-text {
    flex: 1 1 100%;
    font-size: 10px;
    color: var(--og-error-text);
  }
</style>

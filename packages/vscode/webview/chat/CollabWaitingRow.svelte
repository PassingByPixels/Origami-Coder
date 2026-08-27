<script lang="ts">
  // The standing "waiting on…" line at the foot of the stream (report 2.3).
  //
  // A room whose agents are all idle looks the same whether the work is FINISHED
  // or whether one agent is blocked on a question another never answered. This
  // row is the difference, and it stays on screen for as long as the wait does —
  // unlike the ask bubble, which scrolls away.
  //
  // Its own component rather than four lines in CollabStream.svelte, which is at
  // its architecture cap; the pairing rule itself is collabWaiting.ts, pure and
  // tested with no DOM.
  //
  // `nameOf` is the stream's resolver. `'user'` is the human's authorId by wire
  // contract (acpExtTypes: CollabMessage), so the caller maps it to "You" —
  // this row never prints a slug where a name belongs.
  import type { OpenAsk } from './collabWaiting';

  interface Props {
    asks: OpenAsk[];
    nameOf: (id: string) => string;
  }
  let { asks, nameOf }: Props = $props();
</script>

{#if asks.length > 0}
  <!-- role=status, not alert: this is a state the room is in, not an event that
       just happened, and it must not interrupt a screen reader mid-message. -->
  <div class="cs-waiting" role="status">
    <span class="cs-waiting-label">Waiting on</span>
    {#each asks as a, i (a.seq)}<span class="cs-waiting-pair"
      >{i > 0 ? ', ' : ''}{nameOf(a.to)}<span class="cs-waiting-from"> (asked by {nameOf(a.from)})</span></span
    >{/each}
  </div>
{/if}

<style>
  /* A muted, full-width footer rule — deliberately NOT a bubble: nobody said
     this, the room is in this state. The warning tone is the same one the task
     board uses for "sent back", i.e. "a human's attention is owed here". */
  .cs-waiting {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 5px;
    padding: 3px 4px;
    font-size: 10px;
    color: var(--og-warning);
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .cs-waiting-label { text-transform: uppercase; letter-spacing: 0.06em; }
  .cs-waiting-from { color: var(--og-text-muted); }
</style>

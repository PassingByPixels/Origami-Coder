<script lang="ts">
  // One chip's supervision controls: stop one agent, and correct one agent —
  // narrower than the room-wide `collab_stop`, which kills the whole chain.
  //
  // Its own component rather than more props on CollabRosterChip.svelte.
  //
  // Stop is offered only where it does something: `collab_stop_agent` on an
  // idle agent interrupts and dequeues nothing, so the button is absent
  // rather than disabled — a disabled control implies "you may do this later".
  //
  // Redirect is always offered while the room is live: it is a message, not
  // a control, so it is as legitimate for an idle agent as a running one.
  //
  // The outcome shows the engine's own words, not "Stopped.": the wording
  // rule lives in collabSupervision.ts, pure and tested with no DOM.

  interface Props {
    /** The short name the chip shows, so a roster of four is not four identical buttons. */
    name: string;
    /** Whether a turn exists to end (collabSupervision: canStopAgent). */
    canStop: boolean;
    onStop: () => void;
    onRedirect: (text: string) => void;
    /** What the last stop of this agent did, already worded; '' means nothing to say. */
    outcome: string;
    /** Whether this chip's correction box is the open one. The roster owns
     *  it: "one box at a time" means two open boxes would be two drafts. */
    open: boolean;
    onToggle: (open: boolean) => void;
  }
  let { name, canStop, onStop, onRedirect, outcome, open, onToggle }: Props = $props();

  let draft = $state('');

  function send() {
    const text = draft.trim();
    // The engine refuses an empty correction outright, so the box does not
    // offer to send one either.
    if (!text) return;
    draft = '';
    onToggle(false);
    onRedirect(text);
  }
</script>

{#if canStop}
  <button class="cc-btn stop" title={`Stop ${name}'s turn — the rest of the room keeps going`} aria-label={`Stop ${name}`} onclick={onStop}>&#9632;</button>
{/if}
<button
  class="cc-btn"
  class:is-open={open}
  title={`Send ${name} a correction — it goes to the front of its queue`}
  aria-label={`Redirect ${name}`}
  onclick={() => { draft = ''; onToggle(!open); }}
>&#8617;</button>

{#if open}
  <span class="cc-redirect">
    <input
      class="cc-input"
      placeholder={`Tell ${name} what to do instead…`}
      aria-label={`Correction for ${name}`}
      bind:value={draft}
      onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
    />
    <!-- The label NAMES the agent: the composer beside it has a Send of its
         own, and a roster of four would otherwise offer five identical ones. -->
    <button class="cc-btn" aria-label={`Send correction to ${name}`} onclick={send} disabled={!draft.trim()}>Send</button>
  </span>
{/if}

{#if outcome}
  <!-- role=status, not alert: a stop the user asked for is not an interruption
       to announce over whatever they are reading. -->
  <span class="cc-outcome" role="status">{outcome}</span>
{/if}

<style>
  /* Deliberately quieter than the chip they sit beside: supervision is
     available, not advertised. The square and the hook are glyphs rather than
     words because a roster row holds four of these and "Stop"/"Redirect" twice
     per agent would be wider than the names. Both carry aria-labels. */
  .cc-btn {
    background: none;
    border: none;
    padding: 0 2px;
    font-family: inherit;
    font-size: 10px;
    line-height: 1;
    color: var(--og-text-muted);
    cursor: pointer;
  }
  .cc-btn:hover { color: var(--og-text); }
  .cc-btn.stop:hover { color: var(--og-error); }
  .cc-btn.is-open { color: var(--og-accent); }
  .cc-btn:disabled { opacity: 0.45; cursor: default; }

  /* Full-width inside the chip's wrapper, so an open box pushes the roster down
     by one row rather than squeezing the names beside it. */
  .cc-redirect { display: flex; gap: 5px; flex: 1 1 100%; padding: 2px 0; }
  .cc-input {
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
  .cc-input:focus { border-color: var(--og-accent); }

  .cc-outcome {
    flex: 1 1 100%;
    font-size: 10px;
    color: var(--og-text-muted);
  }
</style>

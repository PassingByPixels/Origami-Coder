<script lang="ts">
  // ONE chip's supervision controls (W3 wave 3, report 2.4 / F7).
  //
  // Until wave 1 the only interrupt was `collab_stop` — the whole room's chain
  // killed and the hop budget spent — so steering one agent meant stopping
  // everyone. These are the two narrow methods that replaced that: stop ONE
  // agent, and correct ONE agent.
  //
  // ITS OWN COMPONENT, not four more props' worth of markup in
  // CollabRosterChip.svelte, which had 20 lines under its cap when the error
  // ring and these arrived together. Same extraction the chip itself made out
  // of CollabRoster at X2.
  //
  // STOP IS OFFERED ONLY WHERE IT DOES SOMETHING. `collab_stop_agent` on an
  // idle agent answers `{interrupted:false, dequeued:false}` — there is nothing
  // to end — so the button is absent rather than disabled: a disabled control
  // says "you may do this, later", which is not what idle means.
  //
  // REDIRECT IS OFFERED ALWAYS (while the room is live). It is a MESSAGE, not a
  // control — a human post addressed to one agent, which the engine also moves
  // to the front of that agent's queue — so it is as legitimate for an idle
  // agent as for a running one.
  //
  // THE OUTCOME IS THE ENGINE'S WORDS, not "Stopped.". The wording rule is
  // collabSupervision.ts, pure and tested with no DOM: a stop that interrupted
  // nothing and dequeued nothing has to read as already-idle.

  interface Props {
    /** The SHORT name the chip shows — every label here names the agent, so a
     *  roster of four does not offer four identical "Stop" buttons. */
    name: string;
    /** Whether a turn exists to end (collabSupervision: canStopAgent). */
    canStop: boolean;
    onStop: () => void;
    onRedirect: (text: string) => void;
    /** What the last stop of THIS agent did, already worded. '' for nothing to
     *  say — never a placeholder, which would leave a dead line under a chip. */
    outcome: string;
    /** Whether this chip's correction box is the open one. The ROSTER owns it,
     *  because "one box at a time" is a fact about the roster: two open boxes
     *  would be two drafts, and the second Send would be aimed at whichever the
     *  user last looked at. */
    open: boolean;
    onToggle: (open: boolean) => void;
  }
  let { name, canStop, onStop, onRedirect, outcome, open, onToggle }: Props = $props();

  let draft = $state('');

  function send() {
    const text = draft.trim();
    // The engine refuses an empty correction outright ("an empty correction
    // corrects nothing and would wake the target to read a blank line"), so
    // the box does not offer to send one either.
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

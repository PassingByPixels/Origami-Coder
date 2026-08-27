<script lang="ts">
  // The collab's BUDGET BAR — what is left of the hop budget, the loop-breaker
  // cap input, and STOP. Moved OUT of CollabControls.svelte and remounted as
  // the last child of the pane, directly under the composer.
  //
  // WHY UNDER THE COMPOSER: the budget is spent by posting, and STOP is the
  // control you reach for while you are looking at the box you just typed in.
  // Above the stream it was a header the eye scrolls past; here it sits where
  // the action that consumes it happens.
  //
  // Its own component rather than more markup in CollabPane.svelte, which sits
  // two lines under its architecture cap — the ratchet's remedy is a module.
  //
  // THE COUNT IS SERVER TRUTH. It moves when a poll lands and at no other time:
  // a client-side tick would run the number down while the engine's own budget
  // stood still, which is a countdown that lies between polls.
  import { capShort, capText, hopLow, hopText } from './collabHop';
  import CollabFlavorControl from './CollabFlavorControl.svelte';
  import CollabWidthControl from './CollabWidthControl.svelte';
  import type { CollabHopState } from '../../src/acpExtTypes';

  interface Props {
    /** null = the engine default, 0 = the breaker is OFF, N = that cap. */
    cap: number | null;
    /** What is LEFT of the budget. ABSENT on an older engine, which draws no
     *  count at all rather than inventing one. */
    hopState?: CollabHopState | null;
    /** W5: turns dispatched AT ONCE. null/absent = never set, which is serial. */
    concurrency?: number | null;
    /** W5-L2: what KIND of room this is. Absent on an engine without the mode. */
    flavor?: 'discuss' | 'council';
    archived: boolean;
    onSetCap: (cap: number | null) => void;
    onSetConcurrency: (concurrency: number) => void;
    onSetFlavor: (flavor: 'discuss' | 'council') => void;
    onStop: () => void;
  }
  let { cap, hopState = null, concurrency = null, flavor, archived, onSetCap, onSetConcurrency, onSetFlavor, onStop }: Props = $props();

  /** `bind:value` on a number input yields a NUMBER, or null when the box is
   *  empty — exactly the shape the cap needs, so it is kept, not stringified. */
  let capDraft = $state<number | null>(null);

  const capLine = $derived(capText(cap));
  const hopLine = $derived(hopText(hopState));
  const isLow = $derived(hopLow(hopState));

  function applyCap() {
    // A negative cap is not a setting. Refuse it rather than clamp it — the
    // nearest legal value is 0, which means "the breaker is OFF", and quietly
    // disabling a safety rail is the one wrong answer here.
    if (capDraft !== null && (!Number.isFinite(capDraft) || capDraft < 0)) return;
    onSetCap(capDraft);
  }
</script>

<div class="cap-row">
  <!-- The count first and loudest: it is the fact that changes, and the one a
       user acts on. The cap SETTING follows it as the quieter explanation. -->
  {#if hopLine}<span class="hop-text" class:is-low={isLow} title="Agent turns left before the collab waits for you again. Updates when the engine reports.">{hopLine}</span>{/if}
  <span class="cap-text" title={capLine}>{capShort(cap)}</span>
  <input
    class="cap-input"
    type="number"
    min="0"
    placeholder="default"
    bind:value={capDraft}
    aria-label="Loop breaker cap — blank for the default, 0 to turn it off"
    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCap(); } }}
  />
  <button class="cap-apply" onclick={applyCap}>Set cap</button>
  <!-- The DISPATCH WIDTH, beside the budget because the two answer the same
       question from opposite sides. Its rules are its own — see the component.
       ABSENT in a COUNCIL: a council round dispatches every member at once by
       construction, so "how many turns run at once" has no answer to set
       there, and drawing the control anyway is what sent Passing asking what
       it was for. Gated on the RESOLVED flavor from the poll, same as
       CollabFlavorControl below — never shown or hidden ahead of the engine. -->
  {#if flavor !== 'council'}
    <CollabWidthControl {concurrency} onApply={onSetConcurrency} />
  {/if}
  <!-- ...and what a turn IS. The third face of the same question the cap and
       the width answer, so it belongs beside them rather than in a settings
       drawer of its own. -->
  <CollabFlavorControl {flavor} {archived} onApply={onSetFlavor} />
  <!-- STOP interrupts the drain and spends the budget: the agents go quiet
       until the next human post. Dead on an archived collab, which is already
       quiet by construction. -->
  <button class="cap-apply stop-btn" onclick={onStop} disabled={archived} title="Interrupt the agents now — they stay quiet until you post again">Stop</button>
</div>

<style>
  /* Carried across from CollabControls.svelte with the markup — Svelte scopes
     styles per component, so the rules the row needs live here now. The border
     is on TOP rather than the bottom: this bar is the pane's last child. */
  .cap-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap; /* narrow pane: controls drop to tidy rows, never a crush */
    gap: 8px;
    padding: 5px 12px;
    border-top: 1px solid var(--og-border);
    flex-shrink: 0;
  }
  .cap-text { font-size: 10px; color: var(--og-text-muted); flex: 1 1 auto; white-space: nowrap; }
  /* The remaining count is the bar's headline — larger, monospaced and in the
     brand contrast, so it reads at a glance rather than as another caption. */
  .hop-text {
    font-size: 12px;
    font-weight: 600;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-chat);
    flex: 0 0 auto;
  }
  /* Nearly spent. A theme VAR, never a literal — a hard-coded warning colour is
     unreadable in at least one of the five themes, and this is the one state on
     the bar the user is meant to act on. */
  .hop-text.is-low { color: var(--og-warning); }
  .cap-input {
    width: 78px;
    font: inherit;
    font-size: 11px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    padding: 3px 6px;
    outline: none;
  }
  .cap-input:focus { border-color: var(--og-accent); }
  .cap-apply {
    font-size: 11px;
    padding: 3px 8px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .cap-apply:hover { border-color: var(--og-chat); color: var(--og-text); }
  .stop-btn:hover { border-color: var(--og-error); color: var(--og-text); }
  .stop-btn:disabled { opacity: 0.45; cursor: default; border-color: var(--og-border); }
</style>

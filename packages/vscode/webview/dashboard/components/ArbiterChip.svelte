<script lang="ts">
  // The single per-turn arbiter decision — exactly one chip, never a stack of
  // gate firings. EXTRACTED from ChatPane.svelte (2476 of its 2477-line cap)
  // when the pane needed room for the scroll anchor's wiring: the chip is a
  // self-contained leaf — one object in, one row out, no pane state — so it is
  // what the ratchet asks to move, and its rules travel with its markup.
  import { tip } from '../../shared/warmTip';

  interface Props {
    /** The wire's four values; anything else renders as "Ended". `incomplete`
     *  is not a wire value — ChatPane upgrades a chip to it from an errored or
     *  parked terminal verdict, which is why it has a case here. */
    decision: string;
    /** One line of why. Empty renders no reason and no tooltip. */
    reason: string;
  }
  let { decision, reason }: Props = $props();
</script>

<div class="arbiter-chip arbiter-{decision}" use:tip={reason}>
  <span class="arbiter-label">
    {#if decision === 'done'}Done
    {:else if decision === 'ask_user'}Ask user
    {:else if decision === 'incomplete'}Incomplete
    {:else if decision === 'continue'}Continue
    {:else}Ended{/if}
  </span>
  {#if reason}<span class="arbiter-reason">{reason}</span>{/if}
</div>

<style>
  /* Carried across from ChatPane.svelte with the markup — a Svelte <style> is
     scoped, so the rules have to live beside the element they dress. */
  .arbiter-chip {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 8px 0;
    padding: 4px 10px;
    font-size: 11px;
    border-radius: 6px;
    border-left: 3px solid var(--og-text-muted);
    background: var(--og-surface-alt);
  }
  .arbiter-chip.arbiter-done { border-left-color: var(--og-success); }
  .arbiter-chip.arbiter-continue { border-left-color: var(--og-chat); }
  .arbiter-chip.arbiter-ask_user { border-left-color: var(--og-warning); }
  /* The honest FAILURE/INCOMPLETE verdict — red, distinct from the benign
     "Continue". A budget-walled / no-progress / errored / parked turn lands
     here, never on Continue. */
  .arbiter-chip.arbiter-incomplete {
    border-left-color: var(--og-error);
    background: color-mix(in srgb, var(--og-error) 10%, var(--og-surface-alt));
  }
  .arbiter-chip.arbiter-unknown { border-left-color: var(--og-text-muted); }

  .arbiter-label { font-weight: 600; color: var(--og-text); flex: 0 0 auto; }
  .arbiter-reason {
    color: var(--og-text-secondary);
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

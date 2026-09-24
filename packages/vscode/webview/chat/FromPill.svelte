<script lang="ts">
  // t-s9k0q6 (round 7 rule 5): the mark a chat carries in Here after
  // "Continue here", for the rest of this session. Moved: a dashed
  // "from 5090". Forked: the round-4 "fork" tag. Session-only UI state: the
  // host needs no field for it beyond the Continue result.
  // t-t7lfho: `away` (its tooltip, nestAway.ts awayChipTip) = the other way
  // round: this desk gave the chat to `from`. A dashed "on 5090"; it stays in Here, read only.
  import { tip } from '../shared/WarmTooltip.svelte';

  let { from, fork = false, away }: { from: string; fork?: boolean; away?: string } = $props();
  const label = $derived(fork
    ? `A fork. ${from} was mid-turn, so this desk writes in a copy. Both copies are kept.`
    : `Moved here from ${from} in this session. This desk owns it now.`);
</script>

{#if away !== undefined}
  <span class="arrival away" use:tip={away}>on {from}</span>
{:else if fork}
  <span class="arrival fork" use:tip={label}>fork</span>
{:else}
  <span class="arrival" use:tip={label}>from {from}</span>
{/if}

<style>
  .arrival {
    flex: 0 0 auto;
    margin-left: auto;
    height: 14px;
    padding: 0 5px;
    box-sizing: border-box;
    border: 1px dashed var(--og-border);
    border-radius: 7px;
    color: var(--og-text-muted);
    font-size: 9.5px;
    line-height: 12px;
    white-space: nowrap;
    align-self: center;
  }
  /* After the unread count, the pill sits beside it rather than pushing it. */
  :global(.session-unread) + .arrival { margin-left: 4px; }
  .arrival.fork {
    border-style: solid;
    border-color: color-mix(in srgb, var(--og-warning) 60%, var(--og-border));
    color: var(--og-warning-text);
    font-weight: 600;
  }
</style>

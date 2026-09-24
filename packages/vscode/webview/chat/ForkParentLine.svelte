<script lang="ts">
  // t-s9k0q6 (round 7 rule 5, "Readings I chose"): a fork made here while its
  // parent's turn ran on another desk. The parent stays on that desk, so Here
  // shows it as ONE quiet line (muted title + desk chip, 22 px, no dot, no
  // close) with the fork row under it. It is a label, not a second copy of
  // the chat: a click opens it read only, as in the Nest.
  //
  // The fork row is the product's own row (ChatsList.svelte renders this line
  // just before it), indented and barred in the round-4 fork colour by the
  // sibling rule below.
  import { tip } from '../shared/WarmTooltip.svelte';
  import DeskChip from './DeskChip.svelte';
  import type { NestDesk } from './nestIndex';

  let { title, desk, name, onRead }: { title: string; desk: NestDesk | undefined; name: string; onRead: () => void } = $props();
</script>

<button class="nest-fork-parent" onclick={onRead}
  use:tip={`The parent chat. It stays on ${name}, where the turn goes on. Click to read it.`}>
  <span class="parent-name">{title}</span>
  <DeskChip {desk} {name} />
</button>

<style>
  .nest-fork-parent {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
    padding: 0 4px 0 14px;
    border: 0;
    background: transparent;
    color: var(--og-text-muted);
    font: inherit;
    font-size: 11.5px;
    text-align: left;
    cursor: pointer;
  }
  .nest-fork-parent:hover { color: var(--og-text-secondary); }
  .nest-fork-parent:focus-visible { outline: 1px solid var(--og-chat); outline-offset: -1px; border-radius: 5px; }
  .parent-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The fork row right after this line: indented under the parent, with the
     round-4 fork bar. The row is ChatsList.svelte's element, hence :global. */
  .nest-fork-parent + :global(.session-row) {
    margin-left: 14px;
    border-left: 2px solid var(--og-warning);
    background: color-mix(in srgb, var(--og-warning) 7%, transparent);
  }
</style>

<script lang="ts">
  // WHAT THE FRONT DESK HAS BEEN DOING, AND WHAT IT COST. A ring, newest first.
  //
  // The questions themselves moved out: they are mailbox threads now, rendered
  // by FlockMail.svelte with a decision on each row instead of an allow/deny
  // prompt. What is left here is the thing a thread cannot answer — the running
  // total, chronologically, including the rows that predate the mailbox. It is
  // a COST log, so a refusal is a row too: a log that held only the successes
  // would hide the contact burning through a budget.
  //
  // A HANDLE IS SHOWN SHORT (`flockHandle.ts` says why), whole on the tooltip:
  // these rows carry the raw handle rather than the `handleShort` a contact row
  // gets.
  import { shortHandle } from '../panes/flockHandle';
  import type { FlockAnswerRow } from '../panes/flockTypes';

  interface Props {
    answers: FlockAnswerRow[];
  }
  let { answers }: Props = $props();

  // Newest first for reading; the store appends chronologically.
  let recent = $derived([...answers].reverse().slice(0, 6));
</script>

{#if recent.length === 0}
  <p class="fk-empty">Your front desk has not answered anything yet.</p>
{:else}
  <table class="log">
    <tbody>
      {#each recent as a (a.at + a.from)}
        <tr>
          <td class="when">{a.at.slice(5, 16).replace('T', ' ')}</td>
          <td class="who fk-mono" title={a.from}>{shortHandle(a.from)}</td>
          <td class="what">{a.question}</td>
          <td class="cost" class:refused={!a.ok}>{a.ok ? `${a.tokens} tokens` : 'refused'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .log { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .log td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--og-border); color: var(--og-text-secondary); vertical-align: top; }
  .log tr:last-child td { border-bottom: none; }
  .when { color: var(--og-text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; width: 11ch; }
  .who { width: 15ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cost { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: 11ch; }
  .cost.refused { color: var(--og-error-text); }
</style>

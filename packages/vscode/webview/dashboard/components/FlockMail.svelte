<script lang="ts">
  // THE MAIL MANAGER: three trays, and one set of buttons per kind of row.
  //
  // This tile replaced an Inbox of parked permissions, and the difference is
  // the whole point of the feature. A question is a DECISION — Answer, Answer
  // with guidance, Decline with a reason — not an allow/deny prompt. A reply is
  // a row that goes nowhere until the owner sends it somewhere: a new chat, or
  // one they are already in. Nothing here lands in a session on its own.
  //
  // Every button posts and waits for the engine's re-read. Nothing is patched
  // optimistically, for the reason the rest of this pane does not either: a
  // decide can be refused engine-side (a contact revoked in another window, a
  // budget spent since the row was drawn), and a row that had already moved
  // itself would be telling the owner something had been sent that had not.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import FlockMailBubbles from './FlockMailBubbles.svelte';
  import FlockRowActions from './FlockRowActions.svelte';
  import { bucket, labelOf, stateLabel } from '../panes/flockMail';
  import type { MailRow, MailTab } from '../panes/flockMail';
  import type { DeliverTarget, MailSession } from '../panes/flockDeliverTargets';

  interface Props {
    threads: MailRow[];
    sessions: MailSession[];
    ondecide: (thread: string, action: 'answer' | 'decline', extra?: { guidance?: string; reason?: string }) => void;
    onsend: (thread: string, text?: string) => void;
    /** ONE door for every destination. The engine writes the message either
     *  way; the target only says which chat, and whether it has to be opened. */
    ondeliver: (row: MailRow, target: DeliverTarget) => void;
    onmark: (thread: string) => void;
    onfollowup: (row: MailRow, question: string) => void;
  }
  let { threads, sessions, ondecide, onsend, ondeliver, onmark, onfollowup }: Props = $props();

  let tab: MailTab = $state('inbox');
  // ONE open editor at a time, by row id. The buttons and the box themselves
  // are FlockRowActions.svelte, shared with the contact thread.
  let openRow = $state('');

  let trays = $derived(bucket(threads));
  let shown = $derived(trays[tab]);
</script>

<div class="tabs" role="tablist">
  {#each ['inbox', 'sent', 'archive'] as const as name (name)}
    <button class="tab" class:on={tab === name} role="tab" aria-selected={tab === name} onclick={() => { tab = name; openRow = ''; }}>
      {name}{#if trays[name].length > 0}<span class="fk-chip static">{trays[name].length}</span>{/if}
    </button>
  {/each}
</div>

{#if shown.length === 0}
  <p class="fk-empty">
    {#if tab === 'inbox'}Nothing wants you. A contact's question and a contact's reply both land here.
    {:else if tab === 'sent'}Nothing outstanding. A question you send sits here until they answer.
    {:else}Nothing archived yet.{/if}
  </p>
{/if}

{#each shown as row (row.id)}
  <div class="row" class:unread={row.unread} class:waiting={row.direction === 'in' && row.state === 'pending'}>
    <div class="who" title={row.contact}>
      <ArchetypeGlyph id={row.icon} size={16} />
      <span class="fk-name">{labelOf(row)}</span>
    </div>
    <FlockMailBubbles {row} />
    <div class="who meta">
      <span class="fk-chip static">{stateLabel(row)}</span>
      {#if row.followUpOf}<span class="fk-chip static">follow-up</span>{/if}
      {#if row.question.tokens}<span class="cost">{row.question.tokens} tokens</span>{/if}
    </div>

    <FlockRowActions {row} {sessions} {openRow} onopen={(id) => (openRow = id)} {ondecide} {onsend} {ondeliver} {onmark} {onfollowup} />
  </div>
{/each}

<style>
  .tabs { display: flex; gap: 4px; }
  .tab {
    font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 5px; cursor: pointer; text-transform: capitalize;
    background: none; border: 1px solid transparent; color: var(--og-text-muted);
  }
  .tab.on { background: var(--og-surface-alt); border-color: var(--og-border); color: var(--og-text); }
  .row {
    border-left: 2px solid var(--og-border); background: var(--og-surface-alt); min-width: 0;
    border-radius: 0 5px 5px 0; padding: 8px; display: flex; flex-direction: column; gap: 6px;
  }
  .row.unread { border-left-color: var(--og-accent); }
  .row.waiting { border-left-color: var(--og-status-waiting); }
  .who { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .who.meta { margin-top: -2px; }
  .cost { margin-left: auto; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
</style>

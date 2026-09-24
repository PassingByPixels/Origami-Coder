<script lang="ts">
  // "ALL MAIL" — the middle of the pane when the rail's first row is selected.
  //
  // The three trays, in the same card chrome the contact thread wears, because
  // they are alternatives in one slot: Inbox / Sent / Archive across EVERY
  // contact, which is the one question a per-contact thread cannot answer.
  // Without it a question waiting from a contact nobody has clicked is a dot
  // and nothing else, and "what waits on me" has no page at all.
  //
  // A thin wrapper on purpose. Everything below the head is FlockMail.svelte,
  // unchanged and unforked: the trays, their rules and their buttons have one
  // owner, and this file only puts a header and a border round them.
  import FlockMail from './FlockMail.svelte';
  import type { MailRow } from '../panes/flockMail';
  import type { DeliverTarget, MailSession } from '../panes/flockDeliverTargets';

  interface Props {
    threads: MailRow[];
    sessions: MailSession[];
    waiting: number;
    ondecide: (thread: string, action: 'answer' | 'decline', extra?: { guidance?: string; reason?: string }) => void;
    onsend: (thread: string, text?: string) => void;
    ondeliver: (row: MailRow, target: DeliverTarget) => void;
    onmark: (thread: string) => void;
    onfollowup: (row: MailRow, question: string) => void;
  }
  let { threads, sessions, waiting, ondecide, onsend, ondeliver, onmark, onfollowup }: Props = $props();
</script>

<section class="thread">
  <div class="thread-head">
    <svg class="fk-ico head-ico" aria-hidden="true"><use href="#fk-send" /></svg>
    <span class="fk-caps fk-grow">All mail</span>
    {#if waiting > 0}<span class="fk-pill wait"><span class="fk-dot"></span>{waiting} waiting</span>{/if}
  </div>
  <div class="thread-body">
    <FlockMail {threads} {sessions} {ondecide} {onsend} {ondeliver} {onmark} {onfollowup} />
  </div>
</section>

<style>
  .thread {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px;
    display: flex; flex-direction: column; min-height: 0; min-width: 0;
  }
  .thread-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--og-border); flex-wrap: wrap; }
  .head-ico { color: var(--og-text-muted); }
  .thread-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
</style>

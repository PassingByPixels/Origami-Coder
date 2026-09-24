<script lang="ts">
  // WHAT THE OWNER CAN DO ABOUT ONE ROW — and the box that takes the words
  // when the choice needs some.
  //
  // Extracted at the messenger wave because there are now TWO places a thread
  // is decided: the Mail trays (FlockMail.svelte, "everything that wants me,
  // across everybody") and the contact thread (FlockThread.svelte, "this
  // conversation"). Two copies of these four button sets would be two places to
  // rename `flockDecide`, and the second one would keep posting the old name
  // with the whole suite green — the exact failure the message-name grep test
  // exists for. One leaf, both callers.
  //
  // ONE OPEN EDITOR AT A TIME is still the rule, and the PARENT still owns it:
  // `openRow` is the id of the row whose editor is showing, so a second row's
  // Answer-with-guidance closes the first. Two guidance boxes on screen is two
  // half-written instructions and no way to tell which one Send would use. The
  // draft text itself lives here, per row, so switching away and back does not
  // put one contact's words in another contact's box.
  import { deliverTargets } from '../panes/flockDeliverTargets';
  import type { DeliverTarget, MailSession } from '../panes/flockDeliverTargets';
  import type { MailRow } from '../panes/flockMail';

  type EditKind = 'guidance' | 'decline' | 'draft' | 'followup';

  interface Props {
    row: MailRow;
    sessions: MailSession[];
    /** The id of the row whose editor is open. Anything else closes this one. */
    openRow: string;
    onopen: (id: string) => void;
    ondecide: (thread: string, action: 'answer' | 'decline', extra?: { guidance?: string; reason?: string }) => void;
    onsend: (thread: string, text?: string) => void;
    /** ONE door for every destination. The engine writes the message either
     *  way; the target only says which chat, and whether it has to be opened. */
    ondeliver: (row: MailRow, target: DeliverTarget) => void;
    onmark: (thread: string) => void;
    onfollowup: (row: MailRow, question: string) => void;
  }
  let { row, sessions, openRow, onopen, ondecide, onsend, ondeliver, onmark, onfollowup }: Props = $props();

  let kind: EditKind = $state('guidance');
  let text = $state('');
  let deliverTo = $state('');
  let editing = $derived(openRow === row.id);

  /** The picker for one row: the chat that asked first, then New chat, then the
   *  rest. `deliverTargets` owns that order and its test names it. */
  let targets = $derived<DeliverTarget[]>(deliverTargets(row, sessions));

  function pick(value: string): void {
    const target = targets.find((entry) => entry.value === value);
    if (target) ondeliver(row, target);
  }

  function open(next: EditKind): void {
    kind = next;
    deliverTo = '';
    text = next === 'draft' ? (row.reply?.text ?? '') : '';
    onopen(row.id);
  }

  function confirm(): void {
    const value = text.trim();
    if (kind === 'guidance') ondecide(row.id, 'answer', { guidance: value });
    else if (kind === 'decline') ondecide(row.id, 'decline', { reason: value });
    else if (kind === 'draft') onsend(row.id, value);
    else if (value) onfollowup(row, value);
    text = '';
    onopen('');
  }
</script>

{#if editing}
  <textarea
    class="fk-inp box"
    bind:value={text}
    placeholder={kind === 'guidance'
      ? 'What should the front desk say, or not say?'
      : kind === 'decline'
        ? 'Why (optional). They see this.'
        : kind === 'followup'
          ? 'Your follow-up question, in full.'
          : 'The answer they will read.'}
  ></textarea>
  <div class="fk-do">
    <button class="fk-btn primary" onclick={confirm}>
      {kind === 'decline' ? 'Decline' : kind === 'draft' ? 'Send' : kind === 'followup' ? 'Ask' : 'Draft it'}
    </button>
    <button class="fk-btn" onclick={() => onopen('')}>Cancel</button>
  </div>
{:else}
  <div class="fk-do">
    {#if row.direction === 'in' && row.state === 'pending'}
      <button class="fk-btn primary" onclick={() => ondecide(row.id, 'answer')}>Answer</button>
      <button class="fk-btn" onclick={() => open('guidance')}>Answer with guidance</button>
      <button class="fk-btn" onclick={() => open('decline')}>Decline</button>
      <!-- The third choice the owner asked for: think about it in a chat first.
           The chat is told to ask what YOU want done before it answers
           anything, so this is reflection, not delegation. -->
      <button class="fk-btn" onclick={() => ondeliver(row, { value: 'new', label: 'New chat' })}>Open in chat</button>
    {:else if row.direction === 'in' && row.state === 'answering'}
      <button class="fk-btn primary" disabled={!row.reply} onclick={() => onsend(row.id)}>Send</button>
      <button class="fk-btn" disabled={!row.reply} onclick={() => open('draft')}>Edit</button>
      <button class="fk-btn" onclick={() => open('guidance')}>Edit guidance</button>
      <button class="fk-btn" onclick={() => open('decline')}>Decline</button>
    {:else if row.reply}
      <select class="fk-inp" aria-label="Send to chat" bind:value={deliverTo} onchange={() => { if (deliverTo) { pick(deliverTo); deliverTo = ''; } }}>
        <option value="">Send to chat…</option>
        {#each targets as target (target.value)}<option value={target.value}>{target.label}</option>{/each}
      </select>
      <button class="fk-btn" onclick={() => open('followup')}>Follow up</button>
      {#if row.unread}<button class="fk-btn" onclick={() => onmark(row.id)}>Mark read</button>{/if}
    {:else if row.unread}
      <button class="fk-btn" onclick={() => onmark(row.id)}>Mark read</button>
    {/if}
  </div>
{/if}

<style>
  .box { width: 100%; min-height: 54px; resize: vertical; font: inherit; }
</style>

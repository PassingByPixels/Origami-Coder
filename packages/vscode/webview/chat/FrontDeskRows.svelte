<script lang="ts">
  // THE ROWS INSIDE THE SIDEBAR'S FRONT DESK — a question waiting on a decision,
  // and a reply nobody has read.
  //
  // EXTRACTED from FrontDeskSection.svelte, which sat two lines under its
  // architecture cap when the owner asked for two more controls on these rows:
  // "Open in chat" on a question, and a full destination picker on a reply. The
  // section keeps what it owns — the collapse, the badge, the poll — and the
  // rows keep their own markup and their own colours.
  //
  // THE THREE BUTTONS ARE THREE DIFFERENT DECISIONS. Answer runs the front desk
  // and leaves a draft to review IN THE PANE; nothing is ever sent from this
  // header. Decline goes back signed. Open in chat is the third choice the
  // owner asked for: think about it first, in a real chat, which is told to ask
  // the user before it answers anything.
  import ArchetypeGlyph from '../dashboard/components/ArchetypeGlyph.svelte';
  import FlockMailBubbles from '../dashboard/components/FlockMailBubbles.svelte';
  import { labelOf, stateLabel, type MailRow } from '../dashboard/panes/flockMail';
  import { deliverTargets, type DeliverTarget, type MailSession } from '../dashboard/panes/flockDeliverTargets';

  interface Props {
    waiting: MailRow[];
    replies: MailRow[];
    sessions: MailSession[];
    ondecide: (thread: string, action: 'answer' | 'decline') => void;
    ondeliver: (row: MailRow, target: DeliverTarget) => void;
  }
  let { waiting, replies, sessions, ondecide, ondeliver }: Props = $props();

  let sendTo = $state('');

  function pick(row: MailRow, value: string): void {
    const target = deliverTargets(row, sessions).find((entry) => entry.value === value);
    sendTo = '';
    if (target) ondeliver(row, target);
  }
</script>

{#each waiting as row (row.id)}
  <div class="fd-row">
    <div class="fd-from" title={row.contact}><ArchetypeGlyph id={row.icon} size={14} /><span>{labelOf(row)}</span></div>
    <FlockMailBubbles {row} />
    <div class="fd-actions">
      <button class="fd-btn primary" onclick={() => ondecide(row.id, 'answer')}>Answer</button>
      <button class="fd-btn" onclick={() => ondecide(row.id, 'decline')}>Decline</button>
      <button class="fd-btn" onclick={() => ondeliver(row, { value: 'new', label: 'New chat' })}>Open in chat</button>
    </div>
  </div>
{/each}

{#each replies as row (row.id)}
  <div class="fd-row">
    <div class="fd-from" title={row.contact}><ArchetypeGlyph id={row.icon} size={14} /><span>{labelOf(row)} · {stateLabel(row)}</span></div>
    <FlockMailBubbles {row} />
    <div class="fd-actions">
      <select class="fd-pick" aria-label="Send to chat" bind:value={sendTo} onchange={() => { if (sendTo) pick(row, sendTo); }}>
        <option value="">Send to chat…</option>
        {#each deliverTargets(row, sessions) as target (target.value)}
          <option value={target.value}>{target.label}</option>
        {/each}
      </select>
    </div>
  </div>
{/each}

<style>
  .fd-row {
    display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; min-width: 0;
    border: 1px solid var(--og-border); border-radius: 6px; background: var(--og-surface);
  }
  .fd-from { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--og-text); }
  .fd-from span { overflow-wrap: anywhere; }
  .fd-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .fd-btn {
    font: inherit; font-size: 10px; padding: 2px 8px; border-radius: 5px; cursor: pointer;
    background: var(--og-btn-bg); color: var(--og-text); border: 1px solid var(--og-border);
  }
  .fd-btn.primary { background: var(--og-accent); border-color: transparent; }
  .fd-pick {
    font: inherit; font-size: 10px; padding: 2px 6px; border-radius: 5px; cursor: pointer; max-width: 100%;
    background: var(--og-btn-bg); color: var(--og-text); border: 1px solid var(--og-border);
  }
</style>

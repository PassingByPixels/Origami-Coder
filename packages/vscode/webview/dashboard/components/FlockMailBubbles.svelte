<script lang="ts">
  // ONE EXCHANGE, AS A CONVERSATION — shared by the Mail tile and the sidebar
  // Front Desk, so the two places a thread is read never draw it two ways.
  //
  // A question and its reply are two turns, not one paragraph and a quote
  // underneath: the direction marker says who spoke first, and each bubble
  // sits on the side that speaker owns — the same convention any messenger
  // uses, which is the whole point of the redesign this replaces (a row that
  // read like a parked permission).
  //
  // `origin` names which of the owner's OWN chats asked; only its title is
  // shown, and a row with an id but no title draws no chip rather than an id.
  import { declineReason, type MailRow } from '../panes/flockMail';

  interface Props {
    row: MailRow;
    /** The "→ you asked" line. On in the trays, where a row stands alone and
     *  nothing else says whose turn it was; OFF in the contact thread, where
     *  the rail already names the contact and every bubble is already sided. */
    dir?: boolean;
  }
  let { row, dir = true }: Props = $props();

  let origin = $derived(row.origin?.title?.trim() ?? '');
  /** `out` = the owner asked; the owner's bubble is the QUESTION's. */
  let mine = $derived(row.direction === 'out');
</script>

{#if dir}<div class="mk-dir">{mine ? '→ you asked' : '← they asked'}</div>{/if}
<div class="mk-thread">
  <div class="mk-bubble" class:mine title={row.contact}>
    {row.question.text || 'The question text did not survive the trip.'}
  </div>
  {#if row.reply}
    <div class="mk-bubble" class:mine={!mine} class:bad={!row.reply.signatureOk}>
      {#if !row.reply.signatureOk}<b>NOT VERIFIED — do not rely on this.</b>{/if}
      {declineReason(row) || row.reply.text}
    </div>
  {/if}
</div>
{#if origin}<span class="mk-origin">asked from {origin}</span>{/if}

<style>
  .mk-dir { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--og-text-muted); }
  .mk-thread { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .mk-bubble {
    max-width: 88%; align-self: flex-start; padding: 6px 10px; border-radius: 10px 10px 10px 2px;
    overflow-wrap: anywhere; background: var(--og-surface-alt); border: 1px solid var(--og-border);
    color: var(--og-text-secondary);
  }
  /* The SPEAKER's own bubble, on the other side — whichever turn it is. */
  .mk-bubble.mine {
    align-self: flex-end; border-radius: 10px 10px 2px 10px; background: var(--og-accent);
    border-color: transparent; color: var(--og-text);
  }
  .mk-bubble.bad { color: var(--og-error-text); border-color: var(--og-error); }
  .mk-origin { font-size: 10px; color: var(--og-text-muted); }
</style>

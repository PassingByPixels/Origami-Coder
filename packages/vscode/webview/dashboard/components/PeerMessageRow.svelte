<script module lang="ts">
  // The envelope strip lives in peerEnvelope.ts; re-exported here because every
  // caller and its tests import it from the component (the
  // InstructionRowActions.svelte pattern).
  import { peerBody } from './peerEnvelope';
  export { peerBody };
</script>

<script lang="ts">
  import { peerBadge } from './peerBadge';

  /**
   * A message from ANOTHER agent session, badged as agent-origin.
   *
   * The whole point of this row is that it must not read as the human. It is
   * left-aligned and rule-marked where a user message is a filled bubble, and it
   * leads with WHO sent it. The reply address is not shown to the user — the
   * model receives it in the instruction text that peerBody() strips.
   *
   * Three senders share it — a peer handoff, a FLOCK contact (another person's
   * Origami over the relay) and a SUB-AGENT QUESTION (one of this chat's own
   * children, blocked until it is answered). Which one a row is, and what the
   * badge says, is peerBadge.ts beside this.
   */
  let { from, replyTo, text, timestamp, flock, subagent }: {
    from: string;
    replyTo: string;
    text: string;
    timestamp?: number;
    flock?: { contact: string; thread: string; kind: string; icon?: string };
    subagent?: { label: string; requestID: string; sessionID: string };
  } = $props();

  const clock = (ts?: number) =>
    ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const badge = $derived(peerBadge({ from, ...(flock ? { flock } : {}), ...(subagent ? { subagent } : {}) }));
</script>

<div
  class="peer-row"
  data-peer-from={from}
  data-flock-thread={flock?.thread}
  data-subagent-request={subagent?.requestID}
>
  <div class="peer-head">
    <span class="peer-badge" class:flock={badge.tone === 'flock'} class:subagent={badge.tone === 'subagent'}>
      {badge.text}
    </span>
    {#if badge.detail}<span class="peer-thread">{badge.detail}</span>{/if}
    {#if timestamp}<span class="peer-time">{clock(timestamp)}</span>{/if}
  </div>
  <div class="peer-text">{peerBody(text)}</div>
</div>

<style>
  .peer-row {
    margin: 6px 0;
    padding: 6px 10px;
    border-left: 3px solid var(--og-accent-2);
    background: var(--og-surface-alt);
    border-radius: 0 4px 4px 0;
  }
  .peer-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    font-size: 11px;
    color: var(--og-text-secondary);
  }
  .peer-badge {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid var(--og-accent-2);
    color: var(--og-accent-2);
  }
  /* A flock message comes from OUTSIDE this machine, so it takes the primary
     accent rather than the peer row's secondary one. */
  .peer-badge.flock {
    border-color: var(--og-accent);
    color: var(--og-accent);
  }
  /* A blocked agent of the user's own is a WARNING colour, not an accent: the
     row is asking for something, unlike the other two senders. */
  .peer-badge.subagent {
    border-color: var(--og-warning);
    color: var(--og-warning-text);
  }
  .peer-thread {
    font-size: 10px;
    color: var(--og-text-muted);
  }
  .peer-time {
    margin-left: auto;
    color: var(--og-text-muted);
  }
  .peer-text {
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--og-text);
  }
</style>

<script lang="ts">
  // Flock M4 (C16) — a task_*/system message as ONE LINE, not a bubble.
  //
  // These are the room talking about itself: a task opened, claimed, finished,
  // accepted, reopened. They matter, and they are not conversation — giving
  // each an avatar, a name header and a bordered bubble would bury the four
  // sentences an agent actually said under twelve rows of bookkeeping. So the
  // row is full width, unavatared, and reads as a ledger entry.
  //
  // Its trace still folds here (a task_done can be the product of real tool
  // work), because "which tools ran" is a fact about the TURN, not about how
  // its message happened to be shaped.
  import CollabTrace from './CollabTrace.svelte';
  import type { CollabMessage } from '../../src/acpExtTypes';

  interface Props {
    msg: CollabMessage;
    /** Who did it, already shortened by the stream. '' for a room-level line. */
    name: string;
    /** What they did ('claimed a task'). '' for a plain `system` line, whose
     *  own text is the whole message. */
    label: string;
  }
  let { msg, name, label }: Props = $props();
</script>

<div class="cs-sys">
  <span class="cs-sys-mark" aria-hidden="true">&middot;</span>
  {#if name}<span class="cs-sys-who">{name}</span>{/if}
  {#if label}<span class="cs-sys-label">{label}</span>{/if}
  <span class="cs-sys-text">{msg.text}</span>
  {#if msg.trace && msg.trace.length}
    <span class="cs-sys-trace"><CollabTrace entries={msg.trace} /></span>
  {/if}
</div>

<style>
  .cs-sys {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    padding: 1px 2px;
    font-size: 11px;
    color: var(--og-text-muted);
  }
  .cs-sys-mark { color: var(--og-text-muted); }
  .cs-sys-who { font-weight: 600; color: var(--og-text-secondary); }
  /* The VERB is the row's information, so it carries the only colour here. */
  .cs-sys-label { color: var(--og-accent-2); }
  .cs-sys-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .cs-sys-trace { flex: 1 1 100%; }
</style>

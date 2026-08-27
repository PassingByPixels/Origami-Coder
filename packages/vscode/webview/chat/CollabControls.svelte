<script lang="ts">
  // The collab's control strip — the suspended banner and the standing
  // objective. EXTRACTED from CollabPane.svelte to pay for the task board and
  // the ledger that flock M4 mounts there, per the ratchet.
  //
  // The cap/hop/STOP row LEFT this strip in the M4.2 UAT pass: the budget is
  // spent by posting, so its bar belongs under the composer (CollabHopBar.svelte)
  // rather than in a header the eye scrolls past. What stays here is what has to
  // be seen BEFORE you read the stream — that the room is paused, and what it was
  // asked to do.
  //
  // The suspended wording is collabHop.ts's, shared with that bar: the M4 hop
  // sentence is used ONLY when the engine actually reported a spent budget, and
  // one rule in one leaf is what keeps the two surfaces agreeing.
  //
  // X2: the objective row left this file for CollabObjectiveRow.svelte, where
  // it became editable in place (report 1.5). The row is still mounted from
  // here — this strip is what the eye reads before the stream — but its own
  // draft/commit rules belong with its markup.
  import CollabObjectiveRow from './CollabObjectiveRow.svelte';
  import { suspendText } from './collabHop';
  import type { CollabHopState } from '../../src/acpExtTypes';

  interface Props {
    suspended: boolean;
    /** Flock M4: what is LEFT of the budget. ABSENT on an older engine, which
     *  keeps today's banner wording rather than inventing a hop count. */
    hopState?: CollabHopState | null;
    objective?: string | null;
    /** An archived room takes no writes, so the row draws no editor. */
    archived?: boolean;
    onSetObjective: (text: string) => void;
  }
  let { suspended, hopState = null, objective = null, archived = false, onSetObjective }: Props = $props();

  const suspended_text = $derived(suspendText(hopState));
</script>

{#if suspended}
  <!-- The ONE state the user must act on. The control that resolves it (post
       again, or raise the cap) is the composer and the bar directly beneath it,
       both a glance away — not a settings screen somewhere else. -->
  <div class="banner suspend-banner">
    <span class="suspend-text">{suspended_text}</span>
  </div>
{/if}

<!-- ALWAYS drawn now, objective or not: an unset objective used to render
     nothing, which left the one state that needs the control without one. -->
<CollabObjectiveRow {objective} {archived} {onSetObjective} />

<style>
  .banner { flex-shrink: 0; padding: 6px 12px; font-size: 11px; }
  .suspend-banner { background: color-mix(in srgb, var(--og-warning) 20%, transparent); color: var(--og-text); }

  /* The objective row's own rules moved to CollabObjectiveRow.svelte with it. */
</style>

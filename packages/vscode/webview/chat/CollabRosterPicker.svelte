<script lang="ts">
  // Collabs M3 — repurposed from the New-collab checkbox roster (M2) into the
  // ROSTER'S OWN Invite affordance: a `+` trigger + a small popover of agents
  // still invitable to THIS collab.
  //
  // WHY REPURPOSED, NOT DELETED. Create moved to title-only (Slack model, the
  // owner's call) — see CollabsList.svelte's top comment for the race that
  // decision closed. But "pick an agent from a small list" is still exactly
  // the right control, just moved to where a collab actually gains members:
  // its own pane, after the room exists.
  //
  // X2: the ROWS left this file. They are CollabInviteList.svelte now, so the
  // setup card can mount the same control instead of growing a second one, and
  // so report 1.3's multi-select and 1.4's model/health columns had somewhere
  // to land — this file was 132 of its 135-line cap.
  //
  // WHAT IS LEFT HERE IS THE ONE RULE THE SHELL OWNS: when the popover closes.
  // It used to close after EVERY pick, which is the whole of report 1.3 — a
  // three-agent room cost six clicks and three re-openings. A pick now leaves
  // it open; only the commit closes it.
  //
  // The candidate list arrives already MERGED (CollabPane owns engine-vs-
  // filesystem, collabInvite.ts) — nothing here decides who is invitable.
  import CollabInviteList from './CollabInviteList.svelte';
  import type { InviteCandidate } from './collabInvite';

  interface Props {
    candidates: InviteCandidate[];
    /** One call per commit, with every slug picked. */
    onInvite: (slugs: string[]) => void;
    /** BINDABLE so the roster's empty-state coaching line can open this same
     *  popover instead of mounting a second list (report 1.6). */
    open?: boolean;
  }
  let { candidates, onInvite, open = $bindable(false) }: Props = $props();

  function commit(slugs: string[]) {
    onInvite(slugs);
    open = false;
  }
</script>

<div class="invite">
  <button
    class="invite-btn"
    class:active={open}
    onclick={() => (open = !open)}
    title="Invite agents"
    aria-label="Invite an agent"
  >+</button>
  {#if open}
    <div class="invite-pop">
      <CollabInviteList {candidates} onInvite={commit} />
    </div>
  {/if}
</div>

<style>
  .invite { position: relative; display: inline-flex; }
  .invite-btn {
    font-size: 12px;
    font-weight: 700;
    width: 20px;
    height: 20px;
    line-height: 1;
    padding: 0;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 999px;
    cursor: pointer;
    font-family: inherit;
  }
  .invite-btn:hover, .invite-btn.active { border-color: var(--og-chat); color: var(--og-text); }
  .invite-pop {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 5;
    margin-top: 4px;
    min-width: 240px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 6px;
    padding: 4px;
  }
</style>

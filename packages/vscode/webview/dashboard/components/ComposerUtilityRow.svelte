<script lang="ts">
  // THE COMPOSER'S UTILITY ROW (CHANGES.md round 3, change 44).
  //
  // One row that says WHERE this chat runs and WHAT it can do: the repo and
  // branch pills at the left, the second-opinion scales and the focus eye at
  // the right. The repo/branch pills used to sit on a row of their own above
  // the composer and the two icons on a row of their own inside it — two rows
  // saying one thing.
  //
  // The files chip is NOT here any more: it moved to the model bar's
  // right-hand group with turns and the gauge (change 43), because it answers
  // the same question those two do.
  //
  // Its own file rather than markup in InputBar.svelte, which is at its cap,
  // and rather than more of ChangesPill.svelte, which is now the chip alone.
  //
  // It posts the second-opinion request itself rather than routing the click
  // up through InputBar into ChatPane, which would buy a prop chain and
  // nothing else.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import FocusEye from './FocusEye.svelte';
  import ForkButton from './ForkButton.svelte';
  import RepoBranchPicker from './RepoBranchPicker.svelte';
  import SecondOpinionButton from './SecondOpinionButton.svelte';
  import SecondOpinionMenu from './SecondOpinionMenu.svelte';

  interface Props {
    /** The chat the pills describe. NULL/empty draws no pills: a bare collab
     *  composer has no engine session and so no directory of its own. */
    sessionId?: string | null;
    /** Focus view is ON for this chat — the eye reads as pressed. */
    focused?: boolean;
    /** Flip focus view. ABSENT draws NO eye: a transcript control with no
     *  transcript under it is a dead button. */
    onToggleFocus?: () => void;
    /** The chat a second opinion would review. NULL/empty draws NO scales. */
    secondOpinionFor?: string | null;
    /** A turn is running: the scales are dead until it finishes. */
    busy?: boolean;
  }
  let { sessionId = null, focused = false, onToggleFocus, secondOpinionFor = null, busy = false }: Props = $props();

  const vscode = getVsCodeApi();
  let soOpen = $state(false);

  /** A pick closes the menu and goes to the host. The card is the host's
   *  PENDING answer, not optimistic — a refusal would leave it to un-draw. */
  function pick(modelId: string, modelLabel: string) {
    soOpen = false;
    vscode.postMessage({ type: 'secondOpinion', sessionId: secondOpinionFor, modelId, modelLabel });
  }

  /** t-v5qv6u: the fork goes to the host and NOTHING goes to this chat — the
   *  new tab is the whole answer (src/dashboard/sessionFork.ts). It shows where
   *  the scales show: both need an engine session to copy or review. */
  function fork() {
    vscode.postMessage({ type: 'forkChat', sessionId: secondOpinionFor });
  }
</script>

{#if sessionId || onToggleFocus || secondOpinionFor}
  <div class="composer-util">
    {#if sessionId}<RepoBranchPicker {sessionId} />{/if}
    <!-- ONE `margin-left: auto`, on the group rather than on each control:
         two auto margins on a line would each claim leftover space and park
         the first control in the middle. -->
    <div class="row-end">
      {#if secondOpinionFor}
        <ForkButton disabled={busy} onFork={fork} />
        <SecondOpinionButton open={soOpen} disabled={busy} onToggle={() => (soOpen = !soOpen)} />
        {#if soOpen}
          <SecondOpinionMenu sessionId={secondOpinionFor} onPick={pick} onClose={() => (soOpen = false)} />
        {/if}
      {/if}
      {#if onToggleFocus}<FocusEye {focused} onToggle={onToggleFocus} />{/if}
    </div>
  </div>
{/if}

<style>
  /* `relative` so the second-opinion menu anchors to this row rather than to
     whatever positioned ancestor the composer happens to have.
     NO vertical padding: it reads as a dead band above the textarea (0.4.60
     UAT), and no side padding because `.input-row` already carries the inset
     this row must sit flush inside. */
  .composer-util {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
    padding: 0;
  }
  .row-end { display: flex; align-items: center; gap: 2px; margin-left: auto; }
</style>

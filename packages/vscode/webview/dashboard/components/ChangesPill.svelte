<script lang="ts">
  import { tip } from '../../shared/warmTip';
  // THE FILES CHIP — the running "5 files +312 -40" pill.
  //
  // It lives in the MODEL BAR's right-hand group now (CHANGES.md round 3,
  // change 43): files, turns and the gauge are three numbers about one
  // question — how full is this chat — so they read as one line. It used to
  // head a row of its own; that row is ComposerUtilityRow.svelte now and
  // carries the repo/branch pills and the transcript controls instead.
  //
  // It renders only once something has been edited, so a chat with no edits
  // costs no space on the bar.
  //
  // The SUMMARY is computed by the caller (ChatPane, via sessionChanges.ts);
  // this file only decides how the chip looks, never what the numbers are.
  import ChangedFilesPopover from './ChangedFilesPopover.svelte';
  import type { SessionChanges } from '../panes/sessionChanges';

  interface Props {
    /** Absent on any mount with no engine session behind it (the bare collab
     *  composer), which is the same thing as "nothing changed" here. */
    changes?: SessionChanges;
  }
  let { changes }: Props = $props();

  let open = $state(false);
  const fileCount = $derived(changes?.fileCount ?? 0);
</script>

{#if changes && fileCount > 0}
  <span class="changes-anchor">
    <button
      class="changes-pill"
      aria-expanded={open}
      use:tip={{ text: changes.partial ? 'Files changed in the LOADED part of this chat - older messages are not loaded yet' : 'Files this chat has changed - click for the list', anchor: 'composer' }}
      onclick={() => (open = !open)}
    >
      <span class="cp-files">{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
      <span class="cp-add">+{changes.adds}</span>
      <span class="cp-del">−{changes.dels}</span>
      {#if changes.partial}<span class="cp-part">loaded</span>{/if}
    </button>
    {#if open}<ChangedFilesPopover {changes} onClose={() => (open = false)} />{/if}
  </span>
{/if}

<style>
  /* NO `position` here (t-rnavdc): the popover must anchor to the COMPOSER,
     the same one `.ctx-card-pop` uses, not to this chip — a `relative` here
     used to make it the popover's positioning context and its right edge ran
     off the composer's own border. Leaving this unpositioned lets `.cp-pop`'s
     `position: absolute` resolve against `.input-area` instead. */
  .changes-anchor { display: inline-flex; align-items: center; }

  /* The outline-pill idiom MessageRow's .token-badge/.spend-badge established,
     with tabular-nums so the counts do not jitter as they climb. */
  .changes-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 16px;
    font: inherit;
    font-size: 10px;
    padding: 0 6px;
    color: var(--og-text-muted);
    background: transparent;
    border: 1px solid var(--og-border);
    /* 4px, the model trigger's radius - NOT 8px. At ~16px tall the old radius
       was half the height, so the chip read as a lozenge beside Send. */
    border-radius: 4px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    opacity: 0.8;
  }
  .changes-pill:hover { opacity: 1; border-color: var(--og-chat); }

  .cp-add { color: var(--og-success); }
  .cp-del { color: var(--og-error); }
  .cp-part { color: var(--og-text-muted); font-style: italic; }
</style>

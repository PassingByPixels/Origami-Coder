<script lang="ts">
  // The composer's UTILITY ROW, between the model bar and the input box: the
  // running "5 files +312 −40" pill at the left, the focus eye at the right.
  //
  // The PILL still renders only once something has been edited — the footer's
  // vertical space belongs to the input box, and a permanent "0 files" strip
  // would cost every chat a line to say nothing. The ROW now outlives it,
  // because the eye is a control over the transcript rather than a read-out of
  // it and has to be reachable before the first edit. With NEITHER (the bare
  // collab composer, which passes no `onToggleFocus`) nothing renders at all.
  //
  // The SUMMARY is computed by the caller (ChatPane, via sessionChanges.ts)
  // from that cell's own transcript, the same split CompactionThresholdMenu
  // and ModeControl draw: this file decides how the numbers look, never what
  // they are. It does post its OWN openAbsoluteFile, on VisionPinRow's
  // precedent — the host owns opening a file and answers by opening it, so
  // routing the click back up through InputBar would buy nothing but a prop.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import FocusEye from './FocusEye.svelte';
  import type { SessionChanges } from '../panes/sessionChanges';

  interface Props {
    /** Absent on any mount with no engine session behind it (the bare collab
     *  composer), which is the same thing as "nothing changed" here. */
    changes?: SessionChanges;
    /** Focus view is ON for this chat — the eye reads as pressed. */
    focused?: boolean;
    /** Flip focus view. ABSENT draws NO eye: a transcript control with no
     *  transcript under it is a dead button, and the collab composer has none. */
    onToggleFocus?: () => void;
  }
  let { changes, focused = false, onToggleFocus }: Props = $props();

  const vscode = getVsCodeApi();
  let open = $state(false);

  const fileCount = $derived(changes?.fileCount ?? 0);

  /** Both separators, because the wire hands back whatever the OS gave the
   *  engine — a Windows session's paths arrive with backslashes. */
  function baseName(p: string): string {
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return cut >= 0 ? p.slice(cut + 1) : p;
  }
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') open = false; }} />

{#if onToggleFocus || (changes && fileCount > 0)}
  <div class="changes-row">
    {#if changes && fileCount > 0}
      <button
        class="changes-pill"
        aria-expanded={open}
        title="Files this chat has changed — click for the list"
        onclick={() => (open = !open)}
      >
        <span class="cp-files">{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
        <span class="cp-add">+{changes.adds}</span>
        <span class="cp-del">−{changes.dels}</span>
      </button>

      {#if open}
        <!-- Full-screen transparent catcher, the same idiom CompactionThresholdMenu's
             .ctm-backdrop uses: any click outside the list closes it. -->
        <button class="cp-backdrop" aria-label="Close changed files" onclick={() => (open = false)}></button>
        <div class="cp-pop" role="dialog" aria-label="Files changed in this chat">
          {#each changes.files as f (f.path)}
            <button class="cp-file" title={f.path} onclick={() => vscode.postMessage({ type: 'openAbsoluteFile', path: f.path })}>
              <span class="cp-name">{baseName(f.path)}</span>
              {#if f.created}<span class="cp-new">new</span>{/if}
              <span class="cp-add">+{f.adds}</span>
              <span class="cp-del">−{f.dels}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
    {#if onToggleFocus}<FocusEye {focused} onToggle={onToggleFocus} />{/if}
  </div>
{/if}

<style>
  /* `relative` so the popover anchors to the pill rather than to whatever
     positioned ancestor the composer happens to have.
     NO padding AT ALL: vertical reads as a dead band above the textarea
     (0.4.60 UAT), and the 12px sides went when 0.4.61 moved this row INSIDE
     the textarea's column — `.input-row` already carries that inset, and a
     second one would hold the row off the box it must sit flush on. */
  .changes-row {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0;
  }

  /* The outline-pill idiom MessageRow's .token-badge/.spend-badge established,
     with tabular-nums so the counts do not jitter as they climb. */
  .changes-pill {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    font: inherit;
    font-size: 10px;
    padding: 1px 7px;
    color: var(--og-text-muted);
    background: transparent;
    border: 1px solid var(--og-border);
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    opacity: 0.8;
  }
  .changes-pill:hover { opacity: 1; border-color: var(--og-chat); }

  .cp-add { color: var(--og-success); }
  .cp-del { color: var(--og-error); }

  .cp-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    cursor: default;
  }
  /* Above the pill (the input box is below it, and a list dropping over the
     textarea would cover what the user is typing). Capped and scrolled: a long
     session touches dozens of files and the composer must not grow with them. */
  .cp-pop {
    position: absolute;
    bottom: calc(100% + 4px);
    /* Both were measured off the row's old 12px padding: it is the box's width now. */
    left: 0;
    z-index: 41;
    min-width: 220px;
    max-width: 100%;
    max-height: 220px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    /* The composer's own drop shadow, verbatim from ApprovePopover/ModeControl.
       A shadow is opacity over whatever is behind it, not a themed surface, and
       there is no --og-* shadow var; a sixth composer popover that alone had
       none would read as a bug. See ChangesPill.test.ts for the proof that
       every actual COLOUR here is a var. */
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
  }

  .cp-file {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    font: inherit;
    font-size: 11px;
    text-align: left;
    padding: 3px 6px;
    color: var(--og-text-secondary);
    background: transparent;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .cp-file:hover { background: var(--og-btn-hover); color: var(--og-text); }

  /* The basename is the only part worth reading at a glance; the full path is
     the button's `title`. It ellipsises rather than widening the popover, so a
     deep path cannot push the counts off the right edge. */
  .cp-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cp-new {
    flex: 0 0 auto;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    padding: 0 4px;
    border-radius: 6px;
    color: var(--og-success);
    background: var(--og-success-soft);
  }

  .cp-add, .cp-del { flex: 0 0 auto; }
</style>

<script lang="ts">
  // The changes pill's PER-FILE LIST — the popover that opens above it.
  //
  // EXTRACTED VERBATIM from ChangesPill.svelte, which stood at 199 of its
  // 200-line cap with the second-opinion control still to land. Its own cap note
  // named this exact seam ("ONE line left: the next thing here extracts — the
  // popover is the obvious seam"), so this is the extraction that file asked
  // for, not a convenient one. Markup, class names, `baseName` and every scoped
  // rule moved together: Svelte scopes <style> per component, so a rule left
  // behind would silently stop matching, and vitest never puts a <style> element
  // in the test DOM to notice with.
  //
  // It posts its OWN openAbsoluteFile, exactly as it did inside the pill (on
  // VisionPinRow's precedent): the host owns opening a file and answers by
  // opening it, so routing the click up through two parents would buy nothing.
  //
  // It is mounted ONLY while open, which is why Escape lives here now rather
  // than as a guarded `open &&` listener in the parent — an unmounted popover
  // cannot be asked to close.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import type { SessionChanges } from '../panes/sessionChanges';

  interface Props {
    /** The rollup this list draws (sessionChanges.ts). */
    changes: SessionChanges;
    /** Close the list — Escape, or a click on the full-screen catcher. */
    onClose: () => void;
  }
  let { changes, onClose }: Props = $props();

  const vscode = getVsCodeApi();

  /** Both separators, because the wire hands back whatever the OS gave the
   *  engine — a Windows session's paths arrive with backslashes. */
  function baseName(p: string): string {
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return cut >= 0 ? p.slice(cut + 1) : p;
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- Full-screen transparent catcher, the same idiom CompactionThresholdMenu's
     .ctm-backdrop uses: any click outside the list closes it. -->
<button class="cp-backdrop" aria-label="Close changed files" onclick={onClose}></button>
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

<style>
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
     session touches dozens of files and the composer must not grow with them.
     Right edge on the composer's own gutter line, same mechanism as
     `.ctx-card-pop` in InputBar.svelte (change 55): `.changes-anchor` carries
     no `position` of its own any more, so this resolves against `.input-area`
     — the composer itself — not the small pill button, which is what let the
     list overhang the composer's right border before. */
  .cp-pop {
    position: absolute;
    bottom: calc(100% + 4px);
    right: var(--composer-gutter, 12px);
    z-index: 41;
    min-width: 220px;
    max-width: calc(100% - 2 * var(--composer-gutter, 12px));
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
       none would read as a bug. See ChangedFilesPopover.test coverage in
       ChangesPill.test.ts for the proof that every actual COLOUR here is a var. */
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

  /* The pill draws its own copies of these two; a scoped rule cannot cross a
     component boundary, so the totals row and the per-file rows each carry the
     colour they need. */
  .cp-add { flex: 0 0 auto; color: var(--og-success); }
  .cp-del { flex: 0 0 auto; color: var(--og-error); }
</style>

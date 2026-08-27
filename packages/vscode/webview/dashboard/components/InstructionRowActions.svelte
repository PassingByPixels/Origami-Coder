<script module lang="ts">
  // Pure row-visibility rule, exported so it is unit-testable without
  // rendering: which row gets a "Restore default" button, and which default
  // it restores. null = no button — a built-in prompt has nothing to restore
  // (it IS the default), and every other row (global/config/memory/url, or a
  // project CLAUDE.md/CONTEXT.md) has no known default to restore TO.
  import { isPinned } from './instructionRows';
  export type RestoreKind = 'base-prompt' | 'agents-md' | 'collab-agent-base';
  export function restoreKindFor(e: { source: string; path: string; overridden?: boolean }): RestoreKind | null {
    // Every pinned prompt restores identically: delete the override file.
    if (isPinned(e)) return e.overridden ? (e.source as RestoreKind) : null;
    const name = e.path.split(/[\\/]/).pop();
    return e.source === 'project' && name === 'AGENTS.md' ? 'agents-md' : null;
  }
</script>

<script lang="ts">
  // The button itself. Split out of InstructionsPane.svelte, which sits at
  // its 160-line architecture cap with no room to grow in place.
  //
  // The confirm dialog is HOST-side (vscode.window.showWarningMessage with
  // {modal:true}) — a webview has no native dialog API, only postMessage.
  // This button only asks; DashboardPanel.ts decides, and only overwrites
  // after the user confirms in that native prompt.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  const vscode = getVsCodeApi();

  interface Props { kind: RestoreKind; }
  let { kind }: Props = $props();

  function restore(e: MouseEvent): void {
    // The row itself is the open-file click target — this must never bubble
    // into that, or "restore default" would also open the file.
    e.stopPropagation();
    vscode.postMessage({ type: 'restoreInstructionDefault', kind });
  }
</script>

<button class="ins-restore" onclick={restore} title="Overwrite this file with its default — asks to confirm first">
  Restore default
</button>

<style>
  .ins-restore {
    position: relative;
    align-self: flex-start;
    margin-top: 2px;
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    color: var(--og-text-secondary);
    border-radius: 4px;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 10px;
    font-family: inherit;
  }
  .ins-restore:hover { background: var(--og-btn-hover); color: var(--og-text); border-color: var(--og-warning); }
</style>

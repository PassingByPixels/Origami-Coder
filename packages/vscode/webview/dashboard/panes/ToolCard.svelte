<script lang="ts">
  // One card in ToolsPane's grid — extracted (t-kgtaac round 3) so the pane
  // stays under its architecture cap, same move InstructionsPane's rows got
  // (InstructionRow.svelte). Pure presentation: the parent owns state and the
  // `vscode.postMessage` calls, this owns only how one tool reads.
  //
  // The state control itself lives one file further down
  // (ToolStateSwitch.svelte) — it went from two states to three and no longer
  // fit here.
  import ToolStateSwitch, { type ToolState } from './ToolStateSwitch.svelte';

  export interface ToolCardEntry {
    id: string;
    description: string;
    deferred: boolean;
    /** OFF — `tools: { <id>: false }`. Outranks `deferred` when both are set:
     *  the engine drops a disabled tool BEFORE it decides what to defer
     *  (session/tools.ts), so off is what actually happened. */
    disabled: boolean;
    source: 'builtin' | 'mcp' | 'user-file' | 'plugin';
    location?: string;
    hardRequired: boolean;
  }

  let { entry, onPick, onCopy }: {
    entry: ToolCardEntry;
    onPick: (e: ToolCardEntry, next: ToolState) => void;
    onCopy: (e: ToolCardEntry) => void;
  } = $props();

  function sourceLabel(s: ToolCardEntry['source']): string {
    if (s === 'mcp') return 'MCP server';
    if (s === 'user-file') return 'user file';
    if (s === 'plugin') return 'plugin';
    return 'builtin';
  }

  /** ONE derivation, read by the badge and the switch alike, so the two can
   *  never disagree about what this tool is. */
  const state = $derived<ToolState>(entry.disabled ? 'off' : entry.deferred ? 'deferred' : 'loaded');

  // tool_search is a synthetic row (toolSearchRow.ts) — it is never registered,
  // only offered once something IS deferred, which is exactly why it cannot
  // defer itself or be switched off.
  const lockedReason = $derived(
    entry.id === 'tool_search'
      ? 'tool_search has no state to set — it is what loads a deferred tool\'s schema on demand.'
      : `${entry.id} is always registered; the engine relies on it.`,
  );
</script>

<div class="tool-card" class:deferred={state === 'deferred'} class:off={state === 'off'}>
  <div class="tool-head">
    <span class="tool-name">{entry.id}</span>
    <span class="tool-source">{sourceLabel(entry.source)}</span>
  </div>
  {#if entry.description}<div class="tool-desc">{entry.description.split('\n')[0]}</div>{/if}
  <div class="tool-foot">
    <span class="tl-badge" class:deferred={state === 'deferred'} class:off={state === 'off'}>{state}</span>
    <div class="tool-actions">
      {#if entry.source === 'user-file' && entry.location}
        <button class="tool-copy" onclick={() => onCopy(entry)} title={`Copy ${entry.location}`}>Copy path</button>
      {/if}
      <ToolStateSwitch id={entry.id} {state} locked={entry.hardRequired} {lockedReason}
        onpick={(next) => onPick(entry, next)} />
    </div>
  </div>
</div>

<style>
  .tool-card { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 10px 11px; display: flex; flex-direction: column; min-height: 76px; gap: 6px; }
  .tool-card.deferred { border-style: dashed; }
  /* OFF is not "deferred harder": the card goes quiet, which is the honest
     picture of a tool the model is never handed. Carried by opacity AND the
     badge word, so it survives a theme where the tones read alike. */
  .tool-card.off { opacity: 0.62; border-style: dotted; }
  .tool-head { display: flex; align-items: baseline; gap: 8px; }
  .tool-name { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; font-size: 12px; color: var(--og-text); }
  .tool-source { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--og-text-muted); }
  .tool-desc { font-size: 11px; color: var(--og-text-secondary); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; }
  /* The badge repeats what the card's border style already says, so the state
     survives a theme where the two backgrounds read alike. */
  .tl-badge { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; background: var(--og-success-soft); color: var(--og-success-text); }
  .tl-badge.deferred { background: var(--og-warning-soft); color: var(--og-warning-text); }
  .tl-badge.off { background: var(--og-error-soft); color: var(--og-error-text); }
  .tool-actions { display: flex; align-items: center; gap: 6px; }
  .tool-copy { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 7px; font-size: 10px; }
  .tool-copy:hover { background: var(--og-btn-hover); }
</style>

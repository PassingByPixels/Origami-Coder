<script lang="ts">
  // Flock M4 (C27) — the compact tool trace a turn left behind, folded.
  //
  // FOLDED BY DEFAULT, because a turn that ran twelve tools would otherwise
  // bury the sentence it produced. Open, it is the whole list: tool, what it
  // was called on, and whether it worked. Nothing is summarised further here —
  // the engine already capped the trace at 20 entries and each summary at 120
  // chars, and a second truncation on top of that would hide a truncation.
  //
  // The open-state idiom is PromptCaptureSection's: a caret button whose label
  // states the count, so the row says what is behind it before it is opened.
  import type { TraceEntry } from '../../src/acpExtTypes';

  interface Props { entries: TraceEntry[] }
  let { entries }: Props = $props();

  let open = $state(false);
  const failed = $derived(entries.filter((e) => e.status === 'error').length);
</script>

{#if entries.length > 0}
  <div class="cs-trace">
    <button
      class="cs-trace-head"
      onclick={() => (open = !open)}
      title="The tools this turn ran, as the engine recorded them"
    >
      <span class="cs-caret" class:is-open={open}>&#9656;</span>
      <span class="cs-trace-count">{entries.length} tool{entries.length === 1 ? '' : 's'} ran</span>
      <!-- A failure is stated on the FOLDED row: a trace you have to open to
           learn something went wrong is a trace nobody opens. -->
      {#if failed > 0}<span class="cs-trace-failed">{failed} failed</span>{/if}
    </button>
    {#if open}
      <ul class="cs-trace-list">
        {#each entries as e, i (i)}
          <li class="cs-trace-row" class:is-error={e.status === 'error'}>
            <span class="cs-trace-tool">{e.tool}</span>
            <span class="cs-trace-sum">{e.summary}</span>
            <span class="cs-trace-status">{e.status}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .cs-trace { margin-top: 4px; }
  .cs-trace-head {
    display: flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    color: var(--og-text-muted);
  }
  .cs-trace-head:hover { color: var(--og-text-secondary); }
  .cs-caret { display: inline-block; transition: transform 0.12s; }
  .cs-caret.is-open { transform: rotate(90deg); }
  .cs-trace-count { font-family: var(--vscode-editor-font-family, monospace); }
  .cs-trace-failed { color: var(--og-error-text); }

  .cs-trace-list {
    list-style: none;
    margin: 3px 0 0;
    padding: 0 0 0 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cs-trace-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 10px;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .cs-trace-tool { color: var(--og-text-secondary); flex: 0 0 auto; }
  .cs-trace-sum { flex: 1 1 auto; overflow-wrap: anywhere; }
  .cs-trace-status { flex: 0 0 auto; }
  .cs-trace-row.is-error .cs-trace-status, .cs-trace-row.is-error .cs-trace-tool { color: var(--og-error-text); }
</style>

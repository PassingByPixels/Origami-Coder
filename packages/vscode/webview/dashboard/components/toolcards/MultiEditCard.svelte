<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — specialised renderer for
  // multi_edit results. The runtime returns
  //   "Applied N edits to <path> (atomic — all or none)."
  // (see crates/tools/src/multi_edit.rs:174). Atomic to ONE file with
  // multiple edits — the per-edit diffs aren't echoed back today.
  // We render the path as clickable and surface the edit count.
  //
  // If the runtime ever extends the result to include per-edit diffs,
  // this card can absorb them; for now the surface is a summary line.

  import { getVsCodeApi } from '../../../shared/vscodeApi';

  interface Props {
    result: string;
  }

  let { result }: Props = $props();

  const vscode = getVsCodeApi();

  interface ParsedMulti {
    count: number;
    path: string;
    suffix: string;
  }

  function parseMulti(text: string): ParsedMulti | null {
    const m = /^Applied\s+(\d+)\s+edits?\s+to\s+(.+?)\s+\((.+)\)\.?\s*$/.exec(
      text.split('\n')[0] ?? ''
    );
    if (!m) return null;
    return {
      count: Number(m[1]),
      path: m[2],
      suffix: m[3],
    };
  }

  let parsed = $derived(parseMulti(result));

  function openPath(path: string) {
    vscode.postMessage({ type: 'openAbsoluteFile', path });
  }
</script>

{#if parsed}
  <div class="multi-card">
    <div class="multi-header">
      <span class="multi-verb">Applied</span>
      <span class="multi-count">{parsed.count} {parsed.count === 1 ? 'edit' : 'edits'}</span>
      <span class="multi-to">to</span>
      <button class="multi-path" onclick={() => openPath(parsed!.path)} title="Open file">
        {parsed.path}
      </button>
    </div>
    <div class="multi-suffix">({parsed.suffix})</div>
  </div>
{:else}
  <pre class="multi-fallback">{result}</pre>
{/if}

<style>
  .multi-card {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .multi-header {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .multi-verb {
    color: var(--og-success, #a6e3a1);
    font-weight: 600;
  }

  .multi-count {
    color: var(--og-text);
    font-weight: 600;
  }

  .multi-to {
    color: var(--og-text-muted);
  }

  .multi-path {
    background: none;
    border: none;
    padding: 0;
    color: var(--og-accent, #89b4fa);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  .multi-path:hover {
    text-decoration: underline;
  }

  .multi-suffix {
    color: var(--og-text-muted);
    font-size: 10px;
    font-style: italic;
    margin-top: 2px;
  }

  .multi-fallback {
    margin: 0;
    color: var(--og-text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
</style>

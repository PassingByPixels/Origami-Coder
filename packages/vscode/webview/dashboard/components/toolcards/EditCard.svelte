<script lang="ts">
  // Edit-tool renderer. Preferred path: the structured ACP
  // `{type:'diff'}` block (the engine's `acp/tool.ts:diffContent`) carrying
  // the replaced region's `oldText` / `newText`, rendered SIDE-BY-SIDE —
  // before (red) on the left, after (green) on the right, aligned row by
  // row. Each side scrolls horizontally so long lines stay on one line in
  // the narrow chat pane; on a very narrow pane the two columns stack.
  //
  // Fallback: when no structured diff is present (a fresh write with no
  // `oldString`, or an older session), render the tool's text output as
  // plain lines.

  interface Props {
    result: string;
    diff?: { path: string; oldText: string; newText: string };
  }

  let { result, diff }: Props = $props();

  interface Row {
    left: string | null;
    right: string | null;
  }

  function splitRows(oldText: string, newText: string): Row[] {
    const oldLines = oldText.length ? oldText.split('\n') : [];
    const newLines = newText.length ? newText.split('\n') : [];
    const n = Math.max(oldLines.length, newLines.length);
    const rows: Row[] = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        left: i < oldLines.length ? oldLines[i] : null,
        right: i < newLines.length ? newLines[i] : null,
      });
    }
    return rows;
  }

  let hasDiff = $derived(!!diff && (diff.oldText.length > 0 || diff.newText.length > 0));
  let rows = $derived(diff ? splitRows(diff.oldText, diff.newText) : []);
</script>

{#if hasDiff && diff}
  <div class="diff-split">
    {#if diff.path}
      <div class="diff-path">{diff.path}</div>
    {/if}
    <div class="diff-grid">
      <div class="head head-old">before</div>
      <div class="head head-new">after</div>
      {#each rows as row, i (i)}
        <div class="cell old" class:blank={row.left === null}>{row.left ?? ''}</div>
        <div class="cell new" class:blank={row.right === null}>{row.right ?? ''}</div>
      {/each}
    </div>
  </div>
{:else}
  <pre class="edit-fallback">{result}</pre>
{/if}

<style>
  .diff-split {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    line-height: 1.4;
  }
  .diff-path {
    color: var(--og-text-muted);
    font-style: italic;
    margin-bottom: 4px;
  }

  /* Two equal columns; the header row spans both. On a pane narrower than
     ~360px the columns stack (before above after) so neither is squeezed
     into illegibility. */
  .diff-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 4px;
    row-gap: 0;
    align-items: stretch;
  }

  .head {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
    padding: 1px 4px;
    margin-bottom: 2px;
    color: var(--og-text-muted);
    border-bottom: 1px solid var(--og-border);
  }
  .head-old { color: color-mix(in srgb, var(--og-error) 80%, var(--og-text-muted)); }
  .head-new { color: color-mix(in srgb, var(--og-success) 80%, var(--og-text-muted)); }

  .cell {
    padding: 0 4px;
    white-space: pre;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .cell.old {
    background: rgba(243, 139, 168, 0.10);
    color: var(--og-text-secondary);
  }
  .cell.new {
    background: rgba(80, 220, 80, 0.10);
    color: var(--og-text);
  }
  /* A side with no corresponding line (one text longer than the other) —
     a faint hatched filler so the row alignment reads as add/remove. */
  .cell.blank {
    background:
      repeating-linear-gradient(
        45deg,
        transparent,
        transparent 5px,
        var(--og-border) 5px,
        var(--og-border) 6px
      );
    opacity: 0.5;
    min-height: 1.4em;
  }

  @media (max-width: 360px) {
    .diff-grid {
      grid-template-columns: 1fr;
    }
    /* In stacked mode keep before/after visually paired by colour; the
       header labels still announce which is which. */
    .head-new { margin-top: 6px; }
  }

  .edit-fallback {
    margin: 0;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.4;
  }
</style>

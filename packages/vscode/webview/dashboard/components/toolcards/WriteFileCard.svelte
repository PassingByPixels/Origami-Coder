<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — specialised renderer for
  // write_file results. The runtime returns a header
  //   "Wrote N lines (B bytes) to <path>\n\n[content echo — ...]\n<echo>"
  // (see crates/tools/src/write.rs:254). For ≤20 lines the full
  // content echoes; for larger files head 5 + tail 5 with an omitted
  // count between.
  //
  // We parse the header, surface the path as a clickable open-in-editor
  // link, and render the content echo in a code block with light
  // highlight.js styling. Diff-style tinting isn't applicable here
  // (this is a fresh write, not a replacement) so we keep the
  // background neutral.

  import { getVsCodeApi } from '../../../shared/vscodeApi';
  import { tip } from '../../../shared/warmTip';

  interface Props {
    result: string;
    /** Absolute file path from the ACP tool `locations` — authoritative,
     *  always present for write. Used when the result text doesn't carry a
     *  parseable path (the Origami engine returns a terse "Wrote file
     *  successfully." that has none — only the donor Rust runtime emits the
     *  "Wrote N lines (B bytes) to <path>" header this card originally parsed). */
    path?: string;
    /** Relative path the engine set as the tool title (e.g. projects/x/app.html).
     *  Preferred for display since it's shorter than the absolute path. */
    title?: string;
  }

  let { result, path, title }: Props = $props();

  const vscode = getVsCodeApi();

  interface ParsedWrite {
    verb: string;
    lines: number;
    bytes: number;
    path: string;
    echo: string;
  }

  function parseWrite(text: string): ParsedWrite | null {
    // First line:  "Wrote 12 lines (340 bytes) to src/foo.rs"
    //          or  "Created 12 lines (340 bytes) to src/foo.rs"
    const lines = text.split('\n');
    const headerRe = /^(\w+)\s+(\d+)\s+lines\s+\((\d+)\s+bytes\)\s+to\s+(.+?)\s*$/;
    const m = headerRe.exec(lines[0] ?? '');
    if (!m) return null;
    // Body starts after a blank line; first body line is the
    // "[content echo — ...]" marker which we strip.
    let bodyStart = 1;
    while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart++;
    if (bodyStart < lines.length && /^\[content echo/.test(lines[bodyStart])) {
      bodyStart++;
    }
    return {
      verb: m[1],
      lines: Number(m[2]),
      bytes: Number(m[3]),
      path: m[4],
      echo: lines.slice(bodyStart).join('\n'),
    };
  }

  let parsed = $derived(parseWrite(result));
  // Display path: the authoritative locations path first (the title is now the
  // bare tool name "write", not a path), then a parsed donor header. Open always
  // targets the absolute path.
  let displayPath = $derived(parsed?.path ?? path ?? title ?? '');
  let openTarget = $derived(path ?? parsed?.path ?? title ?? '');

  function openPath(p: string) {
    if (p) vscode.postMessage({ type: 'openAbsoluteFile', path: p });
  }
</script>

{#if parsed}
  <div class="write-card">
    <div class="write-header">
      <span class="write-verb">{parsed.verb}</span>
      <button class="write-path" onclick={() => openPath(parsed!.path)} use:tip={'Open file'}>
        {parsed.path}
      </button>
      <span class="write-stats">
        {parsed.lines} {parsed.lines === 1 ? 'line' : 'lines'} · {parsed.bytes} bytes
      </span>
    </div>
    {#if parsed.echo}
      <pre class="write-echo">{parsed.echo}</pre>
    {/if}
  </div>
{:else}
  <!-- Origami engine's terse "Wrote file successfully." carries no path in the
       result text, so surface the authoritative path from the tool metadata. -->
  <!-- t-yyz5yk (Round 8): the file bar. The engine sends no content for a
       write (no diff block: acp/tool.ts diffContent needs oldString), so the
       mockup's numbered new lines and line count are deferred. -->
  <div class="write-card dbox">
    {#if displayPath}
      <div class="dbar">
        <span class="write-path-text"><bdi dir="ltr">{displayPath}</bdi></span>
        <span class="write-state">· written</span>
        <span class="sp"></span>
        <button type="button" class="write-open" onclick={() => openPath(openTarget)} use:tip={`Open ${displayPath}`}>Open file</button>
      </div>
    {/if}
    {#if result && result.trim() !== 'Wrote file successfully.'}
      <pre class="write-fallback">{result}</pre>
    {/if}
  </div>
{/if}

<style>
  .dbox { border: 1px solid var(--og-border); border-radius: 8px; background: var(--og-bg); overflow: hidden; }
  .dbar { display: flex; align-items: center; gap: 6px; padding: 3px 8px; background: color-mix(in srgb, var(--og-surface) 60%, transparent); color: var(--og-text-muted); }
  .write-path-text { color: var(--og-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .write-state { color: var(--og-success); flex: none; }
  .sp { flex: 1; }
  .write-open { flex: none; background: none; border: 0; padding: 0; font: inherit; color: var(--og-chat, var(--og-accent)); cursor: pointer; }
  .write-open:hover { text-decoration: underline; }
  .dbox .write-fallback { padding: 6px 8px; border-top: 1px solid var(--og-border); }
  .write-card {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .write-header {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 4px;
  }

  .write-verb {
    color: var(--og-success, #a6e3a1);
    font-weight: 600;
  }

  .write-path {
    background: none;
    border: none;
    padding: 0;
    color: var(--og-accent, #89b4fa);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .write-path:hover {
    text-decoration: underline;
  }

  .write-stats {
    color: var(--og-text-muted);
    font-size: 10px;
  }

  .write-echo {
    margin: 0;
    padding: 4px 6px;
    background: var(--og-bg, #181825);
    border-radius: 3px;
    color: var(--og-text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.4;
    max-height: 180px;
    overflow: auto;
  }

  .write-fallback {
    margin: 0;
    color: var(--og-text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
</style>

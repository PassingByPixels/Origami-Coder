<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — specialised renderer for
  // grep results. The runtime returns one match per line in
  // `path:line: content` form (see crates/tools/src/grep.rs:147).
  // Previously this dropped through the GenericCard fallback as an
  // opaque <pre> block; now each row is a clickable filename, a line
  // badge, and the matching text. Click a path → opens the file in
  // VS Code at the matching line.

  import { getVsCodeApi } from '../../../shared/vscodeApi';

  interface Props {
    result: string;
  }

  let { result }: Props = $props();

  const vscode = getVsCodeApi();

  interface GrepHit {
    path: string;
    line: number;
    text: string;
  }

  function parseGrep(input: string): { hits: GrepHit[]; preamble: string[] } {
    // Format: `path:line: content`. Truncate at 50 hits + "(+N more)".
    // Tolerate the runtime's optional header lines (e.g. "Found N
    // matches in M files") by classifying any line that doesn't match
    // the `path:line: ` shape as preamble.
    const hits: GrepHit[] = [];
    const preamble: string[] = [];
    const lineRe = /^([^:]+):(\d+):\s?(.*)$/;
    for (const raw of input.split('\n')) {
      if (!raw.trim()) continue;
      const m = lineRe.exec(raw);
      if (m) {
        hits.push({ path: m[1], line: Number(m[2]), text: m[3] });
      } else {
        preamble.push(raw);
      }
    }
    return { hits, preamble };
  }

  let parsed = $derived(parseGrep(result));
  const MAX_VISIBLE = 50;
  let visibleHits = $derived(parsed.hits.slice(0, MAX_VISIBLE));
  let overflow = $derived(parsed.hits.length - visibleHits.length);

  function openPath(path: string, line: number) {
    vscode.postMessage({ type: 'openAbsoluteFile', path, line });
  }
</script>

{#if parsed.preamble.length > 0}
  <div class="grep-preamble">
    {#each parsed.preamble as p, i (i)}
      <div>{p}</div>
    {/each}
  </div>
{/if}

{#if visibleHits.length === 0 && parsed.preamble.length === 0}
  <div class="grep-empty">(no matches)</div>
{:else}
  <ul class="grep-list">
    {#each visibleHits as hit, i (i)}
      <li class="grep-row">
        <button
          class="grep-path"
          onclick={() => openPath(hit.path, hit.line)}
          title={`Open ${hit.path}:${hit.line}`}
        >
          {hit.path}
        </button>
        <span class="grep-line-badge">:{hit.line}</span>
        <span class="grep-text">{hit.text}</span>
      </li>
    {/each}
    {#if overflow > 0}
      <li class="grep-overflow">… (+{overflow} more matches)</li>
    {/if}
  </ul>
{/if}

<style>
  .grep-preamble {
    color: var(--og-text-muted);
    font-size: 11px;
    font-style: italic;
    margin-bottom: 4px;
  }

  .grep-empty {
    color: var(--og-text-muted);
    font-style: italic;
    font-size: 11px;
  }

  .grep-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .grep-row {
    display: flex;
    align-items: baseline;
    gap: 4px;
    padding: 1px 2px;
    border-radius: 2px;
  }
  .grep-row:hover {
    background: var(--og-btn-bg);
  }

  .grep-path {
    flex: 0 0 auto;
    background: none;
    border: none;
    padding: 0;
    color: var(--og-accent, #89b4fa);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    text-decoration: none;
  }
  .grep-path:hover {
    text-decoration: underline;
  }

  .grep-line-badge {
    flex: 0 0 auto;
    color: var(--og-text-muted);
  }

  .grep-text {
    flex: 1 1 auto;
    color: var(--og-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .grep-overflow {
    color: var(--og-text-muted);
    font-style: italic;
    padding: 2px;
  }
</style>

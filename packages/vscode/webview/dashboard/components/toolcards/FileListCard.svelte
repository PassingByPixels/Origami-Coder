<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — specialised renderer for
  // `glob` and `list_dir` results.
  //
  //   * glob format:      "{N} matches:\n{path1}\n{path2}\n..."
  //                       or "No files matching \"PATTERN\" in BASE"
  //                       (see crates/tools/src/glob.rs:104, 106)
  //   * list_dir format:  "Listing: <path>\n{kind}  {name}  →  {full}"
  //                       or "Listing: <path>\n(empty directory)"
  //                       (see crates/tools/src/list_dir.rs:81-87)
  //
  // We parse both into a unified clickable file list. The list_dir
  // `kind` column (file/dir) becomes a left-side icon.

  import { getVsCodeApi } from '../../../shared/vscodeApi';

  interface Props {
    result: string;
  }

  let { result }: Props = $props();

  const vscode = getVsCodeApi();

  interface FileRow {
    icon: string;   // 📄 for file, 📁 for dir, ↪ for glob hit (kind unknown)
    name: string;   // display name
    fullPath: string | null;  // absolute path (clickable) or null if synthetic
  }

  interface Parsed {
    header: string;
    rows: FileRow[];
  }

  function parseFileList(text: string): Parsed {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) {
      return { header: '(empty)', rows: [] };
    }

    const first = lines[0];

    // list_dir variant: "Listing: <path>"
    if (/^Listing:\s/.test(first)) {
      const rows: FileRow[] = [];
      for (const line of lines.slice(1)) {
        if (line === '(empty directory)') return { header: first, rows: [] };
        // "{kind}  {name}  →  {full}"
        const m = /^(\S+)\s+(.+?)\s+→\s+(.+?)\s*$/.exec(line);
        if (m) {
          const kind = m[1];
          const icon = /^d/i.test(kind) ? '📁' : '📄';
          rows.push({ icon, name: m[2], fullPath: m[3] });
        }
      }
      return { header: first, rows };
    }

    // glob variant: "{N} matches:" or "No files matching ..."
    if (/^\d+\s+matches?:/.test(first) || /^No files matching/.test(first)) {
      const rows: FileRow[] = [];
      for (const line of lines.slice(1)) {
        rows.push({ icon: '↪', name: line, fullPath: line });
      }
      return { header: first, rows };
    }

    // Unknown shape — treat every line as a path.
    return {
      header: '',
      rows: lines.map(l => ({ icon: '·', name: l, fullPath: l })),
    };
  }

  let parsed = $derived(parseFileList(result));
  const MAX_VISIBLE = 80;
  let visibleRows = $derived(parsed.rows.slice(0, MAX_VISIBLE));
  let overflow = $derived(parsed.rows.length - visibleRows.length);

  function openPath(path: string | null) {
    if (path) vscode.postMessage({ type: 'openAbsoluteFile', path });
  }
</script>

<div class="filelist-card">
  {#if parsed.header}
    <div class="filelist-header">{parsed.header}</div>
  {/if}
  {#if visibleRows.length === 0}
    <div class="filelist-empty">(no entries)</div>
  {:else}
    <ul class="filelist">
      {#each visibleRows as r, i (i)}
        <li class="filelist-row">
          <span class="filelist-icon">{r.icon}</span>
          {#if r.fullPath}
            <button class="filelist-name filelist-clickable" onclick={() => openPath(r.fullPath)}>
              {r.name}
            </button>
          {:else}
            <span class="filelist-name">{r.name}</span>
          {/if}
        </li>
      {/each}
      {#if overflow > 0}
        <li class="filelist-overflow">… (+{overflow} more)</li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .filelist-card {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .filelist-header {
    color: var(--og-text-muted);
    font-style: italic;
    margin-bottom: 4px;
  }

  .filelist-empty {
    color: var(--og-text-muted);
    font-style: italic;
  }

  .filelist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .filelist-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 1px 2px;
    border-radius: 2px;
  }
  .filelist-row:hover {
    background: var(--og-btn-bg);
  }

  .filelist-icon {
    flex: 0 0 auto;
    width: 16px;
  }

  .filelist-name {
    color: var(--og-text-secondary);
    font-family: inherit;
    font-size: inherit;
  }

  .filelist-clickable {
    background: none;
    border: none;
    padding: 0;
    color: var(--og-accent, #89b4fa);
    cursor: pointer;
  }
  .filelist-clickable:hover {
    text-decoration: underline;
  }

  .filelist-overflow {
    color: var(--og-text-muted);
    font-style: italic;
    padding: 2px;
  }
</style>

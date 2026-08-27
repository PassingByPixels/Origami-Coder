<script lang="ts">
  // Agent Manager (S4) — the expanded surface under a Done card: the per-file
  // change set (baseSha..working-tree, matching the badge), each row a checkbox
  // + path + (+adds/−dels or "binary"). A row click opens the native VS Code
  // diff (amOpenFileDiff); the footer applies the checked files to the main
  // repo's WORKING TREE (amApply — never commits/stages). A failed apply marks
  // the conflicted rows red and offers "Apply anyway" (a forced --3way that
  // leaves conflict markers for the user to resolve). Self-contained: it owns a
  // window listener keyed to its `id`, so amDiffFiles / amApplyResult replies
  // for THIS card land here. The parent posts the initial amDiffFiles on expand.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';

  interface DiffFile { path: string; adds: number; dels: number; binary: boolean; }
  interface Props {
    root: string;
    id: string;
    /** >0 = this card was already applied (Merged): render read-only — no
     *  checkboxes, no Apply button, just an "Applied ✓" note. */
    mergedAt: number;
    /** Called on a CLEAN apply so the parent collapses + shows a success note. */
    onApplied: () => void;
    /** Called when the user dismisses the panel (Cancel). */
    onClose: () => void;
  }
  let { root, id, mergedAt, onApplied, onClose }: Props = $props();

  const vscode = getVsCodeApi();

  let files = $state<DiffFile[]>([]);
  let loaded = $state(false);
  let checked = $state<Record<string, boolean>>({});
  let conflicts = $state<string[]>([]);
  let applying = $state(false);
  let note = $state('');
  /** The refused patch is already present in main (an earlier apply left it
   *  uncommitted): a calm no-op, NOT a conflict — no "Apply anyway". */
  let alreadyApplied = $state(false);

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data || {};
      if (m.type === 'amDiffFiles' && m.id === id) {
        files = Array.isArray(m.files) ? m.files : [];
        checked = Object.fromEntries(files.map((f) => [f.path, true]));
        conflicts = []; note = ''; applying = false; alreadyApplied = false; loaded = true;
      } else if (m.type === 'amApplyResult' && m.id === id) {
        applying = false;
        if (m.ok) { onApplied(); return; }
        alreadyApplied = m.alreadyApplied === true;
        conflicts = alreadyApplied ? [] : (Array.isArray(m.conflicts) ? m.conflicts : []);
        if (alreadyApplied) {
          note = 'Already applied — these changes are in your tree. Commit them there when ready.';
        } else {
          note = conflicts.length > 0
            ? 'Could not apply cleanly — main has uncommitted or conflicting changes on these files (possibly from an earlier apply). Commit or revert them, or apply anyway (leaves conflict markers).'
            : (typeof m.error === 'string' && m.error ? m.error : 'Nothing to apply.');
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });

  const checkedPaths = (): string[] => files.filter((f) => checked[f.path] !== false).map((f) => f.path);
  const isConflicted = (p: string): boolean => conflicts.includes(p);

  function openDiff(f: DiffFile): void {
    vscode.postMessage({ type: 'amOpenFileDiff', root, id, path: f.path });
  }
  function apply(force: boolean): void {
    const sel = checkedPaths();
    if (sel.length === 0) return;
    applying = true;
    vscode.postMessage({ type: 'amApply', root, id, files: sel, force });
  }
</script>

<div class="am-diff">
  {#if !loaded}
    <div class="am-diff-msg">Loading changes…</div>
  {:else if files.length === 0}
    <div class="am-diff-msg">No changes to apply.</div>
  {:else}
    <ul class="am-diff-files">
      {#each files as f (f.path)}
        <li class="am-diff-row" class:conflict={isConflicted(f.path)}>
          {#if mergedAt === 0}
            <input class="am-diff-check" type="checkbox" checked={checked[f.path] !== false}
              onchange={(e) => (checked = { ...checked, [f.path]: e.currentTarget.checked })}
              aria-label="include {f.path}" />
          {/if}
          <button class="am-diff-path" onclick={() => openDiff(f)} title="Open diff for {f.path}">
            <span class="mono">{f.path}</span>
            {#if f.binary}
              <span class="am-diff-bin">binary</span>
            {:else}
              <span class="am-diff-stat"><span class="adds">+{f.adds}</span><span class="dels">−{f.dels}</span></span>
            {/if}
          </button>
          {#if isConflicted(f.path)}<span class="am-diff-badge">conflict</span>{/if}
        </li>
      {/each}
    </ul>
    <div class="am-diff-foot">
      {#if mergedAt > 0}
        <span class="am-diff-applied">Applied ✓ {new Date(mergedAt).toLocaleString()}</span>
        <button class="am-btn" onclick={onClose}>Close</button>
      {:else}
      {#if note}<span class="am-diff-note" class:calm={alreadyApplied}>{note}</span>{/if}
      {#if alreadyApplied}
        <button class="am-btn" onclick={onClose}>Close</button>
      {:else if conflicts.length > 0}
        <button class="am-btn danger" onclick={() => apply(true)} disabled={applying}>Apply anyway (leaves conflict markers)</button>
        <button class="am-btn" onclick={onClose}>Cancel</button>
      {:else}
        <button class="am-btn primary" onclick={() => apply(false)} disabled={applying || checkedPaths().length === 0}>
          {applying ? 'Applying…' : `Apply ${checkedPaths().length} file(s) to main`}
        </button>
        <button class="am-btn" onclick={onClose}>Cancel</button>
      {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .am-diff {
    margin-top: 6px;
    border-top: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    padding-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .am-diff-msg { font-size: 11px; opacity: 0.7; padding: 2px 0; }
  .am-diff-files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .am-diff-row { display: flex; align-items: center; gap: 6px; }
  .am-diff-row.conflict .am-diff-path { color: #ff9d9d; }
  .am-diff-check { flex: none; margin: 0; }
  .am-diff-path {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: var(--og-text);
    text-align: left;
    padding: 1px 2px;
    font-size: 11px;
    cursor: pointer;
  }
  .am-diff-path:hover { text-decoration: underline; }
  .am-diff-path .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am-diff-stat { display: flex; gap: 4px; margin-left: auto; font-variant-numeric: tabular-nums; flex: none; }
  .adds { color: #7fc97f; }
  .dels { color: #e08a8a; }
  .am-diff-bin { margin-left: auto; opacity: 0.6; font-style: italic; flex: none; }
  .am-diff-badge {
    flex: none;
    font-size: 10px;
    color: #ff9d9d;
    border: 1px solid rgba(192, 80, 80, 0.5);
    border-radius: 4px;
    padding: 0 4px;
  }
  .am-diff-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
  .am-diff-note { font-size: 11px; color: #e0a860; flex: 1 1 100%; }
  .am-diff-note.calm { color: #7fc97f; }
  .am-diff-applied { font-size: 11px; color: #7fc97f; flex: 1 1 100%; }
  .am-btn {
    background: var(--og-surface, rgba(255, 255, 255, 0.06));
    color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    border-radius: 4px;
    padding: 3px 9px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .am-btn:hover { filter: brightness(1.2); }
  .am-btn.primary { background: var(--og-accent, #3b6ea5); border-color: transparent; }
  .am-btn.danger { color: #ff9d9d; border-color: rgba(192, 80, 80, 0.4); }
  .am-btn:disabled { opacity: 0.5; cursor: default; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
</style>

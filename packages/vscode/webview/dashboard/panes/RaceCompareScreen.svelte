<script lang="ts">
  // Race Compare SCREEN (S6d) — a full editor tab that replaces S6c's in-column
  // numbers table (Passing's UAT: a table doesn't let him SEE how siblings differ).
  // For the UNION of files either selected sibling changed (post-.origami-exclusion)
  // it renders TWO ALIGNED COLUMNS of REAL diff content: sibling A's hunks vs base
  // on the left, sibling B's on the right, with add/remove colouring, per-file
  // +adds/−dels headers, a "not touched" placeholder when one sibling left the file
  // alone, and an honest truncation notice for very large files. Per file you can
  // open that sibling's native base-vs-worktree diff, or a native A-vs-B diff of the
  // two on-disk worktree files. The race identity is injected at mount
  // (window.__ORIGAMI_RACE_COMPARE__); per-file diffs are fetched on demand
  // (amRaceFileDiffs) and re-fetched on a selector change or the manual Refresh —
  // there is no live polling in v1, so a working sibling's files may drift (noted).
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';

  interface Sibling { id: string; name: string; state: string; agentName: string; model: string; }
  interface Params { root: string; groupId: string; base: string; siblings: Sibling[]; }
  interface FileDiff { path: string; adds: number; dels: number; binary: boolean; text: string; truncated: boolean; }

  const vscode = getVsCodeApi();
  function post(msg: Record<string, unknown>): void { vscode.postMessage(msg); }

  let params = $state<Params | null>(null);
  let selA = $state('');
  let selB = $state('');
  // Per-sibling change set keyed by record id (merged from every amRaceFileDiffs
  // reply); the table reads the two selected ids out of it.
  let diffsById = $state<Record<string, FileDiff[]>>({});

  onMount(() => {
    params = (window as unknown as { __ORIGAMI_RACE_COMPARE__?: Params }).__ORIGAMI_RACE_COMPARE__ ?? null;
    const sibs = params?.siblings ?? [];
    selA = sibs[0]?.id ?? '';
    selB = sibs[1]?.id ?? '';
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data || {};
      if (m.type === 'amRaceFileDiffs' && m.diffs && typeof m.diffs === 'object') {
        diffsById = { ...diffsById, ...(m.diffs as Record<string, FileDiff[]>) };
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });

  function fetchPair(): void {
    if (params && selA && selB && selA !== selB) post({ type: 'amRaceFileDiffs', root: params.root, ids: [selA, selB] });
  }
  // Fetch on mount and whenever a selector changes (the reply lands in the listener).
  $effect(() => { const _a = selA, _b = selB; if (params) fetchPair(); });

  const sibOf = (id: string): Sibling | undefined => params?.siblings.find((s) => s.id === id);
  const nameOf = (id: string): string => sibOf(id)?.name ?? id;
  // Column/selector identity — WHO this sibling is: agent type + model (the
  // AgentRow fields), with honest fallbacks when a snapshot predates them.
  const typeOf = (id: string): string => sibOf(id)?.agentName || 'agent';
  const modelOf = (id: string): string => sibOf(id)?.model || 'default model';
  const sibLabel = (s: Sibling): string => `${s.name} · ${s.agentName || 'agent'} · ${s.model || 'default model'}`;
  let loaded = $derived(selA in diffsById && selB in diffsById);
  let rows = $derived.by(() => {
    const a = diffsById[selA] ?? [];
    const b = diffsById[selB] ?? [];
    const paths = Array.from(new Set([...a.map((f) => f.path), ...b.map((f) => f.path)])).sort();
    return paths.map((p) => ({ path: p, a: a.find((f) => f.path === p), b: b.find((f) => f.path === p) }));
  });
  let workingNote = $derived([selA, selB]
    .map((id) => params?.siblings.find((s) => s.id === id))
    .some((s) => !!s && (s.state === 'working' || s.state === 'provisioning')));

  interface Line { cls: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string; }
  // Classify unified-diff lines for colouring. Header lines (+++/---, diff/index/
  // new file/…) are meta; +/- are add/del; @@ is a hunk marker; the rest context.
  function parseDiff(text: string): Line[] {
    return text.split('\n').map((ln): Line => {
      if (ln.startsWith('@@')) return { cls: 'hunk', text: ln };
      if (ln.startsWith('+++') || ln.startsWith('---') || /^(diff |index |new file|deleted file|rename |similarity |old mode|new mode)/.test(ln)) return { cls: 'meta', text: ln };
      if (ln.startsWith('+')) return { cls: 'add', text: ln };
      if (ln.startsWith('-')) return { cls: 'del', text: ln };
      return { cls: 'ctx', text: ln };
    });
  }

  function openSide(id: string, path: string): void {
    if (params) post({ type: 'amOpenFileDiff', root: params.root, id, path });
  }
  function crossDiff(path: string): void {
    if (params && selA !== selB) post({ type: 'amCrossDiff', root: params.root, ids: [selA, selB], path });
  }
</script>

{#if !params}
  <div class="rcs-empty">No race to compare.</div>
{:else}
  <div class="rcs">
    <div class="rcs-head">
      <span class="rcs-title">⚡ Compare · {params.base}</span>
      <div class="rcs-sel">
        <select class="rcs-selA" aria-label="Compare sibling A" bind:value={selA}>
          {#each params.siblings as s (s.id)}<option value={s.id}>{sibLabel(s)}</option>{/each}
        </select>
        <span class="rcs-vs">vs</span>
        <select class="rcs-selB" aria-label="Compare sibling B" bind:value={selB}>
          {#each params.siblings as s (s.id)}<option value={s.id}>{sibLabel(s)}</option>{/each}
        </select>
      </div>
      <button class="rcs-refresh" title="Re-fetch both siblings' diffs (files may have changed while a sibling works)" onclick={fetchPair}>↻ Refresh</button>
    </div>

    {#if selA !== selB}
      <div class="rcs-identity">
        {#each [selA, selB] as id (id)}
          <div class="rcs-idcol">
            <span class="rcs-id-name">{nameOf(id)}</span>
            <span class="rcs-id-meta">{typeOf(id)} · {modelOf(id)}</span>
          </div>
        {/each}
      </div>
    {/if}

    {#if selA === selB}
      <div class="rcs-msg">Pick two different siblings to compare.</div>
    {:else if !loaded}
      <div class="rcs-msg">Loading diffs…</div>
    {:else if rows.length === 0}
      <div class="rcs-msg">Neither sibling changed any files.</div>
    {:else}
      {#if workingNote}
        <div class="rcs-note">A selected sibling is still working — its files may still change. Use Refresh.</div>
      {/if}
      {#each rows as r (r.path)}
        <div class="rcs-file">
          <div class="rcs-file-head">
            <span class="rcs-path mono" title={r.path}>{r.path}</span>
            <button class="rcs-avsb" disabled={!(r.a && r.b)}
              title={r.a && r.b ? 'Native diff of this file between the two siblings' : 'Only one sibling touched this file'}
              onclick={() => crossDiff(r.path)}>A vs B</button>
          </div>
          <div class="rcs-cols">
            {#each [{ id: selA, f: r.a }, { id: selB, f: r.b }] as side (side.id)}
              <div class="rcs-col">
                <div class="rcs-col-head">
                  <span class="rcs-col-name">{nameOf(side.id)}</span>
                  {#if side.f && !side.f.binary}
                    <button class="rcs-open" title="Open {nameOf(side.id)}'s base-vs-worktree diff" onclick={() => openSide(side.id, r.path)}>
                      <span class="adds">+{side.f.adds}</span><span class="dels">−{side.f.dels}</span>
                    </button>
                  {/if}
                </div>
                {#if !side.f}
                  <div class="rcs-untouched">not touched</div>
                {:else if side.f.binary}
                  <div class="rcs-untouched">binary file — <button class="rcs-open inline" onclick={() => openSide(side.id, r.path)}>open</button></div>
                {:else}
                  <pre class="rcs-diff">{#each parseDiff(side.f.text) as ln}<span class="rcs-line {ln.cls}">{ln.text}
</span>{/each}</pre>
                  {#if side.f.truncated}<div class="rcs-trunc">Diff truncated (file too large) — open the native diff for the full view.</div>{/if}
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .rcs { display: flex; flex-direction: column; gap: 10px; padding: 12px; height: 100%; min-height: 0; overflow-y: auto; color: var(--og-text); }
  .rcs-empty { padding: 16px; font-size: 13px; opacity: 0.7; }
  .rcs-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex: none; }
  .rcs-title { font-size: 13px; font-weight: 600; }
  .rcs-sel { display: flex; align-items: center; gap: 6px; }
  .rcs-vs { font-size: 11px; opacity: 0.6; }
  .rcs-sel select {
    background: var(--og-bg); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.15));
    border-radius: 4px; padding: 3px 6px; font: inherit; font-size: 12px;
  }
  .rcs-refresh {
    margin-left: auto;
    background: var(--og-surface, rgba(255, 255, 255, 0.06)); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    border-radius: 4px; padding: 3px 9px; font-size: 12px; cursor: pointer; white-space: nowrap;
  }
  .rcs-refresh:hover { filter: brightness(1.2); }
  .rcs-identity { display: grid; grid-template-columns: 1fr 1fr; gap: 0; flex: none; }
  .rcs-idcol {
    display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 4px 8px;
    border-right: 1px solid var(--og-border, rgba(255, 255, 255, 0.08));
  }
  .rcs-idcol:last-child { border-right: none; }
  .rcs-id-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rcs-id-meta { font-size: 11px; opacity: 0.65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rcs-msg { font-size: 12px; opacity: 0.7; padding: 4px 0; }
  .rcs-note { font-size: 11px; color: #e0a860; }
  .rcs-file { border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12)); border-radius: 6px; overflow: hidden; }
  .rcs-file-head {
    display: flex; align-items: center; gap: 8px; padding: 4px 8px;
    background: var(--og-surface, rgba(255, 255, 255, 0.04));
    border-bottom: 1px solid var(--og-border, rgba(255, 255, 255, 0.1));
  }
  .rcs-path { font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rcs-avsb {
    background: var(--og-surface, rgba(255, 255, 255, 0.06)); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    border-radius: 4px; padding: 0 6px; font-size: 10px; cursor: pointer; white-space: nowrap;
  }
  .rcs-avsb:hover:not(:disabled) { filter: brightness(1.2); }
  .rcs-avsb:disabled { opacity: 0.4; cursor: default; }
  .rcs-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .rcs-col { min-width: 0; border-right: 1px solid var(--og-border, rgba(255, 255, 255, 0.08)); }
  .rcs-col:last-child { border-right: none; }
  .rcs-col-head { display: flex; align-items: center; gap: 6px; padding: 3px 8px; font-size: 11px; opacity: 0.85; }
  .rcs-col-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rcs-open {
    display: inline-flex; gap: 4px; margin-left: auto; background: transparent; border: none;
    color: var(--og-text); font-variant-numeric: tabular-nums; cursor: pointer; padding: 0 2px;
  }
  .rcs-open.inline { margin-left: 0; text-decoration: underline; }
  .rcs-open:hover { text-decoration: underline; }
  .rcs-untouched { padding: 8px; font-size: 11px; opacity: 0.45; font-style: italic; }
  .rcs-diff {
    margin: 0; padding: 4px 8px; overflow-x: auto; font-size: 11px; line-height: 1.4;
    font-family: var(--vscode-editor-font-family, monospace); white-space: pre;
  }
  .rcs-line { display: inline; }
  .rcs-line.add { color: #7fc97f; background: rgba(127, 201, 127, 0.08); }
  .rcs-line.del { color: #e08a8a; background: rgba(224, 138, 138, 0.08); }
  .rcs-line.hunk { color: var(--og-accent, #6aa0d8); opacity: 0.9; }
  .rcs-line.meta { opacity: 0.5; }
  .rcs-trunc { padding: 4px 8px; font-size: 10px; color: #e0a860; }
  .adds { color: #7fc97f; }
  .dels { color: #e08a8a; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
</style>

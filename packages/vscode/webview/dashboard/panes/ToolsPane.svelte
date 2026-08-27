<script lang="ts">
  // Tools — every tool the model can reach, and which of them are actually
  // SENT. The Insights pane's question, asked about tools. Cards + filter
  // (t-kgtaac round 3) mirror SkillsPane's idiom; per-card markup lives in
  // ToolCard.svelte, the create box in NewToolPanel.svelte and the failed-load
  // cards in ToolProblemCards.svelte, all three extracted.
  //
  // LOADED = full JSON Schema on every request. DEFERRED = one catalog line
  // until `tool_search` loads it — the SESSION-START verdict; a chat that
  // already searched has more loaded than this list shows. OFF = not offered
  // at all: the engine drops it before it decides what to defer, so there is
  // no catalog line either. The state controls write SETTINGS the engine reads
  // at spawn, and deleting a failed tool file changes a cache it holds until
  // then, so nothing here claims the RUNNING engine changed. `source: 'mcp'`
  // is valid but unproduced — MCP tools aren't rows.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import ToolCard, { type ToolCardEntry } from './ToolCard.svelte';
  import type { ToolState } from './ToolStateSwitch.svelte';
  import NewToolPanel from './NewToolPanel.svelte';
  import ToolProblemCards from './ToolProblemCards.svelte';
  import ToolsNotes from './ToolsNotes.svelte';
  const vscode = getVsCodeApi();

  // Mirrors ToolCatalogEntry / ToolSearchSettings in src/acpExtTypes.ts (not
  // imported: tsconfig.webview.json pins rootDir to `webview/`, so a
  // cross-tree import — even type-only — breaks the type gate, same rule
  // SkillsPane.svelte follows for SkillEntry).
  type Entry = ToolCardEntry;
  interface Settings {
    enabled: boolean;
    mcp: boolean;
    defer: string[];
    always: string[];
  }
  /** Mirrors ToolProblem in src/acpExtTypes.ts — a `.origami/tool/` file the
   *  engine found but could not load. Never a tool ROW: it produced no tool. */
  interface Problem { file: string; message: string; }

  let entries: Entry[] = $state([]);
  let settings: Settings | null = $state(null);
  let problems: Problem[] = $state([]);
  let codeMode = $state(false);
  let error: string | null = $state(null);
  let loaded = $state(false);
  let query = $state('');
  let newName = $state('');

  function refresh(): void {
    loaded = false;
    error = null;
    vscode.postMessage({ type: 'toolsRequest' });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type !== 'toolsData') return;
    entries = Array.isArray(msg.tools) ? msg.tools : [];
    settings = msg.settings ?? null;
    problems = Array.isArray(msg.problems) ? msg.problems : [];
    codeMode = msg.codeMode === true;
    error = typeof msg.error === 'string' ? msg.error : null;
    loaded = true;
  });

  refresh();

  // OFF outranks DEFERRED, the same way the card and the engine order them —
  // counting a disabled tool as deferred would put it in the "costs one line"
  // total when it costs nothing.
  let offCount = $derived(entries.filter((e) => e.disabled).length);
  let deferredCount = $derived(entries.filter((e) => !e.disabled && e.deferred).length);
  let loadedCount = $derived(entries.length - offCount - deferredCount);

  // Sorted server-side (acp/tools.ts) by id already; filtering only narrows.
  let filtered = $derived(
    query.trim()
      ? entries.filter((e) => {
          const q = query.toLowerCase();
          return e.id.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
        })
      : entries,
  );

  /** The tool cards the grid draws — only once the catalog really loaded, so a
   *  read that failed shows its error rather than a stale grid beside it. */
  let cards = $derived(loaded && !error ? filtered : []);

  function toggleCodeMode(): void {
    vscode.postMessage({ type: 'toolsSetCodeMode', on: !codeMode });
  }

  /** Sets one tool's state outright — the control names the state it wants
   *  rather than flipping whatever is current, so a stale render cannot send
   *  the opposite of what was clicked. hardRequired rows never reach this (the
   *  segments are `disabled`), and the host re-checks that against a fresh
   *  catalog read before writing anything. */
  function pickState(e: Entry, next: ToolState): void {
    if (e.hardRequired) return;
    vscode.postMessage({ type: 'toolsSetState', id: e.id, state: next });
  }

  function copyPath(e: Entry): void {
    vscode.postMessage({ type: 'toolsCopyPath', id: e.id });
  }

  /** The one pair that DOES send a path — a file that produced no tool has no
   *  id to send instead. Neither can be aimed from here: the host refuses any
   *  path a fresh engine read is not still naming (toolProblemActions.ts). */
  const openProblem = (file: string) => vscode.postMessage({ type: 'toolsOpenProblem', file });
  const deleteProblem = (file: string) => vscode.postMessage({ type: 'toolsDeleteProblem', file });

  /** The name crosses; the PATH never does. The host resolves the workspace's
   *  own .origami/tool/ and re-checks the name before it becomes a filename. */
  function scaffold(): void {
    const name = newName.trim();
    if (!name) return;
    vscode.postMessage({ type: 'toolsScaffold', name });
    newName = '';
  }
</script>

<div class="tl-pane">
  <div class="tl-toolbar">
    <input class="tl-search" type="text" placeholder="Search tools…" bind:value={query} />
    <span class="tl-count">{filtered.length}/{entries.length}</span>
    <span class="tl-totals">{loadedCount} loaded · {deferredCount} deferred · {offCount} off</span>
    <button class="tl-refresh" onclick={refresh} title="Re-read the tool list from the engine">↻</button>
  </div>

  <ToolsNotes />

  <div class="tl-scroll">
    <div class="tl-card">
      <div class="tl-card-head">
        <span class="tl-card-title">Code mode</span>
        <button
          class="tl-switch"
          class:on={codeMode}
          role="switch"
          aria-checked={codeMode}
          onclick={toggleCodeMode}
          title="Toggle origami.experimentalCodeMode"
        >
          <span class="tl-switch-knob"></span>
        </button>
      </div>
      <div class="tl-card-body">
        Experimental. Replaces the individual MCP tools with one <code>execute</code> tool running a confined
        JavaScript program, so the model can call several MCP tools — including in parallel — from one script.
        It changes how the model reaches MCP tools, so try it before leaving it on.
        <strong>Reload the window</strong> after changing this: the engine reads the setting when it starts.
      </div>
    </div>

    <NewToolPanel bind:name={newName} onScaffold={scaffold} />

    {#if !loaded}
      <div class="tl-empty">Reading the tool list…</div>
    {:else if error}
      <div class="tl-error">{error}</div>
    {:else if entries.length === 0}
      <div class="tl-empty">The engine reported no tools.</div>
    {:else if filtered.length === 0}
      <div class="tl-empty">No tools match "{query}".</div>
    {/if}

    <!-- A failed tool file is a CARD AMONG THE CARDS, at the top of the grid —
         it belongs beside the tools it failed to join, not as a page-wide banner
         above the pane's own boxes. It stays OUTSIDE the loaded/error/empty
         chain above, so a broken file still shows when the catalog is empty or
         unreadable, which is exactly when it matters most. -->
    {#if problems.length > 0 || cards.length > 0}
      <div class="tools-grid">
        <ToolProblemCards {problems} onOpen={openProblem} onDelete={deleteProblem} />
        {#each cards as e (e.id)}
          <ToolCard entry={e} onPick={pickState} onCopy={copyPath} />
        {/each}
      </div>
    {/if}

    {#if settings && !settings.enabled}
      <div class="tl-off">
        The deferred catalog is switched off (<code>experimental.tool_search.enabled: false</code>), so every tool
        above is sent in full on every request.
      </div>
    {/if}
  </div>
</div>

<style>
  .tl-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--og-text); }
  .tl-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .tl-search { flex: 1; padding: 4px 8px; font-size: 12px; background: var(--og-input-bg, var(--og-btn-bg)); color: var(--og-text); border: 1px solid var(--og-border); border-radius: 4px; font-family: inherit; }
  .tl-count { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .tl-totals { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .tl-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 13px; }
  .tl-refresh:hover { background: var(--og-btn-hover); }
  .tl-card-body code, .tl-off code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
  .tl-scroll { flex: 1; overflow-y: auto; min-height: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }

  .tl-card { border: 1px solid var(--og-border); border-radius: 5px; background: var(--og-surface); }
  .tl-card-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--og-border); }
  .tl-card-title { flex: 1; font-size: 12px; font-weight: 600; }
  .tl-card-body { padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); }
  /* The ON state is carried by the track colour AND the knob's position, so it
     never depends on colour alone in any of the five themes. ToolCard.svelte
     repeats these four rules for its own switch — Svelte scopes <style> per
     component, so a shared control's CSS lives at each boundary it appears in. */
  .tl-switch { width: 34px; height: 18px; border-radius: 9px; border: 1px solid var(--og-border); background: var(--og-btn-bg); cursor: pointer; padding: 0 2px; display: flex; align-items: center; justify-content: flex-start; flex-shrink: 0; }
  .tl-switch.on { background: var(--og-accent); justify-content: flex-end; }
  .tl-switch-knob { width: 12px; height: 12px; border-radius: 50%; background: var(--og-text); display: block; }

  .tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; align-content: start; }

  .tl-off { padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); border: 1px solid var(--og-border); border-left: 3px solid var(--og-accent-2); border-radius: 4px; }

  .tl-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .tl-error { color: var(--og-error); font-size: 12px; padding: 16px; line-height: 1.5; }
</style>

<script lang="ts">
  // Tools — every tool the model can reach, and which of them are actually
  // SENT. The Insights pane's question, asked about tools.
  //
  // TWO VIEWS, ONE SWITCH (t-f1j2y3). The toolbar carries a segmented
  // Main agent | Sub-agents control. Main agent is the pane as it has always
  // been (ToolsMainView.svelte: code mode, New tool, the failed-file cards and
  // the tool grid). Sub-agents is one ledger (SubagentLedger.svelte) with the
  // tools as rows and one column per delegate type. What stays here is the
  // catalog state, the search derivation, which view is showing, and every
  // `vscode.postMessage` the pane makes.
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
  import type { ToolCardEntry } from './ToolCard.svelte';
  import type { ToolState } from './ToolStateSwitch.svelte';
  import ToolsNotes from './ToolsNotes.svelte';
  import ToolsMainView from './ToolsMainView.svelte';
  import SubagentLedger from './SubagentLedger.svelte';
  import type { LedgerAgent, LedgerState } from './ledgerRows';
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
  let subagents: LedgerAgent[] = $state([]);
  let codeMode = $state(false);
  let error: string | null = $state(null);
  let loaded = $state(false);
  let query = $state('');
  /** Which half of the pane is showing. Plain component state on purpose: the
   *  choice is meant to survive a refresh, a search and a catalog re-read — the
   *  pane's own life — not to follow the user into the next window. */
  let view: 'main' | 'sub' = $state('main');

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
    subagents = Array.isArray(msg.subagents) ? msg.subagents : [];
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
  // ONE filter for BOTH views: the ledger takes the same list, so a search
  // narrows the cards and the ledger's rows together.
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
   *  catalog read before writing anything. The ledger's Workspace column calls
   *  the same function the card pill does — one setting, one message. */
  function pickState(e: { id: string; hardRequired: boolean }, next: ToolState): void {
    if (e.hardRequired) return;
    vscode.postMessage({ type: 'toolsSetState', id: e.id, state: next });
  }

  /** One cell of the ledger — the agent, the tool and the state the click asked
   *  for. The host re-reads the catalog before it writes anything, so a stale
   *  render cannot aim this at the wrong row. */
  function pickSubagentState(agent: string, id: string, next: LedgerState): void {
    vscode.postMessage({ type: 'toolsSetSubagentState', agent, id, state: next });
  }

  /** A whole column, and one tool across every agent: ONE message each, never a
   *  loop of cell messages. The host owns the loop (subagentToolWrites.ts), so
   *  forty tools cost one config pass and one notice instead of forty of both.
   *  "→ all agents" sends no state at all — the workspace state it copies is
   *  read host-side from the same catalog that decides the locks. The reset sends
   *  no state either: one agent, or the whole sheet, which the ledger confirms. */
  const pickColumn = (agent: string, next: LedgerState) =>
    vscode.postMessage({ type: 'toolsSetSubagentColumn', agent, state: next });
  const pickRowAll = (id: string) => vscode.postMessage({ type: 'toolsSetSubagentRow', id });
  const resetSubagents = (agent?: string) =>
    vscode.postMessage({ type: 'toolsResetSubagentDefaults', ...(agent ? { agent } : {}) });

  function copyPath(e: Entry): void {
    vscode.postMessage({ type: 'toolsCopyPath', id: e.id });
  }

  /** The one pair that DOES send a path — a file that produced no tool has no
   *  id to send instead. Neither can be aimed from here: the host refuses any
   *  path a fresh engine read is not still naming (toolProblemActions.ts). */
  const openProblem = (file: string) => vscode.postMessage({ type: 'toolsOpenProblem', file });
  const deleteProblem = (file: string) => vscode.postMessage({ type: 'toolsDeleteProblem', file });
  const scaffold = (name: string) => vscode.postMessage({ type: 'toolsScaffold', name });
</script>

<div class="tl-pane">
  <div class="tl-toolbar">
    <span class="tl-seg" role="tablist" aria-label="Tools view">
      <button class="tl-seg-btn" class:on={view === 'main'} role="tab" aria-selected={view === 'main'}
        onclick={() => (view = 'main')}>Main agent</button>
      <button class="tl-seg-btn" class:on={view === 'sub'} role="tab" aria-selected={view === 'sub'}
        onclick={() => (view = 'sub')}
      >Sub-agents <span class="tl-seg-n">{subagents.length} type{subagents.length === 1 ? '' : 's'}</span></button>
    </span>
    <input class="tl-search" type="text" placeholder="Search tools…" bind:value={query} />
    <span class="tl-count">{filtered.length}/{entries.length}</span>
    <span class="tl-totals">{loadedCount} loaded · {deferredCount} deferred · {offCount} off</span>
    <button class="tl-refresh" onclick={refresh} title="Re-read the tool list from the engine">↻</button>
  </div>

  {#if view === 'main'}<ToolsNotes />{/if}

  <div class="tl-scroll">
    {#if !loaded}
      <div class="tl-empty">Reading the tool list…</div>
    {:else if error}
      <div class="tl-error">{error}</div>
    {:else if entries.length === 0}
      <div class="tl-empty">The engine reported no tools.</div>
    {:else if filtered.length === 0}
      <div class="tl-empty">No tools match "{query}".</div>
    {/if}

    {#if view === 'main'}
      <ToolsMainView
        {cards} {problems} {codeMode} deferredCatalogOff={settings !== null && !settings.enabled}
        onToggleCodeMode={toggleCodeMode} onScaffold={scaffold} onPick={pickState} onCopy={copyPath}
        onOpenProblem={openProblem} onDeleteProblem={deleteProblem}
      />
    {:else if loaded && !error && entries.length > 0}
      <div class="tl-explain">
        A cell is what this agent type gets if <code>task</code> spawns it now. <b>Workspace</b> is the tool's own
        state from the Main agent view; an agent cell that differs is written to that agent's block in the global
        <code>origami.json</code>.
      </div>
      <SubagentLedger rows={subagents} tools={cards} onPick={pickSubagentState} onColumn={pickColumn}
        onRowAll={pickRowAll} onWorkspace={pickState} onResetColumn={resetSubagents} onResetAll={resetSubagents} />
    {/if}
  </div>
</div>

<style>
  .tl-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--og-text); }
  .tl-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; flex-wrap: wrap; }
  /* The switch reads as two modes of ONE pane, not two panes: one border, two
     halves, the set one filled. Carried by fill AND weight, the same rule
     ToolStateSwitch follows. */
  .tl-seg { display: inline-flex; border: 1px solid var(--og-border); border-radius: 4px; overflow: hidden; flex-shrink: 0; }
  .tl-seg-btn { background: var(--og-btn-bg); color: var(--og-text-muted); border: none; cursor: pointer; padding: 4px 10px; font-size: 11px; font-family: inherit; display: inline-flex; align-items: center; gap: 6px; }
  .tl-seg-btn + .tl-seg-btn { border-left: 1px solid var(--og-border); }
  .tl-seg-btn:hover:not(.on) { background: var(--og-btn-hover); color: var(--og-text); }
  .tl-seg-btn.on { background: var(--og-surface-alt); color: var(--og-text); font-weight: 700; }
  .tl-seg-n { font-size: 9px; color: var(--og-text-muted); border: 1px solid var(--og-border); border-radius: 999px; padding: 0 5px; font-variant-numeric: tabular-nums; }
  .tl-search { flex: 1; min-width: 120px; padding: 4px 8px; font-size: 12px; background: var(--og-input-bg, var(--og-btn-bg)); color: var(--og-text); border: 1px solid var(--og-border); border-radius: 4px; font-family: inherit; }
  .tl-count { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .tl-totals { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .tl-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 13px; }
  .tl-refresh:hover { background: var(--og-btn-hover); }
  .tl-scroll { flex: 1; overflow-y: auto; min-height: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }

  .tl-explain { padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); border: 1px solid var(--og-border); border-left: 3px solid var(--og-accent-2); border-radius: 4px; }
  .tl-explain b { color: var(--og-text); }
  .tl-explain code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }

  .tl-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .tl-error { color: var(--og-error); font-size: 12px; padding: 16px; line-height: 1.5; }
</style>

<script lang="ts">
  // Labyrinth: review a past run as a map of its steps. Three panels: run
  // index, map (one of three layouts), and inspector for the picked step.
  //
  // `run_steps` caps the list (MAX_STEPS = 500); a truncated run says so.
  // No-run-selected, empty-run and failed-to-load are three different
  // states, never one spinner that never resolves.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import LabyrinthMapCanvas from '../components/LabyrinthMapCanvas.svelte';
  import LabyrinthMapToolbar from '../components/LabyrinthMapToolbar.svelte';
  import LabyrinthInspectColumn from '../components/LabyrinthInspectColumn.svelte';
  import LabyrinthRunIndex from '../components/LabyrinthRunIndex.svelte';
  import LabyrinthNotices from '../components/LabyrinthNotices.svelte';
  import LabyrinthUsageStrip from '../components/LabyrinthUsageStrip.svelte';
  import { isThreshold, type LayoutStep, type MapMode } from '../components/labyrinthLayout';
  import { exportMapMessage } from '../components/labyrinthExportMap';
  import { modelsUsed, type PriceTable } from '../components/labyrinthCost';
  import type { RunStatRow } from '../components/labyrinthHealth';
  import { mapNotice } from '../components/labyrinthNotice';
  import { runCwd, stepsRequest, type NavPoint } from '../components/labyrinthNav';
  import type { HighlightTarget } from '../components/labyrinthHighlight';
  import LabyrinthDivider from '../components/LabyrinthDivider.svelte';
  import { MIN_INDEX_WIDTH, DEFAULT_INDEX_WIDTH } from '../components/labyrinthColumns';
  import LabyrinthGlidepathSection from '../components/LabyrinthGlidepathSection.svelte';
  import { applyLabyrinthMessage } from '../components/labyrinthPaneMessages';
  import { claudeRunStats, engineStatIds, isClaudeRunId, visibleRunRows, type ClaudeIndexRow } from '../components/labyrinthClaudeRuns';
  import { claudeShownIn, withClaudeShown } from '../../chat/historyKinds';

  const vscode = getVsCodeApi();

  let mapHidden = $state(false);

  // `ClaudeIndexRow` is DashboardPanel's `historyList` row. `cwd` is the
  // run's full directory (`folder` is only its basename); it must be sent
  // back with the step request since a listed run may not be the active workspace.
  let runs: ClaudeIndexRow[] = $state([]);
  // Claude Code's own transcripts are listed here too, behind the History popup's own switch.
  let showClaude = $state(claudeShownIn(vscode.getState()));
  let runsLoaded = $state(false);
  // Per-run counts for the listed page, asked once per index load, not per row.
  let stats: Record<string, RunStatRow> = $state({});
  let selectedRun: string | null = $state(null);
  let mode: MapMode = $state('thread');
  // No permission/redaction step exists in this engine, so a "threshold"
  // here is exactly a failure — see isThreshold in labyrinthLanes.ts.
  let thresholdsOnly = $state(false);

  let steps: LayoutStep[] = $state([]);
  let truncated = $state(false);
  let total = $state(0);
  let stepsError: string | null = $state(null);
  let deleteError: string | null = $state(null); // why the last delete did not happen; stepsError is the MAP's, this is the index's
  let stepsLoading = $state(false);
  let selectedStep: LayoutStep | null = $state(null);
  let members: string[] = $state([]); // agent slugs in lane order; collab maps ONLY

  // The canvas measures itself; bound here only so export can read its rendered SVG.
  let canvasEl: HTMLElement | undefined = $state();
  let fit = $state(false);

  // The two column dividers. null = default width; the host persists it like the sidebar's width.
  let indexWidth: number | null = $state(null);
  let inspectWidth: number | null = $state(null);
  // Collapsed is its OWN flag, never a width of 0 — the host coerces a
  // non-positive width away, so 0 would ERASE the width dragged to (see there).
  let inspectCollapsed = $state(false);
  // The user's own $/Mtok table, host-persisted like the column widths above.
  let prices: PriceTable = $state({});
  let pricesOpen = $state(false);
  let paneEl: HTMLDivElement | undefined = $state();
  // The trail back out of a click-through, the reopen step from a rung walk, and the hovered chip.
  let nav: NavPoint[] = $state([]);
  let restoreOrdinal: number | null = null;
  let highlight: HighlightTarget | null = $state(null);
  function commitColumn(patch: Record<string, unknown>): void { vscode.postMessage({ type: 'resizeLabyrinthColumn', ...patch }); }

  let indexRuns = $derived(visibleRunRows(runs, showClaude));
  // The FLIGHT view's cache panel reads this to pick its loss text: a Claude
  // Code transcript never carries an engine cause, so it is never the legacy guess.
  let claudeRun = $derived(isClaudeRunId(selectedRun));
  let indexStats = $derived({ ...claudeRunStats(runs), ...stats }); // a Claude row's counts come off the row the scan already measured — the engine has never heard of the session
  let visible = $derived(thresholdsOnly ? steps.filter(isThreshold) : steps);
  // Thread and flight both position by clock. When the run's clock cannot carry
  // that, the map SAYS so rather than implying a timing it does not have.
  let notice = $derived(mapNotice(mode, visible));
  // Exactly the condition the template draws a map under — offering to export
  // when there is no map on screen would be offering to export nothing.
  let canExport = $derived(!!selectedRun && !stepsLoading && !stepsError && visible.length > 0);

  /** The page is ASSEMBLED in labyrinthExportMap.ts; this only aims it. */
  function exportMap(): void {
    const run = runs.find((r) => r.sessionId === selectedRun);
    const message = exportMapMessage({ canvasEl, mode, steps: visible, loaded: steps.length, truncated, total, title: run?.title, folder: run?.folder, when: run?.updatedAt });
    if (message) vscode.postMessage(message);
  }

  function refreshRuns(): void { runsLoaded = false; vscode.postMessage({ type: 'requestHistory' }); }

  /** `cwdOverride` is for a run the index does not list (a delegated child
   *  session opened from a spend chip); without it the engine can't resolve the id. */
  function selectRun(id: string, cwdOverride?: string): void {
    selectedRun = id;
    selectedStep = null; highlight = null;
    steps = []; members = [];
    truncated = false;
    total = 0;
    stepsError = null;
    stepsLoading = true;
    vscode.postMessage(stepsRequest(id, cwdOverride ?? runCwd(runs, id)));
  }

  /** Opens a delegated run: a sub-agent's own session, not in the index, so
   *  it inherits the open run's (or collab's) directory. The run being left
   *  goes on the trail with its open step, so Back restores the view. */
  function openDelegated(id: string): void {
    const cwd = runCwd(runs, selectedRun ?? '');
    nav = [...nav, { sessionId: selectedRun ?? '', cwd, ordinal: selectedStep?.ordinal ?? null }];
    selectRun(id, cwd);
  }

  /** One rung back up that trail — the run AND the step, exactly as they were. */
  function goBack(): void {
    const at = nav[nav.length - 1];
    if (!at) return;
    nav = nav.slice(0, -1);
    restoreOrdinal = at.ordinal;
    selectRun(at.sessionId, at.cwd);
  }

  function savePrices(next: PriceTable): void { prices = next; vscode.postMessage({ type: 'saveLabyrinthPrices', prices: next }); }

  window.addEventListener('message', (event: MessageEvent) => applyLabyrinthMessage(event.data || {}, {
    selectedRun: () => selectedRun,
    // No cwd on the stats request: the engine resolves against its own process directory.
    runs: (rows) => { runs = rows; runsLoaded = true; vscode.postMessage({ type: 'requestRunStats', sessionIds: engineStatIds(rows) }); },
    stats: (byId) => (stats = byId),
    steps: (p) => {
      steps = p.steps; members = p.members; truncated = p.truncated; total = p.total; stepsError = p.error; stepsLoading = false;
      // Re-open the step the BACK journey came back for; a fresh pick opens none.
      selectedStep = restoreOrdinal === null ? null : p.steps.find((x) => x.ordinal === restoreOrdinal) ?? null;
      restoreOrdinal = null;
    },
    columns: (p) => { indexWidth = p.indexWidthPx; inspectWidth = p.inspectWidthPx; inspectCollapsed = p.inspectCollapsed; },
    prices: (table) => (prices = table),
    // A deleted run is cleared off the MAP too: its steps are gone from the store, so drawing them would show a run that no longer exists.
    deleted: (p) => { deleteError = p.error; if (p.ok) { if (selectedRun === p.sessionId) { selectedRun = null; selectedStep = null; steps = []; } refreshRuns(); } },
  }));

  // Load the run index on mount, and recall any dragged column widths + prices.
  refreshRuns();
  vscode.postMessage({ type: 'requestLabyrinthColumns' });
  vscode.postMessage({ type: 'requestLabyrinthPrices' });
</script>

<div class="lab-shell">
  <LabyrinthGlidepathSection onView={(v) => (mapHidden = v !== 'labyrinth')} />
<div class="lab-pane" class:lab-off={mapHidden} bind:this={paneEl}>
  <!-- A run picked from the INDEX spends the trail — a fresh journey, not a step back along the one that led into a delegated run. -->
  <LabyrinthRunIndex runs={indexRuns} loaded={runsLoaded} selected={selectedRun} onRefresh={refreshRuns} onSelect={(id) => { nav = []; restoreOrdinal = null; selectRun(id); }} onDelete={(id) => { deleteError = null; vscode.postMessage({ type: 'labDeleteSession', sessionId: id, cwd: runCwd(runs, id) }); }} {deleteError} width={indexWidth ?? undefined} stats={indexStats} {showClaude} onShowClaude={(on) => { showClaude = on; vscode.setState(withClaudeShown(vscode.getState(), on)); }} models={modelsUsed(visible)} {prices} {pricesOpen} onPrices={() => (pricesOpen = !pricesOpen)} onSavePrices={savePrices} />
  <LabyrinthDivider edge="left" containerEl={paneEl} value={indexWidth} min={MIN_INDEX_WIDTH} defaultPx={DEFAULT_INDEX_WIDTH} label="Resize the run index" onChange={(w) => (indexWidth = w)} onCommit={(w) => commitColumn({ column: 'index', widthPx: w })} />

  <div class="lab-map">
    <LabyrinthMapToolbar {mode} {thresholdsOnly} {fit} inspectOpen={!inspectCollapsed} {canExport} depth={nav.length} onBack={goBack}
      onMode={(m) => (mode = m)} onThresholds={(on) => (thresholdsOnly = on)} onFit={(on) => (fit = on)}
      onInspect={(open) => { inspectCollapsed = !open; commitColumn({ column: 'inspect', collapsed: inspectCollapsed }); }} onExport={exportMap} />

    {#if !selectedRun}
      <div class="lab-empty lab-state">Pick a run from the index to map it.</div>
    {:else if stepsLoading}
      <div class="lab-empty lab-state">Reading the run…</div>
    {:else if stepsError}
      <div class="lab-error lab-state">Could not read this run: {stepsError}</div>
    {:else if steps.length === 0}
      <div class="lab-empty lab-state">This run recorded no steps — nothing to map.</div>
    {:else if visible.length === 0}
      <div class="lab-empty lab-state">No thresholds in this run — no step failed. Untick the filter to see all {steps.length.toLocaleString()} steps.</div>
    {:else}
      <LabyrinthNotices {truncated} loaded={steps.length} {total} {notice} />
      <LabyrinthUsageStrip steps={visible} {truncated} {prices} onOpenSession={openDelegated} onHighlight={(t) => (highlight = t)} />
      <LabyrinthMapCanvas bind:canvasEl steps={visible} {mode} {members} {fit} {highlight} {claudeRun} selected={selectedStep?.ordinal ?? null} onSelect={(s) => (selectedStep = s)} onHighlight={(t) => (highlight = t)} />
    {/if}
  </div>

  {#if !inspectCollapsed}
    <LabyrinthInspectColumn containerEl={paneEl} width={inspectWidth} step={selectedStep}
      onChange={(w) => (inspectWidth = w)} onCommit={(w) => commitColumn({ column: 'inspect', widthPx: w })} />
  {/if}
</div>
</div>

<style>
  .lab-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .lab-pane { display: flex; flex: 1; min-height: 0; color: var(--og-text); }
  /* HIDDEN, not unmounted — see the template. */
  .lab-off { display: none; }
  .lab-map { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .lab-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .lab-error { color: var(--og-error); font-size: 12px; padding: 20px 16px; line-height: 1.5; }
  .lab-state { flex: 1; }
</style>

<script lang="ts">
  // Labyrinth — review any PAST run as a map of its steps. Three panels: the
  // run index (reusing the SAME requestHistory/historyList wire the chat
  // history dropdown uses — there is deliberately no second session lister),
  // the map in one of three layouts, and an inspector for the picked step.
  //
  // Honesty rules this pane exists to keep:
  //  - `run_steps` CAPS the list (MAX_STEPS = 500). A truncated run says so;
  //    drawing a prefix as if it were the whole run is the worst thing this
  //    view could do.
  //  - no-run-selected / empty-run / failed-to-load are three DIFFERENT
  //    states, never one spinner that quietly never resolves.
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
  import type { CollabRow } from '../components/labyrinthCollabIndex';
  import { runCwd, stepsRequest, type NavPoint } from '../components/labyrinthNav';
  import type { HighlightTarget } from '../components/labyrinthHighlight';
  import LabyrinthDivider from '../components/LabyrinthDivider.svelte';
  import { MIN_INDEX_WIDTH, DEFAULT_INDEX_WIDTH } from '../components/labyrinthColumns';

  const vscode = getVsCodeApi();

  // `CollabRow` IS the `historyList` row DashboardPanel posts — one declaration,
  // shared with the index that renders it. `cwd` is the run's own full directory
  // (`folder` is only its basename): a listed run need not belong to the active
  // workspace, so it must be sent back with the step request.
  let runs: CollabRow[] = $state([]);
  let runsLoaded = $state(false);
  // Per-run counts for the LISTED page, keyed by session id. Asked for once per
  // index load, never per row: each id costs the engine a whole message read.
  let stats: Record<string, RunStatRow> = $state({});
  let selectedRun: string | null = $state(null);
  let mode: MapMode = $state('thread');
  // The mockup's thresholdsOnly filter (50-surfaces.js:389). This engine emits
  // no permission/redaction step, so a "threshold" here is exactly a failure —
  // see isThreshold in labyrinthLanes.ts.
  let thresholdsOnly = $state(false);

  let steps: LayoutStep[] = $state([]);
  let truncated = $state(false);
  let total = $state(0);
  let stepsError: string | null = $state(null);
  let stepsLoading = $state(false);
  let selectedStep: LayoutStep | null = $state(null);
  let members: string[] = $state([]); // agent slugs in lane order; collab maps ONLY

  // The canvas MEASURES itself (LabyrinthMapCanvas.svelte); the element is bound
  // back here only because the export reads the rendered SVG out of it.
  let canvasEl: HTMLElement | undefined = $state();
  let fit = $state(false);

  // t-q41pe0 — the two column dividers. null = default CSS width (nothing
  // dragged yet, or the host has nothing persisted); host round-trip mirrors
  // the sidebar's collabsHeight (t-kgserq).
  let indexWidth: number | null = $state(null);
  let inspectWidth: number | null = $state(null);
  // Collapsed is its OWN flag, never a width of 0 — the host coerces a
  // non-positive width away, so 0 would ERASE the width dragged to (see there).
  let inspectCollapsed = $state(false);
  // The user's OWN $/Mtok table, host-persisted like the column widths above.
  // Empty until they type something — there is no bundled price list.
  let prices: PriceTable = $state({});
  let pricesOpen = $state(false);
  let paneEl: HTMLDivElement | undefined = $state();
  // The trail back out of a click-through (empty on a run picked from the index
  // — nowhere to go back to), the step to re-open when a rung of it is walked,
  // and which spend chip the pointer is on.
  let nav: NavPoint[] = $state([]);
  let restoreOrdinal: number | null = null;
  let highlight: HighlightTarget | null = $state(null);
  function commitColumn(patch: Record<string, unknown>): void { vscode.postMessage({ type: 'resizeLabyrinthColumn', ...patch }); }

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

  /** `cwdOverride` is for a run the INDEX does not list — a delegated child
   *  session, opened from a spend chip. Without its parent's directory the
   *  engine resolves the id against its own process cwd and returns nothing. */
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

  /** Open a DELEGATED run: it is a sub-agent's own session, so it is not in the
   *  index and inherits the directory of whatever is open — a run, or a COLLAB,
   *  whose members are the only rows carrying one. The run being LEFT goes on
   *  the trail, with the step that was open in it, so Back restores the view. */
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

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'historyList') {
      runs = Array.isArray(msg.sessions) ? msg.sessions : [];
      runsLoaded = true;
      // No cwd: the engine resolves against its own process directory, which is
      // this workspace. A listed run from ANOTHER workspace then reads as
      // unmeasurable — a blank cell, which is the honest answer for it.
      vscode.postMessage({ type: 'requestRunStats', sessionIds: runs.map((r) => r.sessionId) });
    } else if (msg.type === 'runStatsData') {
      const rows: RunStatRow[] = Array.isArray(msg.stats) ? msg.stats : [];
      stats = Object.fromEntries(rows.filter((r) => r?.sessionId).map((r) => [r.sessionId, r]));
    } else if (msg.type === 'runStepsData') {
      // Ignore a reply for a run the user has already navigated away from.
      if (msg.sessionId && msg.sessionId !== selectedRun) return;
      steps = Array.isArray(msg.steps) ? msg.steps : [];
      members = Array.isArray(msg.members) ? msg.members : [];
      truncated = msg.truncated === true;
      total = typeof msg.total === 'number' ? msg.total : steps.length;
      stepsError = typeof msg.error === 'string' ? msg.error : null;
      stepsLoading = false;
      // Re-open the step the BACK journey came back for; a fresh pick opens none.
      selectedStep = restoreOrdinal === null ? null : steps.find((s) => s.ordinal === restoreOrdinal) ?? null;
      restoreOrdinal = null;
    } else if (msg.type === 'labyrinthColumns') {
      indexWidth = typeof msg.indexWidthPx === 'number' ? msg.indexWidthPx : null;
      inspectWidth = typeof msg.inspectWidthPx === 'number' ? msg.inspectWidthPx : null;
      inspectCollapsed = msg.inspectCollapsed === true;
    } else if (msg.type === 'labyrinthPrices') {
      prices = msg.prices && typeof msg.prices === 'object' ? msg.prices : {};
    }
  });

  // Load the run index on mount, and recall any dragged column widths + prices.
  refreshRuns();
  vscode.postMessage({ type: 'requestLabyrinthColumns' });
  vscode.postMessage({ type: 'requestLabyrinthPrices' });
</script>

<div class="lab-pane" bind:this={paneEl}>
  <!-- A run picked from the INDEX spends the trail — a fresh journey, not a step back along the one that led into a delegated run. -->
  <LabyrinthRunIndex {runs} loaded={runsLoaded} selected={selectedRun} onRefresh={refreshRuns} onSelect={(id) => { nav = []; restoreOrdinal = null; selectRun(id); }} width={indexWidth ?? undefined} {stats} models={modelsUsed(visible)} {prices} {pricesOpen} onPrices={() => (pricesOpen = !pricesOpen)} onSavePrices={savePrices} />
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
      <LabyrinthMapCanvas bind:canvasEl steps={visible} {mode} {members} {fit} {highlight} selected={selectedStep?.ordinal ?? null} onSelect={(s) => (selectedStep = s)} />
    {/if}
  </div>

  {#if !inspectCollapsed}
    <LabyrinthInspectColumn containerEl={paneEl} width={inspectWidth} step={selectedStep}
      onChange={(w) => (inspectWidth = w)} onCommit={(w) => commitColumn({ column: 'inspect', widthPx: w })} />
  {/if}
</div>

<style>
  .lab-pane { display: flex; height: 100%; min-height: 0; color: var(--og-text); }
  .lab-map { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .lab-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .lab-error { color: var(--og-error); font-size: 12px; padding: 20px 16px; line-height: 1.5; }
  .lab-state { flex: 1; }
</style>

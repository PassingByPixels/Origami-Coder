<script lang="ts">
  // Schedules pane — t-ru1qsp: Crons and Loops folded into one rail item
  // (owner: "one icon one word, and inside the UI are our Crons and Loops
  // tabs"). Both panes mount UNCHANGED; this owns only the tab header and
  // which one is showing — same toggle style as RepoDetail.svelte's
  // Checkouts/Branches tabs (am-viewbtn), so a tabbed pane reads the same
  // everywhere on the board.
  import CronsPane from './CronsPane.svelte';
  import LoopsPane from './LoopsPane.svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { consumeRequestedTab, type ScheduleTabId } from './scheduleTabRequest';
  import { scheduleTabFromGlobal } from './scheduleTabGlobal';

  const vscode = getVsCodeApi();

  // A deep link (boardShowSection section 'crons'/'loops', routed through
  // viewForSection in boardViews.ts) is a ONE-SHOT override; absent, fall
  // back to the tab this window had open last (window.__ORIGAMI_SCHEDULE_TAB__,
  // injected by DashboardPanel.ts from scheduleTab.ts's workspaceState read).
  let tab = $state<ScheduleTabId>(consumeRequestedTab() ?? scheduleTabFromGlobal(window));

  function show(t: ScheduleTabId): void {
    tab = t;
    vscode.postMessage({ type: 'setScheduleTab', tab: t });
  }
</script>

<div class="sch-pane">
  <div class="sch-tabs" role="group" aria-label="Which schedule kind to show">
    <button class="sch-tab" class:on={tab === 'crons'} aria-pressed={tab === 'crons'}
      title="Crons — scheduled runs that fire with VS Code closed" onclick={() => show('crons')}>Crons</button>
    <button class="sch-tab" class:on={tab === 'loops'} aria-pressed={tab === 'loops'}
      title="Loops — recurring /loop prompts, persisted across reloads" onclick={() => show('loops')}>Loops</button>
  </div>
  <div class="sch-body">
    {#if tab === 'crons'}
      <CronsPane />
    {:else}
      <LoopsPane />
    {/if}
  </div>
</div>

<style>
  .sch-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .sch-tabs { flex: none; display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--og-border); }
  .sch-tab {
    padding: 3px 10px; background: transparent; color: var(--og-text);
    border: 1px solid var(--og-border); border-radius: 4px;
    font: inherit; font-size: 11px; cursor: pointer; opacity: 0.7;
  }
  .sch-tab:hover { opacity: 1; }
  .sch-tab.on { opacity: 1; border-color: var(--og-accent); background: var(--og-accent); }
  .sch-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
</style>

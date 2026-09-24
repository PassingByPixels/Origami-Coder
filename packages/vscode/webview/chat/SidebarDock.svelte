<script lang="ts">
  // THE SIDEBAR DOCK — one row of icons under the connections block, in place
  // of the Chats toolbar (New chat / History / Agents) and the three section
  // toggles (Collabs, Front Desk, Memory) that used to sit scattered down the
  // panel. (Mock-Redesign/CHANGES.md change 1, react-bits Components/Dock.)
  //
  // The controls it replaces are GONE from the DOM, not hidden. The mock hid
  // them and clicked them through a DOM reference because it could not edit
  // the components; here the actions themselves moved, which is the whole
  // difference between the design surface and the product.
  //
  // WHAT MOVED HERE, and why this file rather than a callback into ChatsList:
  // the History popup is a CONTROL of the toolbar, not of the list — its wire
  // (requestHistory -> historyList), its Claude-Code filter and its anchor all
  // belonged to the row of buttons, and that row is now the dock. ChatsList
  // keeps the sessions; it lost ~55 lines it no longer had a control for.
  //
  // The three toggles stay the PARENT's state (SidebarLauncher owns the
  // Collabs half's height and collapse, FrontDeskSection persists its own):
  // the dock only says "the user asked".
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../shared/vscodeApi';
  import HistoryDropdown from './HistoryDropdown.svelte';
  import WarmTooltip from '../shared/WarmTooltip.svelte';
  import { DOCK_ITEMS, type DockKey } from './sidebarDockItems';
  import SidebarDockTrack from './SidebarDockTrack.svelte';
  import { CLAUDE_MARK, claudeShownIn, filterHistory, historyDropdownRows, historyPickMessage, withClaudeShown, type HistoryItem } from './historyKinds';
  import { claudeScanNote, type ClaudeScanFacts } from './claudeScanNote';

  const vscode = getVsCodeApi();

  interface Props {
    /** Mail waiting at the front desk. 0 draws no badge — a badge that says 0
     *  is a badge that says "look". */
    frontDeskCount?: number;
    collabsOpen?: boolean;
    frontDeskOpen?: boolean;
    memoryOpen?: boolean;
    onToggleCollabs: () => void;
    onToggleFrontDesk: () => void;
    onToggleMemory: () => void;
  }
  let {
    frontDeskCount = 0, collabsOpen = false, frontDeskOpen = false, memoryOpen = false,
    onToggleCollabs, onToggleFrontDesk, onToggleMemory,
  }: Props = $props();

  // In-webview history dropdown (same wire as ChatPane: requestHistory ->
  // historyList; a pick opens the recalled chat in a fresh tab).
  let historyOpen = $state(false);
  let historyLoading = $state(false);
  let historyQuery = $state('');
  // Two kinds of past chat share this list: Origami's engine sessions and
  // Claude Code's own transcripts. Every rule that follows is historyKinds.ts;
  // this file keeps only the state.
  let historyItems = $state<HistoryItem[]>([]);
  // The dock's own element — HistoryDropdown anchors its fixed overlay to this
  // rect (t-hb1o0e), so the popup is the dock's width and floats above the
  // sections instead of squeezing or clipping under them.
  let dockEl = $state<HTMLDivElement>();
  // Unopened artifact arrivals, counted HOST side (src/dashboard/artifactsPane.ts)
  // and pushed here: a count recomputed in the sidebar would come back every
  // time the sidebar was rebuilt.
  let artifactsCount = $state(0);
  let showClaude = $state(claudeShownIn(vscode.getState()));
  let claudeScan = $state<ClaudeScanFacts | undefined>(undefined);
  let historyFiltered = $derived(filterHistory(historyItems, historyQuery, showClaude));
  function setShowClaude(on: boolean) { showClaude = on; vscode.setState(withClaudeShown(vscode.getState(), on)); }

  function openHistoryDropdown() {
    historyOpen = true;
    historyLoading = true;
    historyItems = [];
    historyQuery = '';
    vscode.postMessage({ type: 'requestHistory' });
  }
  function pickHistory(id: string) {
    historyOpen = false;
    // An Origami row is recalled; a Claude row opens a passthrough that resumes
    // it in its own folder. historyKinds.ts decides which, from the row itself.
    vscode.postMessage(historyPickMessage(historyItems, id));
  }

  let on: Record<DockKey, boolean> = $derived({
    new: false, history: historyOpen, agents: false,
    collabs: collabsOpen, frontdesk: frontDeskOpen, memory: memoryOpen, artifacts: false,
  });

  function activate(key: DockKey): void {
    switch (key) {
      // Any dock action that changes session state also collapses the recall
      // panel (pickHistory already does; keep them consistent).
      case 'new': historyOpen = false; vscode.postMessage({ type: 'newSession' }); break;
      case 'history': historyOpen ? (historyOpen = false) : openHistoryDropdown(); break;
      case 'agents': historyOpen = false; vscode.postMessage({ type: 'openAgentManager' }); break;
      // Two messages, one intent, the shape FrontDeskSection.svelte's Open
      // Flock link uses: open the board tab, then name the view it lands on.
      // The badge clears here rather than waiting for the pane to attach.
      case 'artifacts':
        historyOpen = false;
        artifactsCount = 0;
        vscode.postMessage({ type: 'openAgentManager' });
        vscode.postMessage({ type: 'openBoardSection', section: 'artifacts' });
        break;
      case 'collabs': onToggleCollabs(); break;
      case 'frontdesk': onToggleFrontDesk(); break;
      case 'memory': onToggleMemory(); break;
    }
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      switch (msg.type) {
        case 'showHistory':
          openHistoryDropdown();
          break;
        case 'artifactsBadge':
          artifactsCount = typeof msg.count === 'number' && msg.count > 0 ? msg.count : 0;
          break;
        case 'historyList':
          historyItems = Array.isArray(msg.sessions) ? msg.sessions : [];
          claudeScan = (msg as { claudeScan?: ClaudeScanFacts }).claudeScan;
          historyLoading = false;
          break;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<svelte:window onkeydown={(e) => { if (historyOpen && e.key === 'Escape') historyOpen = false; }} />

<WarmTooltip />

<div class="dock" role="toolbar" aria-label="Origami dock" bind:this={dockEl}>
  <SidebarDockTrack pillEl={dockEl} items={DOCK_ITEMS} {on} {frontDeskCount} {artifactsCount} onActivate={activate} />
</div>

{#if historyOpen && dockEl}
  <!-- A fixed overlay anchored to the dock — HistoryDropdown.svelte owns its
       own positioning/backdrop (historyAnchor.ts). Shared with the Collabs
       half; the filter stays here since only this list matches on the folder
       too. -->
  <HistoryDropdown
    items={historyDropdownRows(historyFiltered)}
    kindToggle={{ on: showClaude, mark: CLAUDE_MARK, onChange: setShowClaude }}
    loading={historyLoading}
    query={historyQuery}
    onQuery={(v) => (historyQuery = v)}
    onPick={pickHistory}
    onClose={() => (historyOpen = false)}
    emptyText={historyItems.length === 0 ? 'No past chats yet.' : 'No matches.'}
    note={claudeScanNote(claudeScan, showClaude, historyItems)}
    anchorEl={dockEl}
  />
{/if}

<style>
  /* A rectangular pill, not a capsule: it spans nearly the sidebar's width,
     and a full capsule at that length reads as a search field. */
  .dock {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    /* t-ru0p04 — vertical margins only, 6/10 -> 4/6: the sidebar chrome above
       Chats had grown 54px past 0.4.151 and this is one of the two trims
       (the other folds the Connections label into the brand row, in
       SidebarLauncher.svelte). Horizontal margin (12px) is untouched. */
    margin: 4px 12px 6px;
    background: var(--og-surface-alt);
    border: 1px solid var(--og-border);
    border-radius: 12px;
    box-shadow: 0 6px 18px color-mix(in srgb, var(--og-bg) 60%, transparent);
    flex-shrink: 0;
  }
  /* The track, arrows and every item's own look moved to
     SidebarDockTrack.svelte (t-qlgav5) — it writes that markup now, and
     Svelte scopes a component's CSS to the file that renders it. */
</style>

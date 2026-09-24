<script lang="ts">
  // Agents board shell — owns the left nav rail + view routing for the board
  // editor tab. Replaces the old single-pane mount (ChatView used to render
  // AgentManagerPane directly); this wraps it as the "Folds" view and adds
  // Collab agents / Loops / Crons / Skills / Labyrinth / Insights.
  //
  // Extensibility contract: every rail entry (id, label, hover title, icon,
  // and the component it mounts) lives in ONE array — VIEWS, which left for
  // boardViews.ts when the Bots section landed and this file was at 188 of its
  // 190 cap. Adding a view stays a one-entry change to that array; the markup
  // routes generically off it and never grows an {#if} chain. loadView/
  // saveView moved to boardViewState.ts (t-qn09vr) for the rail-expand state.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { VIEWS, viewForSection, type ViewId } from './boardViews';
  import { resolveView, visibleViews } from './boardVisibility';
  import BoardRail from './BoardRail.svelte'; // the rail, top views + foot views + Docs (t-s9jr6u)
  import WarmTooltip from '../../shared/WarmTooltip.svelte';
  import { loadView, saveView } from './boardViewState';

  const vscode = getVsCodeApi();

  // The host chrome (ChatView's brand bar) sits OUTSIDE this component but has
  // to name the view you're actually looking at — a header reading "Folds"
  // while Skills is on screen is simply wrong. Report the active view's name
  // upward instead of duplicating the VIEWS table in the shell.
  let { onViewName, remoteEnabled = false, flockEnabled = false }: { onViewName?: (name: string) => void; remoteEnabled?: boolean; flockEnabled?: boolean } = $props();

  let view = $state<ViewId>(resolveView(loadView(vscode), remoteEnabled, flockEnabled));
  let current = $derived(VIEWS.find((v) => v.id === view));
  let Active = $derived(current?.component ?? AgentManagerPane);
  $effect(() => { onViewName?.(current?.name ?? 'Folds'); });

  function select(id: ViewId): void {
    view = id;
    saveView(vscode, id);
  }

  // A SECTION REQUEST from another webview. The collab room's "Manage bots"
  // link opens this board tab and asks for the Bots section, but the two are
  // different webviews: a board being opened for the FIRST time has not
  // attached when that request goes out. So the shell announces itself on mount
  // (`boardReady`) and the host replays anything pending, and the shell
  // ACKNOWLEDGES what it acted on (`boardSectionShown`) so a stale request
  // cannot hijack a board opened an hour later for another reason.
  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type !== 'boardShowSection') return;
      const wanted = viewForSection(String(msg.section ?? ''));
      // Acknowledged either way: a section this build cannot show is still a
      // request that has been delivered, and leaving it pending would make the
      // next mount jump somewhere the user never asked for. resolveView also
      // catches a `remote` or `friends` request landing while the row is hidden.
      if (wanted) select(resolveView(wanted, remoteEnabled, flockEnabled));
      vscode.postMessage({ type: 'boardSectionShown' });
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'boardReady' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<div class="board-shell">
  <BoardRail views={visibleViews(remoteEnabled, flockEnabled)} active={view} onSelect={select} />
  <WarmTooltip />
  <div class="board-body">
    <Active />
  </div>
</div>

<style>
  .board-shell {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  /* The rail and its styles are BoardRail.svelte's (t-s9jr6u). */
  .board-body {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>

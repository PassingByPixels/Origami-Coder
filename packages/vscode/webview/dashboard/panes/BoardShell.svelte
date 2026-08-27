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
  // routes generically off it and never grows an {#if} chain.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { DEFAULT_VIEW, VIEWS, isViewId, viewForSection, type ViewId } from './boardViews';
  import { DOCS_ICON } from './boardLinkIcons';

  const vscode = getVsCodeApi();
  // Persist the picked view through the VS Code webview state API — the same
  // getState/setState mechanism theme.ts uses for the theme pick, so the
  // board reopens on the last view instead of always defaulting to Folds.
  const STATE_KEY = 'origami.board.view';

  function loadView(): ViewId {
    try {
      const state = (vscode.getState() as Record<string, unknown>) || {};
      const saved = state[STATE_KEY];
      return isViewId(saved) ? saved : DEFAULT_VIEW;
    } catch {
      return DEFAULT_VIEW;
    }
  }
  function saveView(id: ViewId): void {
    try {
      const state = (vscode.getState() as Record<string, unknown>) || {};
      vscode.setState({ ...state, [STATE_KEY]: id });
    } catch {
      /* getState/setState unavailable in this host — best-effort only */
    }
  }

  // The host chrome (ChatView's brand bar) sits OUTSIDE this component but has
  // to name the view you're actually looking at — a header reading "Folds"
  // while Skills is on screen is simply wrong. Report the active view's name
  // upward instead of duplicating the VIEWS table in the shell.
  let { onViewName }: { onViewName?: (name: string) => void } = $props();

  let view = $state<ViewId>(loadView());
  let current = $derived(VIEWS.find((v) => v.id === view));
  let Active = $derived(current?.component ?? AgentManagerPane);
  $effect(() => { onViewName?.(current?.name ?? 'Folds'); });

  function select(id: ViewId): void {
    view = id;
    saveView(id);
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
      // next mount jump somewhere the user never asked for.
      if (wanted) select(wanted);
      vscode.postMessage({ type: 'boardSectionShown' });
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'boardReady' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<div class="board-shell">
  <nav class="board-nav" aria-label="Board views">
    {#each VIEWS as v (v.id)}
      <button
        class="nav-btn"
        class:active={view === v.id}
        title={v.title}
        aria-label={v.title}
        aria-current={view === v.id ? 'page' : undefined}
        onclick={() => select(v.id)}
      >
        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">{@html v.icon}</svg>
        <span class="nav-label">{v.label}</span>
      </button>
    {/each}
    <div class="nav-spacer"></div>
    <!-- Docs sits ALONE at the rail's foot, the spacer between it and the
         views (owner ruling): it is a link out to the website, not a pane,
         so it neither joins VIEWS nor carries an active state. The URL is
         host-owned — see botsManager's boardOpenDocs. -->
    <button
      class="nav-btn"
      title="Docs — the Origami website"
      aria-label="Docs — opens the Origami website in your browser"
      onclick={() => vscode.postMessage({ type: 'boardOpenDocs' })}
    >
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">{@html DOCS_ICON}</svg>
      <span class="nav-label">Doc</span>
    </button>
  </nav>
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
  .board-nav {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    width: 48px;
    flex-shrink: 0;
    padding: 8px 0;
    border-right: 1px solid var(--og-border);
    background: var(--og-bg);
  }
  .nav-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 38px;
    height: 38px;
    background: transparent;
    color: var(--og-text-secondary);
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
  }
  .nav-btn:hover:not(.active) {
    background: var(--og-btn-bg);
    color: var(--og-text);
  }
  .nav-btn.active {
    background: var(--og-accent);
    color: var(--og-text);
    border-color: transparent;
  }
  .nav-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  .nav-label {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .nav-spacer {
    flex: 1;
  }
  .board-body {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>

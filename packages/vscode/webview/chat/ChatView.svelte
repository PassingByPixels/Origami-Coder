<script lang="ts">
  // CHAT shell — the secondary side-bar (top-right) panel of the split.
  // The chat is the brand hero, so this carries the crane. It hosts the
  // REAL ChatPane (message thread + composer + new-chat tabs) and a
  // minimal, HONEST status badge (online/offline from the real
  // `modelStatus` broadcast). It deliberately has NO ControlStrip — connect
  // / model / context live in the CONFIG view; both share one host.

  import ChatPane from '../dashboard/panes/ChatPane.svelte';
  import SidebarLauncher from './SidebarLauncher.svelte';
  import WikiSearchPane from '../dashboard/panes/WikiSearchPane.svelte';
  import BoardShell from '../dashboard/panes/BoardShell.svelte';
  import RaceCompareScreen from '../dashboard/panes/RaceCompareScreen.svelte';
  import RepoMapScreen from '../dashboard/panes/RepoMapScreen.svelte';
  import CollabPane from './CollabPane.svelte';
  import CraneMark from '../shared/CraneMark.svelte';
  import { applyThemeSilently, loadTheme, type ThemeId } from '../shared/theme';
  import { onMount } from 'svelte';

  // Minimal honest status — read solely from the real modelStatus
  // broadcast the shared host fans out to BOTH views. No fake green: until
  // a model is actually loaded the badge reads Offline.
  let online = $state(false);
  let modelName = $state('');
  // Provider identity + failure reason from the per-session status, so the
  // offline tooltip names the right server (LM Studio vs a remote provider).
  let providerLabel = $state('');
  let providerIsLocal = $state(true);
  let statusReason = $state('');
  // Installed extension version, injected into the webview HTML global by
  // the host — shown in the header so the user can confirm they're not on a
  // stale extension host after an update.
  let version = $state('');
  // When non-empty, this is a popped-out editor tab dedicated to ONE
  // session — ChatPane renders only that session and hides the multi-chat
  // tab strip. Empty = the normal sidebar with all chats.
  let soloSessionId = $state('');
  // When true, this webview is a full editor tab dedicated to the memory
  // graph — renders only WikiSearchPane (no chat, no sidebar).
  let memoryMode = $state(false);
  // When true, this webview is the Agents board — renders only BoardShell
  // (nav rail + Folds/Skills/Crons/Routings; no chat, no sidebar).
  let boardMode = $state(false);
  // The board's active view name, reported up by BoardShell so the brand bar
  // names what's on screen rather than always saying "Folds".
  let boardViewName = $state('Folds');
  // When true, this webview is a race-Compare editor tab — renders only
  // RaceCompareScreen (seeded from __ORIGAMI_RACE_COMPARE__).
  let raceCompareMode = $state(false);
  // When true, this webview is a repo-map editor tab — renders only
  // RepoMapScreen (seeded from __ORIGAMI_REPO_MAP__).
  let repoMapMode = $state(false);
  // When true, this webview is a collab editor tab — renders only CollabPane
  // (seeded from __ORIGAMI_COLLAB__, which carries the collab identity).
  let collabMode = $state(false);

  onMount(() => {
    version = String((window as unknown as { __ORIGAMI_VERSION__?: string }).__ORIGAMI_VERSION__ ?? '');
    soloSessionId = String((window as unknown as { __ORIGAMI_SOLO_SESSION__?: string }).__ORIGAMI_SOLO_SESSION__ ?? '');
    memoryMode = !!(window as unknown as { __ORIGAMI_MEMORY__?: boolean }).__ORIGAMI_MEMORY__;
    boardMode = !!(window as unknown as { __ORIGAMI_BOARD__?: boolean }).__ORIGAMI_BOARD__;
    raceCompareMode = !!(window as unknown as { __ORIGAMI_RACE_COMPARE__?: unknown }).__ORIGAMI_RACE_COMPARE__;
    repoMapMode = !!(window as unknown as { __ORIGAMI_REPO_MAP__?: unknown }).__ORIGAMI_REPO_MAP__;
    collabMode = !!(window as unknown as { __ORIGAMI_COLLAB__?: unknown }).__ORIGAMI_COLLAB__;
    // Honour the persisted theme on mount (the host boots data-theme="meadow"
    // in the HTML; a reopened panel should land on the last pick).
    applyThemeSilently(loadTheme());

    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type === 'modelStatus') {
        // Only reflect THIS solo tab's own session — a status tagged for another
        // chat (e.g. loading a model there) must not flip this badge. Untagged
        // statuses (boot/older host) still apply.
        if (msg.sessionId && soloSessionId && msg.sessionId !== soloSessionId) return;
        online = !!msg.ok;
        modelName = typeof msg.modelName === 'string' ? msg.modelName : '';
        // Provider identity for the offline tooltip — a popped-out Spark chat
        // must name ITS server, not point at the LM Studio engine config.
        if (typeof msg.providerLabel === 'string') providerLabel = msg.providerLabel;
        if (typeof msg.providerIsLocal === 'boolean') providerIsLocal = msg.providerIsLocal;
        if (typeof msg.reason === 'string') statusReason = msg.reason; else if (msg.ok) statusReason = '';
      } else if (msg.type === 'themeSync') {
        applyThemeSilently(msg.theme as ThemeId);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });
</script>

{#if collabMode}
  <!-- Full editor tab: ONE collab's stream (roster + messages + composer). -->
  <div class="chat-shell">
    <div class="brand">
      <span class="brand-mark" style="color: var(--og-crane)">
        <CraneMark size={18} />
      </span>
      <span class="brand-name">Origami — Collab</span>
      {#if version}
        <span class="brand-version" title="Origami Coder extension version (verify you're not on a stale build)">v{version}</span>
      {/if}
    </div>
    <div class="chat-fill">
      <CollabPane />
    </div>
  </div>
{:else if repoMapMode}
  <!-- Full editor tab: a repo's architecture-map screen (layer columns + flows). -->
  <div class="chat-shell">
    <div class="brand">
      <span class="brand-mark" style="color: var(--og-crane)">
        <CraneMark size={18} />
      </span>
      <span class="brand-name">Origami — Map</span>
      {#if version}
        <span class="brand-version" title="Origami Coder extension version (verify you're not on a stale build)">v{version}</span>
      {/if}
    </div>
    <div class="chat-fill">
      <RepoMapScreen />
    </div>
  </div>
{:else if raceCompareMode}
  <!-- Full editor tab: a race group's Compare screen (side-by-side sibling diffs). -->
  <div class="chat-shell">
    <div class="brand">
      <span class="brand-mark" style="color: var(--og-crane)">
        <CraneMark size={18} />
      </span>
      <span class="brand-name">Origami — Compare</span>
      {#if version}
        <span class="brand-version" title="Origami Coder extension version (verify you're not on a stale build)">v{version}</span>
      {/if}
    </div>
    <div class="chat-fill">
      <RaceCompareScreen />
    </div>
  </div>
{:else if boardMode}
  <!-- Full editor tab: the Agents board (nav rail + Folds/Skills/Crons/Routings). -->
  <div class="chat-shell">
    <div class="brand">
      <span class="brand-mark" style="color: var(--og-crane)">
        <CraneMark size={18} />
      </span>
      <span class="brand-name">Origami — {boardViewName}</span>
      {#if version}
        <span class="brand-version" title="Origami Coder extension version (verify you're not on a stale build)">v{version}</span>
      {/if}
    </div>
    <div class="chat-fill">
      <BoardShell onViewName={(n) => (boardViewName = n)} />
    </div>
  </div>
{:else if memoryMode}
  <!-- Full editor tab: the memory graph given the whole editor area. Same
       brand header, then WikiSearchPane at full size (its own fullscreen
       button is hidden since we're already here). -->
  <div class="chat-shell">
    <div class="brand">
      <span class="brand-mark" style="color: var(--og-crane)">
        <CraneMark size={18} />
      </span>
      <span class="brand-name">Origami — Memory</span>
      {#if version}
        <span class="brand-version" title="Origami Coder extension version (verify you're not on a stale build)">v{version}</span>
      {/if}
    </div>
    <div class="chat-fill">
      <WikiSearchPane fullscreen />
    </div>
  </div>
{:else if soloSessionId}
  <!-- Popped-out editor tab: the single chat THREAD + composer, with the
       brand header (crane + version badge + honest status). -->
  <div class="chat-shell">
    <div class="brand">
      <span class="brand-mark" style="color: var(--og-crane)">
        <CraneMark size={18} />
      </span>
      <span class="brand-name">Origami</span>
      {#if version}
        <span class="brand-version" title="Origami Coder extension version (verify you're not on a stale build)">v{version}</span>
      {/if}
      <span
        class="status"
        class:online
        title={online
          ? `Online${modelName ? ` — ${modelName}` : ''}`
          : (providerIsLocal
              ? `Offline — ${statusReason || 'configure the engine in the Origami sidebar'}`
              : `${providerLabel || 'Provider'} unreachable — ${statusReason || 'check the server'}`)}
      >
        <span class="dot" aria-hidden="true"></span>
        <span class="status-text">{online ? (modelName || 'Online') : 'Offline'}</span>
      </span>
    </div>

    <div class="chat-fill">
      <ChatPane {soloSessionId} />
    </div>
  </div>
{:else}
  <!-- Sidebar: the launcher (Chats strip + Settings). Chat threads live in
       their own movable editor tabs (the solo branch above). -->
  <SidebarLauncher />
{/if}

<style>
  .chat-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--og-bg);
    color: var(--og-text);
    overflow: hidden;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 12px 8px;
    background: var(--og-pane-header);
    flex-shrink: 0;
  }
  .brand-mark {
    display: flex;
    line-height: 0;
    flex-shrink: 0;
  }
  .brand-name {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: var(--og-text);
  }
  .brand-version {
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    padding: 1px 5px;
    flex-shrink: 0;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--og-text-secondary);
    flex-shrink: 0;
    margin-left: auto;
  }
  .status .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--og-text-muted);
    flex-shrink: 0;
  }
  .status.online .dot {
    background: var(--og-success);
  }
  .status.online {
    color: var(--og-success-text);
  }
  .status-text {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat-fill {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--og-bg);
  }
</style>

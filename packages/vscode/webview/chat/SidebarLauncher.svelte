<script lang="ts">
  // The Origami SIDEBAR shell (non-solo). The chat THREADS now live in their
  // own movable editor tabs (solo ChatPane); this sidebar is the launcher +
  // settings: the Chats half (now ChatsList.svelte — see the Collabs/Chats
  // comment below) above the global Setup controls (ControlStrip + theme).
  // Attached to the same DashboardPanel host as every chat tab, so it tracks
  // sessions from the shared broadcasts and drives the global model.
  import { getVsCodeApi } from '../shared/vscodeApi';
  import ControlStrip from '../sidebar/ControlStrip.svelte';
  import ThemeEditor from '../dashboard/components/ThemeEditor.svelte';
  import WikiSearchPane from '../dashboard/panes/WikiSearchPane.svelte';
  import ChatsList from './ChatsList.svelte';
  import CollabsList from './CollabsList.svelte';
  import CraneMark from '../shared/CraneMark.svelte';
  import { clampCollabsHeight } from './chatSections';
  import {
    THEMES,
    applyTheme,
    applyThemeSilently,
    loadTheme,
    themeIndex,
    type ThemeId,
  } from '../shared/theme';
  import { onMount } from 'svelte';

  const vscode = getVsCodeApi();

  let version = $state('');

  // Collapsible Memory section: the force-directed memory graph + search.
  // Default-collapsed so the graph's canvas rAF loop only runs when opened.
  let showMemory = $state(false);

  // Theme picker. Apply SILENTLY on mount (see onMount) and post a
  // themeChanged ONLY when the user cycles — a mount-running $effect would
  // echo themeChanged on every passive sidebar reload and pop the
  // workbench-theme-sync prompt (ChatView/ControlStrip avoid this too).
  let themeIdx = $state(themeIndex(loadTheme()));
  let showThemeEditor = $state(false);
  function cycleTheme() {
    themeIdx = (themeIdx + 1) % THEMES.length;
    applyTheme(THEMES[themeIdx].id);
  }
  // Right-click the theme button to edit colours: switch to the 'custom'
  // theme (its edits live there + persist) and open the editor.
  function openThemeEditor(e: MouseEvent) {
    e.preventDefault();
    const ci = THEMES.findIndex(t => t.id === 'custom');
    themeIdx = ci < 0 ? 0 : ci;
    applyTheme('custom');
    showThemeEditor = true;
  }

  // --- Chats / Collabs ------------------------------------------------------
  // Both halves live in their own component now (CollabsList.svelte at M2,
  // ChatsList.svelte at t-kgserq), each owning its wire end to end. Both
  // extractions happened for the same reason: this file's architecture cap
  // comment names "the Chats half and the Collabs half are each an obvious
  // seam" as the remedy once either half's own feature stops fitting here —
  // ChatsList's new drag-into-a-section UI was that moment for Chats.

  // t-kgserq — the Chats/Collabs divider: drag (or ArrowUp/ArrowDown while
  // focused) to shrink or grow the Collabs half back. `collabsHeightPx` is
  // null for the default 50/50 split (the existing flex:1 1 0 on both
  // halves, untouched below); once set, Collabs gets a FIXED flex-basis and
  // Chats absorbs whatever remains. A wire of its own, deliberately separate
  // from ChatsList's chatSections — the two features share no data.
  let collabsHeightPx = $state<number | null>(null);
  let resizing = $state(false);
  let splitEl: HTMLDivElement | undefined = $state();

  function startResize(e: PointerEvent) {
    e.preventDefault();
    resizing = true;
    (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
  }
  function currentCollabsHeight(rect: DOMRect): number {
    return collabsHeightPx ?? rect.height / 2;
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing || !splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    collabsHeightPx = clampCollabsHeight(rect.bottom - e.clientY, rect.height);
  }
  function endResize() {
    if (!resizing) return;
    resizing = false;
    vscode.postMessage({ type: 'resizeCollabsSection', heightPx: collabsHeightPx });
  }
  function resizeKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (!splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    const delta = e.key === 'ArrowUp' ? 20 : -20;
    collabsHeightPx = clampCollabsHeight(currentCollabsHeight(rect) + delta, rect.height);
    vscode.postMessage({ type: 'resizeCollabsSection', heightPx: collabsHeightPx });
  }

  onMount(() => {
    version = String((window as unknown as { __ORIGAMI_VERSION__?: string }).__ORIGAMI_VERSION__ ?? '');
    applyThemeSilently(loadTheme());

    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      switch (msg.type) {
        case 'themeSync': {
          const id = msg.theme as ThemeId;
          const i = THEMES.findIndex(t => t.id === id);
          if (i >= 0 && i !== themeIdx) { themeIdx = i; applyThemeSilently(id); }
          break;
        }
        case 'collabsHeight': {
          const h = msg.heightPx;
          collabsHeightPx = typeof h === 'number' && h > 0 ? h : null;
          break;
        }
      }
    };
    window.addEventListener('message', onMsg);
    // ChatsList runs its OWN requestSessions handshake, whose reply also
    // carries themeSync — that lands on this SAME window regardless of which
    // component asked, so this shell only asks for what nothing else does.
    vscode.postMessage({ type: 'requestCollabsHeight' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<svelte:window onpointermove={onResizeMove} onpointerup={endResize} />

<div class="launcher">
  <div class="brand">
    <span class="brand-mark" style="color: var(--og-crane)"><CraneMark size={18} /></span>
    <span class="brand-name">Origami</span>
    {#if version}
      <span class="brand-version" title="Origami Coder extension version (verify you're not on a stale build)">v{version}</span>
    {/if}
    <button
      class="theme-btn"
      onclick={cycleTheme}
      oncontextmenu={openThemeEditor}
      title={`Theme: ${THEMES[themeIdx].label} — click to cycle (${THEMES[(themeIdx + 1) % THEMES.length].label} next) · right-click to edit colours`}
      aria-label={`Theme: ${THEMES[themeIdx].label}. Click to cycle themes.`}
    >
      <span class="theme-icon" aria-hidden="true">{THEMES[themeIdx].icon}</span>
      <span class="theme-label">{THEMES[themeIdx].label}</span>
    </button>
  </div>

  {#if showThemeEditor}
    <ThemeEditor onClose={() => (showThemeEditor = false)} />
  {/if}

  <!-- Settings + Engine Endpoint first — the global controls (connect /
       status / model / context) that drive the model the chats run against. -->
  <div class="section-label">Settings</div>
  <ControlStrip />

  <!-- Chats + Collabs share the rest of the panel 50/50 by default, each its
       own scroll region, divided by a now-DRAGGABLE .section-divider so the
       Collabs half can be shrunk (t-kgserq). A long chat list can no longer
       push Collabs (or Collabs push Chats) off-screen — each half scrolls
       independently instead of growing into the other. Memory is NOT part of
       this split; see its own comment below for where it sits now. -->
  <div class="chats-collabs-split" bind:this={splitEl}>
    <div class="chats-half">
      <!-- Chats: each opens in its own movable editor tab. -->
      <div class="section-label">Chats</div>
      <ChatsList />
    </div>

    <!-- t-kgserq — draggable resizer. role=separator + tabindex so it is a
         real keyboard target (ArrowUp/ArrowDown nudge it) as well as a
         pointer one; a plain 1px div here would be a resize handle only a
         mouse could ever find. This IS the WAI-ARIA "resizable separator"
         widget (a focusable role=separator with arrow-key resize), which is
         why the a11y lint below is suppressed rather than followed — the
         generic rule assumes role=separator is never interactive, but the
         ARIA spec's own separator pattern says otherwise. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="section-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the Collabs section"
      aria-valuetext={collabsHeightPx ? `${collabsHeightPx}px` : 'default'}
      tabindex="0"
      onpointerdown={startResize}
      onkeydown={resizeKey}
    ></div>

    <!-- Collabs: a shared stream several agents and you can all read; each one
         opens in its own editor tab, exactly like a chat. The half's own
         markup, wire and styles live in CollabsList.svelte (see the Collabs
         comment in the script above for why it was extracted). -->
    <div class="collabs-half" style={collabsHeightPx ? `flex: 0 0 ${collabsHeightPx}px;` : undefined}>
      <div class="section-label">Collabs</div>
      <CollabsList />
    </div>
  </div>

  <!-- Memory: a force-directed graph + search over the wiki/memory source
       folder. Collapsed by default so the graph canvas rAF loop only runs once
       you bring it up. Sources the resolved wiki folder by default — no manual
       pick needed. Sits BELOW the Chats/Collabs split, at its own natural
       (content) height — it is not part of the 50/50 and does not scroll with
       either half. On a viewport too short for split + Memory both, the
       .launcher's own overflow-y:auto (not a pin) is what keeps Memory
       reachable: the whole panel scrolls, same as it always could. -->
  <div class="memory-section">
    <div class="section-label">Memory</div>
    <button
      class="chat-action memory-toggle"
      class:active={showMemory}
      onclick={() => (showMemory = !showMemory)}
      title="Show the memory graph — a map of your wiki/memory pages, tags and namespaces. Defaults to your wiki folder; change it with Source…"
    >{showMemory ? '▾ Hide memory graph' : '▸ Show memory graph'}</button>
    {#if showMemory}
      <div class="memory-host"><WikiSearchPane /></div>
    {/if}
  </div>
</div>

<style>
  .launcher {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--og-bg);
    color: var(--og-text);
    overflow-y: auto;
    overflow-x: hidden;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 12px 8px;
    background: var(--og-pane-header);
    flex-shrink: 0;
  }
  .brand-mark { display: flex; line-height: 0; flex-shrink: 0; }
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
  .theme-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-left: auto;
    padding: 3px 8px;
    font-size: 11px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
  }
  .theme-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  .theme-icon { font-size: 12px; line-height: 1; color: var(--og-chat); }
  .theme-label { font-size: 11px; }

  .section-label {
    padding: 8px 12px 2px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--og-text-muted);
  }

  .chat-action {
    font-size: 11px;
    padding: 4px 8px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .chat-action:hover { border-color: var(--og-chat); color: var(--og-text); }
  .chat-action.active { background: color-mix(in srgb, var(--og-accent) 14%, transparent); color: var(--og-text); }

  /* Chats/Collabs 50/50 split: the only flex-growing item in .launcher's
     column, so it absorbs whatever room is left after the fixed header
     (brand/Settings) and Memory (natural height, below) take theirs.
     min-height is a floor so both halves stay usable even with the memory
     graph open; below that floor .launcher's own overflow-y:auto scrolls the
     whole panel, same safety net Memory already relied on. */
  .chats-collabs-split {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-height: 220px;
  }
  /* Equal flex-basis + grow + shrink -> an exact 50/50 split of the space
     above, regardless of viewport height. min-height:0 overrides the flex
     default (min-height:auto, which refuses to shrink below content) so a
     long chat list scrolls INSIDE its own half instead of pushing Collabs
     down or growing the split past its floor. t-kgserq: Collabs may carry an
     INLINE flex-basis override (see the markup above) once the divider has
     been dragged — that wins over this rule by CSS specificity without this
     rule itself needing to change, which is what the source-regex test below
     still pins down. */
  .chats-half, .collabs-half {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* Memory sits below the split, at its own natural (content) height — not
     part of the 50/50, does not scroll with either half. flex-shrink:0 keeps
     it from being squeezed; if the panel is too short for split + Memory
     both, .launcher's own overflow-y:auto scrolls the whole panel so Memory
     stays reachable. (The Context tracker that used to share this section's
     old margin-top:auto pin was removed — Memory no longer needs the pin at
     all now that the split above it is the one flex-growing item.) */
  .memory-section { flex-shrink: 0; padding-bottom: 6px; }

  /* Collapsible graph host. Fixed height so the graph canvas resolves a size;
     the sidebar itself scrolls (overflow-y:auto). */
  .memory-toggle { display: block; width: calc(100% - 20px); margin: 2px 10px 0; text-align: left; }
  .memory-host {
    height: 380px;
    flex-shrink: 0;
    margin: 6px 10px 2px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--og-surface);
  }

  /* t-kgserq — the draggable divider. A slim hit area (padding, not a tall
     literal box) with the visible line as a ::before, so the CURSOR/hover
     target is comfortably bigger than the 1px line ever was, without the
     divider itself claiming visible height in the layout the old static
     line didn't either. */
  .section-divider {
    flex-shrink: 0;
    height: 7px;
    margin: 5px 12px 3px;
    cursor: row-resize;
    position: relative;
    border-radius: 3px;
  }
  .section-divider::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 3px;
    height: 1px;
    background: var(--og-border);
  }
  .section-divider:hover::before,
  .section-divider:focus-visible::before {
    background: var(--og-accent);
  }
  .section-divider:focus-visible {
    outline: 1px solid var(--og-chat);
    outline-offset: 1px;
  }
</style>

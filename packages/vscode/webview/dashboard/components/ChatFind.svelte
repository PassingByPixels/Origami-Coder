<script lang="ts">
  // Ctrl+F inside one chat cell: a compact bar pinned top-right, with a live
  // count and two arrows. It is mounted per cell and decides for itself
  // whether a Ctrl+F was meant for it (chatFind.ts's pickFindTarget), so only
  // one bar stays open across many chats.
  // The window Escape listener must stay guarded: unguarded, it would
  // swallow Escape meant for a confirm dialog, a question modal, or the
  // lightbox. Enter binds only to the input, never the window, so it cannot
  // eat the composer's send key.
  import { tick, untrack } from 'svelte';
  import {
    cellIdOf, clearHighlights, findMatches, paintHighlights,
    pickFindTarget, revealMatch, stepFrom, type FindMatch,
  } from './chatFind';
  import { markScrollAnchor } from '../panes/chatScroll';
  import { requestHistory, type ChatHistory } from '../panes/chatHistory';
  import ChatFindAll from './ChatFindAll.svelte';
  import { tip } from '../../shared/warmTip';

  // t-ucnp7t: `history` is the chat's lazy-loading state (panes/chatHistory.ts). While older pages
  // are not loaded, LOADED mode says so and offers "Load all"; ALL mode asks the engine.
  // `revealFolded` (t-v5qrdz): leave Focus view, so an ALL hit in a row it folded away is drawn.
  // True when it changed something. ChatPane owns the cell's `focusMode`, so it passes this in.
  let { sessionId, history, revealFolded }: { sessionId: string; history?: ChatHistory; revealFolded?: () => boolean } = $props();
  let mode = $state<'loaded' | 'all'>('loaded');
  let all = $state<{ step: (dir: 1 | -1) => void } | null>(null);

  let open = $state(false);
  let query = $state('');
  let index = $state(0);
  let matches = $state<FindMatch[]>([]);
  /** The match the reader is ON. Steps start from it, not from `index` (chatFind.ts's stepFrom). */
  let current: FindMatch | null = null;
  let inputEl = $state<HTMLInputElement | null>(null);
  /** Where the caret was when find opened. Escape puts it back, or a reader who
   *  glanced at the transcript mid-sentence loses their place in the composer. */
  let returnTo: HTMLElement | null = null;

  /** The cell's own scroller, resolved by id rather than by a `bind:this` — the
   *  pane's established idiom, because a `bind:this` inside its `{#each}` holds
   *  only the LAST cell rendered (ChatPane.svelte's own note at scrollToBottom). */
  const scroller = () =>
    document.querySelector<HTMLElement>(`.cell-messages[data-session-id="${sessionId}"]`);

  function claims(): boolean {
    const cells = Array.from(document.querySelectorAll<HTMLElement>('.chat-cell[data-session-id]'));
    // `:hover` beats a tracked pointerenter: it is the browser's own answer,
    // with no second "where is the mouse" state to go stale. jsdom reports
    // false for hover, so this falls through to the focus and first-cell arms.
    let hovered: string | null = null;
    for (const c of cells) {
      try { if (c.matches(':hover')) { hovered = c.dataset.sessionId ?? null; break; } } catch { /* no :hover here */ }
    }
    const ids = cells.map((c) => c.dataset.sessionId ?? '');
    return pickFindTarget(ids, cellIdOf(document.activeElement), hovered) === sessionId;
  }

  /**
   * Rereads the transcript, then lands `dir` steps from `from` (0 = stay on it;
   * `from` null = the first match). Recomputed on the reader's action, not
   * watched: a MutationObserver would re-walk the whole cell on every streamed
   * token. `scroll` false re-counts only, and leaves the view where it is.
   */
  function land(dir: 1 | -1 | 0, from: FindMatch | null = current, scroll = true) {
    const root = scroller();
    matches = root ? findMatches(root, query) : [];
    index = stepFrom(matches, from, dir, index);
    const hit = matches[index];
    current = hit ?? null;
    paintHighlights(matches, index);
    if (!hit || !root || !scroll) return;
    revealMatch(hit.startNode);
    // scrollIntoView is absent in jsdom, hence the optional call: the counter
    // and the stepping are still assertable there, only the movement is not.
    hit.startNode.parentElement?.scrollIntoView?.({ block: 'center' });
    // Mark after moving, never before: it records where the scroller was
    // last left deliberately, so a later streamed chunk won't misread our jump.
    markScrollAnchor(root);
  }

  async function openFind() {
    if (!open) { returnTo = document.activeElement as HTMLElement | null; open = true; }
    land(0, null);
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  /**
   * `yielded` means this cell lost the key to a sibling, not that the reader
   * dismissed find. It must not restore focus (that fights the winner) and
   * must not clear highlights (the winner already painted, and clearing here
   * would erase a fresh paint instead of a stale one).
   */
  function close(yielded = false) {
    if (!open) return;
    open = false;
    matches = [];
    current = null;
    if (!yielded) { clearHighlights(); returnTo?.focus?.(); }
    returnTo = null;
  }

  function onInputKey(e: KeyboardEvent) {
    // Escape is not handled here; the window handler owns it either way.
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (mode === 'all') { all?.step(e.shiftKey ? -1 : 1); return; }
    land(e.shiftKey ? -1 : 1);
  }

  // An older page prepended above (t-v5qrdz): re-count now, or the counter shows
  // the old total and index until the next step. Runs on a prepend only.
  $effect(() => {
    void history?.older.length;
    untrack(() => { if (open && mode === 'loaded' && query) void tick().then(() => land(0, current, false)); });
  });

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd+F only, not Ctrl+Shift+F (VS Code's search-across-files).
      // `F` alone still matches, since Caps Lock reports it unshifted.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        if (!claims()) { close(true); return; }
        e.preventDefault();
        void openFind();
        return;
      }
      if (open && e.key === 'Escape') { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (open) clearHighlights(); };
  });
</script>

{#if open}
  <div class="cf-bar" role="search">
    <!-- Uses value= assignment, not bind:value: search must run against this
         keystroke's text, not race a separate binding listener. -->
    <input
      class="cf-input"
      type="text"
      placeholder="Find in chat…"
      aria-label="Find in this chat"
      bind:this={inputEl}
      value={query}
      oninput={(e) => { query = e.currentTarget.value; if (mode === 'loaded') land(0, null); }}
      onkeydown={onInputKey}
    />
    <!-- "0/0" only once something was typed: an empty box has not failed to
         find anything, it has not been asked. -->
    {#if history?.lazy}
      <button class="cf-btn cf-mode" aria-pressed={mode === 'all'} onclick={() => { mode = mode === 'all' ? 'loaded' : 'all'; clearHighlights(); if (mode === 'loaded') land(0, null); }}
        use:tip={mode === 'all' ? 'Finding in the WHOLE chat. Click to find in the loaded messages only' : 'Finding in the LOADED messages. Click to find in the whole chat'}>{mode === 'all' ? 'All' : 'Loaded'}</button>
    {/if}
    {#if mode === 'all'}
      <ChatFindAll bind:this={all} {sessionId} {history} {query} {revealFolded} />
    {:else}
    <span class="cf-count" aria-live="polite">
      {matches.length > 0 ? `${index + 1}/${matches.length}` : query ? '0/0' : ''}
    </span>
    {#if history?.hasMore}
      <button class="cf-btn" disabled={!!history.loading} use:tip={'Older messages are not loaded, so this finds in the loaded part only. Load the whole chat'}
        onclick={() => requestHistory(sessionId, 'all', 'find', () => void tick().then(() => land(0)))}>{history.loading ? 'Loading…' : 'Load all'}</button>
    {/if}
    <button class="cf-btn" aria-label="Previous match" use:tip={'Previous match (Shift+Enter)'}
      onclick={() => land(-1)}>&uarr;</button>
    <button class="cf-btn" aria-label="Next match" use:tip={'Next match (Enter)'}
      onclick={() => land(1)}>&darr;</button>
    {/if}
    <button class="cf-btn" aria-label="Close find" use:tip={'Close (Escape)'}
      onclick={() => close()}>&times;</button>
  </div>
{/if}

<style>
  /* Pinned to the cell, not to the scroller: `.chat-cell` is the positioned
     ancestor (it already carries `position: relative` for the task overlay),
     and staying OUT of `.cell-messages` is what keeps the bar's own text off
     the TreeWalker — find would otherwise match its own placeholder.
     z-index 8 clears the task overlay's 6 and stays far below the pane's
     history dropdown (30) and the lightbox (90). */
  .cf-bar {
    position: absolute;
    top: 6px;
    right: 10px;
    z-index: 8;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 4px;
    background: var(--og-surface-alt);
    border: 1px solid var(--og-border);
    border-radius: 4px;
  }
  .cf-input {
    width: 150px;
    height: 18px;
    background: var(--og-input-bg);
    border: 1px solid var(--og-input-border);
    color: var(--og-text);
    border-radius: 3px;
    padding: 0 5px;
    font-size: 11px;
    font-family: inherit;
  }
  .cf-input:focus { outline: 1px solid var(--og-accent); }
  /* Tabular figures: a counter stepping 9/12 -> 10/12 must not shift the arrows. */
  .cf-count {
    min-width: 34px;
    text-align: center;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--og-text-muted);
  }
  .cf-btn {
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    color: var(--og-btn-text);
    border-radius: 3px;
    cursor: pointer;
    padding: 0 5px;
    height: 18px;
    line-height: 1;
    font-size: 11px;
  }
  .cf-btn:hover { background: var(--og-btn-hover); }
  .cf-mode[aria-pressed='true'] { border-color: var(--og-accent); }

  /* The highlights themselves. `::highlight()` paints RANGES, which belong to
     the document rather than to any element, so these rules must be global —
     a scoped selector would name a class no Range carries. Every colour is a
     theme var: a literal here is a match that goes invisible in whichever of
     the five themes it clashes with. */
  :global(::highlight(og-chat-find)) {
    background-color: var(--og-warning-soft);
    color: var(--og-text);
  }
  :global(::highlight(og-chat-find-current)) {
    background-color: var(--og-accent);
    color: var(--og-btn-text);
  }
</style>

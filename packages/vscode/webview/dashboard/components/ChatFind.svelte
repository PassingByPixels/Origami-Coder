<script lang="ts">
  // Ctrl+F inside ONE chat cell — a compact bar pinned to the top-right of the
  // cell it searches, with a live count and two arrows.
  //
  // MOUNTED PER CELL, AND ALWAYS MOUNTED. The widget decides for itself whether
  // a Ctrl+F was meant for it (chatFind.ts's pickFindTarget), which is also what
  // keeps exactly one open across a grid of twelve chats: every widget answers
  // the same question on the same key, so the loser closes in the same tick the
  // winner opens. The alternative — the pane arbitrating and passing an `open`
  // prop down — costs lines in a file with nineteen of them left.
  //
  // WHILE SHUT IT HANDLES NOTHING BUT THE OPENER. The window listener lives as
  // long as the chat pane does, so an unguarded Escape here would swallow the
  // key from the confirm dialog, the question modal and the lightbox for the
  // whole session, with nothing on screen to explain it (ImageLightbox.test.ts
  // documents the same regression class). Enter is narrower still: it is bound
  // to the INPUT and never to the window, so a find bar left open cannot eat
  // the composer's send key.
  import { tick } from 'svelte';
  import {
    cellIdOf, clearHighlights, findMatches, matchRange, paintHighlights,
    pickFindTarget, stepIndex, type FindMatch,
  } from './chatFind';
  import { markScrollAnchor } from '../panes/chatScroll';

  let { sessionId }: { sessionId: string } = $props();

  let open = $state(false);
  let query = $state('');
  let index = $state(0);
  let matches = $state<FindMatch[]>([]);
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
    // `:hover` rather than a tracked pointerenter: it is the browser's own
    // answer, so there is no second copy of "where is the mouse" to go stale.
    // jsdom reports false for it, which is the truth in a headless DOM — a test
    // then falls through to the focus and first-cell arms.
    let hovered: string | null = null;
    for (const c of cells) {
      try { if (c.matches(':hover')) { hovered = c.dataset.sessionId ?? null; break; } } catch { /* no :hover here */ }
    }
    const ids = cells.map((c) => c.dataset.sessionId ?? '');
    return pickFindTarget(ids, cellIdOf(document.activeElement), hovered) === sessionId;
  }

  /**
   * Re-read the transcript, then land on the match `pick` chooses from the new
   * count. Recomputed HERE, on the reader's own action, rather than watched: a
   * chat streams, and a MutationObserver would re-walk the whole cell on every
   * token. The cost is that a match inside a message which arrived since the
   * last keystroke is found on the next one — the moment it is asked for.
   */
  function land(pick: (total: number) => number) {
    const root = scroller();
    matches = root ? findMatches(root, query) : [];
    index = pick(matches.length);
    paintHighlights(matches, index);
    const hit = matches[index];
    if (!hit || !root) return;
    // scrollIntoView is absent in jsdom, hence the optional call: the counter
    // and the stepping are still assertable there, only the movement is not.
    hit.startNode.parentElement?.scrollIntoView?.({ block: 'center' });
    // Then MARK, never before: the anchor records where this scroller was last
    // left deliberately (chatScroll.ts), so a streamed chunk arriving next does
    // not read our own jump as the reader moving away.
    markScrollAnchor(root);
  }

  async function openFind() {
    if (!open) { returnTo = document.activeElement as HTMLElement | null; open = true; }
    land(() => 0);
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  /**
   * `yielded` means this cell LOST the key to a sibling rather than the reader
   * dismissing find. It gives up the bar either way, but it must NOT restore
   * focus (that would fight the winner, who is focusing its own box) and it
   * must NOT clear the highlights: the winner has already painted, and
   * paintHighlights deletes both registrations before it registers anything, so
   * a clear here would erase a fresh paint instead of a stale one. There is
   * always a winner on this path — pickFindTarget only answers null when no
   * cell is on screen, and this widget IS one.
   */
  function close(yielded = false) {
    if (!open) return;
    open = false;
    matches = [];
    if (!yielded) { clearHighlights(); returnTo?.focus?.(); }
    returnTo = null;
  }

  function onInputKey(e: KeyboardEvent) {
    // Escape is deliberately NOT here — the window handler owns it, so it works
    // whether the caret is in this box or back in the transcript.
    if (e.key !== 'Enter') return;
    e.preventDefault();
    land((total) => stepIndex(index, total, e.shiftKey ? -1 : 1));
  }

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd+F only. NOT Ctrl+Shift+F — that is VS Code's search-across-
      // files, and a webview that preventDefaults it takes the workbench's own
      // shortcut away with nothing to show for it. `'F'` is still accepted
      // because Caps Lock reports the upper case with no shift held.
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
    <!-- `value=` + an explicit assignment, not `bind:value`: the search has to
         run against the text of THIS keystroke, and a binding's own listener
         and this one would be racing to say which. -->
    <input
      class="cf-input"
      type="text"
      placeholder="Find in chat…"
      aria-label="Find in this chat"
      bind:this={inputEl}
      value={query}
      oninput={(e) => { query = e.currentTarget.value; land(() => 0); }}
      onkeydown={onInputKey}
    />
    <!-- "0/0" only once something was typed: an empty box has not failed to
         find anything, it has not been asked. -->
    <span class="cf-count" aria-live="polite">
      {matches.length > 0 ? `${index + 1}/${matches.length}` : query ? '0/0' : ''}
    </span>
    <button class="cf-btn" aria-label="Previous match" title="Previous match (Shift+Enter)"
      onclick={() => land((total) => stepIndex(index, total, -1))}>&uarr;</button>
    <button class="cf-btn" aria-label="Next match" title="Next match (Enter)"
      onclick={() => land((total) => stepIndex(index, total, 1))}>&darr;</button>
    <button class="cf-btn" aria-label="Close find" title="Close (Escape)"
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

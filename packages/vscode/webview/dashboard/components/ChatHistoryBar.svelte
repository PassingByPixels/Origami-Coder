<script lang="ts">
  // ChatHistoryBar.svelte — the top of a reopened chat's transcript (t-ucnp7t, plan 3.5 and 3.6).
  //
  // Three states, all driven by the session's `history` (panes/chatHistory.ts):
  //   - reopening with no rows yet: the large crane state (ChatReopenLoading.svelte, t-v47uut);
  //   - reopening, rows arriving (an old engine replays everything): "Loading chat history…", until the engine's window lands;
  //   - older messages exist: a "Load earlier messages (N more)" button, and the same request when
  //     the reader scrolls this bar into view;
  //   - a load failed: the error, and the button again, never "Loading…" for ever.
  //
  // The scroll trigger is ARMED only by the reader scrolling UP. A reopened pane paints at the top
  // before it pins to the bottom, and an observer reports its first state at once: unarmed, that is
  // the sub-agent panel's old defect (plan section 2), a second page fetched the moment the chat
  // opens. The pane's own pin moves scrollTop down, so it never arms this.
  import { earlierLabel, requestHistory, type ChatHistory } from '../panes/chatHistory';
  import { isPinning } from '../panes/chatPin';
  import ChatReopenLoading from './ChatReopenLoading.svelte';

  interface Props {
    sessionId: string;
    history?: ChatHistory;
    /** No transcript rows yet (chatEmptyGate.ts hasConversation is false). */
    empty?: boolean;
    /** Watch `el` inside `root`, call `hit` when it comes into view; returns the stop. Injectable
     *  because jsdom has no IntersectionObserver. */
    observe?: (el: Element, root: Element, hit: () => void) => () => void;
  }

  const intersect = (el: Element, root: Element, hit: () => void) => {
    if (typeof IntersectionObserver === 'undefined') return () => undefined;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) hit(); }, { root });
    io.observe(el);
    return () => io.disconnect();
  };

  let { sessionId, history, empty = false, observe = intersect }: Props = $props();
  let bar = $state<HTMLDivElement | null>(null);

  const loadEarlier = () => {
    if (history?.hasMore && !history.loading) requestHistory(sessionId, 'page', 'scroll');
  };

  $effect(() => {
    const root = bar?.closest<HTMLElement>('.cell-messages');
    if (!bar || !root || !history?.hasMore) return;
    let armed = false;
    let lastTop = root.scrollTop;
    const onScroll = () => {
      if (!isPinning(root) && root.scrollTop < lastTop) armed = true;
      lastTop = root.scrollTop;
    };
    root.addEventListener('scroll', onScroll);
    const stop = observe(bar, root, () => { if (armed) loadEarlier(); });
    return () => { root.removeEventListener('scroll', onScroll); stop(); };
  });
</script>

{#if history?.restoring && empty}
  <ChatReopenLoading />
{:else if history?.restoring}
  <div class="hist-note" role="status">Loading chat history…</div>
{:else if history && (history.hasMore || history.loading || history.error)}
  <div class="hist-bar" bind:this={bar}>
    {#if history.hasMore || history.loading}
      <button class="hist-btn" disabled={!!history.loading} onclick={loadEarlier}>{earlierLabel(history)}</button>
    {/if}
    {#if history.error}<span class="hist-error" role="alert">{history.error}</span>{/if}
  </div>
{/if}

<style>
  .hist-note,
  .hist-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 6px 0 10px;
    font-size: 11px;
    color: var(--og-text-muted);
  }
  .hist-btn {
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    color: var(--og-btn-text);
    border-radius: 3px;
    cursor: pointer;
    padding: 2px 10px;
    font-size: 11px;
    font-family: inherit;
  }
  .hist-btn:hover:not(:disabled) { background: var(--og-btn-hover); }
  .hist-btn:disabled { cursor: default; opacity: 0.75; }
  .hist-error { color: var(--og-error); }
</style>

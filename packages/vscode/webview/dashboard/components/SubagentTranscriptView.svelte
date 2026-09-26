<script lang="ts">
  // SubagentTranscriptView.svelte: read a sub-agent's own session the way you
  // read the Chat panel (running children answer with the partial transcript).
  // Rows arrive in replay-log shape, so chatRestore.ts builds the list and
  // ChatTranscript.svelte draws it: a card fix lands in both at once.
  // `readOnly` drops rewind and Kill/Stop on every ToolCard; thought-open set is local.
  import { onMount, tick } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { tip } from '../../shared/warmTip';
  import { restoreLog, type RestoredEntry } from '../panes/chatRestore';
  import { hasConversation } from '../panes/chatEmptyGate';
  import type { Message } from '../panes/chatMessage';
  import ChatTranscript from './ChatTranscript.svelte';
  import ScrollAnchorPill from './ScrollAnchorPill.svelte';
  import FocusEye from './FocusEye.svelte';
  import ImageLightbox from './ImageLightbox.svelte';
  import { atLatestOnly, beginEarlier, beginLatest, initialPaging, settle, type PagingState } from './subagentPaging';
  import { anchorPillLabel, followLatest, initialAnchorState, jumpToLatest, onAnchorResize, onAnchorScroll, onAnchorWheel, readerScrolled, watchTop, type AnchorState } from './subagentScrollAnchor'; import { watchResize } from '../panes/chatScrollInput'; import { rearmOnContent, watchContent } from '../panes/chatScrollContent';
  import { NO_ANSWER, POLL_MS, replyDeadline } from './subagentTranscriptTiming'; // t-tydjkm: no reply = a visible error, never "Loading…" for ever

  interface Props {
    /** The CHILD's session id; the engine reads it out of the store. */
    sessionId: string;
    /** The launcher card's header; doubles as the label on reply rows. */
    title: string;
    onClose: () => void;
    /** t-j50p3r: the parent cell's own `focusMode` (per SESSION, in memory,
     *  never persisted), passed down so chat and overlay agree. */
    focusMode?: boolean;
    /** Absent draws NO eye: a toggle with no owner for the flag is dead. */
    onToggleFocus?: () => void;
  }
  let { sessionId, title, onClose, focusMode = false, onToggleFocus }: Props = $props();

  const vscode = getVsCodeApi();

  let messages = $state<Message[]>([]);
  let loaded = $state(false);
  let found = $state(false);
  let running = $state(false);
  let truncated = $state(false);
  let error = $state('');
  let openThoughtIds = $state<number[]>([]);
  // t-krxap7. Only the newest block is read on open; older blocks arrive by the
  // button or by scrolling to the top. The page SIZE is the host's setting, not
  // a number this panel carries. subagentPaging.ts holds the rules.
  let paging = $state<PagingState>(initialPaging());
  let nextId = 0;
  let body = $state<HTMLDivElement | null>(null);
  let top = $state<HTMLDivElement | null>(null);
  // Scroll-anchor pill parity (t-q90v2v), wired via subagentScrollAnchor.ts.
  let anchor = $state<AnchorState>(initialAnchorState());
  // t-ucn3fj: the scroll-up trigger waits for the open-time pin or the reader's own scroll/wheel.
  let armed = $state(false);
  // t-l1sovi — this panel is its own standalone view (not inside ChatPane's
  // cell), so it owns its own lightbox rather than sharing the parent's.
  let lightbox: { src: string; alt: string } | null = $state(null);
  const openLightbox = (src: string, alt: string) => (lightbox = { src, alt });

  const deadline = replyDeadline(() => { paging = { ...paging, inFlight: false }; if (!loaded) { error = NO_ANSWER; loaded = true; } });

  /** The newest page. Open, the refresh button, and the running-child poll. */
  const request = () => {
    paging = beginLatest(); deadline.arm();
    vscode.postMessage({ type: 'requestSubagentTranscript', sessionId });
  };

  /** The block before the window; beginEarlier's guard stops a double fetch. */
  function loadEarlier() {
    const next = beginEarlier(paging);
    if (!next) return;
    paging = next.state; deadline.arm();
    vscode.postMessage({ type: 'requestSubagentTranscript', sessionId, before: next.before });
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data || {};
      // Keyed on the child id: a second panel (or a stale reply for a row the
      // user has since switched away from) must not overwrite this one.
      if (m.type !== 'subagentTranscriptData' || m.sessionId !== sessionId) return;
      deadline.clear();
      const settled = settle(paging, m);
      paging = settled.state;
      // A block already in the window: its entries are dropped, never drawn twice.
      if (settled.mode === 'stale') return;
      const rows = (Array.isArray(m.entries) ? m.entries : []) as RestoredEntry[];
      if (settled.mode === 'earlier') {
        // Prepend, and hold the reader's place: inserting above the viewport
        // moves everything down by exactly the height that was added.
        const keep = body ? body.scrollHeight - body.scrollTop : 0;
        messages = [...restoreLog<Message>([], rows, () => ++nextId, title), ...messages];
        queueMicrotask(() => { if (body) body.scrollTop = body.scrollHeight - keep; });
        // Sticky across a prepend: the note describes the WINDOW, and an older
        // block that was trimmed stays trimmed once it is on screen.
        truncated = truncated || m.truncated === true;
      } else {
        nextId = 0;
        messages = restoreLog<Message>([], rows, () => ++nextId, title);
        found = m.found === true;
        // `running` is only meaningful on the newest page: an older block ends
        // wherever the page cut, which says nothing about whether the child is out.
        running = m.running === true;
        // A rebuild replaces the window, so the note is re-derived, not kept.
        truncated = m.truncated === true;
        // Open at the newest reply; a poll follows only a reader stuck to, or back on, the bottom.
        void tick().then(() => { if (body) anchor = followLatest(body, anchor, () => (armed = true)); });
      }
      error = typeof m.error === 'string' ? m.error : '';
      loaded = true;
    };
    window.addEventListener('message', onMsg);
    request();
    return () => { deadline.clear(); window.removeEventListener('message', onMsg); };
  });

  // Only while the child is unsettled: a settled transcript cannot change.
  $effect(() => {
    // Not while paged back: the poll rebuilds from the newest page.
    if (!running || !atLatestOnly(paging)) return;
    const timer = setInterval(request, POLL_MS);
    return () => clearInterval(timer);
  });

  // The scroll-up trigger. Same call as the button, so the single-in-flight guard
  // covers both; the sentinel sits above the first row, inside the scroller.
  $effect(() => { if (armed && top && body && paging.hasMore) return watchTop(top, body, loadEarlier); });

  // Streaming colour parity: the last row while the child runs at the live edge.
  let liveAgentMsgId = $derived(
    running && atLatestOnly(paging) && messages.at(-1)?.kind === 'agent' ? (messages.at(-1)!.id) : null,
  );
</script>

<div class="sat-overlay">
  <div class="sat-head">
    <span class="sat-title" use:tip={title}>{title}</span>
    <!-- Said out loud, never inferred from an empty list: a partial transcript
         and a finished one look identical once drawn. -->
    {#if loaded && running}<span class="sat-note">still running</span>{/if}
    {#if loaded && truncated}<span class="sat-note">output trimmed</span>{/if}
    <!-- The main chat's OWN control; the fold is ChatTranscript's foldForFocus. -->
    {#if onToggleFocus}<FocusEye focused={focusMode} onToggle={onToggleFocus} />{/if}
    <!-- Always offered: covers a child that settled between polls. -->
    <button class="sat-refresh" aria-label="Refresh transcript" use:tip={'Refresh'} onclick={request}>&#8635;</button>
    <button class="sat-close" aria-label="Close transcript" use:tip={'Close'} onclick={onClose}>&times;</button>
  </div>
  <div class="sat-body" bind:this={body} use:watchResize={(el) => (anchor = onAnchorResize(anchor, el))} use:watchContent={(el) => { if (!anchor.stuckToBottom && rearmOnContent(el, false)) anchor = initialAnchorState(); }}
    onscroll={(ev) => { armed ||= readerScrolled(ev.currentTarget); anchor = onAnchorScroll(anchor, ev.currentTarget as HTMLDivElement, messages.at(-1)?.id ?? null); }}
    onwheel={(ev) => { armed = true; anchor = onAnchorWheel(anchor, ev.currentTarget as HTMLDivElement, ev.deltaY, messages.at(-1)?.id ?? null, ev.target); }}>
    {#if !loaded}
      <p class="sat-empty">Loading transcript…</p>
    {:else if error}
      <p class="sat-empty">{error}</p>
    {:else if !found}
      <!-- The engine answers `found: false` rather than throwing for a child it
           cannot read at all. Named as its own case: "gone" is not "empty". -->
      <p class="sat-empty">This sub-agent's session is no longer in the store.</p>
    {:else if !hasConversation(messages)}
      <!-- A2 empty-state gate (chatEmptyGate.ts): scaffold-only rows still read as empty. -->
      <p class="sat-empty">This sub-agent has not written anything yet.</p>
    {:else}
      <!-- Said out loud rather than left to the scroll trigger alone: a reader on
           a trackpad may never reach the top, and a keyboard user has no trigger. -->
      {#if paging.hasMore}
        <div class="sat-earlier" bind:this={top}>
          <button onclick={loadEarlier} disabled={paging.inFlight}>
            {paging.inFlight ? 'Loading earlier messages…' : 'Load earlier messages'}
          </button>
        </div>
      {/if}
      <ChatTranscript
        {messages}
        {sessionId}
        inFlight={liveAgentMsgId !== null}
        currentThoughtMsgId={null}
        currentAgentMsgId={liveAgentMsgId}
        {openThoughtIds}
        onThoughtOpenIds={(ids) => (openThoughtIds = ids)}
        {focusMode}
        onImageClick={openLightbox}
        readOnly
      />
    {/if}
  </div>
  <div class="sat-anchor-slot">
    <ScrollAnchorPill
      label={anchorPillLabel(anchor, messages)}
      onJump={() => { if (body) anchor = jumpToLatest(body); }}
    />
  </div>
  <ImageLightbox src={lightbox?.src ?? null} alt={lightbox?.alt ?? ''} onClose={() => (lightbox = null)} />
</div>

<style>
  /* Covers the chat cell it is opened from, the same absolute-inside-the-cell
     placement the drawer beside it uses — a transcript is a full read, not a
     240px glance, and the drawer is far too narrow to hold one. */
  .sat-overlay {
    position: absolute;
    inset: 0;
    z-index: 8;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--og-bg);
    border: 1px solid var(--og-border);
    border-radius: 6px;
  }
  .sat-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    padding: 6px 10px;
    border-bottom: 1px solid var(--og-border);
    background: var(--og-surface);
  }
  .sat-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--og-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sat-note {
    flex: 0 0 auto;
    font-size: 9px;
    padding: 1px 6px;
    border-radius: 3px;
    color: var(--og-warning);
    border: 1px solid var(--og-warning);
  }
  /* Refresh and close are two ends of one "header control" family, same look
     the drawer's own row controls use. */
  .sat-close, .sat-refresh {
    flex: 0 0 auto;
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 3px;
    border-radius: 3px;
    font-family: inherit;
  }
  .sat-close:hover, .sat-refresh:hover { color: var(--og-text); background: var(--og-btn-bg); }
  .sat-refresh { font-size: 12px; }
  .sat-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 10px; }
  /* The pill floats above this zero-height slot (bottom: calc(100% + 10px)); no composer here to anchor to instead. */
  .sat-anchor-slot { position: relative; flex: 0 0 auto; height: 0; }
  .sat-earlier { display: flex; justify-content: center; padding: 2px 0 8px; }
  .sat-earlier button {
    font: inherit;
    font-size: 10px;
    padding: 2px 10px;
    color: var(--og-text-muted);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 10px;
    cursor: pointer;
  }
  .sat-earlier button:hover:not(:disabled) { color: var(--og-text); }
  .sat-earlier button:disabled { cursor: default; opacity: 0.6; }
  .sat-empty { margin: 0; font-size: 11px; color: var(--og-text-muted); }
</style>

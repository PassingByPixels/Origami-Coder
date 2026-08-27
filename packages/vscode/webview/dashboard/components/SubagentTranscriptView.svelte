<script lang="ts">
  // SubagentTranscriptView.svelte — a sub-agent's own session, read the way you
  // read the Chat panel: its prose, its tool cards, its errors. RUNNING ONES
  // TOO: the engine projects a child's stored messages whether or not it has
  // settled (`subagent_transcript` answers `running: true` with the partial
  // transcript), and a live child used to get a flat `task.log` tab off the
  // forwarded chunk buffer instead — a buffer that is transient, never logged,
  // and therefore empty in a reopened chat, so that tab read "(no output yet)"
  // for an entire multi-hour run.
  //
  // WHAT IT REPLACES. That flat log gave one line per tool — no cards, no
  // diffs, no structure. The child's real transcript was in the engine's store
  // the whole time; it just had no way out. It does now, and the rows come back
  // in the SAME replay-log shape a reloaded chat is rebuilt from, so
  // chatRestore.ts's existing merge rules build the message list and
  // ChatTranscript.svelte — the renderer the live chat uses — draws it. Not a
  // lookalike: the same component, so a fix to a card lands in both at once.
  //
  // READ-ONLY IS THE POINT, and it is not a matter of hiding markup. `readOnly`
  // rides down to ChatTranscript, which drops the rewind button (it rolls the
  // WORKING TREE back) and passes its own `readOnly` to every ToolCard, where
  // Kill and Stop act on whatever turn is running NOW — not on this hour-old
  // one. Opening a file the child touched stays live on purpose: it is what a
  // reader of a transcript wants, and it changes nothing.
  //
  // The reasoning-block open set is LOCAL $state here. In the chat it is a
  // session field, because a manual expand has to survive the next stream
  // delta; a historical transcript has no session to write to and must never
  // reach for one.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { restoreLog, type RestoredEntry } from '../panes/chatRestore';
  import type { Message } from '../panes/chatMessage';
  import ChatTranscript from './ChatTranscript.svelte';

  interface Props {
    /** The CHILD's session id — the engine reads it straight out of the store,
     *  so a child this chat can no longer see still answers. */
    sessionId: string;
    /** The launcher card's header, so the panel names the agent the drawer
     *  named. Doubles as the label on the child's own reply rows. */
    title: string;
    onClose: () => void;
  }
  let { sessionId, title, onClose }: Props = $props();

  const vscode = getVsCodeApi();

  let messages = $state<Message[]>([]);
  let loaded = $state(false);
  let found = $state(false);
  let running = $state(false);
  let truncated = $state(false);
  let error = $state('');
  let openThoughtIds = $state<number[]>([]);

  /** How often a STILL-RUNNING child is re-read. A poll, not a live wire: the
   *  forwarded-chunk wire is what this replaces, and pushing structured entries
   *  per delta would re-project the child's whole stored session on every token
   *  for a panel only open while somebody is looking. One ext read against the
   *  store, stopped the moment the child settles or the panel closes. */
  const POLL_MS = 4000;

  const request = () => vscode.postMessage({ type: 'requestSubagentTranscript', sessionId });

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data || {};
      // Keyed on the child id: a second panel (or a stale reply for a row the
      // user has since switched away from) must not overwrite this one.
      if (m.type !== 'subagentTranscriptData' || m.sessionId !== sessionId) return;
      let id = 0;
      messages = restoreLog<Message>([], (Array.isArray(m.entries) ? m.entries : []) as RestoredEntry[], () => ++id, title);
      found = m.found === true;
      running = m.running === true;
      truncated = m.truncated === true;
      error = typeof m.error === 'string' ? m.error : '';
      loaded = true;
    };
    window.addEventListener('message', onMsg);
    request();
    return () => window.removeEventListener('message', onMsg);
  });

  // Only while the child is UNSETTLED, and torn down by the same rule — a
  // settled transcript cannot change, so a timer over one is a leak per panel
  // the user ever opened. Same shape as SubagentDock's roster tick.
  $effect(() => {
    if (!running) return;
    const timer = setInterval(request, POLL_MS);
    return () => clearInterval(timer);
  });
</script>

<div class="sat-overlay">
  <div class="sat-head">
    <span class="sat-title" title={title}>{title}</span>
    <!-- Said out loud, never inferred from an empty list: a partial transcript
         and a finished one look identical once drawn. -->
    {#if loaded && running}<span class="sat-note">still running</span>{/if}
    {#if loaded && truncated}<span class="sat-note">output trimmed</span>{/if}
    <!-- Always offered, not only while running: the poll above answers the
         ordinary case, and this is what a reader has when a child settled
         between two ticks, or when they simply do not want to wait 4s. -->
    <button class="sat-refresh" aria-label="Refresh transcript" title="Refresh" onclick={request}>&#8635;</button>
    <button class="sat-close" aria-label="Close transcript" title="Close" onclick={onClose}>&times;</button>
  </div>
  <div class="sat-body">
    {#if !loaded}
      <p class="sat-empty">Loading transcript…</p>
    {:else if error}
      <p class="sat-empty">{error}</p>
    {:else if !found}
      <!-- The engine answers `found: false` rather than throwing for a child it
           cannot read at all. Named as its own case: "gone" is not "empty". -->
      <p class="sat-empty">This sub-agent's session is no longer in the store.</p>
    {:else if messages.length === 0}
      <p class="sat-empty">This sub-agent has not written anything yet.</p>
    {:else}
      <ChatTranscript
        {messages}
        {sessionId}
        inFlight={false}
        currentThoughtMsgId={null}
        currentAgentMsgId={null}
        {openThoughtIds}
        onThoughtOpenIds={(ids) => (openThoughtIds = ids)}
        readOnly
      />
    {/if}
  </div>
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
  .sat-empty { margin: 0; font-size: 11px; color: var(--og-text-muted); }
</style>

<script lang="ts">
  // Loops pane — the live /loop schedules across open chats. A loop is a
  // prompt re-run on an interval, in this workspace (see
  // src/dashboard/chatCommands.ts's scheduler + DashboardPanel.startLoopSchedule).
  // Schedules are PERSISTED (src/dashboard/agentManager/loopPersistence.ts,
  // keyed by the chat's engine session id) so they survive a window reload —
  // DashboardPanel re-arms each one once its chat's session is restored, and
  // always schedules its next run a full interval out, never immediately. A
  // loop whose session could NOT be restored is never silently dropped: it
  // shows below under "needs attention" with its prompt intact so the work
  // isn't lost, and can be cancelled from there.
  //
  // A loop can be marked PERSISTENT, which changes one thing: closing its chat
  // no longer ends it (DashboardPanel recalls the engine session headlessly and
  // keeps the timer). It does NOT make a loop fire with VS Code closed — that
  // is a cron, and this pane says so rather than letting the two blur.
  import { onDestroy } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import LoopCard from '../components/LoopCard.svelte';
  import { listState, matchesSearch } from './paneSearch';
  import type { LoopSchedule, NeedsAttentionLoop } from './loopRows';
  const vscode = getVsCodeApi();

  let schedules: LoopSchedule[] = $state([]);
  let needsAttention: NeedsAttentionLoop[] = $state([]);
  let loaded = $state(false);
  let query = $state('');

  // ONE clock for every card, so a pane of loops runs a single timer instead of
  // one per row. Intervals are short enough that a stale countdown is a wrong
  // countdown, and cards only re-read data on refresh.
  let now = $state(Date.now());
  const clock = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(clock));

  const label = (s: LoopSchedule) => `#${s.number} ${s.agentName}${s.title ? ': ' + s.title : ''}`;
  const shownLive = $derived(schedules.filter((s) => matchesSearch([s.prompt, label(s), s.intervalLabel], query)));
  const shownAttn = $derived(needsAttention.filter((s) => matchesSearch([s.prompt, s.intervalLabel], query)));
  const total = $derived(schedules.length + needsAttention.length);
  const state = $derived(listState(total, shownLive.length + shownAttn.length));

  function refresh() {
    loaded = false;
    vscode.postMessage({ type: 'listLoopSchedules' });
  }

  /** Cancel a loop — a live row sends its LOCAL session id (stopped the same
   *  way /loop stop does); a needs-attention row sends its persisted ENGINE
   *  session id (nothing live to stop, so its record is just dropped). Either
   *  way DashboardPanel re-broadcasts fresh data, so the row disappears on
   *  its own — no manual reload needed. */
  function cancel(sessionId: string) {
    vscode.postMessage({ type: 'cancelLoopSchedule', sessionId });
  }

  function togglePersistent(sessionId: string, persistent: boolean) {
    vscode.postMessage({ type: 'setLoopPersistent', sessionId, persistent });
  }

  /** Bring back the chat of a loop that has none — the accumulated runs are in
   *  that transcript, which is the only reason a persistent loop is worth
   *  having. Same two id spaces as cancel. The host detaches the headless
   *  client before opening the chat, so the engine session never has two. */
  function reopen(sessionId: string) {
    vscode.postMessage({ type: 'reopenLoopChat', sessionId });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'loopSchedulesData') {
      schedules = Array.isArray(msg.schedules) ? msg.schedules : [];
      needsAttention = Array.isArray(msg.needsAttention) ? msg.needsAttention : [];
      loaded = true;
    }
  });

  // Load on mount.
  refresh();
</script>

<div class="loops-pane">
  <div class="loops-toolbar">
    <input class="loops-filter" placeholder="Filter loops…" bind:value={query} aria-label="Filter loops" />
    <span class="loops-count">
      {#if query.trim()}{shownLive.length + shownAttn.length}/{total}{:else}{schedules.length} live loop{schedules.length === 1 ? '' : 's'}{/if}
    </span>
    <button class="loops-refresh" onclick={refresh} title="Reload loops">↻</button>
  </div>

  <div class="loops-note">
    A loop re-runs a prompt on an interval in this workspace — start one from a chat's composer
    with <code>/loop &lt;interval&gt; &lt;prompt&gt;</code>. Loops persist across a window reload:
    each one re-arms itself once its chat reconnects, with its next run always a full interval out
    — never a burst of missed runs just because the window was closed.
  </div>

  <!-- The one thing a loop is NOT. Marking a loop persistent buys it a closed
       CHAT, not a closed EDITOR, and the two are easy to conflate the moment a
       toggle labelled "Persistent" appears next to it. -->
  <div class="loops-limit">
    Even a <strong>persistent</strong> loop stops when VS Code closes — it only survives its chat
    being closed. For something that fires with the editor shut, use a <strong>Cron</strong>.
  </div>

  {#if !loaded}
    <div class="loops-empty">Loading loops…</div>
  {:else if state === 'empty'}
    <div class="loops-empty">
      No loops running right now. Start one from a chat's composer with
      <code>/loop &lt;interval&gt; &lt;prompt&gt;</code> — e.g.
      <code>/loop 30m check for newly failing tests</code>.
    </div>
  {:else if state === 'no-matches'}
    <!-- Distinct from "no loops": there ARE loops, this filter just hides them.
         Printing the empty state here would tell someone their scheduled work
         had stopped. -->
    <div class="loops-empty">
      No loop matches <strong>{query}</strong>. {total} loop{total === 1 ? '' : 's'} running —
      <button class="loops-clear" onclick={() => { query = ''; }}>clear the filter</button>.
    </div>
  {:else}
    <div class="loops-list">
      {#each shownLive as s (s.sessionId)}
        <LoopCard live={true} label={label(s)} loop={s} {now}
          ontoggle={() => togglePersistent(s.sessionId, !s.persistent)}
          onreopen={() => reopen(s.sessionId)}
          oncancel={() => cancel(s.sessionId)} />
      {/each}
      {#if shownAttn.length > 0}
        <div class="loops-attention-heading">Needs attention — chat could not be restored</div>
        {#each shownAttn as s (s.sessionId)}
          <LoopCard live={false} loop={s} {now}
            ontoggle={() => togglePersistent(s.sessionId, !s.persistent)}
            onreopen={() => reopen(s.sessionId)}
            oncancel={() => cancel(s.sessionId)} />
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .loops-pane { display: flex; flex-direction: column; height: 100%; color: var(--og-text); }
  .loops-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .loops-filter { flex: 1; min-width: 0; background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 7px; font-size: 11px; font-family: inherit; }
  .loops-count { flex-shrink: 0; font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .loops-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 13px; }
  .loops-refresh:hover { background: var(--og-btn-hover); }
  .loops-note {
    margin: 10px 12px 0; padding: 8px 10px; font-size: 11px; line-height: 1.5;
    color: var(--og-text-secondary); background: var(--og-surface);
    border: 1px solid var(--og-border); border-left: 3px solid var(--og-chat);
    border-radius: 4px; flex-shrink: 0;
  }
  .loops-limit {
    margin: 8px 12px 0; padding: 8px 10px; font-size: 11px; line-height: 1.5;
    color: var(--og-warning-text); background: var(--og-warning-soft);
    border: 1px solid var(--og-warning); border-radius: 4px; flex-shrink: 0;
  }
  .loops-note code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
  .loops-list { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .loops-attention-heading { margin-top: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--og-warning); }
  .loops-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .loops-empty code { font-family: var(--vscode-editor-font-family, monospace); font-style: normal; font-size: 10px; }
  .loops-clear { background: none; border: none; padding: 0; font: inherit; color: var(--og-chat); cursor: pointer; text-decoration: underline; }
</style>

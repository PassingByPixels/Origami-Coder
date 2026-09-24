<script lang="ts">
  // ChatFindAll.svelte — find's GLOBAL mode, drawn inside ChatFind's bar in place of the local
  // counter and arrows (t-ucnp7t). The engine searches the whole stored chat; a hit that is not
  // loaded yet is loaded first, with the older pages it needs, then landed on. The rules are
  // chatFindGlobal.ts's; this file owns the wire and the three bits of state.
  import { tick } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { tip } from '../../shared/warmTip';
  import { requestHistory, type ChatHistory } from '../panes/chatHistory';
  import { markScrollAnchor } from '../panes/chatScroll';
  import { findMatches, paintHighlights, revealMatch, stepIndex } from './chatFind';
  import { hitCount, openToolCard, pickJumpMatch, rowForHit, type GlobalHit } from './chatFindGlobal';

  // `revealFolded`: ChatFind.svelte's prop, passed through (leave Focus view; true = it did).
  let { sessionId, history, query, revealFolded }: { sessionId: string; history?: ChatHistory; query: string; revealFolded?: () => boolean } = $props();

  let hits = $state<GlobalHit[]>([]);
  let index = $state(0);
  let done = $state(true);
  let asked = $state(false);
  let note = $state('');
  let cursor: string | null = null;

  const scroller = () => document.querySelector<HTMLElement>(`.cell-messages[data-session-id="${sessionId}"]`);

  /** Ask the engine. `more` continues a search that stopped before the start of the chat. */
  function search(more?: string) {
    if (!more) { hits = []; index = 0; cursor = null; note = ''; }
    asked = !!query;
    done = !query;
    if (query) getVsCodeApi().postMessage({ type: 'historySearch', sessionId, query, ...(more ? { cursor: more } : {}) });
  }

  // A new query searches again, after the typing pauses.
  $effect(() => {
    void query;
    const timer = setTimeout(() => search(), 300);
    return () => clearTimeout(timer);
  });

  /** Land on a loaded hit (t-v5qrdz). Focus view folds tool and thought rows away, so for those it
   *  is left first; a collapsed tool card is opened; a closed thought block is opened by revealMatch.
   *  A hit still not found leaves Focus view and tries once more (a folded kind not named here). */
  async function landOn(hit: GlobalHit, retried = false) {
    const root = scroller();
    if (!root) return;
    if (!retried && hit.kind !== 'text' && revealFolded?.()) await tick();
    if (openToolCard(root, hit)) await tick();
    const all = findMatches(root, query);
    const at = pickJumpMatch(root, all, hit);
    if (at < 0 && !retried && revealFolded?.()) { await tick(); return landOn(hit, true); }
    if (at >= 0) revealMatch(all[at].startNode);
    paintHighlights(at >= 0 ? [all[at]] : [], 0);
    const target = at >= 0 ? all[at].startNode.parentElement : rowForHit(root, hit);
    target?.scrollIntoView?.({ block: 'center' });
    if (target) markScrollAnchor(root);
    if (at < 0) note = target ? 'The match is inside a collapsed block.' : 'Loaded, but not drawn as text here.';
  }

  /** Go to hit `i`, loading the pages that hold it first (wire_contract.md 5.5). */
  function jump(i: number) {
    const hit = hits[i];
    if (!hit) return;
    index = i;
    note = '';
    if (history?.loadedIds.includes(hit.messageId)) { void tick().then(() => landOn(hit)); return; }
    note = 'Loading older messages…';
    requestHistory(sessionId, { messageId: hit.messageId }, 'find', (res) => {
      note = !res.ok ? (history?.error || 'Could not load older messages.') : res.found === false ? 'That message is no longer in the chat.' : '';
      if (res.ok && res.found !== false) void tick().then(() => landOn(hit));
    });
  }

  /** Enter / the arrows. Past the last hit of an unfinished search, the engine is asked for more. */
  export function step(dir: 1 | -1) {
    if (!asked) { search(); return; }
    if (dir === 1 && index === hits.length - 1 && !done && cursor) { search(cursor); return; }
    jump(stepIndex(index, hits.length, dir));
  }

  $effect(() => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data || {};
      if (m.type !== 'historySearchResult' || m.sessionId !== sessionId || m.query !== query) return;
      const got: GlobalHit[] = Array.isArray(m.hits) ? m.hits : [];
      const from = m.append ? hits.length : 0;
      hits = m.append ? [...hits, ...got] : got;
      done = m.done !== false;
      cursor = typeof m.cursor === 'string' ? m.cursor : null;
      note = typeof m.error === 'string' ? m.error : '';
      if (got.length > 0) jump(from);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<span class="cf-count" aria-live="polite">{hitCount(index, hits, done, asked)}</span>
<button class="cf-btn" aria-label="Previous match" use:tip={'Previous match in the whole chat (Shift+Enter)'} onclick={() => step(-1)}>&uarr;</button>
<button class="cf-btn" aria-label="Next match" use:tip={'Next match in the whole chat (Enter)'} onclick={() => step(1)}>&darr;</button>
{#if note}<span class="cf-note" role="status">{note}</span>{/if}

<style>
  /* Same look as ChatFind's own counter and arrows: the two modes share one bar. */
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
  .cf-note { font-size: 11px; color: var(--og-text-muted); max-width: 180px; }
</style>

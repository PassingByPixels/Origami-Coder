<script lang="ts">
  // t-ttmo5w — the Connections label in the brand row, plus its Refresh button:
  // ask every provider again for its model list, so a model it just added shows
  // in the picker with no window reload. Its own component because
  // SidebarLauncher.svelte sits on its line cap; the label and its style moved
  // here with the button. Click only, no key binding. The host's answer
  // (`modelListsRefreshed`, src/dashboard/modelListRefresh.ts) arrives only after
  // the picker already holds the new list, so the spinner means "still asking".
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../shared/vscodeApi';
  import { tip } from '../shared/warmTip';

  const vscode = getVsCodeApi();
  /** A reply that never comes (the host died mid-refresh) must not spin forever.
   *  Longer than a full sweep: 64 ids, six at a time, 10 s per probe at worst. */
  const GIVE_UP_MS = 150_000;
  const DONE_SHOWN_MS = 2_500;

  let state = $state<'idle' | 'running' | 'done' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TITLES = {
    idle: 'Refresh model lists: ask every connection again for its models',
    running: 'Refreshing model lists…',
    done: 'Model lists refreshed',
    failed: 'Refresh did not reach every connection. Click to try again.',
  };

  function settle(next: 'idle' | 'done' | 'failed') {
    clearTimeout(timer);
    state = next;
    if (next === 'done') timer = setTimeout(() => (state = 'idle'), DONE_SHOWN_MS);
  }

  function refresh() {
    if (state === 'running') return;
    state = 'running';
    clearTimeout(timer);
    timer = setTimeout(() => settle('failed'), GIVE_UP_MS);
    vscode.postMessage({ type: 'refreshModelLists' });
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === 'modelListsRefreshed' && state === 'running') settle(ev.data.ok ? 'done' : 'failed');
    };
    window.addEventListener('message', onMsg);
    return () => { window.removeEventListener('message', onMsg); clearTimeout(timer); };
  });
</script>

<span class="connections-label">Connections</span>
<button
  class="refresh-btn"
  data-state={state}
  onclick={refresh}
  disabled={state === 'running'}
  aria-busy={state === 'running'}
  aria-label={TITLES[state]}
  use:tip={TITLES[state]}
>
  {#if state === 'done'}
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
  {:else if state === 'failed'}
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v6M8 12v1" /></svg>
  {:else}
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" /></svg>
  {/if}
</button>

<style>
  /* t-ru0p04 — Connections' .section-label, moved into the brand row: same
     letter-spacing/case/colour, no padding (the row's own gap spaces it). */
  .connections-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--og-text-muted);
  }
  .refresh-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: -5px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--og-text-muted);
    cursor: pointer;
    flex-shrink: 0;
  }
  .refresh-btn:hover:not(:disabled) { color: var(--og-text); background: var(--og-btn-hover); }
  .refresh-btn:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  .refresh-btn:disabled { cursor: progress; }
  .refresh-btn[data-state='done'] { color: var(--og-success); }
  .refresh-btn[data-state='failed'] { color: var(--og-error); }
  svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .refresh-btn[data-state='running'] svg { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .refresh-btn[data-state='running'] svg { animation: none; opacity: 0.5; } }
</style>

<script lang="ts">
  // t-sc093o: a chat another desk owns opens READ ONLY. ChatPane wraps its
  // composer in this gate. While the chat is in the nest index (every row the
  // host sends is a chat another desk writes, nestHub.ts), the composer is NOT
  // drawn: one line says "Read only · on <desk>" with Continue here in its
  // place, so nothing in this pane can send, interject or compact into it. The
  // engine refuses a prompt into it as well (L4a); this is the UI half.
  //
  // After Continue here takes the chat over, the next index has no row for it
  // and the composer comes back. A fork opens as its own chat.
  //
  // t-t7lfho: a chat this desk GAVE to another desk (`away` in the push, sent
  // the moment the release lands) shows "Continued on <desk> at <time>" with
  // View (pull the newest copy, stay read only) and Take back here (the same
  // nestContinue, run from this side). The composer is not drawn, so no prompt
  // can reach the engine's read-only refusal from this pane.
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../shared/vscodeApi';
  import { tip } from '../shared/WarmTooltip.svelte';
  import NestGlyph from '../shared/NestGlyph.svelte';
  import { continueTip, deskOf, parseNestIndex, type NestIndex } from './nestIndex';
  import { TAKE_BACK_TIP, awayLine, awayOf, viewTip } from './nestAway';

  let { sessionId, children }: { sessionId: string; children: Snippet } = $props();
  const vscode = getVsCodeApi();

  let index = $state<NestIndex>({ rows: [], desks: [] });
  let pending = $state(false);
  let error = $state('');

  const row = $derived(index.rows.find((r) => r.id === sessionId));
  const owner = $derived(row ? deskOf(index, row.owner) : undefined);
  const name = $derived(owner?.name || row?.deskName || row?.owner || '');
  const away = $derived(awayOf(index, sessionId));

  function ask(type: 'nestContinue' | 'nestOpenRead') {
    if (pending) return;
    pending = true;
    error = '';
    vscode.postMessage({ type, id: sessionId });
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type === 'origami/nestIndex') index = parseNestIndex(msg);
      else if ((msg.type === 'nestContinueResult' || msg.type === 'nestOpenReadResult') && msg.id === sessionId) {
        pending = false;
        error = typeof msg.error === 'string' ? msg.error : '';
      }
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'requestNestIndex' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

{#if away || row}
  <div class="nest-ro" class:away={!!away} role="status" data-session={sessionId}>
    <NestGlyph />
    <span class="nest-ro-text">{away ? awayLine(index, away) : `Read only · on ${name}`}</span>
    {#if error}<span class="nest-ro-err" role="alert" use:tip={error}>{error}</span>{/if}
    {#if away}<button class="nest-ro-btn" disabled={pending} onclick={() => ask('nestOpenRead')} use:tip={viewTip(index, away)}>View</button>{/if}
    <button class="nest-ro-btn" disabled={pending} onclick={() => ask('nestContinue')} use:tip={row ? continueTip(row, deskOf(index, row.desk), name) : TAKE_BACK_TIP}>{away ? 'Take back here' : 'Continue here'}</button>
  </div>
{:else}{@render children()}{/if}

<style>
  .nest-ro {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 30px;
    margin: 6px 10px 8px;
    padding: 0 6px 0 10px;
    border: 1px dashed var(--og-border);
    border-radius: 8px;
    background: var(--og-surface-alt);
    color: var(--og-text-secondary);
    font-size: 11.5px;
  }
  .nest-ro-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nest-ro-err { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--og-error-text); }
  .nest-ro-btn {
    flex: 0 0 auto;
    height: 22px;
    padding: 0 10px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-btn-bg);
    color: var(--og-btn-text);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .nest-ro-btn:hover:not(:disabled) { background: var(--og-btn-hover); }
  .nest-ro-btn:disabled { opacity: 0.6; cursor: default; }
  .nest-ro-btn:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
</style>

<script lang="ts">
  // t-t7lfho: the transcript's last row for a chat this desk gave to another
  // desk: "Continued on <desk> at <time>. ..." ChatPane mounts it after the
  // transcript; the buttons are on the bar in the composer's place
  // (NestReadOnlyGate.svelte). The record is the host's (src/dashboard/nestAway.ts,
  // in globalState), so a reload shows the block again. It only listens: the
  // gate in the same cell asks for the index.
  import { onMount } from 'svelte';
  import NestGlyph from '../shared/NestGlyph.svelte';
  import { parseNestIndex, type NestIndex } from './nestIndex';
  import { awayBlockText, awayOf } from './nestAway';

  let { sessionId }: { sessionId: string } = $props();

  let index = $state<NestIndex>({ rows: [], desks: [] });
  const away = $derived(awayOf(index, sessionId));

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type === 'origami/nestIndex') index = parseNestIndex(msg);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });
</script>

{#if away}
  <div class="nest-away-block" role="note" data-session={sessionId}>
    <NestGlyph />
    <span class="nest-away-text">{awayBlockText(index, away)}</span>
  </div>
{/if}

<style>
  .nest-away-block {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 12px 10px 6px;
    padding: 8px 10px;
    border: 1px dashed var(--og-border);
    border-radius: 8px;
    background: var(--og-surface-alt);
    color: var(--og-text-secondary);
    font-size: 12px;
    line-height: 1.45;
  }
  .nest-away-text { flex: 1 1 auto; min-width: 0; }
</style>

<script lang="ts">
  // t-rylyhm — the composer's cache badge, beside the Vision control.
  //
  // A STATUS GLYPH, not a control. There is nothing to pick: the cache is the
  // provider's and the reading is the engine's, so a click would have nothing
  // to open. It is a `<span>` rather than a disabled button for exactly that
  // reason — a greyed-out button reads as a thing that would work if only the
  // state were different.
  //
  // IT OWNS ITS OWN WIRE, the way WorktreeDot.svelte does, and for the same
  // reason: InputBar.svelte had one line of slack under its cap, and a badge
  // that carries its own message is a better leaf than one every surface
  // re-threads. The row already knows the session id, which is all the filter
  // needs.
  //
  // NOTHING RENDERS until a `cacheState` for this session arrives. Against a
  // host that never sends one the badge is simply absent: a neutral dot would
  // be a claim about somebody's cache that nobody made. There is also NO TIMER
  // here — cacheWarmState.ts says why the engine owns the expiry.
  import { onMount } from 'svelte';
  import { tip } from '../../shared/warmTip';
  import { cacheWarmView, type CacheWarmInput, type CacheWarmView } from './cacheWarmState';

  const { sessionId = '' }: { sessionId?: string } = $props();

  let last = $state<CacheWarmInput | undefined>(undefined);
  const view = $derived<CacheWarmView | undefined>(last ? cacheWarmView(last) : undefined);

  onMount(() => {
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data ?? {};
      if (msg.type !== 'cacheState' || msg.sessionId !== sessionId) return;
      last = { state: String(msg.state ?? ''), until: msg.until, ttlSeconds: msg.ttlSeconds };
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
</script>

{#if view}
  <span class="mode-btn cache-dot" class:warm={view.state === 'warm'} class:cold={view.state === 'cold'}
    data-testid="cache-warm-dot" data-state={view.state} use:tip={view.title}>
    <span class="cache-icon">{view.icon}</span>{view.label}
  </span>
{/if}

<style>
  /* `.mode-btn` for the row's rhythm — one height, one radius, one weight. The
     row's own `:global(.mode-btn)` rule paints the ground; only the glyph's
     colour is this file's, so the badge sits in the row rather than beside it. */
  .cache-dot {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    /* A read-out, not a control: no pointer, and nothing to press. */
    cursor: default;
  }
  .cache-icon {
    font-size: 9px;
    line-height: 1;
    /* Unmeasured. --og-text-secondary is the row's own resting ink, which is
       the right weight for "nothing is known". */
    color: var(--og-text-secondary);
  }
  /* The last request read the prefix back. */
  .cache-dot.warm .cache-icon { color: var(--og-success); }
  /* Cold is not an error — it is a cost. --og-warning, not --og-error. */
  .cache-dot.cold .cache-icon { color: var(--og-warning); }
</style>

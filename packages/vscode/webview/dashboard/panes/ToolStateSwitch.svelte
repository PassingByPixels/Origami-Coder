<script lang="ts">
  // The tool's THREE states, as one segmented control. Extracted from
  // ToolCard.svelte the moment the two-state switch became three: the card was
  // at 90/105 lines and a third state is markup plus a colour rule per segment,
  // which does not fit — the same extraction ToolCard itself came out of.
  //
  // WHY A SEGMENTED CONTROL AND NOT A CYCLING TOGGLE. A toggle shows you what
  // it is; it does not show you what else it could be. With two states that is
  // survivable (the label names the other one). With three, a user who wants
  // OFF cannot tell from a "Deferred" pill whether the next click reaches it or
  // goes back to Loaded. All three are drawn, always, and the current one is
  // filled — so the state and the options are the same glance.
  export type ToolState = 'loaded' | 'deferred' | 'off';

  const SEGMENTS: Array<{ value: ToolState; label: string }> = [
    { value: 'loaded', label: 'Loaded' },
    { value: 'deferred', label: 'Deferred' },
    { value: 'off', label: 'Off' },
  ];

  const HINT: Record<ToolState, string> = {
    loaded: 'Loaded — the full JSON Schema goes with every request.',
    deferred: 'Deferred — one catalog line until the model calls tool_search.',
    off: 'Off — not offered to the model at all, and not in the catalog either.',
  };

  let { id, state, locked = false, lockedReason = '', onpick }: {
    id: string;
    state: ToolState;
    /** No control at all: the row is not something config can change. */
    locked?: boolean;
    lockedReason?: string;
    onpick: (next: ToolState) => void;
  } = $props();
</script>

<div class="ts3" class:locked role="radiogroup" aria-label="{id} state">
  {#each SEGMENTS as seg (seg.value)}
    <button
      class="ts3-seg"
      class:loaded={seg.value === 'loaded'}
      class:deferred={seg.value === 'deferred'}
      class:off={seg.value === 'off'}
      class:on={state === seg.value}
      role="radio"
      aria-checked={state === seg.value}
      disabled={locked}
      title={locked ? lockedReason : HINT[seg.value]}
      onclick={() => { if (!locked && state !== seg.value) onpick(seg.value); }}
    >{seg.label}</button>
  {/each}
</div>

<style>
  .ts3 { display: inline-flex; border: 1px solid var(--og-border); border-radius: 4px; overflow: hidden; flex-shrink: 0; }
  .ts3-seg {
    background: var(--og-btn-bg); color: var(--og-text-muted); border: none; cursor: pointer;
    padding: 2px 7px; font-size: 9px; font-family: inherit; text-transform: uppercase; letter-spacing: 0.05em;
  }
  .ts3-seg + .ts3-seg { border-left: 1px solid var(--og-border); }
  .ts3-seg:hover:not(:disabled):not(.on) { background: var(--og-btn-hover); color: var(--og-text); }
  /* The ACTIVE segment is carried by fill AND weight AND position — the same
     rule the switch it replaced followed, so which state is set never depends
     on colour alone in any of the five themes. The three fills reuse the
     badge vocabulary already on this card (success / warning / error), so a
     tool reads the same whichever half of the card you look at. */
  .ts3-seg.on { font-weight: 700; }
  .ts3-seg.loaded.on { background: var(--og-success-soft); color: var(--og-success-text); }
  .ts3-seg.deferred.on { background: var(--og-warning-soft); color: var(--og-warning-text); }
  .ts3-seg.off.on { background: var(--og-error-soft); color: var(--og-error-text); }
  .ts3.locked { opacity: 0.45; }
  .ts3-seg:disabled { cursor: not-allowed; }
</style>

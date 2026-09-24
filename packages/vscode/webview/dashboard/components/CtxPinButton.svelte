<script lang="ts">
  // CtxPinButton.svelte — the control that holds the context breakdown card
  // open (t-ru13hb item 5).
  //
  // Its own control and NOT the gauge's click: that click already arms the
  // compaction fuse, and the card is drawn for exactly the engines whose gauge
  // offers it, so taking the click would leave them no compact button at all.
  // It rides inside `.ctx-gauge-wrap`, because reaching for anything outside
  // the wrap counts as leaving the gauge and would take the card away under
  // the pointer on the way to it.
  //
  // Its own file because InputBar.svelte is a capped file (the ratchet's rule).
  interface Props {
    pinned: boolean;
    onToggle: () => void;
  }
  let { pinned, onToggle }: Props = $props();
</script>

<button
  class="ctx-pin"
  type="button"
  aria-pressed={pinned}
  aria-label={pinned ? 'Unpin the context breakdown' : 'Pin the context breakdown open'}
  title={pinned ? 'Unpin the context breakdown' : 'Pin the context breakdown open'}
  onclick={(e) => { e.stopPropagation(); onToggle(); }}
>&#128204;</button>

<style>
  .ctx-pin {
    margin-left: 2px;
    padding: 0 2px;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 9px;
    line-height: 1;
    opacity: 0.75;
  }
  .ctx-pin:hover { color: var(--og-text); background: var(--og-btn-bg); opacity: 1; }
  .ctx-pin[aria-pressed='true'] { color: var(--og-accent); opacity: 1; }
  .ctx-pin:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
</style>

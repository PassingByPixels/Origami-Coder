<script lang="ts">
  // The scroll anchor: "this much arrived while you were reading", floating
  // just above the composer, clicking it takes you back to the bottom.
  //
  // It lives INSIDE the composer, not in the transcript: `.input-area` sits
  // BELOW the scroller in normal flow, so anchoring to the cell put the pill
  // under the input row. `bottom: calc(100% + 10px)` floats it directly above
  // the composer and follows it as the composer grows.
  //
  // RECTANGULAR, not a lozenge. Every other control on this row measures 3px
  // (mode row), 4px (model trigger) or 8px (Send), so a 999px pill was the one
  // fully-round thing in the composer.
  //
  // The label is the caller's (scrollAnchor.ts counts it off the message list);
  // an empty label means nothing is unseen and the pill does not render.
  import { tip } from '../../shared/warmTip';

  interface Props {
    /** "4 files · 2 tools · 5 messages", or '' for no pill. */
    label: string;
    onJump: () => void;
  }
  let { label, onJump }: Props = $props();
</script>

{#if label}
  <button class="anchor-pill" onclick={onJump}
    use:tip={'Jump to the newest message and follow the turn again'}>
    <span class="anchor-arrow" aria-hidden="true">&#8595;</span>
    <span class="anchor-label">{label}</span>
  </button>
{/if}

<style>
  .anchor-pill {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 10px);
    transform: translateX(-50%);
    z-index: 4;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font: inherit;
    font-size: 11px;
    border-radius: 8px;
    border: 1px solid var(--og-border);
    background: var(--og-surface);
    color: var(--og-text);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
    cursor: pointer;
    white-space: nowrap;
  }
  .anchor-pill:hover { border-color: var(--og-chat); }
  .anchor-arrow { color: var(--og-chat); }
  .anchor-label { font-variant-numeric: tabular-nums; }
</style>

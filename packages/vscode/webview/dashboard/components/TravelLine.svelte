<script lang="ts">
  // TravelLine — t-yyz5yk (Round 8 rules 1-2): the ThoughtLine's travelling
  // light on the bottom edge of a working row. Mount it only while the row
  // works, so a settled transcript runs no animation. The parent must be
  // `position: relative`. `color` is a CSS colour (default: the chat colour).
  let { color = 'var(--og-chat)' }: { color?: string } = $props();
</script>

<span class="og-travel" style="--travel-color: {color}" aria-hidden="true"></span>

<style>
  .og-travel {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    overflow: hidden;
    pointer-events: none;
  }
  .og-travel::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 34%;
    background: var(--travel-color);
    animation: og-travel 1.8s cubic-bezier(0.77, 0, 0.175, 1) infinite;
  }
  @keyframes og-travel { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) { .og-travel::after { animation: none; } }
</style>

<script lang="ts">
  // FuseOverlay.svelte — t-okz748: the burning-bar face of the context gauge's
  // fuse button, split out of InputBar.svelte (over its architecture-test line
  // cap once the fuse landed inline). Purely presentational: the parent owns
  // arm/cancel/burn (contextFuse.ts + InputBar's setTimeout, which is what
  // actually fires compaction) and just tells this component whether to show
  // the burning face and how long the visual burn should take.
  interface Props {
    /** FUSE_MS from contextFuse.ts — how long the CSS burn animation runs.
     *  Purely visual; the real fire-on-burnout timer lives in the parent. */
    fuseMs: number;
  }
  let { fuseMs }: Props = $props();
</script>

<span class="fuse-line" style="animation-duration: {fuseMs}ms"></span>
<span class="ctx-pct fuse-armed-label">compacting…</span>

<style>
  .fuse-armed-label { color: var(--og-warning, #f5a524) !important; }
  .fuse-line {
    position: absolute;
    left: 2px;
    right: 2px;
    bottom: -1px;
    height: 2px;
    border-radius: 1px;
    background: var(--og-warning, #f5a524);
    box-shadow: 0 0 4px color-mix(in srgb, var(--og-warning, #f5a524) 55%, transparent);
    transform-origin: left center;
    animation-name: fuse-burn;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
  }
  @keyframes fuse-burn {
    from { transform: scaleX(1); }
    to { transform: scaleX(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .fuse-line { animation: none; transform: scaleX(0.5); }
  }
</style>

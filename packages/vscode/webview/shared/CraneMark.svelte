<script lang="ts">
  // Shared Origami crane mark. The brand hero glyph, extracted from the
  // chat header so the same 7-polygon geometry (far/near wings, tail,
  // body x2, neck, head+beak) + its gentle drift/rotate animation is used
  // EVERYWHERE the crane appears — the chat header and the empty-state —
  // without duplicating the SVG. `color` is inherited from the parent via
  // currentColor; callers set it to var(--og-crane) so the mark carries
  // each theme's signature colour (green/blue/bronze/navy).

  interface Props {
    /** Rendered width/height in px. */
    size?: number;
  }
  let { size = 18 }: Props = $props();
</script>

<svg
  class="crane-mark"
  viewBox="0 0 64 64"
  width={size}
  height={size}
  aria-hidden="true"
>
  <g fill="currentColor">
    <animateTransform attributeName="transform" type="translate" values="0 0; 0 -2; 0 0" keyTimes="0;0.5;1" dur="4.5s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"/>
    <g opacity="0.45">
      <animateTransform attributeName="transform" type="rotate" values="0 36 40; 7 36 40; 0 36 40" keyTimes="0;0.5;1" dur="3.2s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"/>
      <polygon points="30,40 47,40 52,11"/>
    </g>
    <g>
      <animateTransform attributeName="transform" type="rotate" values="0 34 40; -12 34 40; 0 34 40" keyTimes="0;0.5;1" dur="3.2s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"/>
      <polygon points="26,40 48,40 43,7" opacity="0.92"/>
    </g>
    <polygon points="44,40 62,29 47,48" opacity="0.72"/>
    <polygon points="28,39 48,41 36,55"/>
    <polygon points="21,44 28,39 36,55" opacity="0.7"/>
    <polygon points="9,12 15,13 28,41 22,44" opacity="0.85"/>
    <polygon points="9,12 15,13 14,19 2,17"/>
  </g>
</svg>

<style>
  .crane-mark {
    flex-shrink: 0;
    display: block;
  }
</style>

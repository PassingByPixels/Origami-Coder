<script lang="ts">
  // The nest glyph as a component (t-sc093o): the sidebar's Nest segment and
  // the read-only bar draw this; the rail draws the same string. One source.
  import { NESTS_ICON } from './nestGlyph';
  let { size = 13 }: { size?: number } = $props();
</script>

<svg class="nest-glyph" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{@html NESTS_ICON}</svg>

<style>
  .nest-glyph { flex: 0 0 auto; }
</style>

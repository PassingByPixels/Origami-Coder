<script lang="ts">
  // ToolIcon — t-yyz5yk (Round 8, rule 3): the row's line icon. The path set
  // and the choice live in toolIcon.ts; this only draws it with the theme's
  // `currentColor`, so a running row can tint it without a second asset.
  import { ICON_PATHS, type IconName } from './toolIcon';
  interface Props { name: IconName; size?: number; }
  let { name, size = 14 }: Props = $props();
</script>

<svg class="og-tool-icon" data-icon={name} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
  <!-- Static path data from toolIcon.ts, never user text. -->
  {@html ICON_PATHS[name]}
</svg>

<style>
  .og-tool-icon {
    display: block;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>

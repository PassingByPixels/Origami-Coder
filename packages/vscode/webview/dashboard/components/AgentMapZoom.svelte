<script lang="ts">
  // AgentMapZoom.svelte — the agent map head's zoom group (t-z1xlfy):
  // − / the zoom in percent / + / Fit / 1:1. The maths is agentMapLayout.ts's.
  import { tip } from '../../shared/warmTip';

  let { zoom, onZoom }: { zoom: number; onZoom: (to: 'out' | 'in' | 'fit' | 'one') => void } = $props();
</script>

<span class="am-zoom">
  <button type="button" aria-label="Zoom out" use:tip={'Zoom out (Ctrl + wheel)'} onclick={() => onZoom('out')}>&minus;</button>
  <span class="am-zv">{Math.round(zoom * 100)}%</span>
  <button type="button" aria-label="Zoom in" use:tip={'Zoom in (Ctrl + wheel)'} onclick={() => onZoom('in')}>+</button>
  <button type="button" use:tip={'Zoom to fit'} onclick={() => onZoom('fit')}>Fit</button>
  <button type="button" use:tip={'Actual size'} onclick={() => onZoom('one')}>1:1</button>
</span>

<style>
  .am-zoom { display: inline-flex; align-items: center; gap: 2px; }
  .am-zoom button {
    min-width: 22px; height: 22px; padding: 0 5px; border: 0; border-radius: 6px;
    background: transparent; color: var(--og-text-muted); font: inherit; font-size: 11px; cursor: pointer;
  }
  .am-zoom button:hover { background: var(--og-bg); color: var(--og-text); }
  .am-zv { min-width: 38px; text-align: center; font-size: 10.5px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
</style>

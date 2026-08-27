<script lang="ts">
  // The map panel's toolbar: the threshold filter, the three layouts, the two
  // view switches (fit-to-width, and whether the inspector column is on screen
  // at all) and Export. Extracted from LabyrinthPane.svelte, which was at its
  // architecture cap when the fit and collapse controls landed.
  //
  // Presentation only — every control reports up, so the pane still owns all
  // of the state and there is one place that decides what any of it means.
  // Colours are theme vars ONLY.
  import type { MapMode } from './labyrinthLayout';
  import { wantsBack } from './labyrinthNav';

  const MODES: Array<{ id: MapMode; label: string; title: string }> = [
    { id: 'thread', label: 'Thread', title: 'Vertical spine, one marker per step in run order' },
    { id: 'corridor', label: 'Corridor', title: 'Minimap — the whole run at once, each row reversing, sub-agents as inset chambers' },
    { id: 'flight', label: 'Flight', title: 'Horizontal strip, markers placed by timestamp' },
  ];

  let {
    mode, thresholdsOnly, fit, inspectOpen, canExport, depth = 0,
    onMode, onThresholds, onFit, onInspect, onExport, onBack,
  }: {
    mode: MapMode;
    thresholdsOnly: boolean;
    fit: boolean;
    inspectOpen: boolean;
    canExport: boolean;
    /** Click-throughs deep; 0 = a run from the index, with no BACK to offer. */
    depth?: number;
    onMode: (m: MapMode) => void;
    onThresholds: (on: boolean) => void;
    onFit: (on: boolean) => void;
    onInspect: (open: boolean) => void;
    onExport: () => void;
    onBack?: () => void;
  } = $props();

  // Escape is the back control's keyboard twin, bound HERE because the control
  // is. What it must NOT do is move the reader somewhere they did not ask for,
  // which is `wantsBack`'s whole job (depth 0, and any field holding the key).
  $effect(() => {
    const onKey = (e: KeyboardEvent) => { if (wantsBack(e.target, e.key, depth)) onBack?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<div class="lab-map-head">
  <!-- Only while there is somewhere to go back TO: a control that is always on screen and inert most of the time teaches the reader to ignore it. -->
  {#if depth > 0}
    <button class="lab-back" onclick={() => onBack?.()} title="Back to the run you came from, with the step you had open — Escape does the same">&larr; Back</button>
  {/if}
  <span class="lab-map-title">Labyrinth map</span>
  <label class="lab-check" title="Show only boundary events — steps this run failed on">
    <input type="checkbox" checked={thresholdsOnly} onchange={(e) => onThresholds((e.currentTarget as HTMLInputElement).checked)} /> Thresholds only
  </label>
  <div class="lab-modes">
    {#each MODES as m (m.id)}
      <button class="lab-mode" class:active={mode === m.id} title={m.title} onclick={() => onMode(m.id)}>{m.label}</button>
    {/each}
  </div>
  <button class="lab-toggle" class:active={fit} onclick={() => onFit(!fit)}
    title="Scale the whole map into the panel width instead of scrolling it sideways">Fit</button>
  <button class="lab-toggle" class:active={inspectOpen} onclick={() => onInspect(!inspectOpen)}
    title="Show or hide the inspector column — hiding it gives the map the whole panel">Inspector</button>
  <button class="lab-export" disabled={!canExport} onclick={onExport}
    title="Save the map as it is drawn here, as a self-contained HTML page with a table of every step">Export</button>
</div>

<style>
  .lab-map-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .lab-map-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-secondary); flex: 1; }
  .lab-modes { display: flex; gap: 4px; }
  .lab-mode, .lab-toggle, .lab-export, .lab-back { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text-secondary); border-radius: 4px; padding: 2px 9px; font-size: 10px; cursor: pointer; font-family: inherit; }
  .lab-mode:hover, .lab-toggle:hover, .lab-export:enabled:hover, .lab-back:hover { color: var(--og-text); }
  /* The one control on this row that CHANGES which run is open, so it is the
     one that carries the accent seam — the others only change how it is drawn. */
  .lab-back { border-color: var(--og-accent); white-space: nowrap; }
  .lab-mode.active, .lab-toggle.active { background: var(--og-accent); color: var(--og-text); border-color: var(--og-accent); }
  /* Offered but inert with no map on screen, rather than appearing and
     vanishing as runs are picked — the toolbar's shape stays still. */
  .lab-export:disabled { opacity: 0.4; cursor: default; }
  .lab-check { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--og-text-secondary); cursor: pointer; white-space: nowrap; }
</style>

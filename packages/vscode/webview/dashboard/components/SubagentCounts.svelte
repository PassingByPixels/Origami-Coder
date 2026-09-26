<script lang="ts">
  // SubagentCounts.svelte — the pull-out head's three dot counts: running /
  // done / failed (t-yyz57i, redesign R3). The running dot pulses only while
  // something runs; at zero it is a hollow ring.
  import { stateCounts } from '../panes/subagentCard';
  import { tip } from '../../shared/warmTip';
  import type { SubagentRow } from '../panes/subagentRows';

  let { rows }: { rows: SubagentRow[] } = $props();
  const counts = $derived(stateCounts(rows));
</script>

<!-- The word is in the text for screen readers (and tests), hidden on screen. -->
<span class="sa-cnt" use:tip={'Running'}><i class="sa-cd sa-cd-run" class:sa-cd-live={counts.running > 0}></i>{counts.running}<span class="sa-sr">{' running'}</span></span>
<span class="sa-cnt" use:tip={'Done'}><i class="sa-cd sa-cd-done"></i>{counts.done}<span class="sa-sr">{' done'}</span></span>
<span class="sa-cnt" use:tip={'Failed'}><i class="sa-cd sa-cd-fail"></i>{counts.failed}<span class="sa-sr">{' failed'}</span></span>

<style>
  .sa-cnt { display: inline-flex; align-items: center; gap: 3px; font-size: 9.5px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .sa-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .sa-cd { width: 6px; height: 6px; border-radius: 50%; background: var(--og-text-muted); }
  .sa-cd-run { background: transparent; box-shadow: inset 0 0 0 1.5px var(--og-text-muted); }
  .sa-cd-run.sa-cd-live { background: var(--og-chat); box-shadow: none; animation: sa-cd-pulse 1.4s infinite; }
  .sa-cd-done { background: var(--og-success); }
  .sa-cd-fail { background: var(--og-error); }
  @keyframes sa-cd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>

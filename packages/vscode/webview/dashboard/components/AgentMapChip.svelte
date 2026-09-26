<script lang="ts">
  // AgentMapChip.svelte — ONE background task on the agent map (t-z1xlfy): a
  // dashed chip after its owner's sub-agents. A STEADY dot, never a pulse: a
  // long-lived shell is not "now". While it runs its end shows a ticking age;
  // after, why it stopped ("stopped with T5", "ended", "failed").
  // Its height is agentMapLayout.ts CHIP_H: the layout places it without measuring.
  import { tip } from '../../shared/warmTip';
  import type { TreeTask } from '../panes/agentTree';

  let { task, ownerName, end, dim = false }: { task: TreeTask; ownerName: string; end: string; dim?: boolean } = $props();
</script>

<div class="am-chip" class:am-dim={dim} data-s={task.status === 'running' ? 'run' : 'done'} data-k={task.key} use:tip={`Background shell started by ${ownerName}`}>
  <i class="am-cd"></i>
  <svg class="am-bgi" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6l5 5-5 5" /><path d="M12 18h8" /></svg>
  <span class="am-tt" use:tip={task.title}>{task.title || 'background shell'}</span>
  <span class="am-own">shell · {ownerName}</span>
  <span class="am-bt">{end}</span>
</div>

<style>
  .am-chip {
    box-sizing: border-box; height: 100%;
    display: grid; grid-template-columns: 8px 14px minmax(0, 1fr) auto; grid-template-rows: auto auto;
    column-gap: 7px; align-items: center; padding: 5px 8px;
    border: 1px dashed var(--og-border); border-radius: 7px;
    background: color-mix(in srgb, var(--og-bg) 70%, transparent);
    font-size: 11.5px; transition: border-color 120ms ease, opacity 200ms ease;
  }
  .am-chip:hover { border-color: var(--og-text-muted); }
  .am-chip[data-s='done'] { opacity: 0.6; }
  .am-dim { opacity: 0.45; }
  .am-cd { width: 6px; height: 6px; border-radius: 50%; background: var(--og-text-muted); }
  .am-chip[data-s='run'] .am-cd { background: var(--og-chat); }
  .am-bgi { width: 12px; height: 12px; fill: none; stroke: var(--og-text-muted); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .am-chip[data-s='run'] .am-bgi { stroke: var(--og-chat); }
  .am-tt { color: var(--og-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .am-own { grid-column: 3; grid-row: 2; font-size: 10px; color: var(--og-text-muted); }
  .am-bt { grid-column: 4; grid-row: 1 / span 2; font-size: 10.5px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) { .am-chip { transition: none; } }
</style>

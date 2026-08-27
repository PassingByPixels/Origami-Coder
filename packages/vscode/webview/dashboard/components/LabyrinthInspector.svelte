<script lang="ts">
  // Inspector for one selected step. Every row is gated on the field actually
  // being present: `RunStep` marks status/duration/tokens/model/agent/preview
  // optional and the engine omits them freely, so an ungated row would print
  // "undefined" or — worse — a fabricated 0 that reads as a measurement.
  import { formatDuration, formatClock, spanIsOpen, spanBackground, stepUsageText, type LayoutStep } from './labyrinthLayout';

  let { step }: { step: LayoutStep | null } = $props();

  let duration = $derived(step ? formatDuration(step.durationMs) : undefined);
  let started = $derived(step ? formatClock(step.startedAt) : undefined);
  // Tri-state: true / false / undefined = the engine did not say. Absent must
  // print NO row at all — it does not mean "foreground" (see labyrinthSpans.ts).
  let detached = $derived(step ? spanBackground(step) : undefined);
  // Departed and never merged: the sub-agent had not reported back. The map
  // says this with an open rail; it is spelled out here so it is unmissable.
  let unreturned = $derived(step ? spanIsOpen(step) : false);
</script>

<div class="lab-inspector">
  {#if !step}
    <div class="ins-idle">Select a step on the map to inspect it.</div>
  {:else}
    <div class="ins-head">
      <span class="ins-kind">{step.kind}</span>
      <span class="ins-ord">#{step.ordinal}</span>
    </div>
    <div class="ins-title">{step.title}</div>

    <div class="ins-label">Tool</div>
    <div class="ins-value">{step.tool ?? '—'}</div>

    {#if step.status}
      <div class="ins-label">Status</div>
      <div class="ins-value"><span class="ins-pill status-{step.status}">{step.status}</span></div>
    {/if}
    {#if detached !== undefined}
      <div class="ins-label">Delegation</div>
      <div class="ins-value">
        {detached ? 'Background — ran alongside the conversation' : 'Blocking — the conversation waited for it'}
      </div>
    {/if}
    {#if unreturned}
      <div class="ins-label">Returned</div>
      <div class="ins-value ins-open">Not yet — this sub-agent had not reported back when the run was captured.</div>
    {/if}
    {#if started}
      <div class="ins-label">Started</div>
      <div class="ins-value">{started}</div>
    {/if}
    {#if duration}
      <div class="ins-label">Duration</div>
      <div class="ins-value">{duration}</div>
    {/if}
    {#if stepUsageText(step)}
      <div class="ins-label">Tokens</div>
      <div class="ins-value">{stepUsageText(step)}</div>
    {/if}
    {#if step.model}
      <div class="ins-label">Model</div>
      <div class="ins-value">{step.model}</div>
    {/if}
    {#if step.agent}
      <div class="ins-label">Agent</div>
      <div class="ins-value">{step.agent}</div>
    {/if}
    {#if step.preview}
      <div class="ins-label">Preview</div>
      <div class="ins-value ins-pre">{step.preview}</div>
    {/if}
    {#if step.error}
      <div class="ins-label">Error</div>
      <div class="ins-value ins-error">{step.error}</div>
    {/if}
  {/if}
</div>

<style>
  .lab-inspector { padding: 10px 12px; overflow-y: auto; height: 100%; color: var(--og-text); }
  .ins-idle { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 16px 0; line-height: 1.6; }
  .ins-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .ins-kind { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-chat); }
  .ins-ord { font-size: 10px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .ins-title { font-size: 12px; font-weight: 600; margin: 3px 0 10px; line-height: 1.4; word-break: break-word; }
  .ins-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); margin-top: 9px; }
  .ins-value { font-size: 11px; color: var(--og-text-secondary); margin-top: 2px; word-break: break-word; font-variant-numeric: tabular-nums; }
  .ins-pill { font-size: 9px; padding: 1px 6px; border-radius: 8px; background: var(--og-btn-bg); color: var(--og-text-secondary); }
  .status-completed { background: var(--og-success-soft); color: var(--og-success); }
  .status-error { background: var(--og-error-soft); color: var(--og-error); }
  .status-running { background: var(--og-warning-soft); color: var(--og-warning); }
  .ins-pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; line-height: 1.5; white-space: pre-wrap; background: var(--og-surface-alt); border: 1px solid var(--og-border); border-radius: 4px; padding: 6px 7px; max-height: 220px; overflow-y: auto; }
  .ins-error { color: var(--og-error); }
  .ins-open { color: var(--og-warning); }
</style>

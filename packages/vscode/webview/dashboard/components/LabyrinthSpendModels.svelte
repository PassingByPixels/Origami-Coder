<script lang="ts">
  // WHICH MODELS ACTUALLY RAN — not which one is selected now.
  //
  // The session record carries ONE `model` field and it is the CURRENT
  // selection. A run that switched provider part-way through billed at two
  // rates, and a run reviewed months later is read under whatever model the
  // chat happens to be set to today. Presenting either as "what ran" is the
  // same class of error as printing a raw token count as the cost, so this row
  // reads the per-request model the engine already records on every message.
  //
  // Extracted from LabyrinthUsageStrip.svelte, which was near its architecture
  // cap once the real-cost headline landed. Presentation only — the counting
  // lives in labyrinthCost.ts. Colours are theme vars ONLY.
  import { modelCutovers, type ModelUsage } from './labyrinthCost';
  import { formatTokenCount, type UsageStep } from './labyrinthUsage';

  let { steps, models }: { steps: readonly UsageStep[]; models: readonly ModelUsage[] } = $props();

  let cutovers = $derived(modelCutovers(steps));
  // A single `unknown` bucket is an OLD payload that never recorded a model.
  // Printing "unknown x12" would be a row that answers nothing.
  let shown = $derived(models.length > 1 || (models.length === 1 && models[0]!.model !== 'unknown'));
  let switches = $derived(
    cutovers.map((c) => `${c.from} -> ${c.to} at step ${c.at.toLocaleString()}`).join('\n'),
  );
</script>

{#if shown}
  <div class="spend-models">
    <span class="models-label">Models used</span>
    {#each models as m (m.model)}
      <span class="model-chip" title={`${m.requests.toLocaleString()} request${m.requests === 1 ? '' : 's'} on this model`}>
        {m.model} <b>&times;{m.requests.toLocaleString()}</b>
        {#if formatTokenCount(m.total.tokens)}<i>{formatTokenCount(m.total.tokens)}</i>{/if}
      </span>
    {/each}
    <!-- The CUTOVERS are the part a list of models cannot say: where the run
         changed hands. Each one names both sides and the step it happened at. -->
    {#if cutovers.length > 0}
      <span class="model-switch" title={switches}>
        ⇄ {cutovers.length} switch{cutovers.length === 1 ? '' : 'es'}
      </span>
    {/if}
  </div>
{/if}

<style>
  .spend-models { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; margin-top: 5px; }
  .models-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-muted); }
  .model-chip { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--og-btn-bg); color: var(--og-text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .model-chip b { color: var(--og-text); font-weight: 600; }
  .model-chip i { color: var(--og-text-muted); font-style: normal; margin-left: 4px; }
  /* A switch is a WARNING-toned fact, not a failure: the run's cost cannot be
     read off one model's rates once this appears. */
  .model-switch { font-size: 10px; color: var(--og-warning); white-space: nowrap; }
</style>

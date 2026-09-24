<script lang="ts">
  // THE PROMPT CACHE — DERIVED, entirely from the run's own recorded numbers:
  // cache read and write per turn, the hit ratio over those turns, and every
  // point where a fresh prefill was billed. From 0.4.160 the ENGINE records why
  // (`step.cache.cause`) and this panel reads that verbatim, with a facts line
  // underneath (idle gap, where an already-sent message diverged, a warm that
  // landed first). A run recorded before the field existed falls back to the
  // viewer's own four-rule guess, labelled as exactly that — never presented as
  // what the engine said. Where the PROVIDER never reported a cache at all the
  // panel says THAT instead — a provider that never looked is not a provider
  // that lost, and 0% would read as the second. The old hard-coded per-provider
  // policy table is gone (t-rylq3t): it was the viewer's own guess at a fact the
  // engine now sends. Colours are theme vars ONLY.
  import { cacheBlindness, cacheIsMeasured, cacheTurns, cacheLosses, lossReasonText, lossFactsText } from './labyrinthCache';
  import { formatClock } from './labyrinthFormat';
  import { formatPercent } from './labyrinthCost';
  import { formatTokenCount, type UsageStep } from './labyrinthUsage';
  import LabyrinthStatPills, { type StatCell } from './LabyrinthStatPills.svelte';

  let { steps, onSelect, claudeRun = false }: {
    steps: readonly UsageStep[];
    /** Open a loss point's own step in the inspector. */
    onSelect: (ordinal: number) => void;
    /** This run is a Claude Code transcript — no engine ever attaches a
     *  cause to its steps, so a loss reads as that, never a legacy guess. */
    claudeRun?: boolean;
  } = $props();

  let measured = $derived(cacheIsMeasured(steps));
  let blind = $derived(cacheBlindness(steps));
  let unreported = $derived(blind.providers.join(', '));
  let turns = $derived(cacheTurns(steps));
  let losses = $derived(cacheLosses(steps, claudeRun));
  let read = $derived(turns.reduce((n, t) => n + t.read, 0));
  let write = $derived(turns.reduce((n, t) => n + t.write, 0));
  let input = $derived(turns.reduce((n, t) => n + t.input, 0));
  let overall = $derived(read + input > 0 ? read / (read + input) : undefined);
  /** The same cells the run-spend row uses, so this panel reads as part of it. */
  let cells = $derived([
    { key: 'read', value: formatTokenCount(read) ?? '0', label: 'cache read' },
    { key: 'write', value: formatTokenCount(write) ?? '0', label: 'cache write' },
    // ONE place says the provider never reported: a percentage over turns
    // nobody measured is a number about nothing, so it is not printed at all
    // when every billed request in the run came from such a provider.
    { key: 'hit', value: blind.all ? 'not reported' : formatPercent(overall) ?? '—',
      label: blind.providers.length ? `hit rate — not reported by ${unreported}` : 'hit rate', tone: 'strong' },
    { key: 'lost', value: String(losses.length), label: losses.length === 1 ? 'cache loss' : 'cache losses', ...(losses.length ? { tone: 'warn' as const } : {}) },
  ] as StatCell[]);
</script>

<div class="fl-cache">
  <section class="fl-panel">
    <div class="fl-panel-head">Cache in this run</div>
    {#if !measured}
      <!-- 0% would read as "caching is broken here"; the truth is nobody measured. -->
      <div class="fl-none">This run’s provider reported no cache tokens, so none of the figures below can be derived. That is missing measurement, not a cold cache.</div>
    {:else}
      <LabyrinthStatPills {cells} />
      <div class="fl-turns">
        {#each turns as t (t.ordinal)}
          <!-- A blind turn keeps its row and its width: it really did bill that
               prefill. What it loses is the CLAIM that the prefill was fresh. -->
          <div class="fl-turn-row" class:blind={t.blind}>
            <span class="fl-turn-name" title={t.title}>{t.ordinal < 0 ? 'pre-turn' : `#${t.ordinal}`}</span>
            <span class="fl-turn-track">
              <span class="fl-turn-fill" data-turn={t.ordinal} style="width: {(t.ratio ?? 0) * 100}%;"></span>
            </span>
            <span class="fl-turn-pct">{formatPercent(t.ratio) ?? '—'}</span>
            <span class="fl-turn-tok">{t.blind ? 'not reported' : `${formatTokenCount(t.read) ?? '0'} r · ${formatTokenCount(t.write) ?? '0'} w`}</span>
          </div>
        {/each}
      </div>

      <div class="fl-panel-head fl-sub">Where the cache was lost</div>
      {#if losses.length === 0}
        <div class="fl-none">Every billed prefill in this run read from cache.</div>
      {:else}
        <ul class="fl-losses">
          {#each losses as loss (loss.ordinal)}
            <li>
              <button class="fl-loss-btn" data-loss={loss.ordinal} onclick={() => onSelect(loss.ordinal)}>
                <span class="fl-loss-at">#{loss.ordinal}{formatClock(loss.startedAt) ? ` · ${formatClock(loss.startedAt)}` : ''}</span>
                <span class="fl-loss-why">{lossReasonText(loss)}</span>
                {#if lossFactsText(loss)}
                  <span class="fl-loss-facts">{lossFactsText(loss)}</span>
                {/if}
                <span class="fl-loss-cost">{formatTokenCount(loss.input) ?? '0'} fresh input</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
</div>

<style>
  .fl-cache { flex: 0 0 auto; display: grid; grid-template-columns: 1fr; gap: 14px; margin-top: 14px; }
  .fl-panel { display: flex; flex-direction: column; min-width: 0; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 10px 12px; }
  .fl-panel-head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; margin-bottom: 8px; }
  .fl-sub { margin-top: 12px; }
  .fl-none { font-size: 11px; line-height: 1.5; color: var(--og-text-muted); font-style: italic; }
  .fl-turns { margin-top: 10px; display: flex; flex-direction: column; gap: 5px; }
  .fl-turn-row { display: grid; grid-template-columns: 46px 1fr 34px auto; align-items: center; gap: 8px; font-size: 10.5px; color: var(--og-text-secondary); font-variant-numeric: tabular-nums; }
  .fl-turn-name { color: var(--og-text-muted); overflow: hidden; text-overflow: ellipsis; }
  .fl-turn-track { display: block; height: 6px; background: var(--og-surface-alt); border-radius: 3px; overflow: hidden; }
  .fl-turn-fill { display: block; height: 100%; border-radius: 3px; background: var(--og-chat); }
  .fl-turn-pct { text-align: right; }
  .fl-turn-tok { color: var(--og-text-muted); white-space: nowrap; }
  /* Muted, not hidden: the turn happened and cost what it cost. */
  .fl-turn-row.blind { opacity: 0.6; }
  .fl-turn-row.blind .fl-turn-tok { font-style: italic; }
  .fl-losses { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .fl-loss-btn { display: block; width: 100%; text-align: left; background: none; border: none; border-left: 2px solid var(--og-warning); padding: 3px 0 3px 7px; cursor: pointer; font-family: inherit; }
  .fl-loss-at { display: block; font-size: 10px; color: var(--og-warning); font-variant-numeric: tabular-nums; }
  .fl-loss-why { display: block; font-size: 10.5px; line-height: 1.45; color: var(--og-text-secondary); }
  .fl-loss-facts { display: block; font-size: 10px; line-height: 1.4; color: var(--og-text-muted); font-style: italic; }
  .fl-loss-cost { display: block; font-size: 10px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
</style>

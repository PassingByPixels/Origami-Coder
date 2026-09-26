<script lang="ts">
  // EngineTimeline.svelte — t-xq22sx: Settings › Engines draws one example chat
  // after you leave it, as a Gantt-like chart scaled to the current values.
  // Times come from lib/engineTimeline.ts (one rule set with its test). Two
  // lanes: a provider that publishes a cache life (Anthropic) and one that
  // does not (vLLM, LM Studio, DeepSeek, OpenRouter) — they differ only in
  // when the engine stops. Static drawing; the only motion is a width
  // transition, off under prefers-reduced-motion.
  import { engineTimeline, type EngineTimelineInput } from '../lib/engineTimeline';

  let { settings }: { settings: EngineTimelineInput } = $props();
  const t = $derived(engineTimeline(settings));

  /** Share of the bar for the "Active" part before you leave (t < 0). */
  const LEAD = 12;
  const x = (min: number): number => LEAD + (min / t.span) * (100 - LEAD);
  const fmt = (min: number): string => (min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`);

  type Seg = { cls: string; label: string; from: number; to: number };
  function segs(parkAt: number | null): Seg[] {
    if (t.idleAt === null) return [{ cls: 'active', label: 'Active', from: 0, to: 100 }];
    const end = parkAt ?? t.span;
    const out: Seg[] = [
      { cls: 'active', label: 'Active', from: 0, to: LEAD },
      { cls: 'background', label: 'Background', from: x(0), to: x(t.idleAt) },
      { cls: 'idle', label: 'Idle', from: x(t.idleAt), to: x(end) },
    ];
    if (parkAt !== null) out.push({ cls: 'parked', label: 'Parked', from: x(parkAt), to: 100 });
    return out;
  }
  const lanes = $derived([
    { name: 'Provider with a cache life', ex: 'Anthropic', parkAt: t.parkTimedAt, key: 'timed' },
    { name: 'No published cache life', ex: 'vLLM, LM Studio, DeepSeek, OpenRouter', parkAt: t.parkUntimedAt, key: 'untimed' },
  ]);
  const summary = $derived(t.idleAt === null ? 'Elastic engines is off: no engine changes state.' : `After you leave a chat: background at once, idle after ${fmt(t.idleAt)}, memory trim at ${fmt(t.trimAt ?? 0)}, ` + (t.parkTimedAt === null ? 'never parked.' : `parked after ${fmt(t.parkTimedAt)} with a cache-life provider, ${fmt(t.parkUntimedAt ?? 0)} without one; a park does not clear the provider cache.`));
  const trims = $derived(t.trimAt === null ? [] : [t.trimAt, ...t.retrims]);
</script>

<div class="etl" role="img" aria-label={summary}>
  <div class="etl-head">What happens to a chat’s engine after you leave the chat</div>
  {#each lanes as lane (lane.key)}
    <div class="etl-lane" data-lane={lane.key}>
      <div class="etl-name">{lane.name} <span class="etl-ex">({lane.ex})</span></div>
      <div class="etl-bar">
        {#each segs(lane.parkAt) as s (s.cls)}
          <div class="etl-seg etl-{s.cls}" data-seg={s.cls} style:left="{s.from}%" style:width="{Math.max(s.to - s.from, 0)}%">
            <span class="etl-seg-label">{s.label}</span>
          </div>
        {/each}
        {#each trims.filter((m) => lane.parkAt === null || m < lane.parkAt) as m, i (i)}
          <div class="etl-trim" data-trim={m} style:left="{x(m)}%"></div>
        {/each}
        {#each lane.key === 'timed' ? t.warmBlips : [] as m (m)}
          <div class="etl-warm" data-warm={m} style:left="{x(m)}%"></div>
        {/each}
      </div>
    </div>
  {/each}
  <div class="etl-axis">
    {#if t.idleAt !== null}
      <span class="etl-tick" style:left="{x(0)}%">you leave</span>
      {#if t.idleAt > 0}<span class="etl-tick" style:left="{x(t.idleAt)}%">{fmt(t.idleAt)}</span>{/if}
      {#if t.parkTimedAt !== null}<span class="etl-tick" style:left="{x(t.parkTimedAt)}%">{fmt(t.parkTimedAt)}</span>{/if}
      {#if t.parkUntimedAt !== null && t.parkUntimedAt !== t.parkTimedAt}<span class="etl-tick" style:left="{x(t.parkUntimedAt)}%">{fmt(t.parkUntimedAt)}</span>{/if}
    {/if}
  </div>
  <ul class="etl-legend">
    {#if t.idleAt === null}
      <li>Elastic engines is off: every engine stays at normal priority and is never trimmed or parked.</li>
    {:else}
      <li><b>Background</b> at once: the engine runs at a lower priority. Work in progress continues.</li>
      <li><b>Idle</b> after {fmt(t.idleAt)} with no work: lowest priority.</li>
      <li><b>Trim</b> <span class="etl-trim-key"></span> at {fmt(t.trimAt ?? 0)}, then every {fmt(settings.retrimMinutes)}: the engine gives back unused memory. Nothing is lost.</li>
      {#if t.parkTimedAt === null}
        <li><b>Park</b> is off: engines keep running.</li>
      {:else}
        <li><b>Parked</b> after {fmt(t.parkTimedAt)} (Anthropic) or {fmt(t.parkUntimedAt ?? 0)} (no published cache life): the engine process stops to free its memory. The chat stays. Your next message starts the engine again in about 2 seconds, with byte-identical requests. A park does not clear the provider cache; with cache warming on, a parked chat wakes one minute before its warm is due (the marks on the first lane), warms and parks again. Without a published cache life the first message after a park can miss the cache.</li>
      {/if}
      <li>A chat on screen, or one that runs a turn, a question, a sub-agent or a /loop, does not move on.</li>
    {/if}
  </ul>
</div>

<style>
  .etl { margin: 4px 0 12px; padding: 10px 12px; background: var(--og-surface-alt); border: 1px solid var(--og-border); border-radius: 8px; font-size: 11px; color: var(--og-text); }
  .etl-head { font-weight: 600; margin-bottom: 8px; }
  .etl-lane { margin-bottom: 6px; }
  .etl-name { color: var(--og-text-secondary); margin-bottom: 2px; }
  .etl-ex { color: var(--og-text-muted); }
  .etl-bar { position: relative; height: 18px; border-radius: 4px; background: var(--og-bg); overflow: hidden; }
  .etl-seg { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; overflow: hidden; transition: left 160ms ease, width 160ms ease; }
  .etl-seg-label { padding: 0 4px; font-size: 10px; white-space: nowrap; color: var(--og-text); }
  .etl-active { background: var(--og-chat); }
  .etl-active .etl-seg-label { color: var(--og-btn-text); }
  .etl-background { background: color-mix(in srgb, var(--og-chat) 45%, var(--og-bg)); }
  .etl-idle { background: color-mix(in srgb, var(--og-text-muted) 30%, var(--og-bg)); }
  .etl-parked { background: repeating-linear-gradient(135deg, var(--og-warning-soft) 0 4px, transparent 4px 8px); border-left: 2px solid var(--og-warning); }
  .etl-parked .etl-seg-label { color: var(--og-warning-text); }
  .etl-trim { position: absolute; top: 3px; bottom: 3px; width: 2px; margin-left: -1px; background: var(--og-success); }
  .etl-warm { position: absolute; top: 2px; bottom: 2px; width: 4px; margin-left: -2px; border-radius: 2px; background: var(--og-chat); }
  .etl-trim-key { display: inline-block; width: 2px; height: 9px; background: var(--og-success); vertical-align: middle; }
  .etl-axis { position: relative; height: 14px; margin-bottom: 6px; color: var(--og-text-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
  .etl-tick { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .etl-legend { margin: 0; padding-left: 16px; color: var(--og-text-secondary); line-height: 1.5; }
  @media (prefers-reduced-motion: reduce) { .etl-seg { transition: none; } }
</style>

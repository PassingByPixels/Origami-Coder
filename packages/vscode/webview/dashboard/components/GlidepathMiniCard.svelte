<script lang="ts">
  // One connection, one card: the number, the badge, the wait, and a sparkline
  // that fills the card edge to edge.
  //
  // The sparkline is the SAME drawing as the hero chart, on the SAME normalised
  // axis and from the SAME hourly points, so a card and the line it names cannot
  // disagree about where the window sits or how it got there.
  //
  // A CARD ALWAYS SAYS SOMETHING TRUE. Three states it has to hold honestly: a
  // window whose period nobody stated (no axis, no chart line, just the usage
  // number), a window the guard has closed (a percentage but no forecast, and
  // WHICH of the three conditions failed), and an ordinary one.
  import { monotonePath, type Point } from './glidepathDraw';
  import { cardTail, formatAgo, formatDays, fractionOf, type GlideLane } from './glidepathMath';

  let {
    lane,
    highlight,
    onHighlight,
  }: { lane: GlideLane; highlight: string | null; onHighlight: (id: string | null) => void } = $props();

  const W = 300, H = 46, PAD = 3;
  const x = (f: number) => PAD + Math.max(0, Math.min(1, f)) * (W - PAD * 2);
  const y = (p: number) => H - PAD - (Math.max(0, Math.min(100, p)) / 100) * (H - PAD * 2 - 1);

  const pts = $derived.by((): Point[] =>
    lane.unknownPeriod ? [] : lane.hourly.map((s) => ({ x: x(fractionOf(lane, s.t)), y: y(s.pct) })),
  );
  const lead = $derived(pts.length === 0 ? '' : `M${x(0).toFixed(2)},${y(0).toFixed(2)}L${pts[0]!.x.toFixed(2)},${pts[0]!.y.toFixed(2)}`);
  const curve = $derived(monotonePath(pts));
  const proj = $derived.by(() => {
    const p = lane.projection;
    if (!p || pts.length === 0) return '';
    const end = pts[pts.length - 1]!;
    const to = p.exhaustFrac !== undefined ? { x: x(p.exhaustFrac), y: y(100) } : { x: x(1), y: y(p.atResetPct) };
    return `M${end.x.toFixed(2)},${end.y.toFixed(2)}L${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  });

  const dimmed = $derived(highlight !== null && highlight !== lane.providerId);
  // A PROVISIONAL BADGE IS NOT A DIFFERENT BADGE. Same word, a leading `~` and
  // less ink, so a card that firms up overnight does not change shape.
  const soft = $derived(lane.projection?.basis === 'provisional');
</script>

<!-- Focus does what hover does, so the same fact is reachable without a mouse. -->
<div
  class="gp-mini"
  class:gp-dim={dimmed}
  title="{lane.name} — {lane.label}"
  tabindex="0"
  role="group"
  aria-label="{lane.name}, {lane.usedPct.toFixed(0)} percent used"
  onmouseenter={() => onHighlight(lane.providerId)}
  onmouseleave={() => onHighlight(null)}
  onfocus={() => onHighlight(lane.providerId)}
  onblur={() => onHighlight(null)}
>
  <div class="gp-mini-head">
    <span class="gp-mini-name">{lane.name}</span>
    {#if lane.status}
      <span class="gp-st gp-{lane.status.replace(' ', '-').toLowerCase()}" class:gp-provisional={soft}>{soft ? '~' : ''}{lane.status}</span>
    {:else}
      <span class="gp-st gp-too-early">TOO EARLY</span>
    {/if}
  </div>
  <div class="gp-mini-nums">
    {#if lane.unknownPeriod}
      period unknown · <b>{formatDays(lane.daysToReset)}</b> to reset · used <b>{lane.usedPct.toFixed(1)}%</b>
    {:else}
      <b>{lane.usedPct.toFixed(1)}%</b> used · <b>{formatDays(lane.daysToReset)}</b> to reset{#if lane.fairPct !== undefined} · fair {Math.round(lane.fairPct)}%{/if}
    {/if}
  </div>
  <div class="gp-mini-tail">{cardTail(lane)}</div>
  <div class="gp-mini-sub">{lane.lengthLabel ?? lane.label} · {lane.reads} reads · {formatAgo(lane.sampledAgoMs)}</div>
  {#if !lane.unknownPeriod}
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="presentation">
      <line x1={PAD} y1={y(0)} x2={W - PAD} y2={y(0)} class="gp-mini-base" />
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(100)} class="gp-mini-fair" />
      {#if lead}<path class="gp-mini-lead" d={lead} stroke={lane.colour} fill="none" />{/if}
      {#if curve}<path class="gp-mini-line" d={curve} stroke={lane.colour} fill="none" />{/if}
      {#if proj}<path class="gp-mini-proj" class:gp-proj-prov={soft} d={proj} stroke={lane.colour} fill="none" />{/if}
      {#if pts.length}
        <circle cx={pts[pts.length - 1]!.x} cy={pts[pts.length - 1]!.y} r="3.4" fill={lane.colour} class="gp-mini-dot" />
      {/if}
      <line x1={W - PAD} y1="1" x2={W - PAD} y2={H - 1} class="gp-mini-reset" />
    </svg>
  {/if}
</div>

<style>
  .gp-mini { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 10px; padding: 10px 13px; display: flex; flex-direction: column; min-height: 0; transition: opacity 90ms linear; }
  .gp-mini:focus-visible { outline: 1px solid var(--og-accent); outline-offset: 1px; }
  .gp-dim { opacity: 0.25; }
  .gp-mini-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex: none; }
  .gp-mini-name { font-weight: 600; color: var(--og-text); font-size: 12.5px; }
  .gp-mini-nums { font-size: 10.5px; color: var(--og-text-secondary); margin: 2px 0 1px; flex: none; }
  .gp-mini-nums b { color: var(--og-text); font-size: 12px; }
  .gp-mini-tail { font-size: 10px; color: var(--og-text-secondary); flex: none; }
  .gp-mini-sub { font-size: 9.5px; color: var(--og-text-muted); margin-bottom: 4px; flex: none; }
  .gp-mini svg { display: block; width: 100%; flex: 1; min-height: 34px; }
  .gp-mini-base { stroke: var(--og-border); }
  .gp-mini-fair { stroke: var(--og-text-muted); stroke-width: 1; stroke-dasharray: 4 3; opacity: 0.55; }
  .gp-mini-lead { stroke-width: 1; opacity: 0.5; stroke-dasharray: 2 3; }
  .gp-mini-line { stroke-width: 2; stroke-linecap: round; }
  .gp-mini-proj { stroke-width: 1.5; opacity: 0.6; stroke-dasharray: 3 3; }
  /* The same dash, less ink: a provisional line reads as the weaker claim it
     is without becoming a second kind of line. */
  .gp-mini-proj.gp-proj-prov { opacity: 0.35; }
  .gp-mini-dot { stroke: var(--og-surface); stroke-width: 2; }
  .gp-mini-reset { stroke: var(--og-text); stroke-width: 2; }
</style>

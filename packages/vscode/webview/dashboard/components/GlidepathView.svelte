<script lang="ts">
  // Glidepath — how much of each plan is spent, against that plan's OWN reset.
  //
  // THE PROBLEM THIS VIEW EXISTS FOR. Four or five connections, each with its
  // own window, and none of them resetting on the same day. "68% used" answers
  // nothing on its own: 68% on the second day of a week is a problem and 68% on
  // the sixth day is not. Every number here is paired with where it sits in ITS
  // window.
  //
  // ALL CONNECTIONS, ONE AXIS. The x is the FRACTION of a connection's own
  // window elapsed, so Copilot's month sits beside Claude's week at the same
  // width and both end at the same reset line.
  //
  // A CONNECTION WITH NO KNOWN PERIOD IS NOT ON THAT AXIS. It gets a card that
  // says "period unknown" and states only what was measured. This is the round's
  // whole point: the view previously assumed thirty days for such a window and
  // drew Grok at 78% of a month when it was at 7% of a week.
  //
  // ONE 48/52 SEAM. The left column carries the chart and the insights pill, the
  // right column the mini cards, which grow downward as subscriptions are added.
  // It is a CONTAINER query, not a media query: the pane is a webview column
  // whose width is nothing to do with the window's.
  //
  // THE NUMBERS ARE NOT COMPUTED HERE. glidepathMath.ts owns every one of them;
  // this file lays them out.
  import GlidepathChart from './GlidepathChart.svelte';
  import GlidepathLegend from './GlidepathLegend.svelte';
  import GlidepathMiniCard from './GlidepathMiniCard.svelte';
  import GlidepathInsights from './GlidepathInsights.svelte';
  import {
    connectionLanes,
    connectionName,
    formatSpan,
    GUARD,
    HOUR,
    insightsFor,
    nearestReset,
    plottable,
    windowDaysLabel,
    elapsedDays,
    type GlideProviders,
    type LengthOverrides,
  } from './glidepathMath';

  let {
    providers,
    now,
    capable,
    windowLengths = {},
  }: {
    providers: GlideProviders;
    now: number;
    capable: readonly string[];
    windowLengths?: LengthOverrides;
  } = $props();

  const lanes = $derived(connectionLanes(providers, now, windowLengths));
  const drawable = $derived(plottable(lanes));
  const insights = $derived(insightsFor(lanes));
  const empty = $derived(lanes.length === 0);
  const capableNames = $derived(capable.map(connectionName).join(', '));

  // WHICH connection is being pointed at. One piece of state, shared by the
  // legend, the chart and the cards, so hovering any of the three highlights the
  // same connection everywhere. Five bunched lines are unreadable otherwise.
  let highlight: string | null = $state(null);
  const setHighlight = (id: string | null) => (highlight = id);

  const marker = $derived(nearestReset(drawable) ?? nearestReset(lanes));

  // The reserved note band under the axis: what the sampler has, and what the
  // guard is holding back.
  const firstReadingAt = $derived.by(() => {
    const ts = lanes.map((l) => l.samples[0]?.t).filter((t): t is number => t !== undefined);
    return ts.length === 0 ? undefined : Math.min(...ts);
  });
  const coverageNote = $derived(
    firstReadingAt === undefined
      ? 'no readings recorded yet'
      : `readings began ${new Date(firstReadingAt).toLocaleString()} · ${formatSpan(now - firstReadingAt)} of history`,
  );
  const held = $derived(lanes.filter((l) => !l.guard.ok && !l.unknownPeriod));
  // A BLOCKED LANE OUTRANKS A PROVISIONAL ONE. One line of note space, and
  // "nothing at all on one of these" is the more important of the two facts.
  const soft = $derived(lanes.filter((l) => l.projection?.basis === 'provisional'));
  const guardNote = $derived(
    held.length > 0
      ? `no projection on ${held.length} of ${lanes.length}: needs ${GUARD.MIN_HOURS} h of readings and ${Math.round(GUARD.MIN_FRAC * 100)}% of the window`
      : soft.length > 0
        ? `provisional on ${soft.length} of ${lanes.length}: under ${GUARD.MIN_HOURS} h of readings`
        : '',
  );
  const NOT_IN_BUILD =
    'Not available in this build. Nothing on this panel is generated until the feature lands, so the view never shows model text beside measured numbers by accident.';
  // THE TAB IS HELD ONLY WHILE A LANE PROJECTS NOTHING. A provisional lane has
  // a rate to reason over; it is named so the reasoning can be read with the
  // right weight.
  const reasonedBlock = $derived(
    held.length > 0
      ? `The sampler holds under ${GUARD.PROVISIONAL_HOURS} h of readings on ${held.length} of ${lanes.length} connections, which is less than one full window for each of them. A model asked to reason over that would be reasoning over the sampler's age.`
      : soft.length > 0
        ? `Every connection projects. ${soft.length} of ${lanes.length} do so provisionally — ${soft.map((l) => l.name).join(', ')} — on under ${GUARD.MIN_HOURS} h of readings each. ${NOT_IN_BUILD}`
        : NOT_IN_BUILD,
  );
</script>

<div class="gp-root">
  {#if empty}
    <div class="gp-nothing">
      <p>No metered connections reporting yet.</p>
      {#if capable.length > 0}
        <p class="gp-nothing-sub">Connections that can report: {capableNames}. The first readings are taken when this view opens and every 30 minutes after that; a window needs two readings before it can be plotted.</p>
      {:else}
        <p class="gp-nothing-sub">No configured connection can report plan usage. Sign in to a subscription connection, or open a chat so the engine is running, and this fills in.</p>
      {/if}
    </div>
  {:else}
    <div class="gp-strip">
      {#if marker}
        {#if marker.lengthMs !== undefined}
          <span>day <b>{elapsedDays(marker, now).toFixed(1)}</b> of {windowDaysLabel(marker)} ({marker.name})</span>
        {:else}
          <span>nearest reset <b>{marker.name}</b></span>
        {/if}
        <span class="gp-strip-sep">·</span>
        <span>nearest reset in <b>{formatSpan(marker.msToReset)}</b></span>
        <span class="gp-strip-sep">·</span>
      {/if}
      <span><b>{lanes.length}</b> {lanes.length === 1 ? 'connection' : 'connections'}</span>
      {#if drawable.length !== lanes.length}
        <span class="gp-strip-sep">·</span>
        <span class="gp-strip-warn">{lanes.length - drawable.length} off the axis (period unknown)</span>
      {/if}
    </div>

    <div class="gp-page gp-split">
      <div class="gp-col">
        <div class="gp-tile">
          <div class="gp-tk">Glide path — all connections <span class="gp-tk-sub">consumed share of each window</span></div>
          <GlidepathLegend lanes={drawable} {highlight} onHighlight={setHighlight} />
          {#if drawable.length > 0}
            <GlidepathChart lanes={drawable} {coverageNote} {guardNote} {highlight} onHighlight={setHighlight} />
          {:else}
            <div class="gp-nochart">Nothing can be placed on the shared axis yet. Every reporting connection has a reset time and no period, so none of them has a window to draw a share of. The cards beside this still show what was measured.</div>
          {/if}
        </div>
        <GlidepathInsights {insights} {lanes} {reasonedBlock} />
      </div>
      <div class="gp-minis">
        {#each lanes as lane (lane.providerId + lane.label)}
          <GlidepathMiniCard {lane} {highlight} onHighlight={setHighlight} />
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  /* FLUID, NOT CENTRED. A max-width left the pane's outer thirds empty on a wide
     window while the chart it was meant to protect was squeezed.
     `container-type: inline-size` makes THIS column the reference the @container
     rule measures — the pane's width, not the window's. */
  .gp-root { flex: 1; min-height: 0; overflow: auto; color: var(--og-text); font-size: 13px; line-height: 1.55; container-type: inline-size; }
  .gp-split { display: grid; grid-template-columns: 48fr 52fr; gap: 14px; align-items: start; }
  .gp-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .gp-strip { padding: 12px 22px 0; color: var(--og-text-secondary); font-size: 12px; display: flex; gap: 7px; flex-wrap: wrap; }
  .gp-strip b { color: var(--og-text); font-weight: 600; }
  .gp-strip-sep { color: var(--og-text-muted); }
  .gp-strip-warn { color: var(--og-text-muted); }
  .gp-page { padding: 10px 22px 40px; }
  /* NO FIXED SLOT COUNT. Two columns, and as many rows as there are
     subscriptions — a sixth connection adds a row rather than falling off. */
  .gp-minis { display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: minmax(120px, auto); gap: 10px; align-content: start; min-width: 0; }
  .gp-nochart { color: var(--og-text-muted); font-size: 11.5px; line-height: 1.7; padding: 18px 0; }
  .gp-nothing { padding: 48px 22px; max-width: 640px; margin: 0 auto; text-align: center; }
  .gp-nothing p { color: var(--og-text-secondary); font-size: 13px; margin: 0 0 8px; }
  .gp-nothing-sub { color: var(--og-text-muted); font-size: 11.5px; line-height: 1.7; }

  /* Below 900px the two columns stop being two columns: a 48% share of a narrow
     pane is a chart nobody can read. Everything stacks, cards included. */
  @container (max-width: 900px) {
    .gp-split { grid-template-columns: 1fr; }
    .gp-minis { grid-template-columns: 1fr; }
  }

  /* Shared surface + section key. :global so the child components use ONE
     definition rather than a copy each — a badge that is worded the same and
     coloured differently is the drift this prevents. */
  :global(.gp-tile) { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 10px; padding: 14px 16px; }
  :global(.gp-tk) { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--og-text-muted); margin-bottom: 8px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .gp-tk-sub { text-transform: none; letter-spacing: 0; }
  :global(.gp-st) { font-size: 9px; font-weight: 700; padding: 1px 7px; border-radius: 8px; letter-spacing: 0.5px; white-space: nowrap; }
  :global(.gp-on-track) { background: rgba(78, 201, 176, 0.16); color: #4ec9b0; }
  :global(.gp-ahead) { background: rgba(244, 135, 113, 0.18); color: #f48771; }
  :global(.gp-behind) { background: rgba(86, 156, 214, 0.16); color: #569cd6; }
  :global(.gp-tight) { background: rgba(220, 220, 170, 0.16); color: #dcdcaa; }
  :global(.gp-too-early) { background: var(--og-btn-bg); color: var(--og-text-muted); }
  /* The provisional badge is the SAME badge with less ink. A second colour
     would read as a sixth status rather than a weaker version of one. */
  :global(.gp-provisional) { opacity: 0.7; }
</style>

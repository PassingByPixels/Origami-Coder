<script lang="ts">
  // ONE insights pill with three tabs.
  //
  // Two side-by-side panels put a full panel of "not available in this build"
  // beside the panel that actually says something, and cost the mini cards half
  // the page for it. One pill: the measurements are the default, the reasoned
  // panel is one click away, and DATA is the table view.
  //
  // THE DATA TAB IS NOT AN EXTRA. A line chart that cannot be read as numbers is
  // unreadable to anyone using a screen reader and unverifiable by anyone else:
  // it is where "where did that 78% come from" gets answered, and it carries the
  // one column the chart cannot — where each window's LENGTH came from.
  //
  // EVERY PROGRAMMATIC ROW IS A FACT ABOUT THE RECORDED SAMPLES. None of them
  // tells the user what to do — advice about models or plans goes stale with the
  // next price change, and this panel would then be confidently wrong.
  //
  // THE CHOICE IS REMEMBERED, not synced. Which tab you left open is a way of
  // looking at the pane, so it belongs in this webview's own storage and not in
  // the extension's settings. Every access is guarded: `localStorage` throws
  // outright in some hosts, and a pane that will not render because a preference
  // could not be read is a worse pane than one that opens on the default.
  import {
    formatDays,
    formatSpan,
    HOUR,
    type GlideInsight,
    type GlideLane,
  } from './glidepathMath';

  let {
    insights,
    lanes,
    reasonedBlock,
  }: { insights: readonly GlideInsight[]; lanes: readonly GlideLane[]; reasonedBlock: string } = $props();

  type Tab = 'programmatic' | 'reasoned' | 'data';
  const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'programmatic', label: 'Programmatic' },
    { id: 'reasoned', label: 'Reasoned' },
    { id: 'data', label: 'Data' },
  ];
  const KEY = 'origami.glidepath.insightsTab';

  function remembered(): Tab {
    try {
      const raw = localStorage.getItem(KEY);
      return raw === 'reasoned' || raw === 'data' ? raw : 'programmatic';
    } catch {
      return 'programmatic';
    }
  }

  let tab: Tab = $state(remembered());

  function pick(next: Tab): void {
    tab = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A host that blocks site data still gets the tab it was asked for; it
      // just gets the default again next time.
    }
  }

  const pctText = (v: number) => `${v.toFixed(1)}%`;
</script>

<div class="gp-tile gp-ins">
  <div class="gp-tk gp-ins-head">
    <span class="gp-tabs" role="tablist">
      {#each TABS as t (t.id)}
        <button class="gp-tab" class:active={tab === t.id} role="tab" aria-selected={tab === t.id} onclick={() => pick(t.id)}>{t.label}</button>
      {/each}
    </span>
    {#if tab === 'reasoned'}
      <span class="gp-aichip">AI-generated</span>
    {:else}
      <span class="gp-st gp-behind">COMPUTED LOCALLY</span>
    {/if}
  </div>

  {#if tab === 'programmatic'}
    {#if insights.length === 0}
      <div class="gp-ins-empty">Nothing measurable yet. Each window needs two readings before a pace or a projection means anything.</div>
    {:else}
      <div class="gp-ins-rows">
        {#each insights as ins (ins.id)}
          <div class="gp-insrow">
            <span class="gp-sig gp-sig-{ins.tone}"></span>
            <div>
              <div class="gp-ins-t">{ins.title} <span class="gp-ins-src">{ins.source}</span></div>
              <div class="gp-ins-d">{ins.text}</div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else if tab === 'reasoned'}
    <div class="gp-reasoned">
      <!-- Rendered, disabled, and inert. The panel is part of the approved
           layout, and hiding it until the feature lands would change the page's
           shape twice instead of once. -->
      <button class="gp-rbtn" disabled title="Coming later">Get reasoned insights</button>
      <span class="gp-rhint">A model would review the recorded windows and return a fixed schema: summary, top drivers, recommendations with confidence. Not available in this build.</span>
      <div class="gp-rsummary">
        <div class="gp-rk">Blocked for now</div>
        {reasonedBlock}
      </div>
    </div>
  {:else}
    <div class="gp-datawrap">
      <table class="gp-dt">
        <thead>
          <tr>
            <th>Connection</th><th>Window</th><th>Length</th><th>From</th><th>Elapsed</th>
            <th>Used</th><th>Fair</th><th>Reads</th><th>History</th><th>To reset</th>
            <th>Projected at reset</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {#each lanes as lane (lane.providerId + lane.label)}
            <tr>
              <td><span class="gp-dtdot" style="background:{lane.colour}"></span>{lane.name}</td>
              <td>{lane.label}</td>
              <td>{lane.lengthLabel ?? 'unknown'}</td>
              <!-- The column the chart cannot carry: a length the provider
                   STATED and one this build measured are different claims. -->
              <td>{lane.lengthSource ?? 'not stated'}</td>
              <td>{lane.frac === undefined ? '--' : `${Math.round(lane.frac * 100)}%`}</td>
              <td>{pctText(lane.usedPct)}</td>
              <td>{lane.fairPct === undefined ? '--' : `${Math.round(lane.fairPct)}%`}</td>
              <td>{lane.reads}</td>
              <td>{formatSpan(lane.readingHours * HOUR)}</td>
              <td>{formatDays(lane.daysToReset)}</td>
              <td>{lane.projection ? `${Math.round(lane.projection.atResetPct)}%` : 'not projected'}</td>
              <!-- Three states, not two: a firm badge, a `~` provisional badge, or the
                   `too early` the guard reports when it forecasts nothing. -->
              <td>{lane.projection?.basis === 'provisional' ? `~${lane.status}` : (lane.status ?? 'too early')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .gp-ins { display: flex; flex-direction: column; }
  .gp-ins-head { justify-content: space-between; margin-bottom: 10px; }
  .gp-tabs { display: inline-flex; gap: 4px; }
  .gp-tab { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text-secondary); border-radius: 4px; padding: 3px 12px; font-size: 11px; font-family: inherit; cursor: pointer; text-transform: none; letter-spacing: 0; }
  .gp-tab:hover { color: var(--og-text); }
  .gp-tab.active { background: var(--og-accent); color: var(--og-text); border-color: var(--og-accent); }
  .gp-ins-rows { flex: 1; }
  .gp-ins-empty { flex: 1; color: var(--og-text-muted); font-size: 11.5px; line-height: 1.6; }
  .gp-insrow { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--og-border); align-items: baseline; }
  .gp-insrow:last-child { border-bottom: none; padding-bottom: 0; }
  .gp-sig { width: 7px; height: 7px; border-radius: 50%; flex: none; position: relative; top: -1px; }
  .gp-sig-ok { background: #4ec9b0; }
  .gp-sig-warn { background: #dcdcaa; }
  .gp-sig-bad { background: #f48771; }
  .gp-sig-info { background: #569cd6; }
  .gp-ins-t { font-weight: 600; color: var(--og-text); font-size: 12.5px; }
  .gp-ins-src { font-size: 9.5px; color: var(--og-text-muted); font-weight: 400; letter-spacing: 0.5px; margin-left: 7px; text-transform: uppercase; }
  .gp-ins-d { font-size: 11.5px; color: var(--og-text-secondary); }

  .gp-reasoned { flex: 1; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .gp-aichip { font-size: 9px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--og-accent); border: 1px solid var(--og-accent); padding: 2px 8px; border-radius: 3px; }
  .gp-rbtn { flex: none; background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text-secondary); border-radius: 6px; padding: 4px 12px; font-size: 12px; font-family: inherit; cursor: default; opacity: 0.45; }
  .gp-rhint { font-size: 11px; color: var(--og-text-muted); line-height: 1.5; }
  .gp-rsummary { align-self: stretch; flex: 1; background: var(--og-surface-alt); border: 1px solid var(--og-border); border-radius: 8px; padding: 11px 13px; font-size: 12px; color: var(--og-text-secondary); }
  .gp-rk { font-size: 9.5px; text-transform: uppercase; letter-spacing: 1px; color: var(--og-text-muted); margin-bottom: 5px; }

  /* The table is the one thing on the page allowed to scroll sideways: its
     columns are the audit trail, and dropping any of them to fit is the failure
     the tab exists to prevent. */
  .gp-datawrap { overflow-x: auto; }
  .gp-dt { border-collapse: collapse; font-size: 11px; white-space: nowrap; }
  .gp-dt th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.7px; color: var(--og-text-muted); font-weight: 600; padding: 0 12px 6px 0; }
  .gp-dt td { padding: 5px 12px 5px 0; border-top: 1px solid var(--og-border); color: var(--og-text-secondary); }
  .gp-dtdot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
</style>

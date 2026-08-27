<script lang="ts">
  // CronTable — the Crons view as an OPS TABLE rather than a stack of cards.
  // Cards cost a screenful for four crons; this has to stay readable at forty,
  // which is the state Passing's machine is heading for now that crons work.
  //
  // JOB is three tiers of decreasing emphasis — name, then the model/agent it
  // runs as, then the log path — so a scan down the first column reads as names
  // alone and the detail is there when you stop on a row. Everything derived
  // (times, status, the failure note) comes from cronFormat.ts; this is markup.
  import { cronStatus, lastRunText, relativeWhen, runsText, statusLabel, statusNote, type CronStatus } from '../panes/cronFormat';
  import CronRowDetail from './CronRowDetail.svelte';

  interface CronRow {
    id: string; name: string; prompt: string; scheduleLabel: string;
    agent?: string; model?: string; enabled: boolean; taskName: string;
    logPath: string; scriptPath: string; nextRunAt: string | null; lastOutputAt: number | null;
    runs: number; runsExact: boolean;
    lastOutcome: 'ok' | 'failed' | 'incomplete' | null; lastExitCode: number | null;
  }
  interface Props {
    rows: CronRow[];
    driftIds: Set<string>;
    now: number;
    workspace: string;
    onaction: (type: string, id: string, extra?: Record<string, unknown>) => void;
    onedit: (row: CronRow) => void;
  }
  const { rows, driftIds, now, workspace, onaction, onedit }: Props = $props();

  // Which rows are expanded — a LIST, not a single id: comparing two jobs'
  // prompts is the reason you open one at all. The disclosure is the job-name
  // BUTTON, never the <tr>: a row-level handler fires on the action cell too,
  // and "Delete also expanded the row" is the polite version of that bug.
  let openIds: string[] = $state([]);
  const isOpen = (id: string) => openIds.includes(id);
  const toggle = (id: string) => { openIds = isOpen(id) ? openIds.filter((x) => x !== id) : [...openIds, id]; };
  const st = (c: CronRow): CronStatus => cronStatus(c, driftIds);
  const nextMs = (iso: string | null) => (iso ? Date.parse(iso) : null);
  const metaLine = (c: CronRow) =>
    [c.model || 'no model pinned — runs on whatever model this machine used last', c.agent ? `agent ${c.agent}` : ''].filter((x) => x).join(' · ');
</script>

<div class="cron-table-wrap">
  <table class="cron-table">
    <thead>
      <tr>
        <th>Job</th><th>Schedule</th><th>Next run</th><th>Last run</th><th>Status</th>
        <th class="num">Runs</th><th class="acts-h"></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as c (c.id)}
        <tr class="cron-row" class:off={!c.enabled}>
          <td class="job">
            <!-- The prompt gets no COLUMN (it is prose, and prose wrecks a
                 scannable table) — it gets a disclosure instead, so what a job
                 does is one click away rather than behind the Edit form. -->
            <button class="job-toggle" aria-expanded={isOpen(c.id)} aria-controls="cron-detail-{c.id}"
              onclick={() => toggle(c.id)} title={isOpen(c.id) ? 'Hide what this job does' : 'Show what this job does'}>
              <span class="job-caret" class:open={isOpen(c.id)} aria-hidden="true">▸</span>
              <span class="job-name">{c.name}</span>
            </button>
            <div class="job-meta" class:unpinned={!c.model}>{metaLine(c)}</div>
            <div class="job-path">{c.logPath}</div>
            {#if statusNote(st(c), c)}<div class="job-note">{statusNote(st(c), c)}</div>{/if}
          </td>
          <td class="mono">{c.scheduleLabel}</td>
          <!-- A disabled cron has no next run, so the cell stays empty: printing
               a time would be a promise the scheduler is not holding. An ENABLED
               cron whose next run we cannot compute (an interval task with no
               registration anchor) says so — "unknown" is a fact, a fabricated
               time is not. -->
          <td class="mono">{#if !c.enabled}{''}{:else if c.nextRunAt}{relativeWhen(nextMs(c.nextRunAt), now)}{:else}unknown{/if}</td>
          <td class="mono">{lastRunText(c.lastOutputAt, c.lastOutcome, now)}</td>
          <td class="status"><span class="dot s-{st(c)}"></span><span class="status-word">{statusLabel(st(c))}</span></td>
          <td class="mono num">{runsText(c.runs, c.runsExact)}</td>
          <td class="acts">
            <button class="cron-btn" onclick={() => onaction('runCronNow', c.id)} disabled={!c.enabled}>Run</button>
            <button class="cron-btn" onclick={() => onaction('openCronLog', c.id)}>Log</button>
            <button class="cron-btn" onclick={() => onaction('setCronEnabled', c.id, { enabled: !c.enabled })}>{c.enabled ? 'Disable' : 'Enable'}</button>
            <button class="cron-btn" onclick={() => onedit(c)}>Edit</button>
            <button class="cron-btn cron-danger" onclick={() => onaction('deleteCron', c.id)}>Delete</button>
          </td>
        </tr>
        {#if isOpen(c.id)}<CronRowDetail row={c} {workspace} columns={7} />{/if}
      {/each}
    </tbody>
  </table>
</div>

<style>
  /* The table scrolls INSIDE its own box — a narrow side panel must never make
     the whole pane scroll sideways. */
  .cron-table-wrap { flex: 1; overflow: auto; padding: 8px 12px 12px; }
  .cron-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .cron-table th {
    text-align: left; font-size: 9px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--og-text-muted); padding: 4px 8px 5px;
    border-bottom: 1px solid var(--og-border); white-space: nowrap;
    position: sticky; top: 0; background: var(--og-bg); z-index: 1;
  }
  .cron-table td { padding: 7px 8px; border-bottom: 1px solid var(--og-border); vertical-align: top; }
  .cron-row:hover { background: var(--og-surface); }
  .cron-row.off { opacity: 0.55; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); font-variant-numeric: tabular-nums; color: var(--og-text-secondary); white-space: nowrap; }
  .num { text-align: right; }
  .job { min-width: 150px; }
  .job-toggle {
    display: flex; align-items: baseline; gap: 5px; width: 100%; text-align: left;
    background: none; border: none; padding: 0; margin: 0; font: inherit; cursor: pointer; color: inherit;
  }
  .job-toggle:hover .job-name { text-decoration: underline; }
  .job-caret { flex-shrink: 0; font-size: 9px; color: var(--og-text-muted); transition: transform 0.12s; display: inline-block; }
  .job-caret.open { transform: rotate(90deg); }
  .job-name { font-weight: 600; font-size: 12px; color: var(--og-text); overflow-wrap: anywhere; }
  .job-meta { margin-top: 2px; font-size: 10px; color: var(--og-text-muted); font-family: var(--vscode-editor-font-family, monospace); }
  .job-meta.unpinned { color: var(--og-warning-text); }
  .job-path { margin-top: 1px; font-size: 9px; color: var(--og-text-muted); opacity: 0.75; font-family: var(--vscode-editor-font-family, monospace); }
  .job-note { margin-top: 4px; font-size: 10px; font-style: italic; color: var(--og-warning-text); line-height: 1.35; }
  .status { white-space: nowrap; }
  .status-word { font-size: 9px; font-weight: 600; letter-spacing: 0.05em; color: var(--og-text-secondary); }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; background: var(--og-text-muted); }
  .s-ok { background: var(--og-success); }
  .s-failed { background: var(--og-error); }
  .s-drift { background: var(--og-warning); }
  .s-running { background: var(--og-accent); }
  .s-disabled, .s-never { background: var(--og-text-muted); }
  .acts { text-align: right; white-space: nowrap; }
  .acts-h { width: 1%; }
  .cron-btn { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text-secondary); border-radius: 4px; cursor: pointer; padding: 2px 6px; font-size: 10px; margin-left: 3px; }
  .cron-btn:hover:not(:disabled) { background: var(--og-btn-hover); color: var(--og-text); }
  .cron-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .cron-danger:hover:not(:disabled) { border-color: var(--og-error); color: var(--og-error-text); background: var(--og-error-soft); }
</style>

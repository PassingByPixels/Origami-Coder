<script lang="ts">
  // Crons pane — scheduled runs that fire when VS Code is CLOSED. This is the
  // difference from Loops (LoopsPane.svelte): a loop is an interval re-run
  // inside an OPEN chat and dies with the window; a cron is a real OS
  // scheduled task (Windows Task Scheduler) running `origami run` headless.
  //
  // Truth lives in `.origami/crons.json`, which is git-tracked on purpose —
  // clone the repo elsewhere and the schedules come with it (unregistered
  // there, which the drift report says out loud rather than fixing silently).
  //
  // Every cron runs with `--auto`: it approves its own permissions and can
  // write to the workspace unattended. The pane STATES that as a standing fact
  // (see .cron-unattended) rather than nagging with a confirm dialog on every
  // edit — the trade-off was made once, deliberately, not per-click.
  //
  // The LIST is a table (CronTable.svelte) because this view is now used often
  // enough to hold dozens of rows; the draft form lives in CronForm.svelte.
  // RUNS and LAST RUN are read from each cron's own LOG (src/dashboard/crons/
  // cronLog.ts) — the audit trail is the only counter, so the number on screen
  // cannot drift from what actually happened.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import CronForm from '../components/CronForm.svelte';
  import CronTable from '../components/CronTable.svelte';
  import { listState, matchesSearch } from './paneSearch';
  const vscode = getVsCodeApi();

  interface CronRow {
    id: string; name: string; prompt: string; scheduleLabel: string;
    agent?: string; model?: string; enabled: boolean; taskName: string;
    logPath: string; scriptPath: string; nextRunAt: string | null; lastOutputAt: number | null;
    runs: number; runsExact: boolean;
    lastOutcome: 'ok' | 'failed' | 'incomplete' | null; lastExitCode: number | null;
    schedule: { kind: string; time?: string; days?: string[]; every?: number };
  }
  // The model catalog, listened for exactly the way CollabAgentsPane does it
  // rather than taken as a prop: the host BROADCASTS these two, so a pane that
  // waited to be handed them would show an empty picker until something else
  // asked. Needed here now that a cron must name its model (CronRunTarget).
  interface ModelOpt { value: string; name: string }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }
  interface Drift {
    missingRegistration: Array<{ id: string; name: string; taskName: string }>;
    strayRegistration: Array<{ taskName: string; reason: string }>;
    orphanScripts?: string[];
    error?: string;
  }

  let crons: CronRow[] = $state([]);
  let invalid: Array<{ reason: string }> = $state([]);
  let drift: Drift = $state({ missingRegistration: [], strayRegistration: [] });
  let workspace = $state('');
  let modelOptions: ModelOpt[] = $state([]);
  let providerStatus: ProviderStat[] = $state([]);
  let backendAvailable = $state(true);
  let backendReason = $state('');
  let loaded = $state(false);
  let error = $state('');
  let query = $state('');

  // `editing` holds the id being edited, or '' for a new cron. `formSeq` keys
  // the mount so every open starts from a clean draft — without it, New after
  // New reuses the component and silently keeps the abandoned text.
  let showForm = $state(false);
  let editing = $state('');
  let formSeq = $state(0);
  type FormInit = { name: string; prompt: string; agent?: string; model?: string; schedule: CronRow['schedule'] };
  let formInit: FormInit | null = $state(null);

  // Stamped when data arrives, not read once at mount: a pane left open
  // overnight would otherwise still be calling yesterday "today".
  let now = $state(Date.now());
  const driftIds = $derived(new Set(drift.missingRegistration.map((m) => m.id)));
  const shown = $derived(crons.filter((c) => matchesSearch([c.name, c.prompt, c.scheduleLabel, c.model, c.agent], query)));
  const state = $derived(listState(crons.length, shown.length));

  function refresh() { loaded = false; vscode.postMessage({ type: 'listCrons' }); }

  function openNew() { editing = ''; formInit = null; error = ''; formSeq++; showForm = true; }
  function openEdit(c: CronRow) {
    editing = c.id;
    formInit = { name: c.name, prompt: c.prompt, agent: c.agent, model: c.model, schedule: c.schedule };
    error = ''; formSeq++; showForm = true;
  }
  function submit(draft: Record<string, unknown>) {
    vscode.postMessage(editing ? { type: 'updateCron', id: editing, draft } : { type: 'createCron', draft });
  }
  function action(type: string, id: string, extra: Record<string, unknown> = {}) {
    vscode.postMessage({ type, id, ...extra });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'cronsData') {
      crons = Array.isArray(msg.crons) ? msg.crons : [];
      invalid = Array.isArray(msg.invalid) ? msg.invalid : [];
      drift = msg.drift ?? { missingRegistration: [], strayRegistration: [] };
      workspace = typeof msg.workspace === 'string' ? msg.workspace : '';
      backendAvailable = msg.backendAvailable !== false;
      backendReason = msg.backendReason ?? '';
      now = Date.now();
      loaded = true;
    } else if (msg.type === 'modelOptions') {
      modelOptions = Array.isArray(msg.options) ? msg.options : [];
    } else if (msg.type === 'providerStatus') {
      providerStatus = Array.isArray(msg.providers) ? msg.providers : [];
    } else if (msg.type === 'cronOpResult') {
      if (msg.ok) { showForm = false; error = ''; refresh(); } else { error = msg.error ?? 'failed'; }
    }
  });

  refresh();
  // PULL the catalog, do not wait to be handed it. `modelOptions` /
  // `providerStatus` are broadcasts, not state: whichever fired before this
  // pane mounted is simply gone, and the cron form would open with an empty
  // model picker and no way to satisfy its own required field. Same two
  // requests CollabAgentsPane sends on mount, for the same reason.
  vscode.postMessage({ type: 'requestModels' });
  vscode.postMessage({ type: 'requestProviderStatus' });
</script>

<div class="crons-pane">
  <div class="crons-toolbar">
    <input class="crons-filter" placeholder="Filter crons…" bind:value={query} aria-label="Filter crons" />
    <span class="crons-count">
      {#if query.trim()}{shown.length}/{crons.length}{:else}{crons.length} cron{crons.length === 1 ? '' : 's'}{/if}
    </span>
    <button class="crons-new" onclick={openNew} disabled={!backendAvailable}>+ New cron</button>
    <button class="crons-refresh" onclick={refresh} title="Reload crons">↻</button>
  </div>

  <div class="crons-note">
    A cron is a real OS scheduled task — it fires <strong>with VS Code closed</strong>, unlike a Loop.
    Schedules live in <code>.origami/crons.json</code>, tracked in git.
  </div>

  <div class="cron-unattended">
    Crons run <strong>unattended and auto-approved</strong> (<code>--auto</code>): each one approves its own
    permissions and can write to this workspace with nobody watching. Git is the undo.
  </div>

  {#if !backendAvailable}
    <div class="cron-blocked">{backendReason}</div>
  {/if}

  {#if drift.error}
    <div class="cron-drift">Could not check the system scheduler, so drift is unknown: {drift.error}</div>
  {:else if drift.missingRegistration.length > 0 || drift.strayRegistration.length > 0}
    <div class="cron-drift">
      <div class="drift-head">Drift between <code>crons.json</code> and the system scheduler — reported, not corrected</div>
      {#each drift.missingRegistration as m (m.taskName)}
        <div class="drift-row">In the file but NOT registered — <strong>{m.name}</strong> will not fire ({m.taskName})</div>
      {/each}
      {#each drift.strayRegistration as s (s.taskName)}
        <div class="drift-row">Registered but {s.reason === 'disabled' ? 'disabled here' : 'unknown here'} — {s.taskName} WILL still fire</div>
      {/each}
      {#each drift.orphanScripts ?? [] as id (id)}
        <div class="drift-row">Leftover launcher script with no cron behind it — {id}.cmd (inert; swept on the next create or delete)</div>
      {/each}
    </div>
  {/if}

  {#each invalid as bad, i (i)}
    <div class="cron-invalid">Unreadable entry in crons.json: {bad.reason}</div>
  {/each}

  {#if showForm}
    {#key formSeq}
      <CronForm initial={formInit} editing={!!editing} {error} {modelOptions} {providerStatus}
        onsubmit={submit} oncancel={() => { showForm = false; error = ''; }} />
    {/key}
  {/if}

  {#if !loaded}
    <div class="crons-empty">Loading crons…</div>
  {:else if state === 'empty'}
    <div class="crons-empty">
      No crons yet. A cron runs a prompt on a schedule even when VS Code is closed —
      create one with <strong>+ New cron</strong>.
    </div>
  {:else if state === 'no-matches'}
    <!-- NOT the same statement as "no crons yet". Saying that here, with crons
         on disk and a filter in the box, would be a flat lie about the user's
         own data. -->
    <div class="crons-empty">
      No cron matches <strong>{query}</strong>. {crons.length} cron{crons.length === 1 ? '' : 's'} exist —
      <button class="crons-clear" onclick={() => { query = ''; }}>clear the filter</button>.
    </div>
  {:else}
    <CronTable rows={shown} {driftIds} {now} {workspace} onaction={action} onedit={openEdit} />
  {/if}
</div>

<style>
  .crons-pane { display: flex; flex-direction: column; height: 100%; color: var(--og-text); }
  .crons-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .crons-filter { flex: 1; min-width: 0; background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 7px; font-size: 11px; font-family: inherit; }
  .crons-count { flex-shrink: 0; font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .crons-new, .crons-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 11px; }
  .crons-new:hover:not(:disabled), .crons-refresh:hover { background: var(--og-btn-hover); }
  .crons-new:disabled { opacity: 0.5; cursor: not-allowed; }
  .crons-note {
    margin: 10px 12px 0; padding: 8px 10px; font-size: 11px; line-height: 1.5;
    color: var(--og-text-secondary); background: var(--og-surface);
    border: 1px solid var(--og-border); border-left: 3px solid var(--og-chat);
    border-radius: 4px; flex-shrink: 0;
  }
  /* A standing statement of what these things ARE, not a dismissible warning. */
  .cron-unattended {
    margin: 8px 12px 0; padding: 8px 10px; font-size: 11px; line-height: 1.5;
    color: var(--og-warning-text); background: var(--og-warning-soft);
    border: 1px solid var(--og-warning); border-radius: 4px; flex-shrink: 0;
  }
  .cron-blocked, .cron-drift, .cron-invalid {
    margin: 8px 12px 0; padding: 8px 10px; font-size: 11px; line-height: 1.5;
    color: var(--og-warning-text); background: var(--og-warning-soft);
    border: 1px solid var(--og-warning); border-radius: 4px; flex-shrink: 0;
  }
  .drift-head { font-weight: 600; margin-bottom: 3px; }
  .drift-row { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
  .crons-note code, .cron-unattended code, .cron-drift code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
  .crons-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .crons-clear { background: none; border: none; padding: 0; font: inherit; color: var(--og-chat); cursor: pointer; text-decoration: underline; }
</style>

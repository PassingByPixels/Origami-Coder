<script lang="ts">
  // Flock M4 (C16) — the collab's TASK BOARD, collapsed by default.
  //
  // THE FOLD IS THE PARENT'S (M4.2 UAT). The board draws inside
  // CollabTaskDrawer.svelte now, whose pull-tab is what slides it in and out, so
  // holding a second `open` here would be two controls disagreeing about one
  // state. The head stays clickable and reports the same toggle — TodoStrip's
  // own drawer mode is the precedent for that split.
  //
  // ENGINE-AUTHORITATIVE, with no local splice anywhere: every button posts a
  // mutation and the pane re-polls, so a refusal cannot leave an accepted task
  // on screen. The list arrives on `collab_state` already ordered (open +
  // claimed + done first, accepted last, max 50) and is rendered in that order
  // rather than re-sorted here, or the board and the engine would disagree
  // about what "next" means.
  //
  // ONLY LEGAL ACTIONS ARE DRAWN. The transitions are open->claimed->done->
  // accepted (and done->claimed on a reopen), and claiming is an AGENT's move,
  // so a human sees Accept/Reopen on a done task and nothing at all on the
  // others — a disabled button would say "you may do this, later", which is
  // not what the state machine means.
  //
  // The LEDGER rides the same section: totals from `collab_state` (always
  // present once the engine sends them) and the per-turn entries fetched on
  // expand. labyrinthUsage's printers are reused verbatim, so an absent figure
  // prints nothing and an engine that sent no ledger says so.
  import { formatCost, formatTokenCount } from '../dashboard/components/labyrinthUsage';
  import type { CollabCostTotal, LedgerEntry, TaskEntry } from '../../src/acpExtTypes';

  interface Props {
    /** ABSENT on an older engine — "this build has no board", not "no tasks". */
    tasks?: TaskEntry[];
    costTotals?: CollabCostTotal[];
    ledger?: LedgerEntry[];
    ledgerLoaded: boolean;
    archived: boolean;
    /** Whether the rows are showing. Owned by the drawer — see the header. */
    open: boolean;
    /** The head's click. The drawer decides what a toggle MEANS (it also
     *  fetches the per-turn ledger the first time the board comes out). */
    onToggle: () => void;
    onAdd: (title: string) => void;
    onUpdate: (taskId: string, action: 'accept' | 'reopen', extra: { note?: string }) => void;
  }
  let { tasks, costTotals, ledger, ledgerLoaded, archived, open, onToggle, onAdd, onUpdate }: Props = $props();

  let draftTitle = $state('');
  /** The task a reopen note is being typed for — a reopen without a reason is
   *  refused by the engine, so the note is asked for BEFORE the call. */
  let reopening = $state<string | null>(null);
  let reopenNote = $state('');

  const rows = $derived(tasks ?? []);
  const totals = $derived(costTotals ?? []);
  const totalCost = $derived(totals.reduce((n, t) => n + (Number.isFinite(t.cost) ? t.cost : 0), 0));

  function addTask() {
    const t = draftTitle.trim();
    if (!t) return;
    draftTitle = '';
    onAdd(t);
  }
  function startReopen(id: string) {
    reopening = reopening === id ? null : id;
    reopenNote = '';
  }
  function sendReopen(id: string) {
    const note = reopenNote.trim();
    if (!note) return;
    reopening = null;
    reopenNote = '';
    onUpdate(id, 'reopen', { note });
  }

  /** What each state MEANS to a human, as against what it is called on the wire.
   *  `done` is the one that has to be translated: it is not finished work, it is
   *  work parked on whoever raised it — which is what the Accept and Reopen
   *  buttons on that row are for. A chip reading "done" beside them said the
   *  opposite of what the row was asking. `data-state` keeps the wire word, so
   *  the styling and every engine-facing check are untouched. */
  const CHIP: Record<TaskEntry['state'], string> = {
    open: 'open',
    claimed: 'claimed',
    done: 'awaiting review',
    accepted: 'accepted',
  };

  /** The board's own summary: counts by state, so the folded header says what
   *  is behind it. A board with no tasks says that rather than showing "0".
   *
   *  ONE COUNT PER STATE (W8). `open` used to be summed together with `claimed`
   *  and the pair called "in play", so a task nobody had picked up was reported
   *  as work under way — the header read "1 in play" over a chip reading OPEN,
   *  unassigned. A state nobody is in prints nothing at all, and a board that is
   *  entirely accepted says so rather than counting to zero three times. */
  const headSummary = $derived.by(() => {
    if (rows.length === 0) return tasks ? 'nothing on the board yet' : 'no board on this engine';
    const count = (state: TaskEntry['state']) => rows.filter((t) => t.state === state).length;
    const parts = [
      [count('open'), 'unclaimed'],
      [count('claimed'), 'in play'],
      [count('done'), 'awaiting you'],
    ].filter(([n]) => (n as number) > 0).map(([n, label]) => `${n} ${label}`);
    const head = `${rows.length} task${rows.length === 1 ? '' : 's'}`;
    return [head, ...(parts.length > 0 ? parts : ['all accepted'])].join(' · ');
  });

  const totalsText = $derived.by(() => {
    if (totals.length === 0) return 'Spend: no data yet.';
    const cost = formatCost(totalCost);
    const inTok = formatTokenCount(totals.reduce((n, t) => n + t.tokensInput, 0));
    const outTok = formatTokenCount(totals.reduce((n, t) => n + t.tokensOutput, 0));
    const parts = [cost, inTok ? `${inTok} in` : undefined, outTok ? `${outTok} out` : undefined];
    return `Spend across ${totals.length} agent${totals.length === 1 ? '' : 's'}: ${parts.filter(Boolean).join(' · ')}`;
  });
</script>

<div class="tb">
  <button class="tb-head" onclick={onToggle} title="The collab's task board and its cost ledger">
    <span class="tb-caret" class:is-open={open}>&#9656;</span>
    <span class="tb-title">Tasks</span>
    <span class="tb-summary">{headSummary}</span>
  </button>

  {#if open}
    {#if !archived}
      <div class="tb-add">
        <input
          class="tb-input"
          placeholder="Add a task…"
          bind:value={draftTitle}
          aria-label="New task title"
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } }}
        />
        <button class="tb-btn" onclick={addTask} disabled={!draftTitle.trim()}>Add</button>
      </div>
    {/if}

    {#if rows.length === 0}
      <div class="tb-empty">{tasks ? 'No tasks yet — add one, or let an agent open its own.' : 'This engine build has no task board.'}</div>
    {:else}
      <ul class="tb-list">
        {#each rows as t (t.id)}
          <li class="tb-row">
            <span class="tb-chip" data-state={t.state}>{CHIP[t.state]}</span>
            <span class="tb-name" title={t.title}>{t.title}</span>
            <!-- WHO HAS IT, in the room's own @handle form so it reads as the
                 participant it names rather than as a free-text column. The
                 word for nobody is the one the header counts it under. -->
            <span class="tb-owner">{t.owner ? `@${t.owner}` : 'unclaimed'}</span>
            {#if t.state === 'done' && !archived}
              <!-- Accept CLOSES it; Reopen sends it back with a reason. Neither
                   exists on any other state — see the header comment. -->
              <button class="tb-btn" onclick={() => onUpdate(t.id, 'accept', {})} title="Accept this result and close the task">Accept</button>
              <button class="tb-btn" onclick={() => startReopen(t.id)} title="Send it back with a note">Reopen</button>
            {/if}
            {#if t.result}<span class="tb-result" title={t.result}>{t.result}</span>{/if}
            {#if t.note}<span class="tb-note" title={t.note}>sent back: {t.note}</span>{/if}
            {#if reopening === t.id}
              <span class="tb-reopen">
                <input
                  class="tb-input"
                  placeholder="Why is it going back?"
                  bind:value={reopenNote}
                  aria-label={`Reopen note for ${t.title}`}
                  onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendReopen(t.id); } }}
                />
                <button class="tb-btn" onclick={() => sendReopen(t.id)} disabled={!reopenNote.trim()}>Send back</button>
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="tb-foot">
      <span class="tb-totals">{totalsText}</span>
      {#if ledger && ledger.length > 0}
        <ul class="tb-ledger">
          {#each ledger as e (e.id)}
            <li class="tb-ledger-row">
              <span class="tb-ledger-agent">{e.agentSlug}{e.askedBy ? ` (asked by ${e.askedBy})` : ''}</span>
              <span class="tb-ledger-model">{e.model}</span>
              <span class="tb-ledger-cost">{[formatCost(e.cost), formatTokenCount(e.tokensInput), formatTokenCount(e.tokensOutput)].filter(Boolean).join(' · ')}</span>
            </li>
          {/each}
        </ul>
      {:else if ledgerLoaded}
        <!-- Asked and answered with nothing: no turn has been billed yet. Not
             the same as never having asked, which prints no line at all. -->
        <span class="tb-empty">No per-turn ledger yet.</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tb { flex-shrink: 0; border-bottom: 1px solid var(--og-border); }
  .tb-head {
    display: flex;
    align-items: baseline;
    gap: 7px;
    width: 100%;
    padding: 5px 12px;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
  }
  .tb-head:hover { background: var(--og-btn-bg); }
  .tb-caret { display: inline-block; font-size: 10px; color: var(--og-text-muted); transition: transform 0.12s; }
  .tb-caret.is-open { transform: rotate(90deg); }
  .tb-title { font-size: 11px; font-weight: 600; color: var(--og-text); }
  .tb-summary { font-size: 10px; color: var(--og-text-muted); }

  .tb-add { display: flex; gap: 6px; padding: 4px 12px 6px; }
  .tb-input {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: 11px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    padding: 3px 6px;
    outline: none;
  }
  .tb-input:focus { border-color: var(--og-accent); }
  .tb-btn {
    font-size: 10px;
    padding: 2px 8px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    flex: 0 0 auto;
  }
  .tb-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  .tb-btn:disabled { opacity: 0.45; cursor: default; border-color: var(--og-border); }

  .tb-list { list-style: none; margin: 0; padding: 0 12px 4px; display: flex; flex-direction: column; gap: 3px; }
  .tb-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 11px; }
  .tb-name { color: var(--og-text); flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .tb-owner { font-size: 10px; color: var(--og-text-muted); font-family: var(--vscode-editor-font-family, monospace); }
  /* The result and the reopen note are PREVIEWS — one line each, the full text
     on hover, because a finished task's whole answer belongs in the stream. */
  .tb-result, .tb-note {
    flex: 1 1 100%;
    font-size: 10px;
    color: var(--og-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tb-note { color: var(--og-warning); }
  .tb-reopen { display: flex; gap: 6px; flex: 1 1 100%; padding-top: 2px; }

  /* The state is carried in colour AND in the word, never colour alone. */
  .tb-chip {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: 8px;
    border: 1px solid var(--og-border);
    color: var(--og-text-muted);
    flex: 0 0 auto;
  }
  .tb-chip[data-state='claimed'] { border-color: var(--og-accent); color: var(--og-accent); }
  .tb-chip[data-state='done'] { border-color: var(--og-warning); color: var(--og-warning); }
  .tb-chip[data-state='accepted'] { border-color: var(--og-success); color: var(--og-success); }

  .tb-empty { display: block; padding: 4px 12px 8px; font-size: 10px; font-style: italic; color: var(--og-text-muted); }
  .tb-foot { padding: 4px 12px 8px; border-top: 1px solid var(--og-border); }
  .tb-totals { font-size: 10px; color: var(--og-text-secondary); font-family: var(--vscode-editor-font-family, monospace); }
  .tb-ledger { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .tb-ledger-row {
    display: flex;
    gap: 6px;
    font-size: 10px;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .tb-ledger-agent { color: var(--og-text-secondary); flex: 0 0 auto; }
  .tb-ledger-model { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tb-ledger-cost { flex: 0 0 auto; }
</style>

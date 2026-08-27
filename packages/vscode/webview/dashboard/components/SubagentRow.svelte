<script lang="ts">
  // SubagentRow.svelte — ONE row of the sub-agent drawer: its state dot, name,
  // age, model and live-activity tail, plus a FAILED row's dismiss control.
  //
  // EXTRACTED from SubagentDrawer.svelte (t-kgryh1 polish round) when the
  // list-collapse header and the dismiss button together took that file over
  // its cap. The split is by responsibility: SubagentDrawer.svelte owns the
  // DRAWER (slide, tab, collapse) and SubagentGroup.svelte one band of it;
  // this owns what ONE entry looks like. Pure presentation — no lifecycle
  // decisions here, those stay in subagentEntry.ts / subagentRows.ts.
  import { elapsedText } from '../panes/subagentFormat';
  import type { SubagentRow } from '../panes/subagentRows';

  interface Props {
    row: SubagentRow;
    /** Only ever called for a FAILED row — see the markup below. Removes the
     *  row from the drawer's roster; the transcript's own card is untouched. */
    onDismiss: (key: string) => void;
    /** Read this child's OWN session — SubagentDock opens the read-only
     *  transcript over the chat cell. Running or settled: the engine has the
     *  child's stored session throughout. */
    onOpen: (row: SubagentRow) => void;
  }
  let { row, onDismiss, onOpen }: Props = $props();

  const age = $derived(elapsedText(row.elapsedMs));
  // Per-entry collapse (t-kgryh1 round 2): "hide a stream you don't care
  // about". Local and defaulted OPEN — a fresh row starts showing what it is
  // doing, same as before this landed; the chevron is for the ones you don't.
  let expanded = $state(true);
</script>

<li class="sa-row">
  <div class="sa-line">
    <span class="sa-dot sa-{row.state}" aria-hidden="true"></span>
    <span class="sa-name" title={row.title}>{row.title}</span>
    <!-- An unknown age prints NOTHING. "0s" on an agent that has been out for
         a minute is worse than saying nothing at all. -->
    {#if age}<span class="sa-age">{age}</span>{/if}
    <!-- Offered whenever the child has a session of its own — the engine can
         project its stored transcript whether it is still working or long
         finished. A spawn that never created one (a denied ask) has nothing to
         open, so it gets no control rather than one that opens an empty page. -->
    {#if row.taskSessionId}<button class="sa-pop" title="Open transcript" aria-label="Open {row.title}" onclick={() => onOpen(row)}>&#8599;</button>{/if}
    <!-- Collapses just THIS row's activity tail; the header line above stays. -->
    {#if row.activity}<button class="sa-fold" aria-expanded={expanded} aria-label={expanded ? `Collapse ${row.title}` : `Expand ${row.title}`} onclick={() => (expanded = !expanded)}>{expanded ? '▾' : '▸'}</button>{/if}
    <!-- A failed spawn never settles on its own (subagentEntry.ts), so it needs
         an explicit way OUT; ChatPane auto-dismisses these at the next turn. -->
    {#if row.state === 'failed'}
      <button class="sa-dismiss" title="Dismiss" aria-label="Dismiss {row.title}" onclick={() => onDismiss(row.key)}>&times;</button>
    {/if}
  </div>
  <!-- WHICH model, because a sub-agent routinely does NOT run on the one the
       chat shows — a flock binding or this chat's sub-agent override sends it
       elsewhere, and a slow agent's model is the first thing you want to
       know. Absent when the card had none. -->
  {#if row.model}<span class="sa-model" title={row.model}>{row.model}</span>{/if}
  <!-- The last few lines of what it is DOING. Collapsed to a fixed tail
       (never a scrolling log): the drawer answers "still alive, and on
       what", and the transcript's own card holds the rest. Hidden entirely
       when this ONE row is folded. -->
  {#if expanded && row.activity}<pre class="sa-activity">{row.activity}</pre>{/if}
</li>

<style>
  /* A card, matching the row-card convention used across the dashboard
     (ArchetypeAgentCard.svelte, CacheStatsCard.svelte): surface-alt fill,
     border, small radius. Rows used to be borderless flush text; a fan-out of
     several agents read as one grey block with no way to tell where one row
     ended and the next began. */
  .sa-row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    padding: 4px 6px;
    background: var(--og-surface-alt);
    border: 1px solid var(--og-border);
    border-radius: 4px;
  }
  .sa-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .sa-model { padding-left: 12px; font-size: 9px; color: var(--og-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sa-activity {
    margin: 0; padding-left: 12px; font-size: 9px; line-height: 1.35;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted); opacity: 0.85;
    white-space: pre-wrap; word-break: break-word; overflow: hidden;
  }
  .sa-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 10.5px;
    color: var(--og-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sa-age { flex: 0 0 auto; font-size: 9px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }

  /* State in colour AND in motion: a queued agent is a still dot, a running one
     pulses. Colour alone would be one cue in a five-theme board. */
  .sa-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--og-text-muted); }
  .sa-dot.sa-running { background: var(--og-accent); animation: sa-pulse 1.6s infinite; }
  /* A spawn that never happened, and a child that ran and ERRORED: still, and
     the error colour — the count line names both, because colour alone is one
     cue in a five-theme board. A clean finish takes the success tone rather
     than the muted default, which would read as "queued". */
  .sa-dot.sa-failed, .sa-dot.sa-error { background: var(--og-error); }
  .sa-dot.sa-done { background: var(--og-success); }
  @keyframes sa-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  /* Dismiss, open-in-tab and per-row fold share one small icon-button look —
     they are three ends of the same "row-level control" family. */
  .sa-dismiss, .sa-pop, .sa-fold {
    flex: 0 0 auto;
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    padding: 0 2px;
    border-radius: 3px;
    font-family: inherit;
  }
  .sa-dismiss:hover, .sa-pop:hover, .sa-fold:hover { color: var(--og-text); background: var(--og-btn-bg); }
  .sa-fold { font-size: 8px; color: var(--og-text-muted); }
</style>

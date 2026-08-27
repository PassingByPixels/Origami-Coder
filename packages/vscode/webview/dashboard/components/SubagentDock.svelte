<script lang="ts">
  // SubagentDock.svelte — the sub-agent drawer's LIVE wiring: the rows this
  // chat currently has out, and the CLOCK that keeps their ages honest.
  //
  // EXTRACTED from ChatPane.svelte, which was at 2700/2700 when the clock
  // needed room. SubagentDrawer.svelte owns the drawer's shape and
  // SubagentRow.svelte one row; this owns the fact that a roster is a LIVE
  // thing — it re-derives and it ticks.
  //
  // WHY A CLOCK LIVES HERE AT ALL. `subagentRows` takes `now` as a parameter
  // precisely so ages are testable without waiting, but the pane passed
  // `Date.now()` inline: read once per render, with nothing to re-render on the
  // passage of time. Every row froze at the age it was born with — the one
  // number the drawer exists to answer, wrong in the most convincing way.
  // (WHERE that number comes from is subagentTiming.ts's; this only ticks it.)
  //
  // It also owns WHICH child is read — now every child with a session of its
  // own, running or settled alike. A live one used to get a flat `task.log` tab
  // off the forwarded stream, a buffer that is transient and never logged: a
  // reopened chat's is empty, so that tab read "(no output yet)" for a whole
  // multi-hour run. The engine's stored session is there throughout
  // (`subagent_transcript` answers `running: true` with the partial).
  import SubagentDrawer from './SubagentDrawer.svelte';
  import SubagentTranscriptView from './SubagentTranscriptView.svelte';
  import { groupSubagents, subagentRows, type SubagentMessage, type SubagentRow } from '../panes/subagentRows';

  interface Props {
    /** This chat's transcript — the rows are DERIVED from it, never a second
     *  wire that could disagree with the tool cards it was read from. */
    messages: ReadonlyArray<SubagentMessage>;
    /** Roster keys retired by hand, or by the next turn's auto-clear. */
    dismissed: ReadonlyArray<string>;
    open: boolean;
    onToggle: () => void;
    onDismiss: (key: string) => void;
  }
  let { messages, dismissed, open, onToggle, onDismiss }: Props = $props();

  let now = $state(Date.now());
  const rows = $derived(subagentRows(messages, now, new Set(dismissed)));
  // The tick GATE, deliberately a second derivation rather than reading `rows`:
  // `rows` depends on the clock this effect starts, so gating on it would tear
  // the timer down and build a new one every single second. `0` for `now`
  // because only the count is wanted here.
  //
  // RUNNING rows only, never `rows.length`: settled rows stay on the roster now
  // for the Complete group, so a length test would tick a 1s interval forever
  // in every chat that ever spawned one, ageing rows that stopped moving.
  const anyOut = $derived(groupSubagents(subagentRows(messages, 0, new Set(dismissed))).running.length > 0);

  /** The child whose transcript is open, addressed by its own session id — so
   *  the panel keeps working even if the row behind it is dismissed. A row with
   *  no session id is a spawn that never made a child — nothing to read, no ↗. */
  let reading = $state<SubagentRow | null>(null);
  const openRow = (row: SubagentRow) => { if (row.taskSessionId) reading = row; };

  // An idle chat holds no timer, and the ticking stops by itself when the last
  // agent comes home.
  $effect(() => {
    if (!anyOut) return;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
</script>

<SubagentDrawer {rows} {open} {onToggle} {onDismiss} onOpen={openRow} />
{#if reading}
  <SubagentTranscriptView sessionId={reading.taskSessionId ?? ''} title={reading.title} onClose={() => (reading = null)} />
{/if}

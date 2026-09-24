<script lang="ts">
  // SubagentDock.svelte — the sub-agent drawer's LIVE wiring: the rows this
  // chat currently has out, the CLOCK that keeps their ages honest, the
  // CEILING they are warned against, and the two surfaces opened off a row
  // (its transcript, and the agent map).
  //
  // EXTRACTED from ChatPane.svelte, which was at 2700/2700 when the clock
  // needed room. SubagentDrawer.svelte owns the drawer's shape; this owns the
  // fact that a roster is a LIVE thing — it re-derives, ticks, and retires.
  //
  // WHY A CLOCK LIVES HERE AT ALL. `subagentRows` takes `now` so ages are
  // testable without waiting, but the pane once passed `Date.now()` inline,
  // read once per render — every row froze at the age it was born with.
  // (subagentTiming.ts owns the number; this only ticks it.)
  //
  // It also owns WHICH child is read — every child with a session, running or
  // settled. A live one used to get a flat `task.log` tab off the forwarded
  // stream, empty in a reopened chat; the engine's stored session is there
  // throughout instead.
  //
  // A FINISHED ROW IS HISTORY, and the drawer keeps it (t-h8gv8w). There is no
  // "Clear complete" and no age sweep: the owner's reading is that a roster of
  // what ran is worth having, and the COMPLETE band is shut by default anyway,
  // so it costs one line. The ONE way out stays the row's own × — an explicit
  // act, persisted through `subagentDismissed`.
  //
  // The RULES it wires up are all leaves, none of them here: the ceiling from
  // subagentLimitWire.ts, the amber threshold from subagentWarn.ts, the map's
  // layout from subagentMapNodes.ts.
  import SubagentDrawer from './SubagentDrawer.svelte';
  import SubagentMap from './SubagentMap.svelte';
  import SubagentTranscriptView from './SubagentTranscriptView.svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { groupSubagents, subagentLabel, subagentRows, type SubagentRow } from '../panes/subagentRows';
  import type { SubagentDockProps } from '../panes/subagentProps';
  import { watchSubagentLimit } from '../panes/subagentLimitWire';

  // The prop SHAPE lives in subagentProps.ts — see that file's header.
  let { messages, dismissed, open, chatTitle, onToggle, onDismiss, focusMode, onToggleFocus }: SubagentDockProps = $props();

  const vscode = getVsCodeApi();

  let now = $state(Date.now());
  /** The sub-agent ceiling in ms, 0 until the host answers — so nothing ambers
   *  on the strength of a guess. */
  let limitMs = $state(0);
  const rows = $derived(subagentRows(messages, now, new Set(dismissed)));
  // The tick GATE, deliberately a second derivation rather than reading `rows`:
  // `rows` depends on the clock the effect below starts, so gating on it would
  // tear the timer down and build a new one every second. `0` for `now`.
  const idleRows = $derived(subagentRows(messages, 0, new Set(dismissed)));
  // RUNNING rows only, never `rows.length`: settled rows stay on the roster for
  // the Complete group, so a length test would tick 1 s forever in every chat
  // that ever spawned one, ageing rows that stopped moving.
  const anyOut = $derived(groupSubagents(idleRows).running.length > 0);

  /** The child whose transcript is open, by session id — no session id ⇒ nothing to read, no ↗. */
  let reading = $state<SubagentRow | null>(null);
  const openRow = (row: SubagentRow) => { if (row.taskSessionId) reading = row; };
  /** t-q910fo: abort ONE child. The engine takes the CHILD's session id (it
   *  registers the sub-agent job under exactly that id), so nothing is resolved
   *  here; the label rides along only so the failure sentence can name the row.
   *  No confirm — a sub-agent is cheap to launch again. The row settles as
   *  stopped through the normal task result path, not by a local guess here. */
  const stopRow = (row: SubagentRow) => {
    if (!row.taskSessionId) return;
    vscode.postMessage({ type: 'stopSubagent', sessionId: row.taskSessionId, label: subagentLabel(row) });
  };
  /** The agent map, opened from the pull-out's own head. */
  let mapOpen = $state(false);

  // ONE timer: 1 s while anything is out, nothing at all otherwise. A settled
  // row has no age left to age and nothing retires it on the clock any more
  // (t-h8gv8w), so an idle chat holds no interval however long its history is.
  $effect(() => {
    if (!anyOut) return;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  // Ask the host for the ceiling once, and keep listening — the Insights card
  // can change it mid-session (subagentLimitWire.ts).
  $effect(() => watchSubagentLimit({
    post: (msg) => vscode.postMessage(msg),
    listen: (handler) => {
      const onMessage = (event: MessageEvent) => handler(event.data);
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    },
    onLimit: (ms) => { limitMs = ms; },
  }));
</script>

<SubagentDrawer
  {rows}
  {open}
  {onToggle}
  {onDismiss}
  {limitMs}
  onOpen={openRow}
  onStop={stopRow}
  onMap={() => (mapOpen = true)}
/>
{#if mapOpen}
  <SubagentMap
    {rows}
    title={chatTitle}
    onClose={() => (mapOpen = false)}
    onOpen={(key) => {
      const row = rows.find((r) => r.key === key);
      // The map hands off to the SAME transcript path the drawer's ↗ uses, and
      // closes behind it: two stacked overlays over one chat cell is one too many.
      if (row) { mapOpen = false; openRow(row); }
    }}
  />
{/if}
{#if reading}
  <SubagentTranscriptView sessionId={reading.taskSessionId ?? ''} title={subagentLabel(reading)} onClose={() => (reading = null)}
    {focusMode} {onToggleFocus} />
{/if}

// subagentTiming.ts — how long a sub-agent has been out, and where that
// number is allowed to come from.
//
// The drawer used to age every row from the tool card's own `timestamp`,
// which chatToolMsg.ts stamps `Date.now()` when the card is built. Live
// that's right, but after a reload it's a lie: the replay rebuilds every
// card and stamps the whole roster with the reload instant, so an hour-long
// fan-out came back reading `0s` on every row.
//
// The fix is a source, not a formula: the engine now rides the child's real
// span on the task card (`origami_task_started`/`origami_task_ended`, off
// the stored tool state or the injected completion for a detached child).
// acpTaskMeta.ts decodes them; taskRiders.ts merges them onto the card; this
// file decides what to print.
//
// Split from subagentRows.ts by responsibility: that file answers "which
// agents are on the roster", this one "how long has this one been out".
// Pure and DOM-free, with the clock injected, like its siblings.

/** The engine-supplied span a task card carries. Extended by the card shapes
 *  rather than re-declared on each, so a field cannot arrive on one and be
 *  missing from the next. */
export interface SubagentSpan {
  /** Epoch ms the child STARTED, from the engine's stored tool state. */
  taskStartedAt?: number;
  /** Epoch ms it ENDED. Absent while it is still out. */
  taskEndedAt?: number;
}

/** What this reads off a roster message: the engine's span, plus the card's own
 *  build stamp as the LAST resort. */
export interface SubagentTimed extends SubagentSpan {
  /** Epoch ms the CARD was built — right live, the reload instant after a
   *  reopen. Used only when the engine supplied nothing. */
  timestamp?: number;
}

const at = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** How long this sub-agent ran, in milliseconds, or `0` for "unknown". A
 *  settled span (both ends known) is `end - start` and freezes there rather
 *  than ageing with the drawer's shared tick. With a start and no end the row
 *  is still out, so the honest number is `now - start`, ticking.
 *
 *  `settled` is the row's own lifecycle answer (subagentEntry.ts `isSettled`),
 *  and it is what stops the owner's defect: a child whose END was never
 *  observed — a terminal marker that arrived with no `time.created`, or a
 *  hydrated chat whose finish happened while the window was shut — has a start,
 *  no end, and is NOT out. Ageing that off the wall clock printed "23h 47m" on
 *  agents that ran for five minutes. A finished row with no end reports `0`
 *  (unknown), which SubagentRow.svelte draws as an em dash: "it ended, nobody
 *  timed it" rather than a clock that is still running.
 *
 *  The `timestamp` fallback is deliberately last AND gated on the row still
 *  being out: reached only when the engine rode no start at all (an older
 *  build), it can still print a reload's `0s`, but dropping it would blank a
 *  live drawer against that engine. */
export function subagentElapsed(m: SubagentTimed, now: number, settled: boolean): number {
  const started = at(m.taskStartedAt);
  const ended = at(m.taskEndedAt);
  if (started && ended) return Math.max(0, ended - started);
  if (settled) return 0;
  const from = started || at(m.timestamp);
  // Clamped at 0: a skew between the engine's stamp and the webview's `now`
  // must not print a negative age.
  return from ? Math.max(0, now - from) : 0;
}

/** The SPAWN stamp a `task` card is born with (t-qn0lpl), and the reason the
 *  fallback above is no longer the one a running row reaches.
 *
 *  The engine's `taskStartedAt` rides the RESULT frame (taskRiders.ts merges it
 *  there), so a child still out has never had one, and the row fell through to
 *  `timestamp` — which chatRestore.ts rewrites to the instant the step
 *  ORIGINALLY ran. A run recalled four days later reported an agent 96 hours
 *  out. Stamped at spawn, a running row ages from when its card was built, and
 *  `mergeTaskRiders` still lets the engine's real start overwrite it. */
export function spawnStamp(toolName: string | undefined, now: number): { taskStartedAt?: number } {
  return toolName === 'task' ? { taskStartedAt: now } : {};
}

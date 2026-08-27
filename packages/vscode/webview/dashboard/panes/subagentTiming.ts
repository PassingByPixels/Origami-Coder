// subagentTiming.ts — HOW LONG a sub-agent has been out, and where that number
// is allowed to come from.
//
// THE BUG THIS EXISTS FOR. The drawer aged every row from the tool card's own
// `timestamp`, which chatToolMsg.ts stamps `Date.now()` when the card is BUILT.
// Live that is right — the card is built as the agent is spawned. After a
// RELOAD it is a lie: the window reopens each chat through the engine's
// `session/load`, the replay rebuilds every card, and the whole roster is
// stamped with the instant of the reload. `now - stamp` was then a few hundred
// milliseconds, so a fan-out that had been running for an hour and a half came
// back reading `0s` on every row — running, complete and errored alike.
//
// THE FIX IS A SOURCE, NOT A FORMULA. The replay carries no time of its own
// (verified against the captured `reloadReplay.fixture.json`), so the engine now
// rides the child's real span on the task card: `origami_task_started` off the
// stored tool state, and `origami_task_ended` off either that state (a
// FOREGROUND child) or the injected completion (a DETACHED one, whose launcher
// ended back at spawn). acpTaskMeta.ts decodes them; taskRiders.ts merges them
// onto the card; this file is the one place that decides what to print.
//
// EXTRACTED rather than added to subagentRows.ts, which was at 119/120 — and
// the split is by responsibility anyway: that file answers "which agents are on
// the roster", this one "how long has this one been out", which is the number
// the drawer exists to report and the one that was wrong.
//
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

/**
 * How long this sub-agent ran, in milliseconds, or `0` for "unknown" — which
 * subagentFormat.ts prints as NOTHING rather than as `0s`.
 *
 * A SETTLED span (both ends known) is `end - start` and does not move again.
 * That is not only the reload fix: live, a completed row kept ageing off the
 * wall clock for as long as any SIBLING agent was still out, because the
 * drawer's 1s tick runs for the whole roster. Its total now freezes the moment
 * its own marker lands.
 *
 * With a start and no end the row is still out, so the honest number is its age
 * — `now - start`, ticking.
 *
 * THE FALLBACK IS DELIBERATELY LAST. `timestamp` is only reached when the
 * engine rode no start at all: a card from an engine build older than the
 * rider. It keeps the live path working there exactly as it did, and it is the
 * one case that can still print a reload's `0s`. Preferring it would reinstate
 * the bug; dropping it would blank a live drawer against an older engine.
 */
export function subagentElapsed(m: SubagentTimed, now: number): number {
  const started = at(m.taskStartedAt);
  const ended = at(m.taskEndedAt);
  if (started && ended) return Math.max(0, ended - started);
  const from = started || at(m.timestamp);
  // Clamped at 0: a skew between the engine's stamp and the webview's `now`
  // must not print a negative age.
  return from ? Math.max(0, now - from) : 0;
}

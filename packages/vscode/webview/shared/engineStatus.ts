// The `origami/sessionStatus` label, read the ONE way both of its consumers
// have to read it — the chat list's activity ring (chat/ChatsList.svelte) and
// the composer's in-flight flag (dashboard/panes/ChatPane.svelte).
//
// The engine sends its own per-session run state because `turnDone` cannot
// cover a turn the ENGINE started: a background task result being injected, a
// /loop run, a wakeup. Those have no ACP `prompt()` in flight to settle, so
// the list's pill went green while the model was still working.
//
// Two rules, and they are the reason this is a function rather than a `===`
// inlined twice:
//   1. Only 'idle' means the chat is yours again. Every other label — 'busy',
//      'retry', and whatever a newer engine adds — means a turn is still
//      moving. Read that way round on purpose: an unknown label must never
//      read as done, because the failure that costs the user something is a
//      chat that claims to be finished while it is not.
//   2. A message with no usable label answers NEITHER. `null` is not "idle";
//      a malformed wire message must leave the surface exactly as it was.

/** `true` = a turn is running, `false` = the session is idle, `null` = the
 *  message carried no usable status and nothing should change. */
export function engineTurnRunning(status: unknown): boolean | null {
  if (typeof status !== 'string' || !status) return null;
  return status !== 'idle';
}

/** What the composer's in-flight state becomes, or `null` for "leave it". */
export type TurnFlags = { inFlight: boolean; engineTurn: boolean };

/**
 * The composer's flag, which needs MORE than rule 1 above — the ring does not.
 *
 * A ring is cosmetic and `turnDone` settles it either way. The composer's flag
 * gates sending, so lowering it early is a real defect: the `idle` SSE event
 * and the JSON-RPC response that produces `turnDone` race by design, and for a
 * user-typed turn `idle` can land first. In that gap InputBar's held send fires
 * into a turn whose `prompt()` has not resolved, and the OLD turn's late
 * `turnDone` then lowers the flag over the NEW turn.
 *
 * So the status may only release a turn it ADOPTED: `busy` adopts a turn that
 * is not already in flight (nobody typed it — an injected background-task
 * result, a wakeup), and only such a turn is lowered by `idle`. A user-typed
 * turn, a /loop run and a /firstfold all raise the flag by their own path and
 * still have a terminal message coming; this leaves every one of them alone.
 *
 * Callers must clear `engineTurn` wherever they raise or lower `inFlight`
 * themselves, so a turn that ended by any other route cannot leave the next
 * one wearing this one's label.
 */
export function applyEngineStatus(current: TurnFlags, status: unknown): TurnFlags | null {
  const running = engineTurnRunning(status);
  if (running === null) return null;
  if (running) return current.inFlight ? null : { inFlight: true, engineTurn: true };
  if (!current.inFlight || !current.engineTurn) return null;
  return { inFlight: false, engineTurn: false };
}

// acpTaskMeta.ts — the `_meta` riders the engine puts on SUB-AGENT traffic.
//
// Extracted from acpClient.ts (which sat six lines under its architecture cap)
// when the drawer needed three more facts than the child's session id. Every
// key here is written by packages/engine/src/acp/event.ts — `withTaskSession`
// for the launcher's tool updates, `taskResultMarkers` for the terminal one —
// and MIRRORED here because the webview cannot import engine code. The mirror
// is guarded by acpTaskMeta.test.ts, which reads BOTH files and fails if either
// side renames a key: a silent rename would leave the drawer permanently
// showing agents that finished an hour ago, with nothing red anywhere. Every
// rider decorates a real ACP update — a plain client that ignores `_meta` sees
// a normal tool call and an empty message chunk.

/** Riders on a `task` tool_call / tool_call_update. */
export interface TaskRiders {
  /** The sub-agent SESSION this card spawned — the join key for its stream. */
  taskSessionId?: string;
  /** The child was DETACHED: this call completing means "spawned", not
   *  "finished", so the card's own status must not retire its drawer row. */
  taskBackground?: boolean;
  /** `provider/model` the child was actually routed to (a flock binding or the
   *  chat's sub-agent override routinely differ from the parent's model). */
  taskModel?: string;
  /** Epoch ms the sub-agent STARTED, off the engine's STORED tool state — the
   *  only start that survives a reload, which rebuilds a card stamped NOW. */
  taskStartedAt?: number;
  /** Epoch ms it ENDED. Never on a DETACHED child (its launcher returns at
   *  spawn); that one ends on the terminal marker below. */
  taskEndedAt?: number;
}

/** A settled BACKGROUND child, off the injected result turn's marker chunk. */
export interface TaskDone {
  taskSessionId: string;
  state: 'completed' | 'error';
  /** Epoch ms it settled; absent when the replayed turn carried no time. */
  endedAt?: number;
}

function meta(update: unknown): Record<string, unknown> | undefined {
  const m = (update as { _meta?: unknown } | undefined)?._meta;
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : undefined;
}

/** A finite epoch-ms rider, or undefined — `0` prints as a 56-year run. */
function stamp(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** The riders present on this update; absent fields stay undefined so the
 *  result can be spread over handler args without erasing anything. */
export function taskRiders(update: unknown): TaskRiders {
  const m = meta(update);
  if (!m) return {};
  const model = m.origami_task_model;
  return {
    taskSessionId: typeof m.origami_task_session === 'string' ? m.origami_task_session : undefined,
    taskBackground: m.origami_task_background === true ? true : undefined,
    taskModel: typeof model === 'string' && model ? model : undefined,
    taskStartedAt: stamp(m.origami_task_started),
    taskEndedAt: stamp(m.origami_task_ended),
  };
}

/**
 * The terminal marker, or undefined for every other chunk. Requires BOTH the
 * child id and a known state — a half-formed marker must not retire a row,
 * because a row wrongly retired is a running agent nobody is watching.
 */
export function taskDone(update: unknown): TaskDone | undefined {
  const m = meta(update);
  if (!m) return undefined;
  const id = m.origami_task_session;
  const state = m.origami_task_state;
  if (typeof id !== 'string' || !id) return undefined;
  if (state !== 'completed' && state !== 'error') return undefined;
  const endedAt = stamp(m.origami_task_ended);
  return { taskSessionId: id, state, ...(endedAt === undefined ? {} : { endedAt }) };
}

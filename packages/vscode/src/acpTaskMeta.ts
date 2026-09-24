// The `_meta` riders the engine puts on SUB-AGENT traffic. Every key is written by
// packages/engine/src/acp/event.ts and MIRRORED here because the webview cannot import
// engine code; acpTaskMeta.test.ts reads BOTH files and fails if either side renames a
// key. Every rider decorates a real ACP update, so a plain client sees a normal tool call.

import { taskTokensOf, type TaskTokens } from './acpTaskTokens';

export { TASK_TOKEN_FIELDS, taskTokensOf, type TaskTokens } from './acpTaskTokens';

/** Riders on a `task` tool_call / tool_call_update. */
export interface TaskRiders {
  /** The sub-agent SESSION this card spawned — the join key for its stream. */
  taskSessionId?: string;
  /** DETACHED: completing means "spawned", not "finished" — never retire the row. */
  taskBackground?: boolean;
  /** `provider/model` it was actually routed to (a binding or an override differs). */
  taskModel?: string;
  /** Epoch ms it STARTED, off the engine's STORED tool state — the only start a reload keeps. */
  taskStartedAt?: number;
  /** Epoch ms it ENDED. Never on a DETACHED child; that one ends on the marker below. */
  taskEndedAt?: number;
  /** Spend so far, re-sent per child step; absent on an older engine (fail-open). */
  taskTokens?: TaskTokens;
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

/** The riders present on this update; absent fields stay undefined so the result can be spread over
 *  handler args. */
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
    taskTokens: taskTokensOf(m.origami_task_tokens),
  };
}

/** t-gvz8t0. WHAT a forwarded sub-agent chunk is: `'reasoning'` = the child's
 *  thought, undefined = its prose (every chunk from an older engine). Fail-open
 *  toward the OLD behaviour — an unknown value is not reasoning, so a marker
 *  this side cannot read never hides a line from the stream. */
export function taskPart(update: unknown): 'reasoning' | undefined {
  return meta(update)?.origami_task_part === 'reasoning' ? 'reasoning' : undefined;
}

/** The terminal marker, or undefined for every other chunk. Requires BOTH the child id
 *  and a known state — a row wrongly retired is a running agent nobody is watching. */
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

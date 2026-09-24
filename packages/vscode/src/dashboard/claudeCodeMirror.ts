// claudeCodeMirror.ts — a finished passthrough turn, copied into the cell's
// own ENGINE session.
//
// A passthrough chat binds a real engine session and never writes to it, so
// every surface that reads engine truth (History, Labyrinth, usage tables)
// showed nothing. Stores a COPY via the engine's `session_append_foreign`
// ext method, rather than teaching Origami to read Claude's own transcript
// files, since that layout isn't ours and can change. Best-effort: a mirror
// failure is logged and never costs the user a turn they can see on screen.

import { CLAUDE_CODE_PROVIDER } from '../claudeCode/models';
import type { ResultUsage } from '../claudeCode/protocol';

/** The engine client, structurally — the two members this feature needs, so
 *  nothing here depends on AcpClient. Same shape secondOpinion.ts declares. */
export interface MirrorEngine {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The ENGINE's id for this chat. Null before the ACP session exists — and a
   *  turn that lands in that window is dropped rather than guessed at. */
  readonly currentSessionId: string | null;
}

export interface MirrorHost {
  /** This cell's engine session, as the panel holds it. Absent on a host that
   *  predates the mirror: the turn is then simply not copied. */
  engine?(sessionId: string): { client?: MirrorEngine | null; cwd?: string } | undefined;
  log(line: string): void;
}

/** The engine's ext method. Its contract lives with the engine. */
export const MIRROR_METHOD = 'session_append_foreign';

/** Per message. A passthrough reply can run for minutes and a mirrored row is a
 *  RECORD, not a replay — past this the transcript reads the same and the JSON-RPC
 *  frame stops being one. */
export const TEXT_CAP = 60_000;

/** Per turn. A long agentic turn can run dozens of tools; the summary is for
 *  reading, and the engine bounds the batch at 100 messages either way. */
export const TOOL_CAP = 50;

interface PendingTool {
  id: string;
  name: string;
  title?: string;
  status?: string;
}

interface PendingTurn {
  startedAt: number;
  user: string;
  agent: string;
  tools: PendingTool[];
  /** What the CLI measured for this turn, off the closing `result`. A SIZE, not
   *  a price: the engine still stores the row with `cost: 0` and no step-finish
   *  part (foreign-transcript.ts). */
  tokens?: ResultUsage['tokens'];
}

const turns = new Map<string, PendingTurn>();

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function open(sessionId: string): PendingTurn {
  const existing = turns.get(sessionId);
  if (existing) return existing;
  const fresh: PendingTurn = { startedAt: Date.now(), user: '', agent: '', tools: [] };
  turns.set(sessionId, fresh);
  return fresh;
}

/**
 * One post from the passthrough funnel → the turn buffer, and a flush at the
 * end of it. Reads the same posts the replay log reads. `turnDone` closes a
 * turn from any of its three producers (result, cancel, unexpected exit).
 */
export function mirrorPost(host: MirrorHost, sessionId: string, post: Record<string, unknown>): void {
  const type = str(post.type);
  if (type === 'echoUser') {
    // A NEW turn. Any half-open one is abandoned rather than merged: two user
    // lines in one mirrored message would misrepresent the conversation.
    turns.delete(sessionId);
    open(sessionId).user = str(post.text).slice(0, TEXT_CAP);
    return;
  }
  if (type === 'agentText') {
    const turn = open(sessionId);
    // Deltas, exactly as the replay log receives them.
    if (turn.agent.length < TEXT_CAP) turn.agent = (turn.agent + str(post.text)).slice(0, TEXT_CAP);
    return;
  }
  if (type === 'toolCall') {
    const turn = open(sessionId);
    const id = str(post.toolCallId);
    const name = str(post.toolName) || str(post.title) || 'tool';
    if (turn.tools.length >= TOOL_CAP) return;
    turn.tools.push({ id, name, ...(str(post.title) ? { title: str(post.title) } : {}) });
    return;
  }
  if (type === 'toolResult') {
    const turn = turns.get(sessionId);
    if (!turn) return;
    const id = str(post.toolCallId);
    const entry = turn.tools.find((t) => t.id === id);
    if (!entry) return;
    // The RESOLVED title only lands on the result (a Write's title is the file
    // it wrote), same rule the live card and the replay log both follow.
    if (str(post.title)) entry.title = str(post.title);
    // `failed` is the translator's own word for a denied or errored tool
    // (translator.fromUser reads the CLI's `is_error`); `error` is the engine
    // store's. One rename, in the one place that crosses between them.
    if (str(post.status) === 'failed') entry.status = 'error';
    return;
  }
  if (type === 'turnDone') {
        // Absent on a cancel or a dead child — neither carries a `result`, and
        // no zeros are invented for a measurement nobody made.
    const turn = turns.get(sessionId);
    if (turn && post.tokens && typeof post.tokens === 'object') turn.tokens = post.tokens as ResultUsage['tokens'];
    void flush(host, sessionId);
  }
}

/** Everything this cell has buffered, dropped. Called when a binding ends: the
 *  next engine turn owns the session again and must not inherit a half-turn. */
export function resetMirror(sessionId: string): void {
  turns.delete(sessionId);
}

/** Test seam — the module-level buffer is deliberate, so a suite needs a way
 *  back to a clean slate. */
export function __resetMirrorForTests(): void {
  turns.clear();
}

/**
 * The turn, as `session_append_foreign` takes it. The id is
 * `<cell>:<turn start>:<role>` — stable per turn, unique across reloads,
 * which is what the engine's idempotency guard compares.
 */
export function batchOf(sessionId: string, turn: PendingTurn): Array<Record<string, unknown>> {
  const stamp = `${sessionId}:${turn.startedAt}`;
  const batch: Array<Record<string, unknown>> = [];
  if (turn.user) batch.push({ id: `${stamp}:u`, role: 'user', text: turn.user, timestamp: turn.startedAt });
  if (turn.agent || turn.tools.length > 0) {
    batch.push({
      id: `${stamp}:a`,
      role: 'assistant',
      text: turn.agent,
      timestamp: Date.now(),
      // Absent field ⇒ the engine falls back to zeros, the shape older builds sent.
      ...(turn.tokens ? { tokens: turn.tokens } : {}),
      ...(turn.tools.length > 0
        ? { toolCalls: turn.tools.map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), ...(t.status ? { status: t.status } : {}) })) }
        : {}),
    });
  }
  return batch;
}

/** The turn buffered for this cell, or undefined. Exported for the seam test. */
export function pendingTurn(sessionId: string): PendingTurn | undefined {
  return turns.get(sessionId);
}

async function flush(host: MirrorHost, sessionId: string): Promise<void> {
  const turn = turns.get(sessionId);
  turns.delete(sessionId);
  if (!turn) return;
  const batch = batchOf(sessionId, turn);
  if (batch.length === 0) return;
  const cell = host.engine?.(sessionId);
  const client = cell?.client;
  const engineSessionId = client?.currentSessionId;
  if (!client || !engineSessionId) return;
  try {
    await client.extMethod(MIRROR_METHOD, {
      sessionId: engineSessionId,
      source: CLAUDE_CODE_PROVIDER,
      messages: batch,
      ...(cell?.cwd ? { cwd: cell.cwd } : {}),
    });
  } catch (e) {
    host.log(`[claude-code] mirror failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

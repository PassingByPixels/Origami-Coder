// subagentTodos.ts — how a SUB-AGENT's todo list reaches the Todo panel, which
// is not the way the parent's does.
//
// The parent's list arrives on the wire: `todowrite` is a real ACP tool call on
// the client's own session, acpClient.ts recognises it and posts `todoUpdate`.
// A CHILD's never does. acp/event.ts refuses to forward a sub-agent's tool parts
// as tool calls at all (a forwarded call would materialise a top-level card in
// every client); it degrades each one to a single tagged text line — `>
// todowrite` — under the PARENT's session id. The list itself is dropped on the
// engine side, so there is nothing on the wire to decode. That is why the owner
// could see nine todos rendered as raw JSON inside a sub-agent's transcript and
// nothing at all in the Todo panel.
//
// So the line is used as a SIGNAL, not as data: it says "this child just wrote
// todos", and the host answers by asking the engine for it.
//
// t-qd2riw. That pull used to be the WHOLE `subagent_transcript` read the
// drawer's ↗ makes — one call carrying the child's entire stored session, just
// to scan it backward here for the last todowrite. `subagentTodosPayload`
// (subagentTodosPayload.ts, extracted to keep this file under its cap) is the
// bounded replacement: it calls the engine's `subagent_todos`, which walks the
// child's stored messages backward in fixed-size pages server-side and stops
// at the first hit, then wraps that single hit into the same one-entry shape
// `todosFromTranscript` below already knows how to read.
//
// The pulls are still coalesced per child (one in flight, one queued, later
// signals folded into it) — that cost was never the transcript size, it was
// one engine round trip per todowrite, and still is.

import { todosFromUpdate, type TodoRow } from '../acpTodoWrite';
import type { SessionMessage } from './sessionLog';

/** Does this forwarded child chunk announce a `todowrite`?
 *
 *  Matched against the shape acp/event.ts's `childToolLine` actually writes —
 *  `> <tool>` or `> <tool>: <title>` — and anchored per line, because one chunk
 *  can carry the tool line and a following error line. The tool id is the
 *  engine's own (`tool/todo.ts`, `TodoWriteTool` is defined as "todowrite"). */
export function saysTodoWrite(text: string): boolean {
  return /^>\s*todowrite\b/m.test(text);
}

/** The LATEST todo list in a child's transcript, or `[]` when it wrote none.
 *
 *  Last one wins, searched backwards: `todowrite` replaces the whole list every
 *  time, so an earlier call is a superseded snapshot, never a part of the
 *  current one. Reads `rawInput` rather than the result content because a call
 *  still in flight has an input and no result yet — which is the ordinary case
 *  here, the signal being sent at tool START. */
export function todosFromTranscript(entries: readonly SessionMessage[]): TodoRow[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const call = entries[i]?.tool?.call as { toolName?: unknown; rawInput?: unknown } | undefined;
    if (call?.toolName !== 'todowrite') continue;
    const todos = todosFromUpdate({ rawInput: (call.rawInput ?? null) as { todos?: unknown } | null });
    if (todos) return todos;
  }
  return [];
}

export interface SubagentTodoDeps {
  /** The child's latest todowrite call, already shaped — `subagentTodosPayload`
   *  in production (t-qd2riw), a bounded engine lookup, not a transcript read. */
  read(childSessionId: string): Promise<{ entries: SessionMessage[] }>;
  /** Hand the decoded list to the webview. Called even for an EMPTY list: that
   *  is how a tab disappears when a child clears its todos. */
  post(childSessionId: string, todos: TodoRow[]): void;
  /** Read failures are reported, never thrown at the caller: this runs off a
   *  chunk handler, and one unreadable child must not break the stream. */
  log?(line: string): void;
}

/**
 * A puller with one rule: AT MOST ONE READ PER CHILD AT A TIME.
 *
 * A model writing a nine-item list can emit several `todowrite` calls in a few
 * seconds, and each read returns a whole transcript. Signals that arrive while
 * a read is in flight set a "go again when this one lands" flag rather than
 * queueing, so N signals during one read cost exactly one more read — and the
 * last state always wins, because the extra read happens after the last signal.
 */
export function makeSubagentTodoPuller(deps: SubagentTodoDeps): (childSessionId: string) => void {
  const inFlight = new Set<string>();
  const again = new Set<string>();

  async function run(child: string): Promise<void> {
    inFlight.add(child);
    try {
      deps.post(child, todosFromTranscript((await deps.read(child)).entries));
    } catch (e) {
      deps.log?.(`[subagent-todos] ${child}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight.delete(child);
    }
    if (!again.delete(child)) return;
    await run(child);
  }

  return (childSessionId: string) => {
    if (!childSessionId) return;
    if (inFlight.has(childSessionId)) {
      again.add(childSessionId);
      return;
    }
    void run(childSessionId);
  };
}

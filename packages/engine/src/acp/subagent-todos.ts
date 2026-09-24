import type { SessionMessageResponse } from "@origami/sdk/v2"

/**
 * t-qd2riw. THE child's latest `todowrite` call, found without a whole-transcript
 * read.
 *
 * subagentTodos.ts (host) used to pull a CHILD's entire stored session — via
 * `subagent_transcript` with no `limit` — every time it saw the forwarded
 * `> todowrite` signal, just to scan it backward for the last todowrite part.
 * On a long child that is the read t-krxap7 already fixed for the transcript
 * panel, still happening here. This moves the scan server-side and bounds it
 * the same way t-krxap7 bounds a transcript page: never more than one block of
 * stored messages per store round trip.
 *
 * `tool/todo.ts` names the tool "todowrite". `rawInput` is read rather than a
 * settled result because the host's signal fires at tool START (acp/event.ts's
 * forwarded line races the completed frame) — a call still in flight has an
 * input and no output yet, which is the ordinary case here.
 */
const TODOWRITE = "todowrite"

export type TodoWriteHit = { readonly rawInput: unknown }

type ToolPartLike = { readonly type?: unknown; readonly tool?: unknown; readonly state?: { readonly input?: unknown } }

/**
 * The newest `todowrite` tool part in this page, searched from the END —
 * newest message first, newest part within it first — so the first hit found
 * is the latest call. `undefined` means this page holds none; the caller
 * pages further back.
 */
export function latestTodoWrite(messages: readonly SessionMessageResponse[]): TodoWriteHit | undefined {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const parts = messages[mi]?.parts ?? []
    for (let pi = parts.length - 1; pi >= 0; pi--) {
      const part = parts[pi] as ToolPartLike | undefined
      if (!part || part.type !== "tool" || part.tool !== TODOWRITE) continue
      return { rawInput: part.state?.input ?? null }
    }
  }
  return undefined
}

export type SubagentTodosResult = {
  readonly sessionId: string
  /** False when the child's messages could not be read at all — same meaning
   *  as `subagent_transcript`'s `found`. */
  readonly found: boolean
  /** The latest todowrite's raw input, absent when the child wrote none (or
   *  when the walk exhausted the transcript without finding one). */
  readonly rawInput?: unknown
}

export * as SubagentTodos from "./subagent-todos"

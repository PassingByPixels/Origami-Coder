// t-qd2riw. Left over from t-krxap7: the transcript panel now pages, but the
// host's todo lookup (subagentTodos.ts) still asked `subagent_transcript` with
// no `limit` — the whole child session — just to find its last todowrite. This
// covers the bounded replacement: `subagent_todos` walks the same paged store
// read backward in fixed-size blocks and stops at the first hit.
//
// The bugs worth catching: a "bounded" read that still asks for everything in
// one call because the loop forgot the page size; a scan that finds the FIRST
// todowrite instead of the LAST; a walk that never terminates when the child
// wrote none at all; and a vanished child that throws instead of answering
// `found: false`.

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient, SessionMessageResponse } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"
import { latestTodoWrite } from "@/acp/subagent-todos"
import { MessageV2 } from "@/session/message-v2"

const child = "ses_child"

function assistantMessage(idSuffix: string, created: number, parts: unknown[]): SessionMessageResponse {
  return {
    info: { id: `msg_${idSuffix}`, sessionID: child, role: "assistant", time: { created, completed: created + 1 } },
    parts,
  } as unknown as SessionMessageResponse
}

function textPart(id: string): unknown {
  return { id: `prt_${id}`, sessionID: child, messageID: id, type: "text", text: `step ${id}` }
}

function todoPart(id: string, todos: unknown[]): unknown {
  return {
    id: `prt_${id}_tw`,
    sessionID: child,
    messageID: id,
    type: "tool",
    callID: `call_${id}`,
    tool: "todowrite",
    state: { status: "running", input: { todos } },
  }
}

const list = (...contents: string[]) => contents.map((content) => ({ content, status: "pending" }))

describe("latestTodoWrite — the newest todowrite part in ONE page", () => {
  it("finds it searching from the end, newest message and newest part first", () => {
    const hit = latestTodoWrite([
      assistantMessage("a1", 1, [todoPart("a1", list("old"))]),
      assistantMessage("a2", 2, [textPart("a2")]),
      assistantMessage("a3", 3, [todoPart("a3", list("current"))]),
    ])
    expect((hit?.rawInput as { todos: unknown[] }).todos).toEqual(list("current"))
  })

  it("is undefined for a page with no todowrite at all", () => {
    expect(latestTodoWrite([assistantMessage("a1", 1, [textPart("a1")])])).toBeUndefined()
    expect(latestTodoWrite([])).toBeUndefined()
  })

  it("ignores a non-tool part and a tool part for a different tool", () => {
    const hit = latestTodoWrite([
      assistantMessage("a1", 1, [
        textPart("a1"),
        { id: "p2", sessionID: child, messageID: "a1", type: "tool", callID: "c", tool: "bash", state: { input: {} } },
      ]),
    ])
    expect(hit).toBeUndefined()
  })
})

describe("subagent_todos — bounded backward walk over the wire", () => {
  /** A store that honours limit/before exactly like `subagent-transcript.test.ts`'s
   *  `pagedSdk`, plus a spy on every call's params. */
  function pagedSdk(all: SessionMessageResponse[], seen: Array<{ limit?: number; before?: string }>) {
    return {
      session: {
        messages: (params: { sessionID: string; limit?: number; before?: string }) => {
          seen.push({ limit: params.limit, before: params.before })
          let rows = all
          if (params.before) {
            const at = MessageV2.cursor.decode(params.before)
            rows = rows.filter((m) => (m.info as { time: { created: number } }).time.created < at.time)
          }
          return Promise.resolve({ data: params.limit ? rows.slice(-params.limit) : rows })
        },
      },
    } as unknown as OrigamiClient
  }

  it("finds a RECENT todowrite in ONE bounded call — the common case", async () => {
    const seen: Array<{ limit?: number; before?: string }> = []
    const messages = [
      assistantMessage("a1", 1, [textPart("a1")]),
      assistantMessage("a2", 2, [todoPart("a2", list("read", "write"))]),
      assistantMessage("a3", 3, [textPart("a3")]),
    ]
    const service = ACPService.make({ sdk: pagedSdk(messages, seen) })

    const result = await Effect.runPromise(service.subagentTodos({ sessionId: child }))

    expect(seen).toHaveLength(1)
    expect(seen[0]!.limit).toBeLessThanOrEqual(51)
    expect(result.found).toBe(true)
    expect((result.rawInput as { todos: unknown[] }).todos).toEqual(list("read", "write"))
  })

  // The fixture the ticket asks for: 500 stored messages, one todowrite EARLY
  // on (message 5) and 495 messages of unrelated work after it. A whole-
  // transcript read would fetch all 500 in ONE call; this must never make a
  // call larger than the page size, however many bounded calls it takes.
  it("walks backward across many bounded pages to reach an EARLY todowrite, never fetching one huge block", async () => {
    const seen: Array<{ limit?: number; before?: string }> = []
    const messages: SessionMessageResponse[] = []
    for (let i = 0; i < 500; i++) {
      const id = `a${i}`
      messages.push(assistantMessage(id, i, i === 5 ? [todoPart(id, list("very old plan"))] : [textPart(id)]))
    }
    const service = ACPService.make({ sdk: pagedSdk(messages, seen) })

    const result = await Effect.runPromise(service.subagentTodos({ sessionId: child }))

    expect(result.found).toBe(true)
    expect((result.rawInput as { todos: unknown[] }).todos).toEqual(list("very old plan"))
    // Bounded: every single call asked for a small page, never the 500-row
    // whole-transcript read the old host code produced.
    expect(seen.length).toBeGreaterThan(1)
    for (const call of seen) expect(call.limit).toBeLessThanOrEqual(51)
  })

  it("takes the LATEST of two todowrite calls, not the first", async () => {
    const seen: Array<{ limit?: number; before?: string }> = []
    const messages = [
      assistantMessage("a1", 1, [todoPart("a1", list("old plan"))]),
      assistantMessage("a2", 2, [todoPart("a2", list("current plan", "step two"))]),
    ]
    const service = ACPService.make({ sdk: pagedSdk(messages, seen) })

    const result = await Effect.runPromise(service.subagentTodos({ sessionId: child }))

    expect((result.rawInput as { todos: unknown[] }).todos).toEqual(list("current plan", "step two"))
  })

  it("reaches the head and reports found with no rawInput when the child wrote no todos", async () => {
    const seen: Array<{ limit?: number; before?: string }> = []
    const messages = Array.from({ length: 120 }, (_, i) => assistantMessage(`a${i}`, i, [textPart(`a${i}`)]))
    const service = ACPService.make({ sdk: pagedSdk(messages, seen) })

    const result = await Effect.runPromise(service.subagentTodos({ sessionId: child }))

    expect(result.found).toBe(true)
    expect(result.rawInput).toBeUndefined()
    expect(seen.length).toBeGreaterThan(1)
    for (const call of seen) expect(call.limit).toBeLessThanOrEqual(51)
  })

  it("answers a vanished child with found:false instead of throwing", async () => {
    const sdk = {
      session: { messages: () => Promise.reject(new Error("no such session")) },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })

    const result = await Effect.runPromise(service.subagentTodos({ sessionId: "ses_gone" }))

    expect(result).toEqual({ sessionId: "ses_gone", found: false })
  })
})

describe("subagent_todos ext dispatch", () => {
  it("accepts the `_` wire prefix, and requires a string sessionId", async () => {
    const service = {
      subagentTodos: (input: { sessionId: string }) => Effect.succeed({ sessionId: input.sessionId, found: true }),
    } as unknown as ACPService.Interface
    const agent = new Agent(service)

    const prefixed = await agent.extMethod("_subagent_todos", { sessionId: child })
    const bare = await agent.extMethod("subagent_todos", { sessionId: child })

    expect(prefixed).toEqual(bare)
    expect(prefixed).toMatchObject({ sessionId: child, found: true })
    expect(() => agent.extMethod("_subagent_todos", {})).toThrow()
  })

  it("passes cwd straight through", async () => {
    const seen: unknown[] = []
    const agent = new Agent({
      subagentTodos: (input: unknown) => {
        seen.push(input)
        return Effect.succeed({ sessionId: child, found: true })
      },
    } as unknown as ACPService.Interface)

    await agent.extMethod("_subagent_todos", { sessionId: child, cwd: "/workspace" })

    expect(seen).toEqual([{ sessionId: child, cwd: "/workspace" }])
  })
})

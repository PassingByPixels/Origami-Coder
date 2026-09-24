// t-ru0by6, same family as t-qd2riw's subagent-todos.test.ts: the host's
// changed-files pill lookup (subagentChanges.ts) still asks `subagent_transcript`
// with no `limit` -- the whole child session -- just to find diff-bearing tool
// results. This covers the bounded replacement: `subagent_changes` walks the
// same paged store read backward in fixed-size blocks and collects every
// diff-bearing, non-failed tool part, newest first.
//
// The bugs worth catching: a "bounded" read that still asks for everything in
// one call; a scan that returns a FAILED call's diff (nothing actually
// changed); a scan that misses a diff several pages back; a walk that never
// terminates on a long history with no diffs at all; and a vanished child
// that throws instead of answering `found: false`.

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient, SessionMessageResponse } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"
import { diffBearingParts } from "@/acp/subagent-changes"
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

function editPart(id: string, filePath: string, oldString: string, newString: string, status = "completed"): unknown {
  return {
    id: `prt_${id}_edit`,
    sessionID: child,
    messageID: id,
    type: "tool",
    callID: `call_${id}`,
    tool: "edit",
    state: {
      status,
      input: { filePath, oldString, newString },
      output: `edited ${filePath}`,
      title: `Edit ${filePath}`,
    },
  }
}

describe("diffBearingParts — the diff-bearing tool entries in ONE page, newest first", () => {
  it("reads the diff off a completed tool entry", async () => {
    // Exercise via the projected shape the real page walk builds, not a hand-rolled TranscriptEntry.
    const service = ACPService.make({
      sdk: pagedSdk([assistantMessage("a1", 1, [editPart("a1", "/w/a.ts", "a", "b")])], []),
    })
    const result = await Effect.runPromise(service.subagentChanges({ sessionId: child }))
    expect(result.diffs).toEqual([{ path: "/w/a.ts", oldText: "a", newText: "b" }])
  })

  it("skips a failed call and one with no diff content", () => {
    expect(
      diffBearingParts([
        { type: "tool", messageId: "a1", toolCall: { toolCallId: "c1", status: "failed", content: [{ type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" }] } } as never,
        { type: "tool", messageId: "a2", toolCall: { toolCallId: "c2", status: "completed", content: [] } } as never,
      ]),
    ).toEqual([])
  })

  it("orders newest first across several entries", () => {
    const entries = [
      { type: "tool", messageId: "a1", toolCall: { toolCallId: "c1", status: "completed", content: [{ type: "diff", path: "/w/1.ts", oldText: "", newText: "1" }] } },
      { type: "text", messageId: "a2", role: "assistant", text: "noop" },
      { type: "tool", messageId: "a3", toolCall: { toolCallId: "c3", status: "completed", content: [{ type: "diff", path: "/w/3.ts", oldText: "", newText: "3" }] } },
    ]
    expect(diffBearingParts(entries as never)).toEqual([
      { path: "/w/3.ts", oldText: "", newText: "3" },
      { path: "/w/1.ts", oldText: "", newText: "1" },
    ])
  })
})

/** A store that honours limit/before, plus a spy on every call's params —
 *  same shape as subagent-todos.test.ts's `pagedSdk`. */
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

describe("subagent_changes — bounded backward walk over the wire", () => {
  it("finds a RECENT diff in ONE bounded call — the common case", async () => {
    const seen: Array<{ limit?: number; before?: string }> = []
    const messages = [
      assistantMessage("a1", 1, [textPart("a1")]),
      assistantMessage("a2", 2, [editPart("a2", "/w/read.ts", "x", "y")]),
      assistantMessage("a3", 3, [textPart("a3")]),
    ]
    const service = ACPService.make({ sdk: pagedSdk(messages, seen) })

    const result = await Effect.runPromise(service.subagentChanges({ sessionId: child }))

    expect(seen).toHaveLength(1)
    expect(seen[0]!.limit).toBeLessThanOrEqual(51)
    expect(result.found).toBe(true)
    expect(result.hasMore).toBe(false)
    expect(result.diffs).toEqual([{ path: "/w/read.ts", oldText: "x", newText: "y" }])
  })

  it("does not surface a FAILED edit's diff — nothing actually changed", async () => {
    const messages = [assistantMessage("a1", 1, [editPart("a1", "/w/a.ts", "x", "y", "error")])]
    const service = ACPService.make({ sdk: pagedSdk(messages, []) })

    const result = await Effect.runPromise(service.subagentChanges({ sessionId: child }))

    expect(result.diffs).toEqual([])
  })

  // The fixture the ticket asks for: 500 stored messages. A whole-transcript
  // read would fetch all 500 in ONE call; this must never make a call larger
  // than the page size, however many bounded calls it takes to walk them all.
  it("walks 500 stored messages entirely in bounded pages, never one huge block", async () => {
    const seen: Array<{ limit?: number; before?: string }> = []
    const messages: SessionMessageResponse[] = []
    for (let i = 0; i < 500; i++) {
      const id = `a${i}`
      messages.push(
        assistantMessage(id, i, i === 5 || i === 400 ? [editPart(id, `/w/${id}.ts`, "before", "after")] : [textPart(id)]),
      )
    }
    const service = ACPService.make({ sdk: pagedSdk(messages, seen) })

    const result = await Effect.runPromise(service.subagentChanges({ sessionId: child }))

    expect(result.found).toBe(true)
    expect(result.diffs.map((d) => d.path)).toEqual(["/w/a400.ts", "/w/a5.ts"])
    expect(seen.length).toBeGreaterThan(1)
    for (const call of seen) expect(call.limit).toBeLessThanOrEqual(51)
  })

  it("reaches the head and reports found with no diffs when the child made none", async () => {
    const seen: Array<{ limit?: number; before?: string }> = []
    const messages = Array.from({ length: 120 }, (_, i) => assistantMessage(`a${i}`, i, [textPart(`a${i}`)]))
    const service = ACPService.make({ sdk: pagedSdk(messages, seen) })

    const result = await Effect.runPromise(service.subagentChanges({ sessionId: child }))

    expect(result.found).toBe(true)
    expect(result.diffs).toEqual([])
    expect(result.hasMore).toBe(false)
    expect(seen.length).toBeGreaterThan(1)
    for (const call of seen) expect(call.limit).toBeLessThanOrEqual(51)
  })

  it("answers a vanished child with found:false instead of throwing", async () => {
    const sdk = {
      session: { messages: () => Promise.reject(new Error("no such session")) },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })

    const result = await Effect.runPromise(service.subagentChanges({ sessionId: "ses_gone" }))

    expect(result).toEqual({ sessionId: "ses_gone", found: false, diffs: [], hasMore: false })
  })
})

describe("subagent_changes ext dispatch", () => {
  it("accepts the `_` wire prefix, and requires a string sessionId", async () => {
    const service = {
      subagentChanges: (input: { sessionId: string }) =>
        Effect.succeed({ sessionId: input.sessionId, found: true, diffs: [], hasMore: false }),
    } as unknown as ACPService.Interface
    const agent = new Agent(service)

    const prefixed = await agent.extMethod("_subagent_changes", { sessionId: child })
    const bare = await agent.extMethod("subagent_changes", { sessionId: child })

    expect(prefixed).toEqual(bare)
    expect(prefixed).toMatchObject({ sessionId: child, found: true })
    expect(() => agent.extMethod("_subagent_changes", {})).toThrow()
  })

  it("passes cwd straight through", async () => {
    const seen: unknown[] = []
    const agent = new Agent({
      subagentChanges: (input: unknown) => {
        seen.push(input)
        return Effect.succeed({ sessionId: child, found: true, diffs: [], hasMore: false })
      },
    } as unknown as ACPService.Interface)

    await agent.extMethod("_subagent_changes", { sessionId: child, cwd: "/workspace" })

    expect(seen).toEqual([{ sessionId: child, cwd: "/workspace" }])
  })
})

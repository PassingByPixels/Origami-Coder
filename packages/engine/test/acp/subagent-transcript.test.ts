// `subagent_transcript` — ONE sub-agent's own conversation, projected into the
// shapes the chat already renders, so the shell's sub-agent panel can draw a
// child instead of the flat forwarded log string it shows today.
//
// The bugs worth catching: a projection re-derived here instead of reused from
// acp/tool.ts (which is how the sub-agent view drifts away from the chat, one
// tool at a time — apply_patch is the live example); a child that is still
// working coming back looking finished; a vanished child throwing and killing
// the panel; and an unbounded payload crossing JSON-RPC into a webview.

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient, Part, SessionMessageResponse } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"
import { TEXT_LIMIT, missing, pageSlice, project } from "@/acp/subagent-transcript"
import type { TranscriptEntry, TranscriptTool } from "@/acp/subagent-transcript"
import { MessageV2 } from "@/session/message-v2"
import { completedToolContent, toLocations, toToolKind } from "@/acp/tool"

const child = "ses_child"

let partSeq = 0
function partIds(messageID: string) {
  partSeq++
  return { id: `prt_${partSeq}`, sessionID: child, messageID }
}

function userMessage(messageID: string, text: string): SessionMessageResponse {
  return {
    info: { id: messageID, sessionID: child, role: "user", time: { created: 1_000 }, agent: "build" },
    parts: [{ ...partIds(messageID), type: "text", text }],
  } as unknown as SessionMessageResponse
}

/** Settled unless `time` says otherwise — `completed` is what the engine stamps
 *  on every exit path (session/prompt.ts), so its absence means still in flight. */
function assistantMessage(
  messageID: string,
  parts: unknown[],
  overrides: Record<string, unknown> = {},
): SessionMessageResponse {
  return {
    info: {
      id: messageID,
      sessionID: child,
      role: "assistant",
      time: { created: 1_000, completed: 2_000 },
      parentID: "msg_u1",
      modelID: "mod",
      providerID: "prov",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 10, output: 20 },
      ...overrides,
    },
    parts,
  } as unknown as SessionMessageResponse
}

function textPart(messageID: string, text: string, overrides: Record<string, unknown> = {}): Part {
  return { ...partIds(messageID), type: "text", text, ...overrides } as unknown as Part
}

function completedTool(
  messageID: string,
  tool: string,
  state: Record<string, unknown>,
  callID = `call_${tool}`,
): Part {
  return {
    ...partIds(messageID),
    type: "tool",
    callID,
    tool,
    state: { status: "completed", title: `${tool} call`, metadata: {}, time: { start: 1_100, end: 1_400 }, ...state },
  } as unknown as Part
}

function runningTool(messageID: string, tool: string, input: Record<string, unknown>): Part {
  return {
    ...partIds(messageID),
    type: "tool",
    callID: `call_${tool}`,
    tool,
    state: { status: "running", input, title: `${tool} call`, time: { start: 1_100 } },
  } as unknown as Part
}

const APPLY_PATCH = ["*** Begin Patch", "*** Update File: src/app.ts", "@@ fn()", "-old", "+new", "*** End Patch"].join(
  "\n",
)

function tools(entries: readonly TranscriptEntry[]): TranscriptTool[] {
  return entries.filter((entry): entry is TranscriptTool => entry.type === "tool")
}

describe("subagent transcript projection", () => {
  it("returns the child's prose and one settled card per tool, in stored order", () => {
    const result = project(child, [
      userMessage("msg_u1", "find the leak"),
      assistantMessage("msg_a1", [
        textPart("msg_a1", "Looking at the store."),
        completedTool("msg_a1", "read", { input: { filePath: "/workspace/src/store.ts" }, output: "line one" }),
        textPart("msg_a1", "Found it."),
      ]),
    ])

    expect(result.found).toBe(true)
    expect(result.running).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.entries.map((entry) => entry.type)).toEqual(["text", "text", "tool", "text"])
    expect(result.entries[0]).toMatchObject({ type: "text", role: "user", text: "find the leak" })
    expect(result.entries[1]).toMatchObject({ type: "text", role: "assistant", text: "Looking at the store." })
    expect(result.entries[2]).toMatchObject({
      type: "tool",
      toolCall: {
        toolCallId: "call_read",
        kind: "read",
        status: "completed",
        title: "read call",
        locations: [{ path: "/workspace/src/store.ts" }],
        _meta: { origami_tool_name: "read" },
      },
    })
  })

  it("carries the tool's result content, so the card renders what the child got back", () => {
    const result = project(child, [
      assistantMessage("msg_a1", [
        completedTool("msg_a1", "read", { input: { filePath: "/workspace/a.ts" }, output: "the file body" }),
      ]),
    ])

    expect(tools(result.entries)[0]!.toolCall.content).toEqual([
      { type: "content", content: { type: "text", text: "the file body" } },
    ])
  })

  // The whole reason this is built on acp/tool.ts. apply_patch hides its path in
  // an opaque patchText blob and its own completion title is a multi-line
  // "Success. Updated the following files:..." summary; acp/tool.ts recovers a
  // real path and a one-line title from it. A transcript that re-derived its own
  // projection would show the bare tool name here and the chat would not — the
  // exact drift this test exists to prevent.
  it("inherits acp/tool.ts's projections rather than re-deriving them", () => {
    const state = {
      input: { patchText: APPLY_PATCH },
      output: "Success. Updated the following files:\nM src/app.ts",
      title: "Success. Updated the following files:\nM src/app.ts",
      metadata: { files: [{ filePath: "src/app.ts", oldContent: "old\n", newContent: "new\n" }] },
    }
    const result = project(child, [assistantMessage("msg_a1", [completedTool("msg_a1", "apply_patch", state)])])

    const call = tools(result.entries)[0]!.toolCall
    expect(call.title).toBe("src/app.ts")
    expect(call.kind).toBe(toToolKind("apply_patch"))
    expect(call.locations).toEqual(toLocations("apply_patch", { patchText: APPLY_PATCH }))
    // Byte-identical to what the chat's completed frame carries for this part.
    expect(call.content).toEqual(
      completedToolContent("apply_patch", { status: "completed", ...state } as Parameters<
        typeof completedToolContent
      >[1]),
    )
  })

  it("shows a failed tool as failed, with the error the child saw", () => {
    const result = project(child, [
      assistantMessage("msg_a1", [
        {
          ...partIds("msg_a1"),
          type: "tool",
          callID: "call_bash",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "npm test", explanation: "Run the suite" },
            error: "exit 1",
            time: { start: 1_100, end: 1_200 },
          },
        } as unknown as Part,
      ]),
    ])

    expect(tools(result.entries)[0]!.toolCall).toMatchObject({
      status: "failed",
      title: "Run the suite",
      content: [{ type: "content", content: { type: "text", text: "exit 1" } }],
    })
  })

  it("rides the task metadata, so a grandchild spawn in the transcript is not a dead end", () => {
    const result = project(child, [
      assistantMessage("msg_a1", [
        completedTool("msg_a1", "task", {
          input: { description: "sub-sub" },
          output: "done",
          metadata: { sessionId: "ses_grandchild", background: true, model: { providerID: "p", modelID: "m" } },
        }),
      ]),
    ])

    expect(tools(result.entries)[0]!.toolCall._meta).toMatchObject({
      origami_tool_name: "task",
      origami_task_session: "ses_grandchild",
      origami_task_background: true,
      origami_task_model: "p/m",
    })
  })

  it("drops the engine's own bookkeeping text, which the child never said", () => {
    const result = project(child, [
      assistantMessage("msg_a1", [
        textPart("msg_a1", '<task id="ses_x" state="completed">', { synthetic: true }),
        textPart("msg_a1", "hidden from the reader", { ignored: true }),
        textPart("msg_a1", "   "),
        textPart("msg_a1", "the real answer"),
      ]),
    ])

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ type: "text", text: "the real answer" })
  })

  // t-gvz8t0. Reasoning used to be dropped here too. A child that spends its
  // whole first step thinking - 123 s and 5,449 tokens, measured - then has an
  // EMPTY transcript, which reads as a child that did nothing at all.
  it("keeps the child's reasoning, as its OWN type and never as prose", () => {
    const result = project(child, [
      assistantMessage("msg_a1", [
        { ...partIds("msg_a1"), type: "reasoning", text: "weighing two approaches" } as unknown as Part,
        { ...partIds("msg_a1"), type: "reasoning", text: "   " } as unknown as Part,
        textPart("msg_a1", "the real answer"),
      ]),
    ])

    // Two entries, not three: a thought of pure whitespace is dropped exactly
    // as an empty prose part is.
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toEqual({
      type: "reasoning",
      messageId: "msg_a1",
      text: "weighing two approaches",
    })
    // ...and the prose is still prose. A reader must never be shown thought as
    // the child's answer.
    expect(result.entries[1]).toMatchObject({ type: "text", text: "the real answer" })
  })

  it("caps a long thought like every other string, and says it cut one", () => {
    const result = project(child, [
      assistantMessage("msg_a1", [
        { ...partIds("msg_a1"), type: "reasoning", text: "z".repeat(TEXT_LIMIT + 500) } as unknown as Part,
      ]),
    ])

    expect(result.truncated).toBe(true)
    expect(result.entries[0]).toMatchObject({ type: "reasoning", truncated: true })
    expect([...(result.entries[0] as { text: string }).text].length).toBe(TEXT_LIMIT)
  })

  it("reports a turn the model call failed on, instead of just stopping", () => {
    const result = project(child, [
      assistantMessage("msg_a1", [textPart("msg_a1", "starting")], {
        error: { name: "ProviderRateLimit", data: { message: "429 from upstream" } },
      }),
    ])

    expect(result.entries[1]).toEqual({
      type: "error",
      messageId: "msg_a1",
      name: "ProviderRateLimit",
      message: "429 from upstream",
    })
  })
})

describe("subagent transcript liveness", () => {
  it("says a child holding an unsettled tool is still running, and still returns what it has", () => {
    const result = project(child, [
      userMessage("msg_u1", "go"),
      assistantMessage("msg_a1", [
        textPart("msg_a1", "reading first"),
        runningTool("msg_a1", "bash", { command: "npm test" }),
      ]),
    ])

    expect(result.running).toBe(true)
    expect(result.entries).toHaveLength(3)
    expect(tools(result.entries)[0]!.toolCall.status).toBe("in_progress")
  })

  it("says a child whose last turn was never stamped complete is still running", () => {
    const result = project(child, [
      assistantMessage("msg_a1", [textPart("msg_a1", "done thinking")]),
      assistantMessage("msg_a2", [textPart("msg_a2", "still writing")], { time: { created: 3_000 } }),
    ])

    expect(result.running).toBe(true)
  })

  it("says a child that has written nothing back yet is running, not finished and silent", () => {
    expect(project(child, [userMessage("msg_u1", "go")]).running).toBe(true)
    expect(project(child, []).running).toBe(true)
  })

  it("says a settled child is settled", () => {
    expect(project(child, [assistantMessage("msg_a1", [textPart("msg_a1", "all done")])]).running).toBe(false)
  })
})

describe("subagent transcript bound", () => {
  const huge = "x".repeat(TEXT_LIMIT + 500)

  it("cuts a single oversized string and SAYS the entry was cut", () => {
    const result = project(child, [assistantMessage("msg_a1", [textPart("msg_a1", huge)])])

    const entry = result.entries[0] as { type: "text"; text: string; truncated?: true }
    expect(entry.text).toHaveLength(TEXT_LIMIT)
    expect(entry.text.endsWith("…")).toBe(true)
    expect(entry.truncated).toBe(true)
    expect(result.truncated).toBe(true)
  })

  // The cap has to reach every string a tool card carries, not just the ones it
  // was written for: an oversized payload that arrives through `rawInput` or
  // through a read's `metadata.display.text` is the same megabyte on the wire.
  it("cuts the bulk wherever it hides in a tool card, and marks that entry too", () => {
    const result = project(child, [
      assistantMessage("msg_a1", [
        completedTool("msg_a1", "write", { input: { filePath: "/workspace/big.txt", content: huge }, output: huge }),
      ]),
    ])

    const entry = tools(result.entries)[0]!
    const call = entry.toolCall
    const body = call.content?.[0] as { content: { text: string } }
    expect(body.content.text).toHaveLength(TEXT_LIMIT)
    expect((call.rawInput as { content: string }).content).toHaveLength(TEXT_LIMIT)
    expect(entry.truncated).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it("leaves a string that fits exactly alone, and says nothing was cut", () => {
    const exact = "y".repeat(TEXT_LIMIT)
    const result = project(child, [assistantMessage("msg_a1", [textPart("msg_a1", exact)])])

    expect((result.entries[0] as { text: string }).text).toBe(exact)
    expect(result.truncated).toBe(false)
  })

  // The house position, taken from run-steps when its MAX_STEPS ceiling was
  // removed: the part a reader wants is usually the END of a run, so a prefix
  // is worse than a large payload. Every entry ships; only strings are bounded.
  it("never drops an entry, however long the child ran", () => {
    const parts = Array.from({ length: 400 }, (_, i) =>
      completedTool("msg_a1", "read", { input: { filePath: `/workspace/f${i}.ts` }, output: "ok" }, `call_${i}`),
    )
    const result = project(child, [assistantMessage("msg_a1", parts)])

    expect(result.entries).toHaveLength(400)
    expect(result.truncated).toBe(false)
    expect(tools(result.entries)[399]!.toolCall.locations).toEqual([{ path: "/workspace/f399.ts" }])
  })
})

// t-krxap7 — selective loading. The bugs worth catching here: a page that hands
// back the OLDEST N (a reader wants the end of a run, not its opening); a cursor
// taken from the row that was dropped rather than the one kept, which would skip
// a message on the next page; and `before` reaching the store without a `limit`,
// which the store answers with a 400.
describe("pageSlice — the newest block, and what lies before it", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      assistantMessage(`msg_a${i}`, [textPart(`msg_a${i}`, `step ${i}`)], { time: { created: 1_000 + i, completed: 2_000 } }),
    )

  it("keeps the NEWEST limit rows, not the first ones the store listed", () => {
    // The store answers oldest-first, so the tail is the recent end of the run.
    const slice = pageSlice(rows(5), 3)
    expect(slice.kept.map((m) => m.info.id)).toEqual(["msg_a2", "msg_a3", "msg_a4"])
  })

  it("reports no older block when the reply did not overflow the asked-for size", () => {
    const three = rows(3)
    expect(pageSlice(three, 3)).toEqual({ kept: three, hasMore: false })
    expect(pageSlice(rows(2), 3).hasMore).toBe(false)
  })

  it("cursors on the first row it KEPT, so the next page stops just short of it", () => {
    const slice = pageSlice(rows(5), 3)
    expect(slice.hasMore).toBe(true)
    // msg_a2 is kept; cursoring on the dropped msg_a1 would lose msg_a2 next time.
    expect(slice.oldest).toEqual({ id: "msg_a2", time: 1_002 })
  })

  it("round-trips through the store's own cursor codec", () => {
    const oldest = pageSlice(rows(5), 3).oldest!
    const encoded = MessageV2.cursor.encode({ id: oldest.id, time: oldest.time } as never)
    const back = MessageV2.cursor.decode(encoded) as { id: string; time: number }
    expect(back.id).toBe(oldest.id)
    expect(back.time).toBe(oldest.time)
  })

  it("is a no-op for a limit that is not a page", () => {
    const four = rows(4)
    expect(pageSlice(four, 0)).toEqual({ kept: four, hasMore: false })
  })
})

describe("subagent_transcript paging over the wire", () => {
  /** A store that HONOURS limit/before, so the assertions are about our request,
   *  not about a fake that answers everything the same way. */
  function pagedSdk(all: SessionMessageResponse[], seen: unknown[]) {
    return {
      session: {
        messages: (params: { sessionID: string; limit?: number; before?: string }) => {
          seen.push(params)
          if (params.before && params.limit === undefined) return Promise.reject(new Error("before requires limit"))
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

  const many = Array.from({ length: 7 }, (_, i) =>
    assistantMessage(`msg_a${i}`, [textPart(`msg_a${i}`, `step ${i}`)], { time: { created: 1_000 + i, completed: 2_000 } }),
  )

  it("asks for ONE row more than the page size and answers only the page", async () => {
    const seen: unknown[] = []
    const service = ACPService.make({ sdk: pagedSdk(many, seen) })

    const result = await Effect.runPromise(service.subagentTranscript({ sessionId: child, limit: 3 }))

    expect(seen).toEqual([{ sessionID: child, limit: 4 }])
    expect(result.entries.map((e) => (e as { text: string }).text)).toEqual(["step 4", "step 5", "step 6"])
    expect(result.hasMore).toBe(true)
    expect(typeof result.cursor).toBe("string")
  })

  it("walks backwards with the cursor, delivering the block just before the last one", async () => {
    const seen: unknown[] = []
    const service = ACPService.make({ sdk: pagedSdk(many, seen) })

    const first = await Effect.runPromise(service.subagentTranscript({ sessionId: child, limit: 3 }))
    const second = await Effect.runPromise(
      service.subagentTranscript({ sessionId: child, limit: 3, before: first.cursor }),
    )

    // No overlap and no gap: 1..3 sits immediately before 4..6.
    expect(second.entries.map((e) => (e as { text: string }).text)).toEqual(["step 1", "step 2", "step 3"])
    expect(second.hasMore).toBe(true)
  })

  it("says hasMore:false on the head of the transcript", async () => {
    const service = ACPService.make({ sdk: pagedSdk(many, []) })
    let cursor: string | undefined
    const seenText: string[] = []
    for (let i = 0; i < 4; i++) {
      const page = await Effect.runPromise(
        service.subagentTranscript({ sessionId: child, limit: 3, ...(cursor ? { before: cursor } : {}) }),
      )
      seenText.unshift(...page.entries.map((e) => (e as { text: string }).text))
      if (!page.hasMore) break
      cursor = page.cursor
    }
    expect(seenText).toEqual(many.map((_, i) => `step ${i}`))
  })

  // The whole-transcript path is what the sub-agent todo read still uses.
  it("leaves the unpaged read untouched - no limit, no before, no page fields", async () => {
    const seen: unknown[] = []
    const service = ACPService.make({ sdk: pagedSdk(many, seen) })

    const result = await Effect.runPromise(service.subagentTranscript({ sessionId: child }))

    expect(seen).toEqual([{ sessionID: child }])
    expect(result.entries).toHaveLength(7)
    expect(result.hasMore).toBeUndefined()
    expect(result.cursor).toBeUndefined()
  })

  it("never sends `before` without a `limit` - the store answers that pair with a 400", async () => {
    const seen: unknown[] = []
    const service = ACPService.make({ sdk: pagedSdk(many, seen) })

    await Effect.runPromise(service.subagentTranscript({ sessionId: child, before: "whatever" }))

    expect(seen).toEqual([{ sessionID: child }])
  })
})

describe("subagent_transcript service method", () => {
  function readSdk(store: Record<string, SessionMessageResponse[]>, seen: unknown[], broken = new Set<string>()) {
    const forbid =
      (name: string) =>
      (...args: unknown[]) => {
        seen.push(`MUTATION:${name}`)
        void args
        return Promise.resolve({ data: {} })
      }
    return {
      session: {
        messages: (params: { sessionID: string }) => {
          seen.push(params)
          if (broken.has(params.sessionID)) return Promise.reject(new Error("no such session"))
          return Promise.resolve({ data: store[params.sessionID] ?? [] })
        },
        create: forbid("create"),
        get: forbid("get"),
        delete: forbid("delete"),
        prompt: forbid("prompt"),
        abort: forbid("abort"),
        update: forbid("update"),
        revert: forbid("revert"),
        fork: forbid("fork"),
      },
    } as unknown as OrigamiClient
  }

  it("reads the child with ONE plain GET and mutates nothing", async () => {
    const seen: unknown[] = []
    const service = ACPService.make({
      sdk: readSdk({ [child]: [assistantMessage("msg_a1", [textPart("msg_a1", "hi")])] }, seen),
    })

    const result = await Effect.runPromise(service.subagentTranscript({ sessionId: child, cwd: "/workspace" }))

    expect(result.found).toBe(true)
    expect(result.entries).toHaveLength(1)
    expect(seen).toEqual([{ directory: "/workspace", sessionID: child }])
  })

  it("omits the directory when no cwd is given rather than inventing one", async () => {
    const seen: unknown[] = []
    await Effect.runPromise(ACPService.make({ sdk: readSdk({}, seen) }).subagentTranscript({ sessionId: child }))

    expect(seen).toEqual([{ sessionID: child }])
  })

  // A panel has to draw something. A rejected promise here kills the view, and
  // a child the parent spawned an hour ago is exactly the one most likely to
  // have been deleted since.
  it("answers a vanished child with an empty transcript instead of throwing", async () => {
    const seen: unknown[] = []
    const service = ACPService.make({ sdk: readSdk({}, seen, new Set(["ses_gone"])) })

    const result = await Effect.runPromise(service.subagentTranscript({ sessionId: "ses_gone" }))

    expect(result).toEqual({ sessionId: "ses_gone", found: false, running: false, entries: [], truncated: false })
  })

  it("tells an EMPTY child apart from a missing one", async () => {
    const seen: unknown[] = []
    const service = ACPService.make({ sdk: readSdk({ [child]: [] }, seen) })

    const result = await Effect.runPromise(service.subagentTranscript({ sessionId: child }))

    expect(result.found).toBe(true)
    expect(result.entries).toEqual([])
    // Nothing written back yet is a child still out, never one that finished silent.
    expect(result.running).toBe(true)
  })

  it("missing() is the shape the UI renders for a child it cannot read", () => {
    expect(missing("ses_x")).toEqual({
      sessionId: "ses_x",
      found: false,
      running: false,
      entries: [],
      truncated: false,
    })
  })
})

describe("subagent_transcript ext dispatch", () => {
  const service = {
    subagentTranscript: (input: { sessionId: string; cwd?: string }) =>
      Effect.succeed({ sessionId: input.sessionId, found: true, running: false, entries: [], truncated: false }),
  } as unknown as ACPService.Interface

  it("accepts the `_` wire prefix clients put on extension methods", async () => {
    const agent = new Agent(service)

    const prefixed = await agent.extMethod("_subagent_transcript", { sessionId: child })
    const bare = await agent.extMethod("subagent_transcript", { sessionId: child })

    expect(prefixed).toEqual(bare)
    expect(prefixed).toMatchObject({ sessionId: child, found: true })
  })

  it("refuses a call with no sessionId rather than answering about some other child", () => {
    const agent = new Agent(service)

    expect(() => agent.extMethod("_subagent_transcript", {})).toThrow()
    expect(() => agent.extMethod("_subagent_transcript", { sessionId: 7 })).toThrow()
  })

  // t-krxap7. Both refusals are about answering the WRONG block silently: a
  // nonsense limit would fall back to the whole transcript, and a `before`
  // with no limit is dropped by the store and answered with the newest page.
  it("refuses a limit that is not a non-negative number, and a before with no limit", () => {
    const agent = new Agent(service)

    expect(() => agent.extMethod("_subagent_transcript", { sessionId: child, limit: "50" })).toThrow()
    expect(() => agent.extMethod("_subagent_transcript", { sessionId: child, limit: -1 })).toThrow()
    expect(() => agent.extMethod("_subagent_transcript", { sessionId: child, limit: Number.NaN })).toThrow()
    expect(() => agent.extMethod("_subagent_transcript", { sessionId: child, before: "cur" })).toThrow()
  })

  it("passes limit and before straight through", async () => {
    const seen: unknown[] = []
    const agent = new Agent({
      subagentTranscript: (input: unknown) => {
        seen.push(input)
        return Effect.succeed({ sessionId: child, found: true, running: false, entries: [], truncated: false })
      },
    } as unknown as ACPService.Interface)

    await agent.extMethod("_subagent_transcript", { sessionId: child, limit: 50.7, before: "cur" })

    expect(seen).toEqual([{ sessionId: child, limit: 50, before: "cur" }])
  })
})

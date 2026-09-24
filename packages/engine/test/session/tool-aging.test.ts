import { beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionV1 } from "@origami/core/v1/session"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Database } from "@origami/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionToolAging } from "@/session/tool-aging"
import type { Provider } from "@/provider/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")

const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID,
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} as unknown as Provider.Model

function assistantInfo(id: string): SessionV1.Assistant {
  return {
    id: MessageID.make(id),
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID: MessageID.make("msg_user"),
    modelID: model.api.id,
    providerID: model.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Assistant
}

let partCounter = 0
function nextPartID() {
  partCounter++
  return PartID.make(`prt_${String(partCounter).padStart(4, "0")}`)
}

function toolPart(input: {
  messageID: string
  tool: string
  args: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
  status?: "completed" | "error"
  id?: string
  attachments?: SessionV1.ToolStateCompleted["attachments"]
}): SessionV1.ToolPart {
  const id = input.id ? PartID.make(input.id) : nextPartID()
  const base = {
    id,
    sessionID,
    messageID: MessageID.make(input.messageID),
    type: "tool" as const,
    callID: `call_${id}`,
    tool: input.tool,
  }
  if (input.status === "error") {
    return {
      ...base,
      state: {
        status: "error",
        input: input.args,
        error: input.output ?? "boom",
        time: { start: 0, end: 1 },
      },
    } as SessionV1.ToolPart
  }
  return {
    ...base,
    state: {
      status: "completed",
      input: input.args,
      output: input.output ?? "",
      title: input.tool,
      metadata: input.metadata ?? {},
      time: { start: 0, end: 1 },
      ...(input.attachments ? { attachments: input.attachments } : {}),
    },
  } as SessionV1.ToolPart
}

function textPart(messageID: string, text: string): SessionV1.Part {
  return {
    id: nextPartID(),
    sessionID,
    messageID: MessageID.make(messageID),
    type: "text",
    text,
  } as SessionV1.Part
}

/** One assistant message per tool call — the shape a real step loop produces. */
function assistantMessage(id: string, parts: SessionV1.Part[]): SessionV1.WithParts {
  return { info: assistantInfo(id), parts }
}

function readPart(messageID: string, path: string, lines: number, body: string) {
  return toolPart({
    messageID,
    tool: "read",
    args: { filePath: path },
    output: body,
    metadata: { display: { type: "file", path, totalLines: lines } },
  })
}

/** N reads, one assistant message each, in call order. */
function readHistory(count: number) {
  const parts: SessionV1.ToolPart[] = []
  const messages: SessionV1.WithParts[] = []
  for (let index = 1; index <= count; index++) {
    const messageID = `msg_a${index}`
    const part = readPart(messageID, `/w/file${index}.ts`, index * 10, "x".repeat(index * 100))
    parts.push(part)
    messages.push(assistantMessage(messageID, [part]))
  }
  return { parts, messages }
}

// A batch of 1 commits every decision at once, so the tests below see what one
// boundary decides. Batching itself is tested in "commits in batches".
const boundary = (messages: SessionV1.WithParts[], id = sessionID) =>
  SessionToolAging.plan({ sessionID: id, messages, boundary: true, batch: 1 })

/** The production path: no `batch`, so `BATCH` applies. */
const batched = (messages: SessionV1.WithParts[], id = sessionID) =>
  SessionToolAging.plan({ sessionID: id, messages, boundary: true })

const step = (messages: SessionV1.WithParts[], id = sessionID) =>
  SessionToolAging.plan({ sessionID: id, messages, boundary: false })

beforeEach(() => {
  SessionToolAging.reset()
  partCounter = 0
})

describe("session.tool-aging.plan", () => {
  test("keeps the last K results and stubs everything older", () => {
    const { parts, messages } = readHistory(SessionToolAging.K + 1)
    const plan = boundary(messages)

    expect(plan.rewrites.size).toBe(1)
    expect(plan.rewrites.has(parts[0].id)).toBe(true)
    expect(plan.counts).toEqual({ aged: 1, superseded: 0, kept: SessionToolAging.K })
    for (const part of parts.slice(1)) expect(plan.rewrites.has(part.id)).toBe(false)
  })

  test("K results are all inside the window", () => {
    const { messages } = readHistory(SessionToolAging.K)
    expect(boundary(messages).rewrites.size).toBe(0)
  })

  test("a read superseded by a later edit is stubbed inside the window, naming the step", () => {
    const target = "/w/target.ts"
    const read = readPart("msg_a1", target, 214, "1: alpha\n2: beta")
    const edit = toolPart({ messageID: "msg_a2", tool: "edit", args: { filePath: target, oldString: "a", newString: "b" } })
    const messages = [assistantMessage("msg_a1", [read]), assistantMessage("msg_a2", [edit])]

    const plan = boundary(messages)

    // Two results only — the whole history is inside the K window.
    expect(plan.counts).toEqual({ aged: 1, superseded: 1, kept: 1 })
    expect(plan.rewrites.get(read.id)?.output).toBe(
      "[read /w/target.ts · 16 B · 214 lines · superseded: edited at step 2]",
    )
  })

  test("a re-read supersedes the earlier read of the same path", () => {
    const target = "/w/again.ts"
    const first = readPart("msg_a1", target, 12, "body")
    const second = readPart("msg_a2", target, 12, "body")
    const plan = boundary([assistantMessage("msg_a1", [first]), assistantMessage("msg_a2", [second])])

    // A re-read changed nothing, so the stub must not read as "it changed" —
    // it says a newer read exists and there is nothing to redo.
    expect(plan.rewrites.get(first.id)?.output).toBe(
      "[read /w/again.ts · 4 B · 12 lines · newer read at step 2 — nothing to redo]",
    )
    expect(plan.rewrites.get(first.id)?.output).not.toContain("superseded")
    expect(plan.rewrites.has(second.id)).toBe(false)
  })

  test("an edit or write still says the file was superseded, not re-read", () => {
    const editTarget = "/w/target.ts"
    const editRead = readPart("msg_a1", editTarget, 214, "1: alpha\n2: beta")
    const edit = toolPart({ messageID: "msg_a2", tool: "edit", args: { filePath: editTarget, oldString: "a", newString: "b" } })
    const editPlan = boundary([assistantMessage("msg_a1", [editRead]), assistantMessage("msg_a2", [edit])])
    expect(editPlan.rewrites.get(editRead.id)?.output).toContain("superseded: edited at step 2")
    expect(editPlan.rewrites.get(editRead.id)?.output).not.toContain("newer read")

    const writeTarget = "/w/new.ts"
    const writeRead = readPart("msg_b1", writeTarget, 5, "hello")
    const write = toolPart({ messageID: "msg_b2", tool: "write", args: { filePath: writeTarget, content: "hi" } })
    const writePlan = boundary([assistantMessage("msg_b1", [writeRead]), assistantMessage("msg_b2", [write])])
    expect(writePlan.rewrites.get(writeRead.id)?.output).toContain("superseded: written at step 2")
    expect(writePlan.rewrites.get(writeRead.id)?.output).not.toContain("newer read")
  })

  test("path comparison ignores separator and case, so a Windows edit supersedes a POSIX read", () => {
    const read = readPart("msg_a1", "C:/w/Target.ts", 5, "body")
    const write = toolPart({
      messageID: "msg_a2",
      tool: "write",
      args: { filePath: "c:\\w\\target.ts", content: "new" },
    })
    const plan = boundary([assistantMessage("msg_a1", [read]), assistantMessage("msg_a2", [write])])

    expect(plan.rewrites.get(read.id)?.output).toContain("superseded: written at step 2")
  })

  test("a decision is monotonic: a stubbed part stays stubbed after it re-enters the window", () => {
    const { parts, messages } = readHistory(SessionToolAging.K + 2)
    const first = boundary(messages)
    expect([...first.rewrites.keys()]).toEqual([parts[0].id, parts[1].id])

    // The history shrinks (compaction filters the head away in real life), so
    // the two stubbed parts are now inside the last K. They stay stubbed.
    const second = boundary(messages.slice(0, 6))
    expect(second.counts.aged).toBe(0)
    expect(second.rewrites.has(parts[0].id)).toBe(true)
    expect(second.rewrites.has(parts[1].id)).toBe(true)
  })

  test("no new decisions between boundaries, and the outgoing array does not move", async () => {
    const { parts, messages } = readHistory(SessionToolAging.K + 1)
    boundary(messages)

    const extra = readPart("msg_a8", "/w/file8.ts", 80, "y".repeat(900))
    const grown = [...messages, assistantMessage("msg_a8", [extra])]

    const one = step(grown)
    const two = step(grown)

    // parts[1] would fall out of the window at the next boundary. It must not
    // fall out here: a non-boundary step decides nothing.
    expect(one.rewrites.size).toBe(1)
    expect(one.rewrites.has(parts[1].id)).toBe(false)
    expect(one.counts).toEqual({ aged: 0, superseded: 0, kept: 0 })

    const first = await MessageV2.toModelMessages(grown, model, { toolRewrites: one.rewrites })
    const second = await MessageV2.toModelMessages(grown, model, { toolRewrites: two.rewrites })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))

    // ...and the next boundary does take it.
    expect(boundary(grown).rewrites.has(parts[1].id)).toBe(true)
  })

  test("a result the assistant quoted survives one more boundary", () => {
    const quoted = "export function loadTheConfiguration() {"
    const { parts, messages } = readHistory(SessionToolAging.K)
    // The body is padded past the length of its own stub on purpose: a result
    // smaller than the stub replacing it is never aged at all (see "never
    // trades a result for a bigger stub"), and this test is about the reprieve,
    // not about the size guard in front of it.
    const old = readPart("msg_a0", "/w/quoted.ts", 3, `1: ${quoted}\n2: }\n3: // ${"x".repeat(120)}`)
    const history = [assistantMessage("msg_a0", [old, textPart("msg_a0", `I found:\n${quoted}`)]), ...messages]

    expect(boundary(history).rewrites.has(old.id)).toBe(false)
    // The reprieve is spent, so the next boundary ages it.
    expect(boundary(history).rewrites.has(old.id)).toBe(true)
    expect(parts).toHaveLength(SessionToolAging.K)
  })

  test("a result whose path the assistant names survives one more boundary", () => {
    const { messages } = readHistory(SessionToolAging.K)
    // Padded past its own stub for the same reason as the test above.
    const old = readPart("msg_a0", "/w/named.ts", 3, `1: short\n2: bits\n3: ${"y".repeat(120)}`)
    const history = [
      assistantMessage("msg_a0", [old]),
      assistantMessage("msg_a0b", [textPart("msg_a0b", "The bug is in /w/named.ts near the top.")]),
      ...messages,
    ]

    expect(boundary(history).rewrites.has(old.id)).toBe(false)
    expect(boundary(history).rewrites.has(old.id)).toBe(true)
  })

  test("a superseded read is stubbed even when the assistant quoted it", () => {
    const target = "/w/stale.ts"
    const read = readPart("msg_a1", target, 3, "1: line")
    const messages = [
      assistantMessage("msg_a1", [read, textPart("msg_a1", `Editing ${target} now.`)]),
      assistantMessage("msg_a2", [
        toolPart({ messageID: "msg_a2", tool: "edit", args: { filePath: target, oldString: "a", newString: "b" } }),
      ]),
    ]

    expect(boundary(messages).rewrites.get(read.id)?.output).toContain("superseded: edited at step 2")
  })

  test("write arguments are stubbed and edit arguments are capped, outgoing only", () => {
    const body = "z".repeat(5000)
    const write = toolPart({
      messageID: "msg_a1",
      tool: "write",
      args: { filePath: "/w/out.ts", content: body },
      output: "ok",
    })
    const edit = toolPart({
      messageID: "msg_a2",
      tool: "edit",
      args: { filePath: "/w/out.ts", oldString: "a".repeat(3000), newString: "b" },
      output: "ok",
    })
    const filler = readHistory(SessionToolAging.K)
    const messages = [assistantMessage("msg_a1", [write]), assistantMessage("msg_a2", [edit]), ...filler.messages]

    const plan = boundary(messages)

    expect(plan.rewrites.get(write.id)).toEqual({ input: { filePath: "/w/out.ts", content: "[wrote /w/out.ts · 5000 bytes]" } })
    expect(plan.rewrites.get(write.id)?.output).toBeUndefined()

    const capped = plan.rewrites.get(edit.id)?.input as { oldString: string; newString: string }
    expect(capped.oldString).toHaveLength(SessionToolAging.EDIT_ARG_MAX_CHARS + "… [+952 chars]".length)
    expect(capped.oldString.endsWith("… [+952 chars]")).toBe(true)
    expect(capped.newString).toBe("b")

    // The stored parts are unchanged: the decision is a map, not an edit.
    expect((write.state as SessionV1.ToolStateCompleted).input.content).toBe(body)
    expect((edit.state as SessionV1.ToolStateCompleted).input.oldString).toHaveLength(3000)
  })

  test("an edit under the cap is not rewritten at all", () => {
    const edit = toolPart({
      messageID: "msg_a1",
      tool: "edit",
      args: { filePath: "/w/small.ts", oldString: "a", newString: "b" },
      output: "ok",
    })
    const filler = readHistory(SessionToolAging.K)
    expect(boundary([assistantMessage("msg_a1", [edit]), ...filler.messages]).rewrites.has(edit.id)).toBe(false)
  })

  test("skill, todowrite, task, question and error results are never aged", () => {
    const protectedParts = [
      toolPart({ messageID: "msg_a1", tool: "skill", args: { name: "wrap" }, output: "s".repeat(5000) }),
      toolPart({ messageID: "msg_a2", tool: "todowrite", args: { todos: [] }, output: "t".repeat(5000) }),
      toolPart({ messageID: "msg_a3", tool: "task", args: { prompt: "go" }, output: "k".repeat(5000) }),
      toolPart({ messageID: "msg_a4", tool: "question", args: { question: "?" }, output: "q".repeat(5000) }),
      toolPart({ messageID: "msg_a5", tool: "read", args: { filePath: "/w/bad.ts" }, status: "error" }),
    ]
    const messages = protectedParts.map((part, index) => assistantMessage(`msg_a${index + 1}`, [part]))
    const filler = readHistory(SessionToolAging.K)

    const plan = boundary([...messages, ...filler.messages])
    for (const part of protectedParts) expect(plan.rewrites.has(part.id)).toBe(false)
  })

  test("a result carrying an image is never aged", () => {
    const withMedia = toolPart({
      messageID: "msg_a0",
      tool: "read",
      args: { filePath: "/w/shot.png" },
      output: "Image read successfully",
      attachments: [
        { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
      ] as unknown as SessionV1.ToolStateCompleted["attachments"],
    })
    const filler = readHistory(SessionToolAging.K + 1)
    const plan = boundary([assistantMessage("msg_a0", [withMedia]), ...filler.messages])

    expect(plan.rewrites.has(withMedia.id)).toBe(false)
    // The read behind it still ages, so the guard is narrow rather than a veto.
    expect(plan.rewrites.has(filler.parts[0].id)).toBe(true)
  })

  test("an MCP-shaped tool result ages with the generic stub", () => {
    const mcp = toolPart({
      messageID: "msg_a1",
      tool: "blender_get_scene_info",
      args: {},
      output: "j".repeat(4096),
    })
    const filler = readHistory(SessionToolAging.K)
    const plan = boundary([assistantMessage("msg_a1", [mcp]), ...filler.messages])

    expect(plan.rewrites.get(mcp.id)?.output).toBe(
      "[blender_get_scene_info result · 4.0 KB · aged out — call again if needed]",
    )
  })

  test("the kill switch decides nothing and remembers nothing", () => {
    const { parts, messages } = readHistory(SessionToolAging.K + 3)
    const off = SessionToolAging.plan({ sessionID, messages, boundary: true, enabled: false })
    expect(off.rewrites.size).toBe(0)

    // No state was written, so turning it back on starts from a clean history.
    const on = boundary(messages)
    expect(on.counts.aged).toBe(3)
    expect(on.rewrites.has(parts[0].id)).toBe(true)
  })

  test("the session store is bounded and evicts the oldest writer first", () => {
    const { messages } = readHistory(SessionToolAging.K + 1)
    for (let index = 0; index <= SessionToolAging.LIMIT; index++) {
      boundary(messages, SessionID.make(`session_${index}`))
    }
    // The first session's decisions were evicted, so a non-boundary step for it
    // answers with nothing rather than with a stale map.
    expect(step(messages, SessionID.make("session_0")).rewrites.size).toBe(0)
    expect(step(messages, SessionID.make(`session_${SessionToolAging.LIMIT}`)).rewrites.size).toBe(1)
  })
})

describe("session.tool-aging never trades a result for a bigger stub", () => {
  test("a result no larger than its own stub is left intact", () => {
    // AGING IS A BYTE TRADE, and on a small result the trade is a loss twice
    // over. An empty `read` (0 B) was replaced by a 68-character stub, and a
    // `grep` that found nothing (10 B) by a 54-character one: the wire GREW,
    // and the stub told the model content had "aged out" and invited it to
    // call again for content that never existed. Both halves of the feature
    // run backwards there, so the only correct move is to leave the part alone.
    const empty = toolPart({ messageID: "msg_a0", tool: "read", args: { filePath: "/w/empty.ts" }, output: "" })
    const nothingFound = toolPart({ messageID: "msg_a0b", tool: "grep", args: { pattern: "zzz" }, output: "No matches" })
    // K + 1 fillers, so the two small results AND the first filler all sit
    // outside the tail: the only thing separating them is the size guard.
    const filler = readHistory(SessionToolAging.K + 1)
    const plan = boundary([
      assistantMessage("msg_a0", [empty]),
      assistantMessage("msg_a0b", [nothingFound]),
      ...filler.messages,
    ])

    expect(plan.rewrites.has(empty.id)).toBe(false)
    expect(plan.rewrites.has(nothingFound.id)).toBe(false)
    // The guard is a size test, not a blanket reprieve for the head of the
    // history: a result that really is large still ages from the same slot.
    expect(plan.rewrites.has(filler.parts[0].id)).toBe(true)
  })

  test("a stale result is still stubbed however small it was", () => {
    // The size guard must not protect a SUPERSEDED read. Those bytes are not
    // merely redundant, they are WRONG - the file has moved on - so replacing
    // two characters with a longer stub that says so is worth the bytes.
    const target = "/w/tiny.ts"
    const read = readPart("msg_a1", target, 1, "hi")
    const edit = toolPart({
      messageID: "msg_a2",
      tool: "edit",
      args: { filePath: target, oldString: "h", newString: "H" },
    })
    const plan = boundary([assistantMessage("msg_a1", [read]), assistantMessage("msg_a2", [edit])])

    const stub = plan.rewrites.get(read.id)?.output
    expect(stub).toContain("superseded: edited at step 2")
    expect(stub!.length).toBeGreaterThan("hi".length)
  })
})

describe("session.tool-aging superseder pointer", () => {
  test("a superseded read points at the LATEST toucher, not the first", () => {
    // A read the model can still recover from is one whose pointer lands on
    // content that is actually in the request. The first toucher is the wrong
    // one to name: an `edit` at step 2 recovers nothing (an edit result is not
    // the file), while the re-read at step 3 IS the current content and sits in
    // the tail. Naming the newest also keeps the pointer as shallow as it can be.
    const target = "/w/moved.ts"
    const first = readPart("msg_a1", target, 4, "one two three four")
    const edit = toolPart({
      messageID: "msg_a2",
      tool: "edit",
      args: { filePath: target, oldString: "one", newString: "1" },
    })
    const again = readPart("msg_a3", target, 4, "1 two three four")
    const plan = boundary([
      assistantMessage("msg_a1", [first]),
      assistantMessage("msg_a2", [edit]),
      assistantMessage("msg_a3", [again]),
    ])

    expect(plan.rewrites.get(first.id)?.output).toBe(
      "[read /w/moved.ts · 18 B · 4 lines · newer read at step 3 — nothing to redo]",
    )
  })

  test("no stub ever points the model at another stub", () => {
    // THE CHAIN. Five reads of one file: every one but the last is superseded,
    // so every one but the last is stubbed. Pointing each at its immediate
    // successor builds a chain of stubs that each say "nothing to redo" while
    // the content is four hops away - and a model that follows one, finds
    // another stub, and re-reads the file is the exact behaviour aging exists
    // to prevent. Every pointer must land on a result the request still carries.
    const target = "/w/chain.ts"
    const parts: SessionV1.ToolPart[] = []
    const messages: SessionV1.WithParts[] = []
    for (let index = 1; index <= 5; index++) {
      const part = readPart(`msg_c${index}`, target, 1, "body of the chained file")
      parts.push(part)
      messages.push(assistantMessage(`msg_c${index}`, [part]))
    }
    const plan = boundary(messages)

    expect(plan.counts.superseded).toBe(4)
    expect(plan.rewrites.has(parts[4].id)).toBe(false)
    for (const part of parts.slice(0, 4)) {
      const stub = plan.rewrites.get(part.id)!.output!
      const step = Number(stub.match(/at step (\d+)/)![1])
      // The step a stub names must be a part that still carries its own output.
      expect(plan.rewrites.has(parts[step - 1].id)).toBe(false)
    }
  })
})

describe("session.tool-aging keeps the newest result", () => {
  test("the newest completed result is never stubbed at its first boundary", () => {
    // The tail is `results.slice(-K)`, so the newest result is inside it by
    // construction - but supersession deliberately overrides the tail, and the
    // window edges are where an off-by-one would show. K-1, K, K+1 and 2K all
    // have to leave the newest part whole: the most recent thing the model did
    // is the one result nothing else in the request can re-derive.
    for (const count of [SessionToolAging.K - 1, SessionToolAging.K, SessionToolAging.K + 1, SessionToolAging.K * 2]) {
      SessionToolAging.reset()
      const { parts, messages } = readHistory(count)
      const plan = SessionToolAging.plan({
        sessionID: SessionID.make(`ses_${count}`),
        messages,
        boundary: true,
        batch: 1,
      })
      expect(plan.rewrites.has(parts[count - 1].id)).toBe(false)
      expect(plan.counts.aged).toBe(Math.max(0, count - SessionToolAging.K))
    }
  })

  test("...and not when every read in the history superseded the one before it", () => {
    // The supersession path is the one that ignores the tail, so it is the one
    // that could reach the newest part. It must stop one short of it.
    const target = "/w/hot.ts"
    const parts: SessionV1.ToolPart[] = []
    const messages: SessionV1.WithParts[] = []
    for (let index = 1; index <= SessionToolAging.K + 4; index++) {
      const part = readPart(`msg_h${index}`, target, 2, "the same file read over and over again")
      parts.push(part)
      messages.push(assistantMessage(`msg_h${index}`, [part]))
    }
    const plan = boundary(messages)

    expect(plan.rewrites.has(parts[parts.length - 1].id)).toBe(false)
    expect(plan.counts.superseded).toBe(SessionToolAging.K + 3)
  })

  test("an empty history, a single step and a step with no tool parts all decide nothing", () => {
    expect(boundary([]).counts).toEqual({ aged: 0, superseded: 0, kept: 0 })
    SessionToolAging.reset()
    const one = readHistory(1)
    expect(boundary(one.messages).counts).toEqual({ aged: 0, superseded: 0, kept: 1 })
    SessionToolAging.reset()
    expect(boundary([assistantMessage("msg_t", [textPart("msg_t", "no tools here")])]).counts).toEqual({
      aged: 0,
      superseded: 0,
      kept: 0,
    })
  })
})

describe("session.tool-aging commits in batches", () => {
  const { K, BATCH } = SessionToolAging

  test("a boundary with fewer than BATCH new rewrites sends what the last step sent", async () => {
    const { parts, messages } = readHistory(K + BATCH - 1)
    const before = await MessageV2.toModelMessages(messages, model, { toolRewrites: step(messages).rewrites })
    const plan = batched(messages)

    expect(plan.rewrites.size).toBe(0)
    expect(plan.counts).toEqual({ aged: 0, superseded: 0, kept: parts.length })
    const after = await MessageV2.toModelMessages(messages, model, { toolRewrites: plan.rewrites })
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  test("BATCH new rewrites commit together, and the next BATCH - 1 turns move nothing", () => {
    const { parts, messages } = readHistory(K + BATCH)
    const first = batched(messages)
    expect(first.counts.aged).toBe(BATCH)
    const committed = [...first.rewrites.keys()]
    expect(committed).toEqual(parts.slice(0, BATCH).map((part) => part.id))

    // One more result per turn: each turn start is a boundary, and each leaves
    // the aged set, and so the sent prefix, exactly as it was.
    const grown = [...messages]
    for (let index = 1; index < BATCH; index++) {
      const id = `msg_n${index}`
      grown.push(assistantMessage(id, [readPart(id, `/w/new${index}.ts`, 10, "z".repeat(500))]))
      const plan = batched(grown)
      expect(plan.counts.aged).toBe(0)
      expect([...plan.rewrites.keys()]).toEqual(committed)
    }

    // The BATCH-th new result fills the next batch.
    grown.push(assistantMessage("msg_last", [readPart("msg_last", "/w/last.ts", 10, "z".repeat(500))]))
    expect(batched(grown).counts.aged).toBe(BATCH)
  })

  test("a superseded read waits for the batch like any other rewrite", () => {
    const { messages } = readHistory(3)
    const read = readPart("msg_r", "/w/file1.ts", 10, "q".repeat(400))
    const history = [...messages, assistantMessage("msg_r", [read])]
    // file1 was re-read, so the first read is stale - but one rewrite is not a batch.
    expect(batched(history).rewrites.size).toBe(0)
  })

  test("a boundary that commits nothing does not spend a reprieve", () => {
    const quoted = "export function loadTheConfiguration() {"
    const old = readPart("msg_a0", "/w/quoted.ts", 3, `1: ${quoted}
2: }
3: // ${"x".repeat(120)}`)
    const { messages } = readHistory(K + BATCH - 1)
    const history = [assistantMessage("msg_a0", [old, textPart("msg_a0", `I found:
${quoted}`)]), ...messages]

    // BATCH - 1 rewrites besides the quoted one: nothing commits.
    expect(batched(history).rewrites.size).toBe(0)
    // One more result makes a batch. The quoted result still has its reprieve,
    // because the boundary above committed nothing.
    const grown = [...history, assistantMessage("msg_z", [readPart("msg_z", "/w/z.ts", 10, "z".repeat(500))])]
    const plan = batched(grown)
    expect(plan.counts.aged).toBe(BATCH)
    expect(plan.rewrites.has(old.id)).toBe(false)
  })
})

describe("session.tool-aging through toModelMessages", () => {
  test("renders the exact read stub, and the untouched tail in full", async () => {
    const { parts, messages } = readHistory(SessionToolAging.K + 1)
    const plan = boundary(messages)
    const rendered = await MessageV2.toModelMessages(messages, model, { toolRewrites: plan.rewrites })

    const outputs = rendered
      .filter((message) => message.role === "tool")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .map((entry) => (entry as { output: { value: string } }).output.value)

    expect(outputs[0]).toBe("[read /w/file1.ts · 100 B · 10 lines · aged out — read again if needed]")
    // t-j3qxtc: an untouched result carries the elapsed marker; the aged stub does not.
    expect(outputs[1]).toBe("[took 0.0 s]\n" + "x".repeat(200))
    expect(outputs).toHaveLength(SessionToolAging.K + 1)
    expect(parts).toHaveLength(SessionToolAging.K + 1)
  })

  test("renders the exact shell stub with its exit code", async () => {
    const shell = toolPart({
      messageID: "msg_a1",
      tool: "bash",
      args: { command: "bun test --timeout 30000 test/session/tool-aging.test.ts --reporter verbose" },
      output: "o".repeat(2048),
      metadata: { exit: 1, truncated: false, output: "" },
    })
    const filler = readHistory(SessionToolAging.K)
    const messages = [assistantMessage("msg_a1", [shell]), ...filler.messages]
    const plan = boundary(messages)
    const rendered = await MessageV2.toModelMessages(messages, model, { toolRewrites: plan.rewrites })

    const first = rendered.find((message) => message.role === "tool")!
    const value = (first.content as { output: { value: string } }[])[0]!.output.value
    expect(value).toBe(
      '[shell "bun test --timeout 30000 test/session/tool-aging.test.ts --r" · 2.0 KB · exit 1 · aged out — run again if needed]',
    )
    // Exactly COMMAND_PREVIEW_CHARS of the command, and no more.
    expect(value.slice(8, 8 + SessionToolAging.COMMAND_PREVIEW_CHARS + 1)).toBe(
      "bun test --timeout 30000 test/session/tool-aging.test.ts --r\"",
    )
  })

  test("a rewritten write sends the stub as its arguments and keeps its own output", async () => {
    const write = toolPart({
      messageID: "msg_a1",
      tool: "write",
      args: { filePath: "/w/out.ts", content: "q".repeat(4096) },
      output: "wrote it",
    })
    const filler = readHistory(SessionToolAging.K)
    const messages = [assistantMessage("msg_a1", [write]), ...filler.messages]
    const plan = boundary(messages)
    const rendered = await MessageV2.toModelMessages(messages, model, { toolRewrites: plan.rewrites })

    const call = rendered
      .filter((message) => message.role === "assistant")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((entry) => (entry as { type: string }).type === "tool-call") as { input: Record<string, unknown> }
    expect(call.input).toEqual({ filePath: "/w/out.ts", content: "[wrote /w/out.ts · 4096 bytes]" })

    const output = (rendered.find((message) => message.role === "tool")!.content as { output: { value: string } }[])[0]!
    expect(output.output.value).toBe("[took 0.0 s]\nwrote it")
  })

  test("with no rewrites the array is byte-identical to the un-aged one", async () => {
    const { messages } = readHistory(SessionToolAging.K + 1)
    const off = SessionToolAging.plan({ sessionID, messages, boundary: true, enabled: false })
    const aged = await MessageV2.toModelMessages(messages, model, { toolRewrites: off.rewrites })
    const plain = await MessageV2.toModelMessages(messages, model)
    expect(JSON.stringify(aged)).toBe(JSON.stringify(plain))
  })

  test("a part the prune already cleared keeps the prune's own notice", async () => {
    const { parts, messages } = readHistory(SessionToolAging.K + 1)
    const state = parts[0]!.state as SessionV1.ToolStateCompleted
    state.time.compacted = 1
    const plan = boundary(messages)
    const rendered = await MessageV2.toModelMessages(messages, model, { toolRewrites: plan.rewrites })

    const first = rendered.find((message) => message.role === "tool")!
    const value = (first.content as { output: { value: string } }[])[0]!.output.value
    expect(value).toBe("[Old tool result content cleared]")
  })
})

const dbNode = LayerNode.group([
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(AppNodeBuilder.build(dbNode, []))

describe("session.tool-aging never writes the database", () => {
  it.live(
    "the stored output survives aging unchanged",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const info = yield* sessions.create({})
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: { providerID, modelID: ModelV2.ID.make("test-model") },
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: info.id,
          type: "text",
          text: "go",
        })

        const stored: string[] = []
        for (let index = 1; index <= SessionToolAging.K + 2; index++) {
          const assistant: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test-model"),
            providerID,
            parentID: user.id,
            time: { created: Date.now() },
            finish: "tool-calls",
          } as unknown as SessionV1.Assistant
          yield* sessions.updateMessage(assistant)
          const output = `<path>/w/db${index}.ts</path>\n` + "d".repeat(index * 500)
          stored.push(output)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: `/w/db${index}.ts` },
              output,
              title: "read",
              metadata: { display: { type: "file", path: `/w/db${index}.ts`, totalLines: index } },
              time: { start: Date.now(), end: Date.now() },
            },
          })
        }

        const before = yield* sessions.messages({ sessionID: info.id })
        // The in-memory parts too: the engine persists this very array
        // elsewhere in the loop, so an aging path that edited a part here
        // would reach SQLite by someone else's write.
        const snapshot = JSON.stringify(before)
        const plan = SessionToolAging.plan({ sessionID: info.id, messages: before, boundary: true, batch: 1 })
        expect(plan.counts.aged).toBe(2)

        const rendered = yield* MessageV2.toModelMessagesEffect(before, model, { toolRewrites: plan.rewrites })
        expect(JSON.stringify(rendered)).toContain("aged out — read again if needed")
        expect(JSON.stringify(before)).toBe(snapshot)

        // Read back THROUGH THE STORE, not through the array we just rendered.
        const after = yield* sessions.messages({ sessionID: info.id })
        const outputs = after
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool")
          .map((part) => (part.state.status === "completed" ? part.state.output : ""))
        expect(outputs).toEqual(stored)
        for (const part of after.flatMap((message) => message.parts)) {
          if (part.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeUndefined()
          }
        }
      }),
    ),
  )
})

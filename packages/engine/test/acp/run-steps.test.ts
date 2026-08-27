import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient, Part, SessionMessageResponse } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { MAX_CHILD_SESSIONS, MAX_SUBAGENT_DEPTH, PREVIEW_LIMIT, childSessionIds, project } from "@/acp/run-steps"

const sessionID = "ses_review"

let partSeq = 0
function partIds(messageID: string) {
  partSeq++
  return { id: `prt_${partSeq}`, sessionID, messageID }
}

function userMessage(messageID: string, text: string, created = 1_000): SessionMessageResponse {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "prov", modelID: "mod" },
    },
    parts: [{ ...partIds(messageID), type: "text", text }],
  } as unknown as SessionMessageResponse
}

function assistantMessage(
  messageID: string,
  parts: unknown[],
  overrides: Record<string, unknown> = {},
): SessionMessageResponse {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: 1_000, completed: 2_000 },
      parentID: "msg_u1",
      modelID: "mod",
      providerID: "prov",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      ...overrides,
    },
    parts,
  } as unknown as SessionMessageResponse
}

function completedTool(messageID: string, tool: string, output: string, title = `${tool} call`): Part {
  return {
    ...partIds(messageID),
    type: "tool",
    callID: `call_${tool}`,
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title,
      metadata: {},
      time: { start: 1_100, end: 1_400 },
    },
  } as unknown as Part
}

/**
 * A `task` call as the engine really stores it: the child's session id lives on
 * `state.metadata.sessionId`, written by `ctx.metadata(...)` in `tool/task.ts`.
 * Shape copied from a real stored run (the owner's "Generating 10 stories using
 * 10 subagents" session), which also carries parentSessionId/model/jobId.
 */
function taskTool(messageID: string, childSessionId: string, title: string): Part {
  return {
    ...partIds(messageID),
    type: "tool",
    callID: `call_${childSessionId}`,
    tool: "task",
    state: {
      status: "completed",
      input: {},
      output: `<task id="${childSessionId}" state="running">`,
      title,
      metadata: { parentSessionId: sessionID, sessionId: childSessionId, jobId: childSessionId },
      time: { start: 1_100, end: 1_400 },
    },
  } as unknown as Part
}

/** A whole child run: one prompt plus one assistant turn of `tools` tool calls. */
function childRun(childSessionId: string, tools: string[], extra: unknown[] = []): SessionMessageResponse[] {
  const mid = `msg_${childSessionId}`
  return [
    {
      info: {
        id: `${mid}_u`,
        sessionID: childSessionId,
        role: "user",
        time: { created: 1_100 },
        agent: "explore",
        model: { providerID: "kid", modelID: "kmod" },
      },
      parts: [{ ...partIds(`${mid}_u`), type: "text", text: `child prompt ${childSessionId}` }],
    },
    {
      info: {
        id: mid,
        sessionID: childSessionId,
        role: "assistant",
        time: { created: 1_100, completed: 1_400 },
        parentID: `${mid}_u`,
        modelID: "kmod",
        providerID: "kid",
        mode: "build",
        agent: "explore",
        path: { cwd: "/workspace", root: "/workspace" },
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [...tools.map((tool) => completedTool(mid, tool, `${tool} out`)), ...extra],
    },
  ] as unknown as SessionMessageResponse[]
}

describe("every step is placeable in time", () => {
  // A consumer that positions a run on a CLOCK (the map's thread axis) needs
  // every step timed, and degrades the WHOLE view to list order if one is not.
  // A user prompt is never streamed, so its part carries no time — which meant
  // every real run had at least one untimed step and the clock axis never once
  // engaged. These pin the instants that made it fall back.
  it("gives a user prompt the instant its message was created", () => {
    const [step] = project([userMessage("msg_u1", "do the thing", 1_234)]).steps
    expect(step).toMatchObject({ kind: "prompt", startedAt: 1_234 })
  })

  it("gives a retry an instant too — one retry must not untime a whole run", () => {
    const { steps } = project([
      userMessage("msg_u1", "go", 1_000),
      assistantMessage("msg_a1", [{ ...partIds("msg_a1"), type: "retry", attempt: 2, error: "rate limited" }], {
        time: { created: 2_000, completed: 2_500 },
      }),
    ])
    expect(steps.every((s) => typeof s.startedAt === "number")).toBe(true)
    expect(steps.find((s) => s.title === "Retry 2")).toMatchObject({ startedAt: 2_000 })
  })

  it("prefers a STREAMED part's own start over its message's — the part is more precise", () => {
    const { steps } = project([
      assistantMessage(
        "msg_a1",
        [{ ...partIds("msg_a1"), type: "reasoning", text: "considering", time: { start: 1_050, end: 1_080 } }],
        { time: { created: 9_999, completed: 10_500 } },
      ),
    ])
    expect(steps[0]).toMatchObject({ kind: "thinking", startedAt: 1_050, endedAt: 1_080 })
  })
})

describe("run-steps projection", () => {
  it("orders a prompt, a tool call, a subagent spawn and a failure into the right kinds", () => {
    const result = project([
      userMessage("msg_u1", "do the thing"),
      assistantMessage("msg_a1", [
        { ...partIds("msg_a1"), type: "reasoning", text: "considering", time: { start: 1_050, end: 1_080 } },
        completedTool("msg_a1", "bash", "hello"),
        completedTool("msg_a1", "task", "subagent finished"),
        {
          ...partIds("msg_a1"),
          type: "tool",
          callID: "call_edit",
          tool: "edit",
          state: { status: "error", input: {}, error: "permission denied", time: { start: 1_500, end: 1_550 } },
        },
        { ...partIds("msg_a1"), type: "text", text: "all done" },
      ]),
    ])

    expect(result.steps.map((step) => step.kind)).toEqual(["prompt", "thinking", "tool", "subagent", "tool", "reply"])
    expect(result.steps.map((step) => step.ordinal)).toEqual([0, 1, 2, 3, 4, 5])
    expect(result.truncated).toBe(false)
    expect(result.total).toBe(6)

    // The `task` call is the subagent spawn, and keeps its tool name.
    expect(result.steps[3]).toMatchObject({ kind: "subagent", tool: "task", status: "completed" })
    // The failed edit reports error status AND the message.
    expect(result.steps[4]).toMatchObject({ kind: "tool", tool: "edit", status: "error", error: "permission denied" })
    // Durations derive from both timestamps.
    expect(result.steps[2]).toMatchObject({ startedAt: 1_100, endedAt: 1_400, durationMs: 300 })
  })

  it("projects a message-level failure as an error step carrying the message", () => {
    const result = project([
      assistantMessage("msg_a1", [{ ...partIds("msg_a1"), type: "text", text: "partial" }], {
        error: { name: "ProviderAuthError", data: { providerID: "prov", message: "auth expired" } },
      }),
    ])

    expect(result.steps.map((step) => step.kind)).toEqual(["reply", "error"])
    expect(result.steps[1]).toMatchObject({ kind: "error", status: "error", error: "auth expired" })
  })

  it("reports running and pending tool states rather than guessing completion", () => {
    const result = project([
      assistantMessage("msg_a1", [
        {
          ...partIds("msg_a1"),
          type: "tool",
          callID: "call_a",
          tool: "bash",
          state: { status: "running", input: {}, title: "bash: sleep", time: { start: 2_000 } },
        },
        {
          ...partIds("msg_a1"),
          type: "tool",
          callID: "call_b",
          tool: "read",
          state: { status: "pending", input: {}, raw: "" },
        },
      ]),
    ])

    expect(result.steps[0]).toMatchObject({ status: "running", startedAt: 2_000 })
    expect(result.steps[0]!.endedAt).toBeUndefined()
    // No end timestamp means no fabricated duration.
    expect(result.steps[0]!.durationMs).toBeUndefined()
    expect(result.steps[1]).toMatchObject({ status: "pending" })
    expect(result.steps[1]!.startedAt).toBeUndefined()
  })

  it("returns every step of a run and never flags truncation", () => {
    const parts = Array.from({ length: 12 }, (_, i) => completedTool("msg_a1", "bash", `out ${i}`))
    const result = project([assistantMessage("msg_a1", parts)])

    expect(result.steps).toHaveLength(12)
    expect(result.truncated).toBe(false)
    expect(result.total).toBe(12)
    // Ordinals stay 0-based contiguous positions in the run.
    expect(result.steps.map((step) => step.ordinal)).toEqual(Array.from({ length: 12 }, (_, i) => i))
  })

  it("ships a run past the old 500-step ceiling in full", () => {
    const parts = Array.from({ length: 510 }, () => completedTool("msg_a1", "bash", "out"))
    const result = project([assistantMessage("msg_a1", parts)])

    expect(result.steps).toHaveLength(510)
    expect(result.truncated).toBe(false)
    expect(result.total).toBe(510)
    expect(result.steps.at(-1)!.ordinal).toBe(509)
  })

  it("degrades an unrecognised part type to a generic step instead of throwing", () => {
    const result = project([
      assistantMessage("msg_a1", [
        { ...partIds("msg_a1"), type: "quantum-part", payload: { nested: true } },
        { ...partIds("msg_a1"), type: "text", text: "still here" },
      ]),
    ])

    // The unknown part is surfaced, and crucially the rest of the run survives.
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]).toMatchObject({ kind: "tool", tool: "quantum-part" })
    expect(result.steps[1]).toMatchObject({ kind: "reply", preview: "still here" })
  })

  it("skips bookkeeping parts so a run reads as actions, not internals", () => {
    const result = project([
      assistantMessage("msg_a1", [
        { ...partIds("msg_a1"), type: "step-start" },
        { ...partIds("msg_a1"), type: "snapshot", snapshot: "abc" },
        { ...partIds("msg_a1"), type: "text", text: "answer" },
        {
          ...partIds("msg_a1"),
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ]),
    ])

    expect(result.steps.map((step) => step.kind)).toEqual(["reply"])
    expect(result.total).toBe(1)
  })

  it("drops synthetic and ignored text so injected context is not shown as a user prompt", () => {
    const result = project([
      {
        info: userMessage("msg_u1", "x").info,
        parts: [
          { ...partIds("msg_u1"), type: "text", text: "real prompt" },
          { ...partIds("msg_u1"), type: "text", text: "injected", synthetic: true },
          { ...partIds("msg_u1"), type: "text", text: "hidden", ignored: true },
          { ...partIds("msg_u1"), type: "text", text: "   " },
        ],
      } as unknown as SessionMessageResponse,
    ])

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({ kind: "prompt", preview: "real prompt" })
  })

  it("hard-caps the preview and never splits a surrogate pair", () => {
    // Astral emoji: one code point, two UTF-16 units. A naive slice would cut one in half.
    const emoji = "😀".repeat(600)
    const result = project([assistantMessage("msg_a1", [{ ...partIds("msg_a1"), type: "text", text: emoji }])])

    const excerpt = result.steps[0]!.preview!
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(PREVIEW_LIMIT)
    // A lone surrogate would land in this range; none may survive truncation.
    expect(/[\uD800-\uDFFF]/.test(excerpt.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false)
  })

  it("attaches usage once per assistant message, not once per part", () => {
    const result = project([
      assistantMessage("msg_a1", [
        completedTool("msg_a1", "bash", "one"),
        { ...partIds("msg_a1"), type: "text", text: "done" },
      ]),
    ])

    const withTokens = result.steps.filter((step) => step.tokens)
    expect(withTokens).toHaveLength(1)
    expect(withTokens[0]).toMatchObject({ kind: "reply", tokens: { input: 10, output: 20 } })
    // The reason the rule exists: a consumer totals a run by SUMMING steps, so
    // one message counted on both its parts doubles that run's reported spend.
    expect(result.steps.reduce((n, s) => n + (s.tokens?.input ?? 0), 0)).toBe(10)
    expect(result.steps.reduce((n, s) => n + (s.cost ?? 0), 0)).toBe(0)
    expect(result.steps.filter((s) => s.cost !== undefined)).toHaveLength(1)
  })

  it("projects reasoning and cache alongside input/output, and the message's cost", () => {
    const result = project([
      assistantMessage("msg_a1", [{ ...partIds("msg_a1"), type: "text", text: "done" }], {
        cost: 0.0042,
        tokens: { total: 75_464, input: 636, output: 274, reasoning: 58, cache: { read: 74_496, write: 12 } },
      }),
    ])

    // Cache-read is NOT folded into input: 636 in + 74,496 cached is the shape
    // a real cached turn has (verified against the v2-rebase store), and
    // collapsing them hides the whole difference between cheap and expensive.
    expect(result.steps[0]!.tokens).toEqual({
      input: 636,
      output: 274,
      reasoning: 58,
      cache: { read: 74_496, write: 12 },
    })
    expect(result.steps[0]!.cost).toBe(0.0042)
    expect(result.steps[0]!.usageMissing).toBeUndefined()
  })

  it("OMITS an absent reasoning/cache rather than reporting it as zero", () => {
    const result = project([
      assistantMessage("msg_a1", [{ ...partIds("msg_a1"), type: "text", text: "done" }], {
        tokens: { input: 10, output: 20 },
      }),
    ])

    // A zero here would read as "this model did no reasoning and cached
    // nothing", which is a measurement the store never took.
    expect(result.steps[0]!.tokens).toEqual({ input: 10, output: 20 })
    expect(Object.keys(result.steps[0]!.tokens!).sort()).toEqual(["input", "output"])
  })

  it("KEEPS a genuine zero — a free local turn is a measurement, not an absence", () => {
    const result = project([
      assistantMessage("msg_a1", [{ ...partIds("msg_a1"), type: "text", text: "done" }], {
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ])

    expect(result.steps[0]!.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(result.steps[0]!.cost).toBe(0)
    expect(result.steps[0]!.usageMissing).toBeUndefined()
  })

  it("FLAGS an assistant message that recorded no usage, so a sum is not read as complete", () => {
    const result = project([
      assistantMessage("msg_a1", [{ ...partIds("msg_a1"), type: "text", text: "recorded" }]),
      assistantMessage("msg_a2", [{ ...partIds("msg_a2"), type: "text", text: "not recorded" }], {
        tokens: undefined,
        cost: undefined,
      }),
    ])

    expect(result.steps[0]!.usageMissing).toBeUndefined()
    expect(result.steps[1]!.usageMissing).toBe(true)
    expect(result.steps[1]!.tokens).toBeUndefined()
    // Nothing invented in its place: the gap is DECLARED, not filled with 0.
    expect(result.steps[1]!.cost).toBeUndefined()
  })

  // THE DEFECT: usage was attached to "the last step this message produced",
  // so a message that produced NO step lost its usage entirely — and lost the
  // `usageMissing` flag with it, so the short total was not even marked short.
  // Measured in the local store: 2,665 of 33,718 stored assistant messages are
  // exactly this shape, carrying 25.9M tokens. The two real signatures are both
  // covered below.
  it("carries the usage of a request whose parts were ALL structural", () => {
    const result = project([
      assistantMessage(
        "msg_a1",
        [
          { ...partIds("msg_a1"), type: "step-start", snapshot: "abc" },
          { ...partIds("msg_a1"), type: "step-finish", reason: "tool-calls", snapshot: "abc" },
        ],
        { tokens: { input: 447, output: 1, reasoning: 0, cache: { read: 61_184, write: 0 } }, cost: 0 },
      ),
    ])

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({ kind: "reply", model: "prov/mod", agent: "build" })
    expect(result.steps[0]!.tokens).toEqual({ input: 447, output: 1, reasoning: 0, cache: { read: 61_184, write: 0 } })
    // 61,632 tokens that used to vanish from every total drawn off these steps.
    expect(result.steps.reduce((n, s) => n + (s.tokens?.cache?.read ?? 0), 0)).toBe(61_184)
  })

  it("carries the usage of a request whose only text part came back EMPTY", () => {
    const result = project([
      assistantMessage(
        "msg_a1",
        [
          { ...partIds("msg_a1"), type: "step-start", snapshot: "abc" },
          { ...partIds("msg_a1"), type: "text", text: "" },
          { ...partIds("msg_a1"), type: "step-finish", reason: "stop", snapshot: "abc" },
        ],
        { tokens: { input: 510, output: 4, reasoning: 0, cache: { read: 80_384, write: 0 } }, cost: 0 },
      ),
    ])

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]!.tokens?.input).toBe(510)
  })

  it("EVERY provider's requests reach the projection — a second provider is not dropped", () => {
    const result = project([
      assistantMessage("msg_a1", [{ ...partIds("msg_a1"), type: "text", text: "from one" }], {
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 9_000, write: 0 } },
      }),
      assistantMessage("msg_a2", [{ ...partIds("msg_a2"), type: "text", text: "from the other" }], {
        providerID: "xai",
        modelID: "grok-4.5",
        tokens: { input: 200, output: 20, reasoning: 143, cache: { read: 800, write: 0 } },
      }),
    ])

    expect(result.steps.map((s) => s.model)).toEqual(["openai/gpt-5.6-sol", "xai/grok-4.5"])
    expect(result.steps.reduce((n, s) => n + (s.tokens?.input ?? 0), 0)).toBe(1_200)
    // The reasoning tokens belong to the SECOND provider only, so a total that
    // reports 0 here is one that stopped counting after the first.
    expect(result.steps.reduce((n, s) => n + (s.tokens?.reasoning ?? 0), 0)).toBe(143)
  })

  it("labels model and agent from the owning message", () => {
    const result = project([userMessage("msg_u1", "hi"), assistantMessage("msg_a1", [])])

    expect(result.steps[0]).toMatchObject({ model: "prov/mod", agent: "build" })
  })

  it("survives an empty run, and a partless message earns a step only if it MEASURED something", () => {
    expect(project([])).toEqual({ steps: [], truncated: false, total: 0 })
    // Measured: the request happened and was billed, so it is carried. (The
    // default fixture records tokens.)
    expect(project([assistantMessage("msg_a1", [])]).total).toBe(1)
    // Unmeasured AND partless: a non-event. A marker for it would be a node on
    // the map standing for nothing at all.
    expect(project([assistantMessage("msg_a1", [], { tokens: undefined, cost: undefined })]).total).toBe(0)
  })
})

describe("subagent branches", () => {
  /** Parent run: prompt -> [task spawn, bash, reply]. The task step is ordinal 1. */
  function parentRun(spawns: [string, string][] = [["ses_kid", "Story #1"]]) {
    return [
      userMessage("msg_u1", "delegate it"),
      assistantMessage("msg_a1", [
        ...spawns.map(([id, title]) => taskTool("msg_a1", id, title)),
        completedTool("msg_a1", "bash", "after the subagent"),
        { ...partIds("msg_a1"), type: "text", text: "all done" },
      ]),
    ]
  }

  it("reads the child session id off the stored task metadata, deduped, ignoring ordinary tools", () => {
    const ids = childSessionIds([
      assistantMessage("msg_a1", [
        completedTool("msg_a1", "bash", "not a spawn"),
        taskTool("msg_a1", "ses_kid_a", "A"),
        taskTool("msg_a1", "ses_kid_b", "B"),
        // A resumed task (`task_id`) reuses one session across calls.
        taskTool("msg_a1", "ses_kid_a", "A again"),
        // task_stop manages a task; it does not spawn one.
        completedTool("msg_a1", "task_stop", "stopped"),
      ]),
    ])

    expect(ids).toEqual(["ses_kid_a", "ses_kid_b"])
  })

  it("branches the child's steps inline after its task step, then returns to the main line", () => {
    const result = project(parentRun(), new Map([["ses_kid", childRun("ses_kid", ["read", "grep"])]]))

    // prompt(0) task(1) [child prompt(2) read(3) grep(4)] bash(5) reply(6)
    expect(result.steps.map((step) => step.kind)).toEqual([
      "prompt",
      "subagent",
      "prompt",
      "tool",
      "tool",
      "tool",
      "reply",
    ])
    // One contiguous sequence over the WHOLE flattened list — the ordering
    // contract the existing consumer relies on.
    expect(result.steps.map((step) => step.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(result.total).toBe(7)

    // Only the child's steps are nested, and they all point at the task step.
    expect(result.steps.map((step) => step.depth)).toEqual([undefined, undefined, 1, 1, 1, undefined, undefined])
    expect(result.steps.map((step) => step.parentOrdinal)).toEqual([
      undefined,
      undefined,
      1,
      1,
      1,
      undefined,
      undefined,
    ])
    // The step AFTER the branch is the parent's own next action, not the child's.
    expect(result.steps[5]).toMatchObject({ kind: "tool", tool: "bash", preview: "after the subagent" })
  })

  it("keeps a child step's own model and agent instead of inheriting the spawning message's", () => {
    const result = project(parentRun(), new Map([["ses_kid", childRun("ses_kid", ["read"])]]))

    expect(result.steps[1]).toMatchObject({ kind: "subagent", model: "prov/mod", agent: "build" })
    // Child steps are the subagent's work under the subagent's model.
    expect(result.steps[2]).toMatchObject({ model: "kid/kmod", agent: "explore" })
    expect(result.steps[3]).toMatchObject({ model: "kid/kmod", agent: "explore" })
  })

  it("projects the parent alone when the child's messages were not supplied", () => {
    const result = project(parentRun())

    expect(result.steps.map((step) => step.kind)).toEqual(["prompt", "subagent", "tool", "reply"])
    expect(result.steps.every((step) => step.depth === undefined)).toBe(true)
    expect(result.steps.every((step) => step.parentOrdinal === undefined)).toBe(true)
    expect(result.total).toBe(4)
  })

  it("stops expanding at MAX_SUBAGENT_DEPTH, still showing the step that would have gone deeper", () => {
    // root -> A (depth 1) -> B (depth 2) -> C (would be depth 3)
    const a = childRun("ses_a", [], [taskTool("msg_ses_a", "ses_b", "grandchild")])
    const b = childRun("ses_b", [], [taskTool("msg_ses_b", "ses_c", "great-grandchild")])
    const c = childRun("ses_c", ["read"])
    const result = project(
      parentRun([["ses_a", "child"]]),
      new Map([
        ["ses_a", a],
        ["ses_b", b],
        ["ses_c", c],
      ]),
    )

    const depths = result.steps.map((step) => step.depth ?? 0)
    expect(Math.max(...depths)).toBe(MAX_SUBAGENT_DEPTH)
    expect(depths.some((depth) => depth > MAX_SUBAGENT_DEPTH)).toBe(false)
    // C was fetched and offered, but never expanded: its spawning step is the
    // deepest thing present, and none of C's own work leaked in.
    const titles = result.steps.map((step) => step.title)
    expect(titles).toContain("great-grandchild")
    expect(result.steps.some((step) => step.preview === "child prompt ses_c")).toBe(false)
  })

  it("does not re-enter a session already on the branch, so a cycle cannot spin forever", () => {
    // The child's task step points back at the run being reviewed.
    const looping = childRun("ses_kid", [], [taskTool("msg_ses_kid", sessionID, "back to the root")])
    const result = project(parentRun(), new Map([["ses_kid", looping]]))

    // Terminates, and the root's steps appear exactly once each.
    expect(result.steps.filter((step) => step.preview === "delegate it")).toHaveLength(1)
    expect(result.steps.filter((step) => step.preview === "all done")).toHaveLength(1)
    expect(result.steps.map((step) => step.ordinal)).toEqual(result.steps.map((_, i) => i))
  })

  it("expands a resumed child session once even when several task calls name it", () => {
    const result = project(
      parentRun([
        ["ses_kid", "first call"],
        ["ses_kid", "resumed"],
      ]),
      new Map([["ses_kid", childRun("ses_kid", ["read"])]]),
    )

    // Two subagent steps (both calls really happened) but ONE branch — the
    // resumed session's messages are the same records, not a second run.
    expect(result.steps.filter((step) => step.kind === "subagent")).toHaveLength(2)
    expect(result.steps.filter((step) => step.preview === "child prompt ses_kid")).toHaveLength(1)
  })

  it("ships a ten-subagent fan-out whole, every child step included", () => {
    const spawns = Array.from({ length: 10 }, (_, i) => [`ses_kid_${i}`, `Story #${i}`] as [string, string])
    const children = new Map(spawns.map(([id]) => [id, childRun(id, ["read", "grep", "edit"])]))
    // Each child contributes 4 steps (prompt + 3 tools); 10 spawns + bash + reply
    // + 40 child steps = 53 in total.
    const result = project(parentRun(spawns), children)

    expect(result.steps).toHaveLength(53)
    expect(result.truncated).toBe(false)
    expect(result.total).toBe(53)
    expect(result.steps.map((step) => step.ordinal)).toEqual(Array.from({ length: 53 }, (_, i) => i))
    // The LAST spawn's own work is present, which is exactly what the old cap cut.
    expect(result.steps.some((step) => step.title === "Story #9")).toBe(true)
    expect(result.steps.filter((step) => step.preview === "child prompt ses_kid_9")).toHaveLength(1)
  })
})

/**
 * Shapes below are copied from real stored rows in the owner's v2-rebase store
 * (the "Write war story" run): a detached spawn is `status: "completed"` with an
 * end ~14ms after its start, `state.metadata.background === true`, and the
 * subagent's real finish only exists as a synthetic `<task_result>` turn injected
 * back into the PARENT's stream.
 */
describe("background subagents", () => {
  /** A `task` call spawned with `background: true`, exactly as the engine stores it. */
  function backgroundSpawn(messageID: string, child: string, title: string, start: number, toolEnd: number): Part {
    return {
      ...partIds(messageID),
      type: "tool",
      callID: `call_${child}`,
      tool: "task",
      state: {
        status: "completed",
        input: {},
        // The spawn returns immediately; the subagent has NOT run yet.
        output: `<task id="${child}" state="running">\n<summary>Background task started</summary>`,
        title,
        metadata: { parentSessionId: sessionID, sessionId: child, jobId: child, background: true },
        time: { start, end: toolEnd },
      },
    } as unknown as Part
  }

  /** The synthetic turn `tool/task.ts` injects when a background subagent settles. */
  function injectedResult(
    messageID: string,
    created: number,
    results: { child: string; status?: "completed" | "error" }[],
  ): SessionMessageResponse {
    return {
      info: { id: messageID, sessionID, role: "user", time: { created }, agent: "build" },
      parts: [
        {
          ...partIds(messageID),
          type: "text",
          synthetic: true,
          text: results
            .map(
              ({ child, status = "completed" }) =>
                `<task id="${child}" state="${status}">\n<summary>Background task ${
                  status === "error" ? "failed" : "completed"
                }: work</summary>\n<task_result>\nthe result\n</task_result>\n</task>`,
            )
            .join("\n"),
        },
      ],
    } as unknown as SessionMessageResponse
  }

  it("marks a detached spawn as background and a foreground one as not", () => {
    const result = project([
      assistantMessage("msg_a1", [
        backgroundSpawn("msg_a1", "ses_bg", "Write war story #1", 1_785_320_173_015, 1_785_320_173_029),
        taskTool("msg_a1", "ses_fg", "blocking child"),
      ]),
    ])

    expect(result.steps[0]).toMatchObject({ kind: "subagent", background: true, childSessionId: "ses_bg" })
    // A foreground task must not be dressed up as detached — its own span is true.
    expect(result.steps[1]!.background).toBeUndefined()
    expect(result.steps[1]).toMatchObject({ status: "completed", startedAt: 1_100, endedAt: 1_400, durationMs: 300 })
  })

  it("reports a background subagent that never returned as running, with no end", () => {
    // Real row: "Extract EA core memory", spawned and never settled in this run.
    const result = project([
      assistantMessage("msg_a1", [
        backgroundSpawn("msg_a1", "ses_bg", "Extract EA core memory", 1_785_148_975_777, 1_785_148_975_787),
      ]),
    ])

    const step = result.steps[0]!
    expect(step).toMatchObject({ kind: "subagent", background: true, status: "running", startedAt: 1_785_148_975_777 })
    // The tool's own 10ms end is the spawn returning, NOT the subagent finishing.
    expect(step.endedAt).toBeUndefined()
    expect(step.durationMs).toBeUndefined()
  })

  it("takes a completed background subagent's end from the injected result, not the spawn's return", () => {
    const start = 1_785_149_022_673
    const injected = 1_785_150_614_039 // real row: the subagent ran 1_591_366ms
    const result = project([
      assistantMessage("msg_a1", [backgroundSpawn("msg_a1", "ses_bg", "Extract EA subprojects", start, start + 12)]),
      injectedResult("msg_inject", injected, [{ child: "ses_bg" }]),
    ])

    const step = result.steps[0]!
    expect(step).toMatchObject({ status: "completed", startedAt: start, endedAt: injected })
    expect(step.durationMs).toBe(injected - start)
    // The whole point: not the 12ms the spawn's own tool state claims.
    expect(step.durationMs).toBe(1_591_366)
  })

  it("carries a failed background subagent's error status and its real end", () => {
    const result = project([
      assistantMessage("msg_a1", [backgroundSpawn("msg_a1", "ses_bg", "doomed", 5_000, 5_010)]),
      injectedResult("msg_inject", 9_000, [{ child: "ses_bg", status: "error" }]),
    ])

    expect(result.steps[0]).toMatchObject({ status: "error", startedAt: 5_000, endedAt: 9_000, durationMs: 4_000 })
  })

  it("times each task in a drained batch, where one injected turn carries several results", () => {
    // `drain` joins every result queued during a turn into ONE synthetic turn, so
    // reading only the first marker would strand every sibling as "running".
    const result = project([
      assistantMessage("msg_a1", [
        backgroundSpawn("msg_a1", "ses_one", "one", 1_000, 1_010),
        backgroundSpawn("msg_a1", "ses_two", "two", 2_000, 2_010),
      ]),
      injectedResult("msg_inject", 8_000, [{ child: "ses_one" }, { child: "ses_two", status: "error" }]),
    ])

    expect(result.steps[0]).toMatchObject({ status: "completed", endedAt: 8_000, durationMs: 7_000 })
    expect(result.steps[1]).toMatchObject({ status: "error", endedAt: 8_000, durationMs: 6_000 })
  })

  it("times a background subagent whose child session was never fetched", () => {
    // No `children` map at all: the completion lives in the parent's own stream,
    // so timing must not depend on expanding the child.
    const result = project([
      assistantMessage("msg_a1", [backgroundSpawn("msg_a1", "ses_bg", "unfetched", 1_000, 1_012)]),
      injectedResult("msg_inject", 61_000, [{ child: "ses_bg" }]),
    ])

    expect(result.steps.filter((step) => step.depth !== undefined)).toHaveLength(0)
    expect(result.steps[0]).toMatchObject({
      background: true,
      status: "completed",
      endedAt: 61_000,
      durationMs: 60_000,
    })
  })

  it("keeps ordinals contiguous when background steps are timed and children expand", () => {
    const result = project(
      [
        userMessage("msg_u1", "spawn two"),
        assistantMessage("msg_a1", [
          backgroundSpawn("msg_a1", "ses_one", "one", 1_000, 1_010),
          backgroundSpawn("msg_a1", "ses_two", "two", 2_000, 2_010),
        ]),
        injectedResult("msg_inject", 8_000, [{ child: "ses_one" }]),
      ],
      new Map([["ses_one", childRun("ses_one", ["read"])]]),
    )

    expect(result.steps.map((step) => step.ordinal)).toEqual(Array.from({ length: result.steps.length }, (_, i) => i))
    expect(result.total).toBe(result.steps.length)
    // Timing a spawn must not move it: the second spawn still follows the branch.
    expect(result.steps.at(-1)).toMatchObject({ kind: "subagent", childSessionId: "ses_two", status: "running" })
  })

  it("gives a user-invoked subtask the instant it was invoked", () => {
    const result = project([
      {
        info: { id: "msg_u1", sessionID, role: "user", time: { created: 4_242 }, agent: "build" },
        parts: [
          {
            ...partIds("msg_u1"),
            type: "subtask",
            prompt: "go and look",
            description: "Recon",
            agent: "explore",
          },
        ],
      } as unknown as SessionMessageResponse,
    ])

    const step = result.steps[0]!
    expect(step).toMatchObject({ kind: "subagent", title: "Recon", agent: "explore", startedAt: 4_242 })
    // SubtaskPart stores no end and no status — so neither is invented.
    expect(step.endedAt).toBeUndefined()
    expect(step.status).toBeUndefined()
    expect(step.background).toBeUndefined()
  })
})

describe("run_steps service method", () => {
  function trackingSdk(seen: { calls: unknown[]; mutations: string[] }) {
    const forbid =
      (name: string) =>
      (...args: unknown[]) => {
        seen.mutations.push(name)
        void args
        return Promise.resolve({ data: {} })
      }
    return {
      session: {
        messages: (params: unknown) => {
          seen.calls.push(params)
          return Promise.resolve({
            data: [
              userMessage("msg_u1", "review me"),
              assistantMessage("msg_a1", [completedTool("msg_a1", "bash", "ok")]),
            ],
          })
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

  it("reviews a session that was never loaded in this connection, without mutating it", async () => {
    const seen = { calls: [] as unknown[], mutations: [] as string[] }
    // No newSession/loadSession call precedes this — the session is unknown here.
    const service = ACPService.make({ sdk: trackingSdk(seen) })

    const result = await Effect.runPromise(service.runSteps({ sessionId: "ses_never_loaded", cwd: "/workspace" }))

    expect(result.steps.map((step) => step.kind)).toEqual(["prompt", "tool"])
    expect(seen.calls).toEqual([{ directory: "/workspace", sessionID: "ses_never_loaded" }])
    // Read-only: nothing that creates, resumes, mutates or deletes was touched.
    expect(seen.mutations).toEqual([])
  })

  it("omits the directory when no cwd is given rather than inventing one", async () => {
    const seen = { calls: [] as unknown[], mutations: [] as string[] }
    const service = ACPService.make({ sdk: trackingSdk(seen) })

    await Effect.runPromise(service.runSteps({ sessionId: "ses_1" }))

    expect(seen.calls).toEqual([{ sessionID: "ses_1" }])
  })

  it("surfaces a backing-store failure as an ACP error instead of an empty run", async () => {
    const sdk = {
      session: { messages: () => Promise.reject(new Error("store offline")) },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })

    const failure = await Effect.runPromise(Effect.flip(service.runSteps({ sessionId: "ses_1" })))

    expect(failure._tag).toBe("ACPServiceFailureError")
  })
})

describe("run_steps subagent fetching", () => {
  /** An sdk backed by a per-session store, recording every session it was asked for. */
  function storeSdk(store: Record<string, SessionMessageResponse[]>, reads: string[], broken = new Set<string>()) {
    return {
      session: {
        messages: (params: { sessionID: string }) => {
          reads.push(params.sessionID)
          if (broken.has(params.sessionID)) return Promise.reject(new Error("child gone"))
          return Promise.resolve({ data: store[params.sessionID] ?? [] })
        },
      },
    } as unknown as OrigamiClient
  }

  function spawner(spawns: [string, string][]) {
    return [
      userMessage("msg_u1", "delegate it"),
      assistantMessage(
        "msg_a1",
        spawns.map(([id, title]) => taskTool("msg_a1", id, title)),
      ),
    ]
  }

  it("fetches each spawned child once and returns the branch, not just the task step", async () => {
    const reads: string[] = []
    const service = ACPService.make({
      sdk: storeSdk({ ses_root: spawner([["ses_kid", "Story #1"]]), ses_kid: childRun("ses_kid", ["read"]) }, reads),
    })

    const result = await Effect.runPromise(service.runSteps({ sessionId: "ses_root", cwd: "/workspace" }))

    expect(reads).toEqual(["ses_root", "ses_kid"])
    expect(result.steps.map((step) => step.depth)).toEqual([undefined, undefined, 1, 1])
    expect(result.steps[3]).toMatchObject({ kind: "tool", tool: "read", depth: 1, parentOrdinal: 1 })
  })

  it("bounds the reads at MAX_CHILD_SESSIONS on a pathological fan-out", async () => {
    const spawns = Array.from(
      { length: MAX_CHILD_SESSIONS + 15 },
      (_, i) => [`ses_kid_${i}`, `#${i}`] as [string, string],
    )
    const store: Record<string, SessionMessageResponse[]> = { ses_root: spawner(spawns) }
    for (const [id] of spawns) store[id] = childRun(id, ["read"])
    const reads: string[] = []
    const service = ACPService.make({ sdk: storeSdk(store, reads) })

    const result = await Effect.runPromise(service.runSteps({ sessionId: "ses_root" }))

    // One read for the run itself, then no more than the child budget.
    expect(reads).toHaveLength(MAX_CHILD_SESSIONS + 1)
    // Every spawn is still REPORTED; only the ones past the budget stay unexpanded.
    expect(result.steps.filter((step) => step.kind === "subagent")).toHaveLength(spawns.length)
    expect(result.steps.filter((step) => step.depth === 1)).toHaveLength(MAX_CHILD_SESSIONS * 2)
  })

  it("keeps the review alive when a child session cannot be read", async () => {
    const reads: string[] = []
    const service = ACPService.make({
      sdk: storeSdk(
        {
          ses_root: spawner([
            ["ses_dead", "deleted child"],
            ["ses_kid", "live child"],
          ]),
          ses_kid: childRun("ses_kid", ["read"]),
        },
        reads,
        new Set(["ses_dead"]),
      ),
    })

    const result = await Effect.runPromise(service.runSteps({ sessionId: "ses_root" }))

    // The dead child's own step survives; the live sibling still expands.
    expect(result.steps.filter((step) => step.kind === "subagent").map((step) => step.title)).toEqual([
      "deleted child",
      "live child",
    ])
    expect(result.steps.filter((step) => step.depth === 1)).toHaveLength(2)
  })

  it("passes the reviewed directory to every child read, and omits it when none was given", async () => {
    const scoped: unknown[] = []
    const sdk = {
      session: {
        messages: (params: { sessionID: string }) => {
          scoped.push(params)
          const store: Record<string, SessionMessageResponse[]> = {
            ses_root: spawner([["ses_kid", "child"]]),
            ses_kid: childRun("ses_kid", []),
          }
          return Promise.resolve({ data: store[params.sessionID] ?? [] })
        },
      },
    } as unknown as OrigamiClient

    await Effect.runPromise(ACPService.make({ sdk }).runSteps({ sessionId: "ses_root", cwd: "/workspace" }))
    expect(scoped).toEqual([
      { directory: "/workspace", sessionID: "ses_root" },
      { directory: "/workspace", sessionID: "ses_kid" },
    ])

    scoped.length = 0
    await Effect.runPromise(ACPService.make({ sdk }).runSteps({ sessionId: "ses_root" }))
    expect(scoped).toEqual([{ sessionID: "ses_root" }, { sessionID: "ses_kid" }])
  })
})

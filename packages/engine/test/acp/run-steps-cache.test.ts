// `run_steps` carries the engine's cache verdict (t-rylleg).
//
// The projection used to send `tokens` and nothing else, so Labyrinth derived a
// cause from four rules and printed "unknown — the run records no cause" for
// half the losses it showed. The engine now records the cause on the
// `step-finish` part, and `step-finish` is a STRUCTURAL part the projection
// skips — so the verdict has to be moved onto a step a reader can see.
//
// Which step: the one that carries the message's tokens, i.e. the reply or tool
// call of that same model step. The two shapes that break a naive answer are
// both fixtures here — a step-finish that is a separate part from the reply
// text of the same assistant message, and a message with SEVERAL step-finish
// parts, where each step's cause must land on its own step rather than all of
// them piling onto the last one.

import { describe, expect, test } from "bun:test"
import type { Part, SessionMessageResponse } from "@origami/sdk/v2"
import { project } from "@/acp/run-steps"

const sessionID = "ses_cache"

let seq = 0
const ids = (messageID: string) => {
  seq++
  return { id: `prt_${seq}`, sessionID, messageID }
}

const text = (messageID: string, value: string): Part =>
  ({ ...ids(messageID), type: "text", text: value, time: { start: 1_100, end: 1_200 } }) as unknown as Part

const tool = (messageID: string, name: string): Part =>
  ({
    ...ids(messageID),
    type: "tool",
    callID: `call_${name}`,
    tool: name,
    state: { status: "completed", input: {}, output: "ok", title: name, metadata: {}, time: { start: 1, end: 2 } },
  }) as unknown as Part

/** A `step-finish` part as the engine now stores it. */
const stepFinish = (messageID: string, cache?: unknown, prefix?: unknown): Part =>
  ({
    ...ids(messageID),
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(cache === undefined ? {} : { cache }),
    ...(prefix === undefined ? {} : { prefix }),
  }) as unknown as Part

const assistant = (messageID: string, parts: Part[]): SessionMessageResponse =>
  ({
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
      path: { cwd: "/w", root: "/w" },
      cost: 0.5,
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  }) as unknown as SessionMessageResponse

const MISS = {
  cause: "tools",
  preserved: false,
  divergence: { message: 3, role: "user", offset: 4_096, source: "tool-aging" },
  idleMs: 1_800,
  ttlSeconds: 300,
} as const

describe("the cache verdict lands on the step that carries the message's tokens", () => {
  test("a step-finish in its own part puts the verdict on the reply of that step", () => {
    const steps = project([
      assistant("msg_a", [
        text("msg_a", "Here is the answer."),
        stepFinish("msg_a", MISS, { system: "aaaa", tools: "bbbb", history: "cccc" }),
      ]),
    ]).steps

    expect(steps).toHaveLength(1)
    expect(steps[0]!.kind).toBe("reply")
    // The same step that carries the tokens carries the reason it read cold.
    expect(steps[0]!.tokens?.input).toBe(10)
    expect(steps[0]!.cache).toEqual(MISS)
    expect(steps[0]!.prefix).toEqual({ system: "aaaa", tools: "bbbb", history: "cccc" })
  })

  test("each step of a multi-step message keeps its OWN cause", () => {
    const steps = project([
      assistant("msg_b", [
        tool("msg_b", "read"),
        stepFinish("msg_b", { cause: "cold" }),
        tool("msg_b", "edit"),
        stepFinish("msg_b", { cause: "provider", preserved: true }),
        text("msg_b", "Done."),
        stepFinish("msg_b", { preserved: true, idleMs: 12 }),
      ]),
    ]).steps

    expect(steps.map((step) => step.title)).toEqual(["read", "edit", "Done."])
    expect(steps[0]!.cache).toEqual({ cause: "cold" })
    expect(steps[1]!.cache).toEqual({ cause: "provider", preserved: true })
    // A HIT: facts, no cause. The message's tokens are on this last step too.
    expect(steps[2]!.cache).toEqual({ preserved: true, idleMs: 12 })
    expect(steps[2]!.tokens?.output).toBe(20)
  })

  test("a restore's `stopped` cause and its halves pass through; unknown halves are dropped (t-w2txb2)", () => {
    const steps = project([
      assistant("msg_s", [
        text("msg_s", "Back."),
        stepFinish("msg_s", { cause: "stopped", stopped: ["tools", "sunspots", "history"], idleMs: 60_000 }),
      ]),
    ]).steps

    expect(steps[0]!.cache).toEqual({ cause: "stopped", idleMs: 60_000, stopped: ["tools", "history"] })
  })

  test("a message whose only parts are bookkeeping still reports its verdict", () => {
    const steps = project([assistant("msg_c", [stepFinish("msg_c", { cause: "compaction" })])]).steps

    expect(steps).toHaveLength(1)
    expect(steps[0]!.title).toBe("No output recorded")
    expect(steps[0]!.cache).toEqual({ cause: "compaction" })
  })
})

describe("what the projection refuses to pass on", () => {
  test("a step-finish with neither block leaves both fields absent, not empty", () => {
    const steps = project([assistant("msg_d", [text("msg_d", "hi"), stepFinish("msg_d")])]).steps

    expect(steps[0]!.cache).toBeUndefined()
    expect(steps[0]!.prefix).toBeUndefined()
  })

  test("a cache-blind step keeps its prefix digests and claims no cause", () => {
    const steps = project([
      assistant("msg_e", [text("msg_e", "hi"), stepFinish("msg_e", undefined, { system: "aaaa", tools: "bbbb" })]),
    ]).steps

    expect(steps[0]!.cache).toBeUndefined()
    expect(steps[0]!.prefix).toEqual({ system: "aaaa", tools: "bbbb" })
  })

  test("a cause this build has no sentence for is dropped rather than relabelled", () => {
    const steps = project([
      assistant("msg_f", [text("msg_f", "hi"), stepFinish("msg_f", { cause: "sunspots", preserved: false })]),
    ]).steps

    expect(steps[0]!.cache).toEqual({ preserved: false })
  })

  test("a divergence missing its numbers is dropped; the rest of the block survives", () => {
    const steps = project([
      assistant("msg_g", [
        text("msg_g", "hi"),
        stepFinish("msg_g", { cause: "history", divergence: { role: "user" } }),
      ]),
    ]).steps

    expect(steps[0]!.cache).toEqual({ cause: "history" })
  })

  test("an unrecognised divergence source is dropped, and the divergence is still reported", () => {
    const steps = project([
      assistant("msg_h", [
        text("msg_h", "hi"),
        stepFinish("msg_h", { cause: "history", divergence: { message: 2, role: "user", offset: 9, source: "ufo" } }),
      ]),
    ]).steps

    expect(steps[0]!.cache).toEqual({ cause: "history", divergence: { message: 2, role: "user", offset: 9 } })
  })
})

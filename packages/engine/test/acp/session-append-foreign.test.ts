// `session_append_foreign` — the mirror. A Claude Code passthrough chat binds a
// real engine session and never writes to it, so History, the Labyrinth and the
// usage tables (all of which read engine truth) showed an empty chat. This
// method copies the transcript in WITHOUT running a turn.
//
// WHAT IS PINNED HERE, and what deliberately is not.
//
// The PLANNER is pure and takes its ids and its clock as arguments, so every
// row it produces can be asserted exactly — that is where idempotency, the
// parent-pointer invariant and the zero-pricing shape live, and all three are
// mutation-proved (remove the `stored` check and the second test goes red).
//
// The REFUSALS are asserted at the agent's dispatch, synchronously, exactly as
// session-delete.test.ts asserts its own: the JSON-RPC layer turns a throw into
// an error response, so a client can never get a plausible `{ appended: n }`
// back for a batch that was never written.
//
// The WRITE ITSELF (Session.updateMessage → the projector → MessageTable) is
// not re-asserted here. It is the same seam the turn loop and `interject`
// already use and it is proven in session/*; re-testing it would need a real
// instance and a real database, and this file touches neither.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { SessionMessageResponse } from "@origami/sdk/v2"
import { Agent } from "@/acp/agent"
import * as ACPService from "@/acp/service"
import { CLAUDE_CODE, MAX_MESSAGES, isForeign, lastUserID, plan, storedIds } from "@/acp/foreign-transcript"
import { stat } from "@/acp/run-stats"

function ids(prefix: string) {
  let n = 0
  return () => `${prefix}_${++n}`
}

function planner(over: Partial<Parameters<typeof plan>[0]> = {}) {
  return {
    sessionID: "ses_a",
    source: CLAUDE_CODE,
    incoming: [],
    stored: new Map<string, string>(),
    path: { cwd: "/repo", root: "/repo" },
    agent: "build",
    modelID: "sonnet",
    providerID: CLAUDE_CODE,
    nextMessageID: ids("msg"),
    nextPartID: ids("prt"),
    now: () => 1000,
    ...over,
  }
}

const TURN = [
  { id: "cc-1", role: "user" as const, text: "fix the parser", timestamp: 10 },
  {
    id: "cc-2",
    role: "assistant" as const,
    text: "done",
    timestamp: 20,
    toolCalls: [{ name: "Read", title: "parser.ts" }],
  },
]

describe("foreign-transcript.plan — one mirrored turn", () => {
  it("writes the user line and parents the assistant to it, both stamped with their source", () => {
    const { rows, skipped } = plan(planner({ incoming: TURN }))

    expect(skipped).toBe(0)
    expect(rows.map((r) => String(r.info.id))).toEqual(["msg_1", "msg_2"])
    const user = rows[0]!.info as Record<string, unknown>
    const assistant = rows[1]!.info as Record<string, unknown>
    expect(user["role"]).toBe("user")
    expect(user["source"]).toBe(CLAUDE_CODE)
    expect(user["sourceMessageID"]).toBe("cc-1")
    expect(assistant["parentID"]).toBe("msg_1")
    expect(assistant["source"]).toBe(CLAUDE_CODE)
    expect(assistant["sourceMessageID"]).toBe("cc-2")
    // The foreign harness's timestamps, not the planner's clock: a mirror that
    // restamped every message with "now" would sort the whole transcript into
    // one instant the moment a re-sync ran.
    expect((user["time"] as { created: number }).created).toBe(10)
    expect((assistant["time"] as { created: number }).created).toBe(20)
  })

  it("prices a mirrored turn at ZERO and writes no step-finish part", () => {
    const { rows } = plan(planner({ incoming: TURN }))
    const assistant = rows[1]!.info as Record<string, unknown>

    expect(assistant["cost"]).toBe(0)
    // A client that reported nothing gets zeros — the store's shape has no way
    // to say "unmeasured", and this is what every build before the counts sent.
    expect(assistant["tokens"]).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    // The session's running cost/token columns are only ever moved by a
    // step-finish part (core/session/projector.ts `usage`/`applyUsage`), so its
    // ABSENCE is the half of zero-pricing the numbers above cannot cover.
    expect(rows.flatMap((r) => r.parts).some((p) => (p as { type: string }).type === "step-finish")).toBe(false)
  })

  // TOKENS ARE A SIZE, NOT A PRICE. Zeroing the counts was not caution, it was a
  // false claim: the Labyrinth reads `info.tokens` through run-steps.ts, so every
  // mirrored turn showed as a turn of no size. Carrying the real ones must move
  // NEITHER of the two things that make a row cost money.
  it("carries the foreign harness's REAL token counts while staying unpriced", () => {
    const { rows } = plan(
      planner({
        incoming: [
          TURN[0]!,
          {
            id: "cc-2",
            role: "assistant" as const,
            text: "done",
            tokens: { input: 10, output: 62, cacheRead: 128, cacheWrite: 36352 },
          },
        ],
      }),
    )
    const assistant = rows[1]!.info as Record<string, unknown>

    expect(assistant["tokens"]).toEqual({ input: 10, output: 62, reasoning: 0, cache: { read: 128, write: 36352 } })
    // Both halves of the zero-pricing guard, asserted against a row that now
    // carries real numbers — this is the pairing the whole change turns on.
    expect(assistant["cost"]).toBe(0)
    expect(rows.flatMap((r) => r.parts).some((p) => (p as { type: string }).type === "step-finish")).toBe(false)
  })

  // The counts cross a JSON-RPC boundary from another process. A negative one
  // would SUBTRACT from the Labyrinth's totals and make a real run look cheaper
  // than it was, so a mirrored row must not be able to carry one.
  it("clamps a count that is negative, not a number, or missing", () => {
    const { rows } = plan(
      planner({
        incoming: [
          TURN[0]!,
          {
            id: "cc-2",
            role: "assistant" as const,
            text: "done",
            tokens: { input: -500, output: Number.NaN, cacheRead: "12" as unknown as number },
          },
        ],
      }),
    )

    expect((rows[1]!.info as Record<string, unknown>)["tokens"]).toEqual({
      input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 },
    })
  })

  // TWO CALLS OF THE SAME TOOL IN ONE TURN. `callID` was `<messageID>-<name>`,
  // which collides the moment an agentic turn runs `Glob` twice — captured live
  // in `~/.origami/sessions/session-2.json`, where both Globs of one mirrored
  // turn were stored as `msg_0595e68d…-Glob`. A reader that keys tool cards by
  // callID then merges the second call's update onto the first card and leaves
  // the second spinning for ever. The position in the turn is what separates
  // them, and it is stable across re-reads of the stored row.
  it("gives every tool step its own callID, even two calls of the same tool", () => {
    const { rows } = plan(
      planner({
        incoming: [
          TURN[0]!,
          {
            id: "cc-2",
            role: "assistant" as const,
            text: "",
            toolCalls: [
              { name: "Glob", title: "**/skills/delegate/SKILL.md" },
              { name: "Glob", title: "C:\\Users\\dev\\.claude\\skills" },
            ],
          },
        ],
      }),
    )

    const ids = (rows[1]!.parts as unknown as Array<Record<string, unknown>>).map((p) => p["callID"])
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual(["msg_2-0-Glob", "msg_2-1-Glob"])
  })

  it("records tool calls as steps, keeping a failure a failure", () => {
    const { rows } = plan(
      planner({
        incoming: [
          TURN[0]!,
          {
            id: "cc-2",
            role: "assistant" as const,
            text: "",
            toolCalls: [
              { name: "Read", title: "parser.ts" },
              { name: "Bash", title: "npm test", status: "error" },
            ],
          },
        ],
      }),
    )

    const parts = rows[1]!.parts as unknown as Array<Record<string, unknown>>
    // No text part: the reply said nothing, and an empty bubble is not content.
    expect(parts.map((p) => p["type"])).toEqual(["tool", "tool"])
    expect(parts.map((p) => p["tool"])).toEqual(["Read", "Bash"])
    expect((parts[0]!["state"] as { status: string }).status).toBe("completed")
    expect((parts[1]!["state"] as { status: string }).status).toBe("error")
  })
})

describe("foreign-transcript.plan — idempotency", () => {
  it("appends NOTHING when the session already holds the batch", () => {
    const first = plan(planner({ incoming: TURN }))
    const stored = storedIds(first.rows.map((r) => ({ info: r.info as unknown as { id: string; sourceMessageID?: string } })))

    const second = plan(planner({ incoming: TURN, stored }))

    expect(second.rows).toEqual([])
    expect(second.skipped).toBe(2)
  })

  it("parents a NEW assistant to the stored user message when only that half is a repeat", () => {
    const stored = new Map([["cc-1", "msg_stored_user"]])
    const { rows, skipped } = plan(planner({ incoming: TURN, stored }))

    expect(skipped).toBe(1)
    expect(rows).toHaveLength(1)
    expect((rows[0]!.info as Record<string, unknown>)["parentID"]).toBe("msg_stored_user")
  })

  it("drops an assistant that has no user turn to parent to, rather than guessing one", () => {
    const { rows, skipped } = plan(planner({ incoming: [TURN[1]!] }))

    expect(rows).toEqual([])
    expect(skipped).toBe(1)
  })

  it("parents an orphan assistant to the session's OWN last user message when there is one", () => {
    const { rows } = plan(planner({ incoming: [TURN[1]!], lastUserID: "msg_engine_user" }))

    expect((rows[0]!.info as Record<string, unknown>)["parentID"]).toBe("msg_engine_user")
  })
})

describe("foreign-transcript helpers", () => {
  it("reads the foreign→engine id map off the stored messages, ignoring engine-written ones", () => {
    const map = storedIds([
      { info: { id: "msg_1", sourceMessageID: "cc-1" } },
      { info: { id: "msg_2" } },
      { info: { id: "msg_3", sourceMessageID: "" } },
    ])

    expect([...map]).toEqual([["cc-1", "msg_1"]])
  })

  it("finds the NEWEST user message, not the first", () => {
    expect(
      lastUserID([
        { info: { id: "msg_1", role: "user" } },
        { info: { id: "msg_2", role: "assistant" } },
        { info: { id: "msg_3", role: "user" } },
      ]),
    ).toBe("msg_3")
    expect(lastUserID([{ info: { id: "msg_1", role: "assistant" } }])).toBeUndefined()
  })

  it("calls a message foreign only when it carries a non-empty source", () => {
    expect(isForeign({ source: CLAUDE_CODE })).toBe(true)
    expect(isForeign({ source: "" })).toBe(false)
    expect(isForeign({})).toBe(false)
    expect(isForeign(undefined)).toBe(false)
  })
})

// The reason the stamp is DECLARED in the schema rather than carried as an
// excess property: run_stats reads its messages back over the HTTP API, whose
// success schema drops every key it does not declare. Assert the guard on the
// shape that actually arrives there.
describe("run_stats prices a mirrored turn at zero", () => {
  const assistant = (over: Record<string, unknown>): SessionMessageResponse =>
    ({
      info: {
        id: "msg_a",
        sessionID: "ses_a",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parentID: "msg_u",
        modelID: "m",
        providerID: "p",
        mode: "build",
        agent: "build",
        path: { cwd: "/w", root: "/w" },
        cost: 0.25,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        ...over,
      },
      parts: [],
    }) as unknown as SessionMessageResponse

  it("counts an ENGINE assistant message as one request with its spend", () => {
    const engine = stat("ses_a", [assistant({})])

    expect(engine.requests).toBe(1)
    expect(engine.cost).toBe(0.25)
    expect(engine.tokens).toEqual({ input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  })

  // The row this stands over now carries REAL counts (foreign-transcript writes
  // whatever the harness measured), so `tokens` here is deliberately non-zero:
  // the guard has to hold on a row that has something to report, not only on a
  // zeroed one. The default `tokens: { input: 10, output: 20 }` above IS the
  // point of the fixture.
  it("counts a MIRRORED assistant message as no requests and no spend at all", () => {
    const mirrored = stat("ses_a", [assistant({ source: CLAUDE_CODE, sourceMessageID: "cc-2", cost: 0 })])

    expect(mirrored.requests).toBe(0)
    expect(mirrored.cost).toBeUndefined()
    expect(mirrored.tokens).toBeUndefined()
    // The message itself is still LISTED — the chat happened, and a mirror that
    // hid it would defeat its own purpose. Only the spend is somebody else's.
    expect(mirrored.messages).toBe(1)
  })
})

describe("session_append_foreign ext method dispatch", () => {
  const service = {
    sessionAppendForeign: (input: unknown) => Effect.succeed({ appended: 0, skipped: 0, echo: input }),
  } as unknown as ACPService.Interface
  const agent = () => new Agent(service)

  it("accepts the `_` wire prefix clients send for extension methods", async () => {
    const args = { sessionId: "ses_a", source: CLAUDE_CODE, messages: [] }
    expect(await agent().extMethod("_session_append_foreign", args)).toEqual(
      await agent().extMethod("session_append_foreign", args),
    )
  })

  it("refuses a missing, non-string or EMPTY sessionId rather than writing into a guess", () => {
    const a = agent()
    expect(() => a.extMethod("session_append_foreign", { source: CLAUDE_CODE, messages: [] })).toThrow("Invalid params")
    expect(() => a.extMethod("session_append_foreign", { sessionId: "", source: CLAUDE_CODE, messages: [] })).toThrow(
      "Invalid params",
    )
    expect(() => a.extMethod("session_append_foreign", { sessionId: 42, source: CLAUDE_CODE, messages: [] })).toThrow(
      "Invalid params",
    )
  })

  it("refuses a batch with no source, so a mirrored row can never be unattributable", () => {
    expect(() => agent().extMethod("session_append_foreign", { sessionId: "ses_a", messages: [] })).toThrow(
      "Invalid params",
    )
    expect(() =>
      agent().extMethod("session_append_foreign", { sessionId: "ses_a", source: "", messages: [] }),
    ).toThrow("Invalid params")
  })

  it("refuses a messages value that is not an array", () => {
    expect(() =>
      agent().extMethod("session_append_foreign", { sessionId: "ses_a", source: CLAUDE_CODE, messages: "nope" }),
    ).toThrow("Invalid params")
  })

  it(`refuses more than ${MAX_MESSAGES} messages in one call`, () => {
    const over = Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => ({ id: `cc-${i}`, role: "user", text: "hi" }))
    expect(() =>
      agent().extMethod("session_append_foreign", { sessionId: "ses_a", source: CLAUDE_CODE, messages: over }),
    ).toThrow("Invalid params")
    const exact = over.slice(0, MAX_MESSAGES)
    expect(
      agent().extMethod("session_append_foreign", { sessionId: "ses_a", source: CLAUDE_CODE, messages: exact }),
    ).resolves.toBeDefined()
  })

  it("refuses an entry with no id — the id IS the idempotency guard", () => {
    expect(() =>
      agent().extMethod("session_append_foreign", {
        sessionId: "ses_a",
        source: CLAUDE_CODE,
        messages: [{ role: "user", text: "hi" }],
      }),
    ).toThrow("Invalid params")
  })

  it("refuses a role outside the union, and a non-string text", () => {
    const send = (message: unknown) =>
      agent().extMethod("session_append_foreign", { sessionId: "ses_a", source: CLAUDE_CODE, messages: [message] })
    expect(() => send({ id: "cc-1", role: "system", text: "hi" })).toThrow("Invalid params")
    expect(() => send({ id: "cc-1", role: "user", text: { oops: true } })).toThrow("Invalid params")
    expect(() => send({ id: "cc-1", role: "user", text: "hi", toolCalls: [{ title: "no name" }] })).toThrow(
      "Invalid params",
    )
  })

  /**
   * THE TOKENS REGRESSION, at the boundary that actually dropped them.
   *
   * `plan()` has read `message.tokens` since the counts were added, and the
   * planner tests above pass because they call `plan()` DIRECTLY. Nothing ever
   * reached it: `foreignMessage` rebuilds every entry field by field, `tokens`
   * was not one of the fields, and so every mirrored row was still stored with
   * zeros. The suite stayed green while live UAT showed a
   * `claude-code/claude-code ×1` row in the Labyrinth with RUN SPEND all zeros.
   *
   * The batch below is the one `claudeCodeMirror.batchOf` builds, with the
   * counts `protocol.resultUsage` read off the CAPTURED `result` frame
   * (spike/transcript_run1.txt: input 10, output 62, cache_read 0,
   * cache_creation 36352) — so the fixture is the real wire, not a shape
   * invented to match the code.
   */
  it("carries the client's token counts THROUGH the validator, not just through plan()", async () => {
    const seen: unknown[] = []
    const tracking = {
      sessionAppendForeign: (input: unknown) => {
        seen.push(input)
        return Effect.succeed({ appended: 0, skipped: 0 })
      },
    } as unknown as ACPService.Interface

    await new Agent(tracking).extMethod("session_append_foreign", {
      sessionId: "ses_a",
      source: CLAUDE_CODE,
      messages: [
        { id: "session-1:1788205471602:u", role: "user", text: "Tell me who you are", timestamp: 1788205471602 },
        {
          id: "session-1:1788205471602:a",
          role: "assistant",
          text: "I'm Sam",
          timestamp: 1788205483651,
          tokens: { input: 10, output: 62, cacheRead: 0, cacheWrite: 36352 },
        },
      ],
    })

    const messages = (seen[0] as { messages: Array<Record<string, unknown>> }).messages
    expect(messages[1]!["tokens"]).toEqual({ input: 10, output: 62, cacheRead: 0, cacheWrite: 36352 })
    // And the row the planner then builds carries them, which is what the
    // Labyrinth reads through run-steps.ts `messageUsage`.
    const { rows } = plan(
      planner({ incoming: messages as never, lastUserID: "msg_engine_user" }),
    )
    expect((rows[1]!.info as Record<string, unknown>)["tokens"]).toEqual({
      input: 10, output: 62, reasoning: 0, cache: { read: 0, write: 36352 },
    })
    // The two things that make a row cost money are still untouched.
    expect((rows[1]!.info as Record<string, unknown>)["cost"]).toBe(0)
    expect(rows.flatMap((r) => r.parts).some((p) => (p as { type: string }).type === "step-finish")).toBe(false)
  })

  it("omits a token block that carries no numbers, rather than inventing zeros", async () => {
    const seen: unknown[] = []
    const tracking = {
      sessionAppendForeign: (input: unknown) => {
        seen.push(input)
        return Effect.succeed({ appended: 0, skipped: 0 })
      },
    } as unknown as ACPService.Interface

    await new Agent(tracking).extMethod("session_append_foreign", {
      sessionId: "ses_a",
      source: CLAUDE_CODE,
      messages: [
        { id: "cc-1", role: "assistant", text: "x", tokens: { input: "12", output: null } },
        { id: "cc-2", role: "assistant", text: "y", tokens: "nonsense" },
      ],
    })

    const messages = (seen[0] as { messages: Array<Record<string, unknown>> }).messages
    // A malformed count is DROPPED, never refused: the transcript the user can
    // see on screen must not fail to mirror because a number was the wrong type.
    expect(messages[0]!["tokens"]).toBeUndefined()
    expect(messages[1]!["tokens"]).toBeUndefined()
  })

  it("normalises an absent text to '' and drops an empty toolCalls list", async () => {
    const seen: unknown[] = []
    const tracking = {
      sessionAppendForeign: (input: unknown) => {
        seen.push(input)
        return Effect.succeed({ appended: 0, skipped: 0 })
      },
    } as unknown as ACPService.Interface

    await new Agent(tracking).extMethod("session_append_foreign", {
      sessionId: "ses_a",
      source: CLAUDE_CODE,
      cwd: "/repo",
      messages: [{ id: "cc-1", role: "user", toolCalls: [] }],
    })

    expect(seen).toEqual([
      { sessionId: "ses_a", source: CLAUDE_CODE, messages: [{ id: "cc-1", role: "user", text: "" }], cwd: "/repo" },
    ])
  })
})

// Per-agent activity retention. Pure: no runner, no store, no session - just
// the reading of one message and the folding of it into what an agent has been
// doing lately (report F3, "one live pill, 200 characters").

import { describe, expect, it } from "bun:test"
import { CollabActivity } from "@/collab/activity"

const message = (id: string, parts: readonly unknown[]) =>
  ({ info: { id, role: "assistant", time: { created: 0 } }, parts }) as never

const tool = (name: string, arg: string) => ({ type: "tool", tool: name, state: { status: "running", input: { arg } } })
const thinking = (text: string) => ({ type: "reasoning", text })

const entry = (kind: "tool" | "thought", text: string, messageId: string) => ({ kind, text, messageId })

describe("collab turn activity", () => {
  it("reads EVERY tool and thought of the turn, in the order they happened", () => {
    expect(
      CollabActivity.turnActivity(
        message("msg_1", [thinking("the schema first"), tool("read", "sql.ts"), tool("edit", "store.ts")]),
      ),
    ).toEqual([
      { kind: "thought", text: "the schema first" },
      { kind: "tool", text: "read: sql.ts" },
      { kind: "tool", text: "edit: store.ts" },
    ])
  })

  it("skips a thought that has streamed nothing yet, and every other kind of part", () => {
    expect(
      CollabActivity.turnActivity(
        message("msg_1", [thinking("   "), { type: "text", text: "the final answer" }, tool("bash", "ls")]),
      ),
    ).toEqual([{ kind: "tool", text: "bash: ls" }])
  })

  it("is empty when there is no message at all", () => {
    expect(CollabActivity.turnActivity(undefined)).toEqual([])
  })

  it("bounds each signal at the wire's own limit", () => {
    const long = "z".repeat(CollabActivity.LIVE_ACTIVITY_MAX_CHARS + 50)
    const signals = CollabActivity.turnActivity(message("msg_1", [thinking(long), tool("read", long)]))
    expect(signals.map((signal) => signal.text.length)).toEqual([
      CollabActivity.LIVE_ACTIVITY_MAX_CHARS,
      CollabActivity.LIVE_ACTIVITY_MAX_CHARS,
    ])
  })
})

describe("collab activity retention", () => {
  it("tags what a turn produced with the turn it came from", () => {
    expect(CollabActivity.mergeActivity([], "msg_1", [{ kind: "tool", text: "read: sql.ts" }])).toEqual([
      entry("tool", "read: sql.ts", "msg_1"),
    ])
  })

  it("folds a RE-READ of the same turn in place rather than piling copies up", () => {
    // The poll re-reads the message the turn is still writing. Appending it
    // blindly would fill the whole log with one turn's first tool call.
    const first = CollabActivity.mergeActivity([], "msg_1", [{ kind: "tool", text: "read: sql.ts" }])
    const grown = CollabActivity.mergeActivity(first, "msg_1", [
      { kind: "tool", text: "read: sql.ts" },
      { kind: "tool", text: "edit: store.ts" },
    ])
    expect(grown).toEqual([entry("tool", "read: sql.ts", "msg_1"), entry("tool", "edit: store.ts", "msg_1")])
  })

  it("keeps the PREVIOUS turn's entries - the log outlives one hop", () => {
    const first = CollabActivity.mergeActivity([], "msg_1", [{ kind: "tool", text: "read: sql.ts" }])
    expect(CollabActivity.mergeActivity(first, "msg_2", [{ kind: "tool", text: "edit: store.ts" }])).toEqual([
      entry("tool", "read: sql.ts", "msg_1"),
      entry("tool", "edit: store.ts", "msg_2"),
    ])
  })

  it("caps the log and drops the OLDEST, so what is kept is what just happened", () => {
    const filled = Array.from({ length: CollabActivity.ACTIVITY_LOG_MAX }, (_, index) =>
      entry("tool", `read: file${index}.ts`, `msg_${index}`),
    )
    const next = CollabActivity.mergeActivity(filled, "msg_new", [{ kind: "tool", text: "edit: last.ts" }])
    expect(next).toHaveLength(CollabActivity.ACTIVITY_LOG_MAX)
    expect(next[0]).toEqual(entry("tool", "read: file1.ts", "msg_1"))
    expect(next.at(-1)).toEqual(entry("tool", "edit: last.ts", "msg_new"))
  })

  it("keeps the newest of ONE turn when that turn alone overruns the cap", () => {
    const many = Array.from({ length: CollabActivity.ACTIVITY_LOG_MAX + 3 }, (_, index) => ({
      kind: "tool" as const,
      text: `read: file${index}.ts`,
    }))
    const next = CollabActivity.mergeActivity([], "msg_1", many)
    expect(next).toHaveLength(CollabActivity.ACTIVITY_LOG_MAX)
    expect(next[0]?.text).toBe("read: file3.ts")
  })
})

// THE TRAILING LANE — everything the engine appends to a request beyond the
// system prompt and the conversation: the memory index and the in-memory
// reminders. Both used to be written into the LAST USER MESSAGE, and that is
// what these tests exist to keep out.
//
// Two requirements, and either one alone re-admits the other's bug.
//
// 1. PORTABILITY. The first step of a turn ends on the user's own message, so a
//    naive append emits `user, user`. `@ai-sdk/anthropic` merges adjacent user
//    turns and hides it; `@ai-sdk/google` does not —
//    `convertToGoogleGenerativeAIMessages` pushes one `contents` entry per
//    message, so Gemini would receive two consecutive `user` roles, which its
//    multi-turn contract does not promise to accept.
//
// 2. BYTE STABILITY. A sub-agent has ONE user message for its whole life, so
//    that message IS the head of its conversation, and a prefix cache matches
//    from byte 0. Writing into it — memory folded in on step 1 and gone on step
//    2, or a reminder that fires on one step and not the next — rewrote the head
//    and re-billed the entire body. Nothing here may touch an input message.
//
// These assert the SHAPE that goes to the provider, which is the thing a
// provider can reject. A live Gemini call is the only stronger evidence for (1),
// and this suite has no key for one.
import { describe, expect, it } from "bun:test"
import type { ModelMessage } from "ai"
import { TRAILING_INJECTION_SEPARATOR, withTrailingInjections } from "@/session/prompt"

const mem = [{ text: "# Memory Index\n- [gitea](gitea.md)" }]
const textOf = (m: ModelMessage): string =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((p) => (p.type === "text" ? p.text : "")).join("")

describe("withTrailingInjections", () => {
  it("never emits two consecutive user turns, whatever the conversation ends on", () => {
    // The case that matters: step 1 of a turn, ending on what the user typed.
    const out = withTrailingInjections([{ role: "user", content: "hello" }], mem)
    const roles = out.map((m) => m.role)
    expect(roles.filter((r, i) => r === "user" && roles[i - 1] === "user")).toHaveLength(0)
    // The separator is what buys that, and it is an assistant turn.
    expect(roles).toEqual(["user", "assistant", "user"])
    expect(textOf(out[1]!)).toBe(TRAILING_INJECTION_SEPARATOR)
    // ...and the memory really is delivered, in a message of its own.
    expect(textOf(out[2]!)).toContain("# Memory Index")
  })

  it("leaves the user's own turn byte-identical, which is what a sub-agent's cache lives on", () => {
    // THE SUB-AGENT DEFECT. Step 1 ends on the user's message; step 2 ends on a
    // tool result. If step 1 rewrote that user message and step 2 did not, the
    // two steps disagree at the HEAD of the conversation - for a sub-agent, at
    // the whole of it - and every provider re-bills the body. So the same input
    // message must come back untouched on both.
    const first: ModelMessage = { role: "user", content: "do the thing" }
    const step1 = withTrailingInjections([first], mem)
    const step2 = withTrailingInjections(
      [first, { role: "assistant", content: "working" }, { role: "tool", content: [] }],
      mem,
    )
    expect(JSON.stringify(step1[0])).toBe(JSON.stringify(first))
    expect(JSON.stringify(step2[0])).toBe(JSON.stringify(first))
  })

  it("stands alone after an assistant turn, with no separator to pay for", () => {
    // Every later step ends on an assistant or tool message, so the adjacency
    // the separator exists for cannot arise and it is not sent.
    const history: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "thinking" },
    ]
    const out = withTrailingInjections(history, mem)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual(history[0]!)
    expect(out[1]).toEqual(history[1]!)
    expect(out[2]!.role).toBe("user")
    expect(textOf(out[2]!)).toContain("# Memory Index")
  })

  it("leaves a multi-part user turn exactly as it was", () => {
    // A user message carrying an image has array content, not a string. The
    // fold used to push a text part onto it, and losing the image while doing
    // that would have been a silent data loss. Nothing is pushed now, so the
    // message must come back identical - parts, order and all.
    const image: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "file", data: new URL("https://example.test/a.png"), mediaType: "image/png" },
      ],
    }
    const out = withTrailingInjections([image], mem)
    expect(out).toHaveLength(3)
    expect(out[0]).toBe(image)
    const content = out[0]!.content
    expect((content as { type: string }[]).filter((p) => p.type === "file")).toHaveLength(1)
    expect(textOf(out[0]!)).toBe("look at this")
    expect(textOf(out[2]!)).toContain("# Memory Index")
  })

  it("carries a reminder with no memory store at all, separator included", () => {
    // A session with no memory still gets reminders, and they still may not be
    // written into the conversation. Before this lane existed the reminder had
    // nowhere else to go but the user's own message.
    const out = withTrailingInjections([{ role: "user", content: "hello" }], [], ["<system-reminder>todo</system-reminder>"])
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(textOf(out[0]!)).toBe("hello")
    expect(textOf(out[2]!)).toBe("<system-reminder>todo</system-reminder>")
  })

  it("pins the order: memory first, then the reminders as given", () => {
    // Not cosmetic. The block is rebuilt on every step, so an order that
    // depended on anything but the inputs would change the bytes for free.
    const out = withTrailingInjections([{ role: "assistant", content: "ok" }], mem, ["FIRST-REMINDER", "SECOND-REMINDER"])
    const tail = textOf(out[out.length - 1]!)
    expect(tail.indexOf("# Memory Index")).toBeLessThan(tail.indexOf("FIRST-REMINDER"))
    expect(tail.indexOf("FIRST-REMINDER")).toBeLessThan(tail.indexOf("SECOND-REMINDER"))
    // One message, not three: the whole lane is a single trailing turn.
    expect(out).toHaveLength(2)
  })

  it("is byte-deterministic: the same messages and the same state give the same array", () => {
    // The cache fix rests on two steps producing identical bytes for identical
    // input. A non-deterministic join here - an id, a timestamp, a set walked
    // in hash order - would break that without breaking any other assertion.
    const history: ModelMessage[] = [{ role: "user", content: "hello" }]
    const parts = [{ text: "# Memory Index\n- [gitea](gitea.md)" }, { text: "bot memory" }]
    const reminders = ["<system-reminder>todo</system-reminder>"]
    expect(JSON.stringify(withTrailingInjections(history, parts, reminders))).toBe(
      JSON.stringify(withTrailingInjections(history, parts, reminders)),
    )
  })

  it("is a no-op with nothing to inject, so a bare session pays nothing", () => {
    const history: ModelMessage[] = [{ role: "user", content: "hello" }]
    expect(withTrailingInjections(history, [])).toEqual(history)
    expect(withTrailingInjections(history, [], [])).toEqual(history)
  })
})

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
import {
  TRAILING_CONTEXT_CLOSE,
  TRAILING_CONTEXT_CONTINUE,
  TRAILING_CONTEXT_OPEN,
  TRAILING_INJECTION_SEPARATOR,
  memoryForStep,
  trailingContextMode,
  withTrailingInjections,
} from "@/session/prompt"
import { SessionPromptCapture } from "@/session/prompt-capture"

const mem = [{ text: "# Memory Index\n- [gitea](gitea.md)" }]
const textOf = (m: ModelMessage): string =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((p) => (p.type === "text" ? p.text : "")).join("")

// origami_change (t-46a74d): `withTrailingInjections` now returns the messages
// AND the block it sent, so a turn can tell an unchanged tail from a new one.
// These tests are about the message shape, so they read the messages half; the
// digest and the fold-into-tool-result path get their own tests below.
const injectTail = (...args: Parameters<typeof withTrailingInjections>) =>
  withTrailingInjections(...args).messages

describe("withTrailingInjections", () => {
  it("never emits two consecutive user turns, whatever the conversation ends on", () => {
    // The case that matters: step 1 of a turn, ending on what the user typed.
    const out = injectTail([{ role: "user", content: "hello" }], mem)
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
    const step1 = injectTail([first], mem)
    const step2 = injectTail(
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
    const out = injectTail(history, mem)
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
    const out = injectTail([image], mem)
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
    const out = injectTail([{ role: "user", content: "hello" }], [], ["<system-reminder>todo</system-reminder>"])
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(textOf(out[0]!)).toBe("hello")
    expect(textOf(out[2]!)).toBe(`${TRAILING_CONTEXT_OPEN}
<system-reminder>todo</system-reminder>
${TRAILING_CONTEXT_CLOSE}`)
  })

  it("pins the order: memory first, then the reminders as given", () => {
    // Not cosmetic. The block is rebuilt on every step, so an order that
    // depended on anything but the inputs would change the bytes for free.
    const out = injectTail([{ role: "assistant", content: "ok" }], mem, ["FIRST-REMINDER", "SECOND-REMINDER"])
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
    expect(JSON.stringify(injectTail(history, parts, reminders))).toBe(
      JSON.stringify(injectTail(history, parts, reminders)),
    )
  })

  it("is a no-op with nothing to inject, so a bare session pays nothing", () => {
    const history: ModelMessage[] = [{ role: "user", content: "hello" }]
    expect(injectTail(history, [])).toEqual(history)
    expect(injectTail(history, [], [])).toEqual(history)
  })

  it("frames the tail on EVERY step, not only the one that gets a separator", () => {
    // THE GAP THIS PINS. The `<engine-note>` separator is emitted only when the
    // conversation ends on a user turn — step 1. Every LATER step ends on a
    // tool result, so the tail arrived as a bare `user` message with no framing
    // at all: an unlabelled user turn, last in the request. That is the shape a
    // model answers instead of working. The framing must therefore live INSIDE
    // the tail message, where it cannot be conditional on what came before.
    const step1 = injectTail([{ role: "user", content: "hello" }], mem)
    const step2 = injectTail(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }] },
        { role: "tool", content: [] },
      ],
      mem,
    )
    expect(step1.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(step2.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"])
    for (const out of [step1, step2]) {
      const tail = textOf(out[out.length - 1]!)
      expect(tail.startsWith(TRAILING_CONTEXT_OPEN)).toBe(true)
      expect(tail.endsWith(TRAILING_CONTEXT_CLOSE)).toBe(true)
      expect(tail).toContain("# Memory Index")
    }
  })

  it("says the block is reference context and needs no reply, without an order to obey", () => {
    // The symptom was a model REPLYING to the tail. Framing that itself gives
    // an order ("Do not reply to this") is one more sentence to answer, so the
    // whole lane — separator and wrapper — must be statements of fact only.
    // Second person, and the imperative verbs the tail used to open on, are
    // what a model reads as addressed to it.
    const framing = `${TRAILING_INJECTION_SEPARATOR}
${TRAILING_CONTEXT_OPEN}
${TRAILING_CONTEXT_CLOSE}`
    expect(framing).toContain("not a message from the user")
    expect(framing).toContain("needs no reply")
    expect(framing).toContain("answers the user's own message above")
    expect(framing).not.toMatch(/\byou\b|\byour\b/i)
    // Every sentence of the framing must be a statement, not an instruction:
    // an imperative opener is the shape a model answers.
    const sentences = framing
      .split(/(?<=[.:])\s+|[\n<>]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/^(Do|Don't|Read|Use|Keep|Continue|Remember|Note|Please|Ignore)\b/)
    }
  })
})

describe("memoryForStep", () => {
  const index = SessionPromptCapture.memoryParts({ memory: ["# Memory Index\n- [gitea](gitea.md)"] })

  it("carries the whole index on a turn's first step", () => {
    const first = memoryForStep({ first: true, parts: index, previous: undefined })
    expect(first.parts.map((p) => p.text)).toEqual(["# Memory Index\n- [gitea](gitea.md)"])
    expect(first.digest).toBe("# Memory Index\n- [gitea](gitea.md)")
  })

  it("sends NO memory part on a later step whose index did not change", () => {
    // THE DEFECT THIS PINS. A later step used to carry a one-line notice —
    // "The memory index shown earlier in this turn is unchanged" — as the
    // trailing USER message. Two things were wrong with it, and both are
    // observable from right here:
    //
    //  1. It was FALSE to the model. The trailing lane is never persisted into
    //     the transcript, so a later step's request contains no index at all;
    //     nothing was "shown earlier" in the request the model is reading. The
    //     sibling test below proves that absence on a real step-2 array.
    //  2. It carried no index text, no hooks and no memory directory, so it
    //     bought no recall either. It was a bare imperative addressed to the
    //     model, last in the request — and chatty models ANSWERED it
    //     ("Understood. I'll continue using the existing memory index
    //     unchanged."), spending a whole assistant turn on it.
    //
    // Sending nothing loses no capability the notice provided and removes the
    // sentence that could be answered.
    const first = memoryForStep({ first: true, parts: index, previous: undefined })
    const later = memoryForStep({ first: false, parts: index, previous: first.digest })
    expect(later.parts).toEqual([])
    expect(later.digest).toBe(first.digest)
  })

  it("a later step's request carries no index text, so no notice may claim one was shown", () => {
    // The evidence for (1) above, on the message array a provider receives.
    const first = memoryForStep({ first: true, parts: index, previous: undefined })
    const later = memoryForStep({ first: false, parts: index, previous: first.digest })
    const step2: ModelMessage[] = [
      { role: "user", content: "find the git host" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }] },
      { role: "tool", content: [] },
    ]
    const wire = JSON.stringify(injectTail(step2, later.parts, []))
    expect(wire).not.toContain("# Memory Index")
    expect(wire).not.toContain("gitea")
    // ...and with nothing left to inject the lane costs nothing at all.
    expect(injectTail(step2, later.parts, [])).toEqual(step2)
  })

  it("carries the index again when a remember call changed it mid-turn", () => {
    const first = memoryForStep({ first: true, parts: index, previous: undefined })
    const rewritten = SessionPromptCapture.memoryParts({ memory: ["# Memory Index\n- [gitea](gitea.md)\n- [new](new.md)"] })
    const later = memoryForStep({ first: false, parts: rewritten, previous: first.digest })
    expect(later.parts.map((p) => p.text)).toEqual(["# Memory Index\n- [gitea](gitea.md)\n- [new](new.md)"])
  })

  it("sends nothing, not a notice, when there is no memory at all", () => {
    const later = memoryForStep({ first: false, parts: [], previous: "" })
    expect(later.parts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// origami_change (t-46a74d): where the tail goes on a step that is NOT step 0.
// ---------------------------------------------------------------------------

/** A history that ends the way every step after the first does: on a tool result. */
const afterTool = (text = "tool output"): ModelMessage[] => [
  { role: "user", content: "do the job" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "glob", input: {} }] },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "c1", toolName: "glob", output: { type: "text", value: text } }],
  },
]

describe("trailing lane after a tool result", () => {
  const mem = [{ text: "MEMORY-INDEX" }]

  it("an unchanged block is not re-sent, and the digest is carried forward", () => {
    const first = withTrailingInjections(afterTool(), mem, ["R1"])
    expect(first.block).toBeDefined()
    // Same inputs, and the turn says it already sent exactly this.
    const second = withTrailingInjections(afterTool(), mem, ["R1"], first.block)
    expect(second.messages).toEqual(afterTool())
    expect(second.block).toBe(first.block)
    // Nothing was appended at all - no turn boundary, no bytes, no cache move.
    expect(JSON.stringify(second.messages)).not.toContain("<engine-context>")
  })

  it("a CHANGED block rides inside the last tool result, not a new turn", () => {
    const previous = withTrailingInjections(afterTool(), mem, ["R1"]).block
    const next = withTrailingInjections(afterTool(), mem, ["R1", "R2-NEW"], previous)

    // Same number of messages: nothing new was opened.
    expect(next.messages).toHaveLength(3)
    expect(next.messages.at(-1)!.role).toBe("tool")

    const result = (next.messages.at(-1)!.content as { output: { value: string } }[])[0]!
    // The tool's own output is intact, and the block is appended behind its
    // own delimiter so the envelope is not mistaken for the tool talking.
    expect(result.output.value.startsWith("tool output")).toBe(true)
    expect(result.output.value).toContain("<engine-context>")
    expect(result.output.value).toContain("R2-NEW")
    expect(next.block).toBe(next.block)
  })

  it("a tool result that is not plain text falls back rather than guessing", () => {
    // A JSON or media output is a structure the provider parses; writing prose
    // into it would be worse than a boundary.
    const history: ModelMessage[] = [
      { role: "user", content: "do the job" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "glob", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "glob", output: { type: "json", value: { a: 1 } } }],
      },
    ]
    const out = withTrailingInjections(history, mem, ["R1"])
    expect(out.messages).toHaveLength(4)
    expect(out.messages.at(-1)!.role).toBe("user")
  })

  it("step 0 is unchanged: separator then the user-role tail", () => {
    const out = withTrailingInjections([{ role: "user", content: "hello" }], mem, ["R1"])
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
  })
})

// ---------------------------------------------------------------------------
// origami_change (t-53vyxf): the three request shapes the validation panel
// compares. `on-change` is the shipped path every test above already pins, so
// what these add is the OTHER two - and one assertion that the default is
// still literally the shipped path, because a switch whose default drifted
// would invalidate every run measured against it.
// ---------------------------------------------------------------------------
describe("trailing context modes", () => {
  const mem = [{ text: "MEMORY-INDEX" }]
  /** The last message's text, whatever shape it carries. */
  const tailText = (out: { messages: ModelMessage[] }) => textOf(out.messages.at(-1)!)

  it("the default argument sends exactly what the shipped path sends", () => {
    // The switch may not move `on-change`. Same inputs, one call naming the
    // mode and one leaving it out: identical arrays, byte for byte.
    const history = afterTool()
    const implicit = withTrailingInjections(history, mem, ["R1"])
    const explicit = withTrailingInjections(history, mem, ["R1"], undefined, "on-change")
    expect(JSON.stringify(implicit.messages)).toBe(JSON.stringify(explicit.messages))
    expect(implicit.block).toBe(explicit.block)
  })

  it("every-step puts the block in a USER message after a tool result", () => {
    // THE PRE-0.4.127 SHAPE, which is what this mode exists to reproduce: a
    // user-role message last in the request, after tool output - the batch
    // boundary t-46a74d removed. It must not fold, because the fold is the
    // change being measured against.
    const out = withTrailingInjections(afterTool(), mem, ["R1"], undefined, "every-step")
    expect(out.messages).toHaveLength(4)
    expect(out.messages.at(-1)!.role).toBe("user")
    expect(tailText(out)).toContain("MEMORY-INDEX")
    expect(tailText(out)).toContain("R1")
    expect(out.action).toBe("user")
    // The tool result is left exactly as the tool wrote it - nothing grafted.
    const result = (out.messages[2]!.content as { output: { value: string } }[])[0]!
    expect(result.output.value).toBe("tool output")
  })

  it("every-step ignores the digest: an unchanged block is sent again", () => {
    // The one behaviour the on-change path exists to prevent, and the one this
    // mode exists to restore. Same block, previous digest handed back, and it
    // still goes - that is what "every step" means.
    const first = withTrailingInjections(afterTool(), mem, ["R1"], undefined, "every-step")
    const second = withTrailingInjections(afterTool(), mem, ["R1"], first.block, "every-step")
    expect(second.messages).toHaveLength(4)
    expect(second.messages.at(-1)!.role).toBe("user")
    expect(second.block).toBe(first.block)
    expect(second.action).toBe("user")
    // ...where on-change, given the same digest, sends nothing at all.
    const dedup = withTrailingInjections(afterTool(), mem, ["R1"], first.block, "on-change")
    expect(dedup.action).toBe("skipped")
    expect(dedup.messages).toEqual(afterTool())
  })

  it("every-step keeps step 0 as separator + user", () => {
    const out = withTrailingInjections([{ role: "user", content: "hello" }], mem, ["R1"], undefined, "every-step")
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(textOf(out.messages[1]!)).toBe(TRAILING_INJECTION_SEPARATOR)
    expect(out.action).toBe("user-step0")
  })

  it("every-step-continue ends the block with the continue sentence, verbatim", () => {
    // The panel's third shape. The sentence is the LAST line before the closing
    // tag - the last thing the model reads - and it is asserted against the
    // exported constant so a paraphrase in either place fails here.
    const out = withTrailingInjections(afterTool(), mem, ["R1"], undefined, "every-step-continue")
    expect(out.messages.at(-1)!.role).toBe("user")
    const text = tailText(out)
    expect(text.endsWith(`\n${TRAILING_CONTEXT_CONTINUE}\n${TRAILING_CONTEXT_CLOSE}`)).toBe(true)
    const lines = text.split("\n")
    expect(lines.at(-1)).toBe(TRAILING_CONTEXT_CLOSE)
    expect(lines.at(-2)).toBe(TRAILING_CONTEXT_CONTINUE)
  })

  it("no other mode carries the continue sentence", () => {
    // It is second person and imperative - the shape the whole lane is written
    // to avoid - so it may not leak into a run that did not ask for it.
    for (const mode of ["on-change", "every-step"] as const) {
      const afterToolOut = withTrailingInjections(afterTool(), mem, ["R1"], undefined, mode)
      const step0 = withTrailingInjections([{ role: "user", content: "hi" }], mem, ["R1"], undefined, mode)
      for (const out of [afterToolOut, step0])
        expect(JSON.stringify(out.messages)).not.toContain("Your turn is not over")
    }
  })

  it("an empty block sends nothing in every mode, so a bare session pays nothing", () => {
    for (const mode of ["on-change", "every-step", "every-step-continue"] as const) {
      const out = withTrailingInjections(afterTool(), [], [], undefined, mode)
      expect(out.messages).toEqual(afterTool())
      expect(out.action).toBe("none")
      expect(out.bytes).toBe(0)
    }
  })

  it("reports the action and the bytes it actually appended", () => {
    // The log line the panel greps is built from these two, so they are the
    // contract - not a convenience. `skipped` reports 0 because nothing left.
    const first = withTrailingInjections(afterTool(), mem, ["R1"])
    expect(first.action).toBe("folded")
    expect(first.bytes).toBe(first.block!.length)
    const skipped = withTrailingInjections(afterTool(), mem, ["R1"], first.block)
    expect(skipped).toMatchObject({ action: "skipped", bytes: 0 })
  })

  it("reads the env value, and falls back on anything it does not know", () => {
    expect(trailingContextMode(undefined)).toEqual({ mode: "on-change", unknown: undefined })
    expect(trailingContextMode("")).toEqual({ mode: "on-change", unknown: undefined })
    expect(trailingContextMode(" Every-Step ")).toEqual({ mode: "every-step", unknown: undefined })
    expect(trailingContextMode("every-step-continue")).toEqual({
      mode: "every-step-continue",
      unknown: undefined,
    })
    // A typo is the case worth a WARN: a run labelled `every-step` that quietly
    // measured `on-change` is a wrong answer, not a missing one.
    expect(trailingContextMode("everystep")).toEqual({ mode: "on-change", unknown: "everystep" })
  })
})

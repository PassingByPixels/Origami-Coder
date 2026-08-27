// The AI SDK adapter's `<think>` handling.
//
// Local OpenAI-compatible servers (vLLM, LM Studio) leak reasoning markup onto the
// CONTENT channel. The observed shape from `vllm/laguna-s-2.1-nvfp4` is a CLOSER
// WITH NO OPENER — `</think>PONG` — which reached a session title verbatim.
//
// The bug is one character of markup; the risk is the STREAM. This seam carries
// every text delta of every turn for every AI-SDK provider, so these tests are
// aimed at the failure modes that would break ordinary streaming: a tag split
// across deltas, held characters never released, and an id collision with the
// provider's own reasoning block (which is a fatal defect downstream, not a
// cosmetic one — publish-llm-event.ts dies on a duplicate start).

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMAISDK } from "@/session/llm/ai-sdk"

type AISDKAdapterEvent = Parameters<typeof LLMAISDK.toLLMEvents>[1]
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fixtures are narrower than AI SDK's full event union
const ev = (input: unknown) => input as AISDKAdapterEvent

const adapt = (events: ReadonlyArray<unknown>) => {
  const state = LLMAISDK.adapterState()
  return Effect.runPromise(
    Effect.forEach(events.map(ev), (event) => LLMAISDK.toLLMEvents(state, event)).pipe(
      Effect.map((items) => items.flat()),
    ),
  )
}

/** The text a user would actually see, in order. */
const textOf = (events: ReadonlyArray<{ type: string }>) =>
  events
    .filter((e): e is { type: string; text: string } => e.type === "text-delta")
    .map((e) => e.text)
    .join("")

const reasoningOf = (events: ReadonlyArray<{ type: string }>) =>
  events
    .filter((e): e is { type: string; text: string } => e.type === "reasoning-delta")
    .map((e) => e.text)
    .join("")

/** One text block carrying the given content deltas, opened and closed properly. */
const block = (...deltas: string[]) => [
  { type: "text-start", id: "text-1" },
  ...deltas.map((text) => ({ type: "text-delta", id: "text-1", text })),
  { type: "text-end", id: "text-1" },
]

describe("ai-sdk adapter — orphan think closers never reach text", () => {
  test("drops a closer with no opener — the exact observed vLLM shape", async () => {
    const events = await adapt(block("</think>PONG"))
    expect(textOf(events)).toBe("PONG")
  })

  test("drops a DOUBLED orphan closer", async () => {
    const events = await adapt(block("</think></think>example-skill"))
    expect(textOf(events)).toBe("example-skill")
  })

  test("drops an orphan arriving SPLIT across two deltas", async () => {
    // The failure this pins: scanning per-chunk sees `</thi` (no tag) then `nk>`
    // (no tag) and leaks both halves. The scanner state has to survive the delta
    // boundary, which is the whole reason it lives on adapterState().
    const events = await adapt(block("</thi", "nk>loop ran"))
    expect(textOf(events)).toBe("loop ran")
    expect(textOf(events)).not.toContain("think")
  })

  test("drops an orphan split one character at a time", async () => {
    const events = await adapt(block(..."</think>done".split("")))
    expect(textOf(events)).toBe("done")
  })
})

describe("ai-sdk adapter — held text is always released", () => {
  test("a reply ENDING in a bare `<` keeps that character", async () => {
    // `<` is held back so the next chunk can prove whether it starts a tag. If the
    // stream ends there and nothing drains it, the reply silently loses its last
    // characters — worse than the stray tag this feature removes.
    const events = await adapt(block("if a < b"))
    expect(textOf(events)).toBe("if a < b")
  })

  test("a reply ending in a partial tag prefix keeps it verbatim", async () => {
    const events = await adapt(block("comparing </th"))
    expect(textOf(events)).toBe("comparing </th")
  })

  test("prose containing `<` that is not a tag survives byte-identical", async () => {
    const source = "use Array<string> and x <= y and <div> markup"
    const events = await adapt(block(source))
    expect(textOf(events)).toBe(source)
  })

  test("held text is drained even when the stream never sends text-end", async () => {
    // An error/abort path can finish with the block still open. The characters have
    // somewhere legal to go while currentTextID is set, so they must go there.
    const events = await adapt([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "trailing <" },
      { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
    ])
    expect(textOf(events)).toBe("trailing <")
  })

  test("held text is released when the stream ABORTS instead of finishing", async () => {
    // Stopping a turn ends the stream with `abort` and nothing after it — no
    // text-end, no finish. Whatever the scanner is holding comes out here or it
    // never comes out at all, and the reply loses its last characters on disk.
    const events = await adapt([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "trailing <" },
      { type: "abort" },
    ])
    expect(textOf(events)).toBe("trailing <")
  })

  test("a drain after abort cannot emit the same characters twice", async () => {
    // The stream drains on abort AND on its exit; both run for an aborted stream
    // that still reports finish. A repeated tail would duplicate text on disk.
    const state = LLMAISDK.adapterState()
    const run = (events: ReadonlyArray<unknown>) =>
      Effect.runPromise(
        Effect.forEach(events.map(ev), (event) => LLMAISDK.toLLMEvents(state, event)).pipe(
          Effect.map((items) => items.flat()),
        ),
      )
    const events = await run([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "trailing <" },
      { type: "abort" },
    ])
    const after = LLMAISDK.drain(state)
    expect(textOf([...events, ...after])).toBe("trailing <")
  })

  test("drain releases held text for a stream that ends with no terminal event at all", async () => {
    // The provider can simply stop producing: the async iterable ends without
    // text-end and without finish. Nothing inside the adapter runs again, so the
    // stream itself has to drain the scanner — this is that seam.
    const state = LLMAISDK.adapterState()
    const events = await Effect.runPromise(
      Effect.forEach(
        [
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "trailing <" },
        ].map(ev),
        (event) => LLMAISDK.toLLMEvents(state, event),
      ).pipe(Effect.map((items) => items.flat())),
    )
    expect(textOf([...events, ...LLMAISDK.drain(state)])).toBe("trailing <")
  })

  test("drain emits nothing when no text block is open", async () => {
    // A delta into a block that was never started is a fatal defect downstream,
    // so the drain must stay silent rather than fabricate an id.
    expect(LLMAISDK.drain(LLMAISDK.adapterState())).toEqual([])
  })

  test("empty and whitespace-only deltas pass through without disturbing the scanner", async () => {
    const events = await adapt(block("", "  ", "", "hello", "", " world"))
    expect(textOf(events)).toBe("  hello world")
  })
})

describe("ai-sdk adapter — a matched pair becomes reasoning, and never vanishes", () => {
  test("content inside a matched pair is reclassified, not dropped", async () => {
    const events = await adapt(block("<think>weighing options</think>the answer"))
    expect(reasoningOf(events)).toBe("weighing options")
    expect(textOf(events)).toBe("the answer")
  })

  test("the reasoning block is opened and closed exactly once", async () => {
    // publish-llm-event.ts DIES on a delta before start, a duplicate start, or an
    // end before start. Exactly-once is a correctness requirement, not tidiness.
    const events = await adapt(block("<think>a</think>b<think>c</think>d"))
    const starts = events.filter((e) => e.type === "reasoning-start")
    const ends = events.filter((e) => e.type === "reasoning-end")
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    for (const start of starts) {
      const id = (start as unknown as { id: string }).id
      expect(events.filter((e) => (e as unknown as { id?: string }).id === id && e.type === "reasoning-start")).toHaveLength(1)
      expect(events.filter((e) => (e as unknown as { id?: string }).id === id && e.type === "reasoning-end")).toHaveLength(1)
    }
  })

  test("a pair split across deltas still reclassifies both halves", async () => {
    const events = await adapt(block("<thi", "nk>deep ", "thought</thi", "nk>visible"))
    expect(reasoningOf(events)).toBe("deep thought")
    expect(textOf(events)).toBe("visible")
  })

  test("an UNCLOSED opener flushes its content as reasoning rather than swallowing it", async () => {
    const events = await adapt(block("<think>never closed"))
    expect(reasoningOf(events)).toBe("never closed")
    expect(textOf(events)).toBe("")
  })
})

describe("ai-sdk adapter — the provider's own reasoning channel is untouched", () => {
  test("reasoning-delta events pass through unchanged and unscanned", async () => {
    // `reasoning_content` is the well-behaved channel. It never went through the
    // scanner before and must not now — this is the regression that would hit
    // every properly-implemented reasoning model.
    const events = await adapt([
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", text: "genuine <think> chain" },
      { type: "reasoning-end", id: "reasoning-1" },
    ])
    expect(reasoningOf(events)).toBe("genuine <think> chain")
    expect(events.map((e) => e.type)).toEqual(["reasoning-start", "reasoning-delta", "reasoning-end"])
  })

  test("a scanner block cannot collide with a provider block in the same stream", async () => {
    // The fatal case: if both used `reasoning-0`, the second start is a duplicate
    // and the session dies. Ids must come from separate namespaces.
    const events = await adapt([
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", text: "provider side" },
      { type: "reasoning-end", id: "reasoning-1" },
      ...block("<think>scanner side</think>out"),
    ])
    const ids = events
      .filter((e) => e.type === "reasoning-start")
      .map((e) => (e as unknown as { id: string }).id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(reasoningOf(events)).toBe("provider sidescanner side")
  })
})

describe("ai-sdk adapter — ordinary streaming is unchanged", () => {
  test("tag-free content is emitted delta by delta, byte-identical", async () => {
    const events = await adapt(block("Hel", "lo ", "world"))
    expect(textOf(events)).toBe("Hello world")
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(3)
    expect(events.filter((e) => e.type === "reasoning-start")).toHaveLength(0)
  })

  test("the text block still opens and closes around its deltas", async () => {
    const events = await adapt(block("hi"))
    expect(events.map((e) => e.type)).toEqual(["text-start", "text-delta", "text-end"])
  })

  test("scanner state resets after finish, so a reused adapter starts clean", async () => {
    const state = LLMAISDK.adapterState()
    const run = (events: ReadonlyArray<unknown>) =>
      Effect.runPromise(
        Effect.forEach(events.map(ev), (event) => LLMAISDK.toLLMEvents(state, event)).pipe(
          Effect.map((items) => items.flat()),
        ),
      )
    await run([
      ...block("<think>first stream"),
      { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
    ])
    // If `inside` leaked across the reset, this second stream's plain prose would
    // be classified as reasoning and disappear from the reply.
    const second = await run(block("plain text"))
    expect(textOf(second)).toBe("plain text")
    expect(reasoningOf(second)).toBe("")
  })
})

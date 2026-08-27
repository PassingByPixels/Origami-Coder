// `<think>` leak — vLLM / LM Studio emit a reasoning model's think markup on
// `delta.content` instead of `delta.reasoning_content`. Nothing stripped it, so the
// tags rendered as prose, were PERSISTED into the transcript, and were replayed to the
// model as prior-turn context. These drive the REAL openai-chat stream parser (the one
// `openai-compatible-chat` reuses verbatim, i.e. every local server) through a fixture
// SSE body, and assert what a user actually gets: reasoning in the reasoning channel,
// no tag anywhere in the answer, and tag-free content untouched.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../../src"
import * as OpenAIChat from "../../src/protocols/openai-chat"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { deltaChunk } from "../lib/openai-chunks"
import { sseEvents } from "../lib/sse"

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "qwen3-coder" })

const request = LLM.request({ id: "req_think", model, prompt: "Say hello." })

/** Run a content-delta sequence through the real parser and read the response. */
const run = (...contents: ReadonlyArray<string>) =>
  LLMClient.generate(request).pipe(
    Effect.provide(fixedResponse(sseEvents(...contents.map((c) => deltaChunk({ content: c })), deltaChunk({}, "stop")))),
  )

describe("openai-chat — <think> leaked onto delta.content", () => {
  it.effect("(i) a clean pair becomes reasoning; the answer keeps no tag", () =>
    Effect.gen(function* () {
      const response = yield* run("<think>weighing options</think>", "Hello.")
      expect(response.reasoning).toBe("weighing options")
      expect(response.text).toBe("Hello.")
      expect(response.text).not.toContain("think")
    }),
  )

  it.effect("(ii) a tag split across two chunks is still recognised, not emitted raw", () =>
    Effect.gen(function* () {
      // The split lands mid-tag in BOTH directions: `<thi|nk>` and `</thi|nk>`.
      const response = yield* run("<thi", "nk>weighing", " options</thi", "nk>Hello.")
      expect(response.reasoning).toBe("weighing options")
      expect(response.text).toBe("Hello.")
      expect(response.text).not.toContain("<")
    }),
  )

  it.effect("(iii) an ORPHAN closer (opener stripped by the server) is dropped", () =>
    Effect.gen(function* () {
      const response = yield* run("</think>", "Hello.")
      expect(response.text).toBe("Hello.")
    }),
  )

  it.effect("(iv) a doubled </think></think> is dropped whole — the observed shape", () =>
    Effect.gen(function* () {
      const response = yield* run("</think></think>Hello.")
      expect(response.text).toBe("Hello.")
    }),
  )

  it.effect("(v) REGRESSION GUARD: tag-free content survives byte-identical, tail `<` included", () =>
    Effect.gen(function* () {
      // The shapes the hold-back buffer could plausibly eat: a bare `<` mid-text, a
      // chunk ENDING on `<` (released once the next chunk proves it was not a tag),
      // and a `<` as the very last byte of the stream (released by the halt flush).
      const parts = ["if (a < b) {", " return a;", " } // rethink <", "later>", " done <"]
      const response = yield* run(...parts)
      expect(response.text).toBe(parts.join(""))
      expect(response.reasoning).toBe("")
      // Every byte arrives, in order, on one text block — a chunk that ends mid-
      // potential-tag defers those bytes to the next delta, so delta BOUNDARIES may
      // shift; the stream and its event shape may not.
      const deltas = response.events.filter((event) => event.type === "text-delta")
      expect(deltas.map((event) => (event as { text: string }).text).join("")).toBe(parts.join(""))
      const shape: string[] = ["step-start", "text-start", ...deltas.map(() => "text-delta"), "text-end", "step-finish", "finish"]
      expect(response.events.map((event) => String(event.type))).toEqual(shape)
    }),
  )

  it.effect("(v-b) chunks that cannot be a tag head are passed through delta-for-delta", () =>
    Effect.gen(function* () {
      const parts = ["Hello", ", ", "world."]
      const response = yield* run(...parts)
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "text-start", id: "text-0" },
        ...parts.map((text) => ({ type: "text-delta" as const, id: "text-0", text })),
        { type: "text-end", id: "text-0" },
        { type: "step-finish", index: 0, reason: "stop", usage: undefined, providerMetadata: undefined },
        { type: "finish", reason: "stop", usage: undefined },
      ])
    }),
  )

  it.effect("repeated think bursts in one turn interleave with the answer", () =>
    Effect.gen(function* () {
      const response = yield* run("<think>first</think>A.", "<think>second</think>B.")
      expect(response.reasoning).toBe("firstsecond")
      expect(response.text).toBe("A.B.")
    }),
  )

  it.effect("the reasoning_content channel still works and is not disturbed", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { choices: [{ delta: { reasoning_content: "native" } }] },
        { choices: [{ delta: { content: "<think>leaked</think>Answer." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      expect(response.reasoning).toBe("nativeleaked")
      expect(response.text).toBe("Answer.")
    }),
  )
})

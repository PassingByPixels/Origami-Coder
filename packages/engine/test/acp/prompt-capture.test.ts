// `prompt_capture` — the ACP surface over the transparency store. The bugs
// worth catching are a request answered for the WRONG session (the shell would
// show one chat's prompt under another's), and an unsent session reported as a
// failure instead of "nothing yet".

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { Agent } from "@/acp/agent"

const stubSdk = {} as unknown as OrigamiClient

const capture = (text: string): SessionPromptCapture.Capture => ({
  capturedAt: "2026-08-03T00:00:00.000Z",
  model: "anthropic/claude",
  labeledParts: [SessionPromptCapture.part("instructions", text)],
  finalSystem: [SessionPromptCapture.block(text)],
  tools: [{ name: "grep", descriptionChars: 6, schemaBytes: 24, description: "Search" }],
  steps: [],
  tokensApproxMethod: "chars/4",
})

function serviceWithCaptures(store: Record<string, SessionPromptCapture.Capture>, asked: string[]) {
  return ACPService.make({
    sdk: stubSdk,
    promptCapture: (sessionID) => {
      asked.push(sessionID)
      return store[sessionID] ?? null
    },
  })
}

describe("prompt_capture service method", () => {
  it("answers for the session it was asked about, and echoes the id back", async () => {
    const asked: string[] = []
    const service = serviceWithCaptures({ ses_1: capture("one"), ses_2: capture("two") }, asked)

    const result = await Effect.runPromise(service.promptCapture({ sessionId: "ses_2" }))

    expect(asked).toEqual(["ses_2"])
    expect(result.sessionId).toBe("ses_2")
    expect(result.capture!.finalSystem[0]!.text).toBe("two")
  })

  it("reports a session that has not sent a turn as null, not an error", async () => {
    const result = await Effect.runPromise(serviceWithCaptures({}, []).promptCapture({ sessionId: "ses_new" }))

    expect(result.capture).toBeNull()
  })

  it("sends the TEXT, unlike the sizes-only instruction inventory — that is the feature", async () => {
    const result = await Effect.runPromise(
      serviceWithCaptures({ ses_1: capture("AGENTS.md body") }, []).promptCapture({ sessionId: "ses_1" }),
    )

    expect(result.capture!.labeledParts[0]!.text).toBe("AGENTS.md body")
    expect(result.capture!.labeledParts[0]!.label).toBe("instructions")
    expect(result.capture!.tools[0]).toMatchObject({ name: "grep", descriptionChars: 6, schemaBytes: 24 })
  })
})

describe("prompt_capture ext dispatch", () => {
  const service = {
    promptCapture: (input: { sessionId: string }) => Effect.succeed({ sessionId: input.sessionId, capture: null }),
  } as unknown as ACPService.Interface

  it("accepts the `_` wire prefix clients put on extension methods", async () => {
    const agent = new Agent(service)

    const prefixed = await agent.extMethod("_prompt_capture", { sessionId: "ses_1" })
    const bare = await agent.extMethod("prompt_capture", { sessionId: "ses_1" })

    expect(prefixed).toEqual(bare)
    expect(prefixed).toMatchObject({ sessionId: "ses_1", capture: null })
  })

  it("refuses a call with no sessionId rather than answering about some other chat", () => {
    const agent = new Agent(service)

    expect(() => agent.extMethod("_prompt_capture", {})).toThrow()
    expect(() => agent.extMethod("_prompt_capture", { sessionId: 7 })).toThrow()
  })
})

describe("the default reader is the engine's own store", () => {
  it("a service built with no injected reader still sees what the prompt loop recorded", async () => {
    SessionPromptCapture.reset()
    SessionPromptCapture.draft("ses_live", [SessionPromptCapture.part("env", "env text")])
    SessionPromptCapture.record({
      sessionID: "ses_live",
      capturedAt: "2026-08-03T00:00:00.000Z",
      model: "anthropic/claude",
      base: ["base"],
      finalSystem: ["base\nenv text"],
      tools: {},
    })

    const result = await Effect.runPromise(ACPService.make({ sdk: stubSdk }).promptCapture({ sessionId: "ses_live" }))

    expect(result.capture!.finalSystem[0]!.text).toBe("base\nenv text")
    SessionPromptCapture.reset()
  })
})

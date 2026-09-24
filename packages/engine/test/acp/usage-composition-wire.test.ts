// t-s8ikm2. The context gauge's breakdown card reads `_meta.composition` off
// `usage_update`. The bug this catches: the usage service the ACP agent REALLY
// runs (ACPService.make with no injected `usage`, as acp/agent.ts builds it)
// sent the frame without a composition, so the card never showed on a live
// session although the prompt capture held the request. Nothing here injects a
// usage service or a capture reader: the frame is the production path's.

import { beforeEach, describe, expect, it } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, ManagedRuntime } from "effect"
import { jsonSchema } from "ai"
import * as ACPService from "@/acp/service"
import type { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { SessionPromptCapture } from "@/session/prompt-capture"

beforeEach(() => SessionPromptCapture.reset())

const PROVIDER = "opencode-go"
const MODEL = "deepseek-v4.1-flash"

type Frame = Parameters<AgentSideConnection["sessionUpdate"]>[0]

function harness(tokens: { input: number; cacheRead: number }) {
  const frames: Frame[] = []
  const assistant = {
    info: {
      role: "assistant",
      providerID: PROVIDER,
      modelID: MODEL,
      cost: 0.01,
      tokens: { input: tokens.input, output: 50, reasoning: 0, cache: { read: tokens.cacheRead, write: 0 } },
    },
  }
  const sdk = {
    // The event loop is never fed: the test hands events to `handle` itself.
    global: { event: () => new Promise(() => {}) },
    session: {
      get: (input?: { sessionID?: string }) => Promise.resolve({ data: { id: input?.sessionID } }),
      messages: () => Promise.resolve({ data: [{ info: { role: "user" } }, assistant] }),
      list: () => Promise.resolve({ data: [] }),
    },
    config: {
      providers: () =>
        Promise.resolve({
          data: { providers: [{ id: PROVIDER, models: { [MODEL]: { limit: { context: 1_000_000 } } } }] },
        }),
    },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: (frame: Frame) => {
      frames.push(frame)
      return Promise.resolve()
    },
  } as unknown as AgentSideConnection
  const session = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
  let subscription: ACPEvent.Subscription | undefined
  ACPService.make({ sdk, connection, session, eventSubscription: (events) => (subscription = events) })
  return { frames, session, subscription: () => subscription! }
}

/** One prepared request on the opencode-go path, recorded the way request.ts records it. */
function prepareOneRequest(sessionID: string) {
  SessionPromptCapture.draft(sessionID, [SessionPromptCapture.part("env", "x".repeat(4_000))])
  SessionPromptCapture.record({
    sessionID,
    capturedAt: new Date().toISOString(),
    model: `${PROVIDER}/${MODEL}`,
    base: ["b".repeat(8_000)],
    finalSystem: ["b".repeat(8_000), "x".repeat(4_000)],
    tools: { grep: { description: "Search files", inputSchema: jsonSchema({ type: "object" }) } },
    messages: [{ role: "user", content: "hello" }],
    ttlSeconds: 300,
  })
}

function stepFinish(sessionID: string): Event {
  return {
    id: "evt_step_1",
    type: "message.part.updated",
    properties: {
      sessionID,
      time: Date.now(),
      part: {
        id: "prt_step_1",
        sessionID,
        messageID: "msg_1",
        type: "step-finish",
        reason: "stop",
        cost: 0.01,
        tokens: { input: 1_000, output: 50, reasoning: 0, cache: { read: 330_000, write: 0 } },
      },
    },
  } as Event
}

function usageFrames(frames: Frame[]) {
  return frames
    .map((frame) => frame.update as { sessionUpdate: string; used?: number; _meta?: { composition?: unknown } })
    .filter((update) => update.sessionUpdate === "usage_update")
}

describe("usage_update composition on the production usage service", () => {
  it("carries a composition whose three parts sum to `used` after one prepared request", async () => {
    const h = harness({ input: 1_000, cacheRead: 330_000 })
    await Effect.runPromise(h.session.create({ id: "ses_go", cwd: "/workspace" }))
    prepareOneRequest("ses_go")

    await h.subscription().handle(stepFinish("ses_go"))

    const updates = usageFrames(h.frames)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.used).toBe(331_000)
    const composition = updates[0]!._meta?.composition as
      | { systemPrompt: number; tools: number; conversation: number; estimated: boolean }
      | undefined
    expect(composition).toBeDefined()
    expect(composition!.systemPrompt).toBeGreaterThan(0)
    expect(composition!.tools).toBeGreaterThan(0)
    expect(composition!.systemPrompt + composition!.tools + composition!.conversation).toBe(331_000)
    expect(composition!.estimated).toBe(true)
  })

  it("sends no composition for a session with no prepared request, and still sends the gauge", async () => {
    const h = harness({ input: 1_000, cacheRead: 330_000 })
    await Effect.runPromise(h.session.create({ id: "ses_cold", cwd: "/workspace" }))

    await h.subscription().handle(stepFinish("ses_cold"))

    const updates = usageFrames(h.frames)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.used).toBe(331_000)
    expect(updates[0]!._meta?.composition).toBeUndefined()
  })
})

import { describe, expect, it } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, ManagedRuntime } from "effect"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { UsageService } from "@/acp/usage"

// Mid-turn cost cadence. Before this, `usage_update` was sent ONCE, after the
// whole prompt resolved — so a ten-minute turn showed a frozen gauge and a cost
// that only moved when everything was already paid for. The engine now reports
// on every step-finish (the engine's own "one model round trip is billed"
// marker), rate-limited per session.

type SendUpdateInput = Parameters<UsageService.Interface["sendUpdate"]>[0]

function makeSessionService() {
  return ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function createHarness(options: { parents?: Record<string, string>; failSend?: boolean } = {}) {
  const sends: SendUpdateInput[] = []
  const clock = { now: 0 }
  const sdk = {
    session: {
      get: (input?: { sessionID?: string }) =>
        Promise.resolve({
          data: { id: input?.sessionID, parentID: input?.sessionID ? options.parents?.[input.sessionID] : undefined },
        }),
    },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: () => Promise.resolve(),
  } satisfies Pick<AgentSideConnection, "sessionUpdate">
  const usage = {
    sendUpdate: (input: SendUpdateInput) => {
      sends.push(input)
      return options.failSend ? Effect.die(new Error("usage exploded")) : Effect.void
    },
  } as unknown as UsageService.Interface
  const session = makeSessionService()
  const subscription = new ACPEvent.Subscription({
    sdk,
    connection,
    session,
    usage,
    now: () => clock.now,
  })

  return { clock, sends, session, subscription }
}

const createSession = (session: ACPSession.Interface, id: string, cwd = "/workspace") =>
  Effect.runPromise(session.create({ id, cwd }))

let seq = 0
function stepFinish(sessionID: string): Event {
  seq++
  return {
    id: `evt_step_${seq}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      time: Date.now(),
      part: {
        id: `prt_step_${seq}`,
        sessionID,
        messageID: "msg_1",
        type: "step-finish",
        reason: "stop",
        cost: 0.01,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  } as Event
}

function textPart(sessionID: string): Event {
  seq++
  return {
    id: `evt_text_${seq}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      time: Date.now(),
      part: { id: `prt_text_${seq}`, sessionID, messageID: "msg_1", type: "text", text: "hi" },
    },
  } as Event
}

describe("acp mid-turn usage cadence", () => {
  it("reports usage on a step-finish, before the prompt resolves", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    await harness.subscription.handle(stepFinish("ses_a"))

    expect(harness.sends).toHaveLength(1)
    expect(harness.sends[0]).toMatchObject({ sessionID: "ses_a", directory: "/workspace" })
  })

  it("throttles to one update per 2s per session", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.clock.now = 0
    await harness.subscription.handle(stepFinish("ses_a"))
    harness.clock.now = 500
    await harness.subscription.handle(stepFinish("ses_a"))
    harness.clock.now = 1_999
    await harness.subscription.handle(stepFinish("ses_a"))

    // Three steps inside the window, one report — the leading one.
    expect(harness.sends).toHaveLength(1)

    harness.clock.now = 2_000
    await harness.subscription.handle(stepFinish("ses_a"))
    expect(harness.sends).toHaveLength(2)
  })

  it("throttles per session, so a busy session cannot silence another", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")
    await createSession(harness.session, "ses_b")

    await harness.subscription.handle(stepFinish("ses_a"))
    await harness.subscription.handle(stepFinish("ses_b"))
    await harness.subscription.handle(stepFinish("ses_a"))

    expect(harness.sends.map((send) => send.sessionID)).toEqual(["ses_a", "ses_b"])
  })

  it("does not report on parts that are not step-finish", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    await harness.subscription.handle(textPart("ses_a"))

    expect(harness.sends).toHaveLength(0)
  })

  it("ignores a step-finish for a session the client never opened", async () => {
    const harness = createHarness()

    await harness.subscription.handle(stepFinish("ses_unknown"))

    expect(harness.sends).toHaveLength(0)
  })

  it("reports a SUBAGENT step under its registered ancestor, the id the client knows", async () => {
    const harness = createHarness({ parents: { ses_child: "ses_a" } })
    await createSession(harness.session, "ses_a")

    await harness.subscription.handle(stepFinish("ses_child"))

    expect(harness.sends).toHaveLength(1)
    expect(harness.sends[0]).toMatchObject({ sessionID: "ses_a" })
  })

  it("a failing usage report does not break event handling", async () => {
    const harness = createHarness({ failSend: true })
    await createSession(harness.session, "ses_a")

    await harness.subscription.handle(stepFinish("ses_a"))

    expect(harness.sends).toHaveLength(1)
  })

  it("sends nothing when no usage service is wired in", async () => {
    const session = makeSessionService()
    const subscription = new ACPEvent.Subscription({
      sdk: { session: { get: () => Promise.resolve({ data: {} }) } } as unknown as OrigamiClient,
      connection: { sessionUpdate: () => Promise.resolve() },
      session,
    })
    await createSession(session, "ses_a")

    // No usage service: the handler must be a no-op, not a crash.
    await subscription.handle(stepFinish("ses_a"))
  })
})

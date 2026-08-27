// The wire END of goal mode: a verdict produced in the session layer has to
// come out of the ACP connection as `origami/turnEnd`, and only for a session
// this connection actually owns.
//
// `test/session/turn-end.test.ts` proves the PAYLOAD matches what the VS Code
// client decodes. This proves the payload is actually SENT - the two halves a
// phantom notification needs, and the reason this one shipped dark for so long.
import { afterEach, describe, expect, it } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { LayerNode } from "@origami/core/effect/layer-node"
import type { OrigamiClient } from "@origami/sdk/v2"
import { Effect, ManagedRuntime } from "effect"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { publishTurnEnd, resetTurnEndListeners } from "@/session/turn-end"

type Notification = { method: string; params: unknown }

const makeSessionService = () =>
  ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )

const sdk = {
  global: { event: () => new Promise<never>(() => {}) },
} as unknown as OrigamiClient

const harness = () => {
  const sent: Notification[] = []
  const connection = {
    sessionUpdate: () => Promise.resolve(),
    extNotification: (method: string, params: unknown) => {
      sent.push({ method, params })
      return Promise.resolve()
    },
  } as unknown as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
  const session = makeSessionService()
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })
  return { sent, session, subscription }
}

const settle = async () => {
  for (let attempt = 0; attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 2))
}

afterEach(() => resetTurnEndListeners())

describe("origami/turnEnd on the ACP connection", () => {
  it("sends the verdict for a session this connection owns", async () => {
    const { sent, session, subscription } = harness()
    await Effect.runPromise(session.create({ id: "ses_owned", cwd: "/repo" }))
    subscription.start()

    publishTurnEnd("ses_owned", "success")
    await settle()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe("origami/turnEnd")
    expect(sent[0]!.params).toEqual({ stop_reason: "success" })
    subscription.stop()
  })

  it("carries each taxonomy label through unchanged", async () => {
    // The label is the whole message. A verdict rewritten on the way out - a
    // `error_max_turns` softened to `success` - is the blind-instrument bug the
    // client's own comments describe, only now on the engine side.
    const { sent, session, subscription } = harness()
    await Effect.runPromise(session.create({ id: "ses_owned", cwd: "/repo" }))
    subscription.start()

    publishTurnEnd("ses_owned", "error_max_turns")
    publishTurnEnd("ses_owned", "asked_user")
    publishTurnEnd("ses_owned", "error_during_execution")
    await settle()

    expect(sent.map((item) => (item.params as { stop_reason: string }).stop_reason)).toEqual([
      "error_max_turns",
      "asked_user",
      "error_during_execution",
    ])
    subscription.stop()
  })

  it("stays silent for a session this connection does not own", async () => {
    // The channel is process-wide. A sub-agent's session, or another chat's, is
    // not this connection's to announce - and the client's decode carries no
    // session id, so a stray one would badge the WRONG chat.
    const { sent, subscription } = harness()
    subscription.start()

    publishTurnEnd("ses_someone_else", "success")
    await settle()

    expect(sent).toHaveLength(0)
    subscription.stop()
  })

  it("stops listening once the subscription is stopped", async () => {
    const { sent, session, subscription } = harness()
    await Effect.runPromise(session.create({ id: "ses_owned", cwd: "/repo" }))
    subscription.start()
    subscription.stop()

    publishTurnEnd("ses_owned", "success")
    await settle()

    expect(sent).toHaveLength(0)
  })

  it("does not fall over on a client with no extNotification", async () => {
    // Every ACP client is allowed to omit it (the type marks it Partial), and a
    // missing badge must never be an error - nothing downstream depends on it.
    const session = makeSessionService()
    await Effect.runPromise(session.create({ id: "ses_owned", cwd: "/repo" }))
    const subscription = new ACPEvent.Subscription({
      sdk,
      connection: { sessionUpdate: () => Promise.resolve() },
      session,
    })
    subscription.start()

    publishTurnEnd("ses_owned", "success")
    await settle()
    subscription.stop()
  })
})

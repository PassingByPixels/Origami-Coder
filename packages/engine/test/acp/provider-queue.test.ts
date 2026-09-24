// t-52cxcw. A sub-agent queued on a provider's `max_concurrent` had no live
// surface: its transcript row label is frozen at the pending frame and
// `session.status` is not on the ACP wire. The drawer's activity tail is fed by
// the childChunk text path, so the waiting line has to leave the connection as a
// child-tagged `agent_message_chunk` — the same envelope the child's own prose
// uses, which is why the drawer needs no extension change to show it.
//
// `test/session/llm-native-concurrency.test.ts` proves the wait is PUBLISHED.
// This proves it is SENT, under the right session, and only for a child.
import { afterEach, describe, expect, it } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { LayerNode } from "@origami/core/effect/layer-node"
import type { OrigamiClient } from "@origami/sdk/v2"
import { Effect, ManagedRuntime } from "effect"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { publishProviderQueue, resetProviderQueueListeners } from "@/session/provider-queue"

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]

const makeSessionService = () =>
  ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )

// Domain parent chain, child id -> parent id: a sub-agent session lives only in
// the domain store, so this is what the ancestor walk reads.
const makeSdk = (parents: Record<string, string>, delays: number[] = []) => {
  // `delays[n]` is how long the nth `session.get` takes, so a test can make the
  // FIRST forward's read the slow one (t-fijy8a F13).
  let calls = 0
  return {
    global: { event: () => new Promise<never>(() => {}) },
    session: {
      get: (input?: { sessionID?: string }) => {
        const sessionID = input?.sessionID
        const delay = delays[calls++] ?? 0
        const data = sessionID ? { id: sessionID, parentID: parents[sessionID] } : { id: "ses_loaded" }
        if (delay <= 0) return Promise.resolve({ data })
        return new Promise((resolve) => setTimeout(() => resolve({ data }), delay))
      },
    },
  } as unknown as OrigamiClient
}

const harness = (parents: Record<string, string> = {}, delays: number[] = []) => {
  const updates: SessionUpdateParams[] = []
  const connection = {
    sessionUpdate: (params: SessionUpdateParams) => {
      updates.push(params)
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "sessionUpdate">
  const session = makeSessionService()
  const subscription = new ACPEvent.Subscription({ sdk: makeSdk(parents, delays), connection, session })
  return { updates, session, subscription }
}

const settle = async () => {
  for (let attempt = 0; attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 2))
}

const chunkText = (params: SessionUpdateParams) => (params.update as { content: { text: string } }).content.text
const childOf = (params: SessionUpdateParams) =>
  (params.update as { _meta?: { origami_child_session?: string } })._meta?.origami_child_session

afterEach(() => resetProviderQueueListeners())

describe("provider queue waits on the ACP connection", () => {
  it("puts a child's wait, and the number ahead, on the parent's stream tagged with the child id", async () => {
    const { updates, session, subscription } = harness({ ses_child: "ses_parent" })
    await Effect.runPromise(session.create({ id: "ses_parent", cwd: "/repo" }))
    subscription.start()

    publishProviderQueue({ sessionID: "ses_child", providerID: "openai", state: { type: "waiting", ahead: 2 } })
    await settle()

    expect(updates).toHaveLength(1)
    // Sent under the ANCESTOR's id - the only session id the client knows.
    expect(updates[0]!.sessionId).toBe("ses_parent")
    expect(updates[0]!.update.sessionUpdate).toBe("agent_message_chunk")
    expect(chunkText(updates[0]!)).toBe("waiting for a provider slot (2 ahead)\n")
    expect(childOf(updates[0]!)).toBe("ses_child")

    subscription.stop()
  })

  it("clears the wait with a follow-up line when the slot is granted after a real wait", async () => {
    // The activity tail is append-only (last N non-empty lines), so a stale
    // "waiting" can only be superseded, never erased.
    const { updates, session, subscription } = harness({ ses_child: "ses_parent" })
    await Effect.runPromise(session.create({ id: "ses_parent", cwd: "/repo" }))
    subscription.start()

    publishProviderQueue({ sessionID: "ses_child", providerID: "openai", state: { type: "waiting", ahead: 0 } })
    await settle()
    publishProviderQueue({ sessionID: "ses_child", providerID: "openai", state: { type: "started" } })
    await settle()

    expect(updates.map(chunkText)).toEqual(["waiting for a provider slot\n", "provider slot granted\n"])
    subscription.stop()
  })

  // t-fijy8a F13.
  it("says nothing when the permit was granted with no wait at all", async () => {
    // The wait is published the moment the queue LOOKS full; the permit can
    // still be handed over before anything queued. Reporting that pair puts a
    // "waiting" line on a row that never waited, and the tail cannot erase it.
    const { updates, session, subscription } = harness({ ses_child: "ses_parent" })
    await Effect.runPromise(session.create({ id: "ses_parent", cwd: "/repo" }))
    subscription.start()

    publishProviderQueue({ sessionID: "ses_child", providerID: "openai", state: { type: "waiting", ahead: 0 } })
    publishProviderQueue({ sessionID: "ses_child", providerID: "openai", state: { type: "started" } })
    await settle()

    expect(updates).toHaveLength(0)
    subscription.stop()
  })

  // t-fijy8a F13.
  it("keeps the pair in order when the first forward's session read is the slower one", async () => {
    // Each forward reads the session tree before it sends. With two of them in
    // flight and the FIRST read slower, the started line used to land first and
    // the waiting line after it - a permanent "waiting" on a row that is
    // running. RED before the chain: ["provider slot granted", "waiting..."].
    const { updates, session, subscription } = harness({ ses_child: "ses_parent" }, [60, 0])
    await Effect.runPromise(session.create({ id: "ses_parent", cwd: "/repo" }))
    subscription.start()

    publishProviderQueue({ sessionID: "ses_child", providerID: "openai", state: { type: "waiting", ahead: 1 } })
    // Long enough that the waiting forward is PAST the cancel point and parked
    // on its slow read, and short enough that it has not finished.
    await new Promise((resolve) => setTimeout(resolve, 10))
    publishProviderQueue({ sessionID: "ses_child", providerID: "openai", state: { type: "started" } })
    await settle()

    expect(updates.map(chunkText)).toEqual(["waiting for a provider slot (1 ahead)\n", "provider slot granted\n"])
    subscription.stop()
  })

  it("says nothing for a PARENT's own wait", async () => {
    // A registered session resolves to no child id, and a bare "waiting for a
    // provider slot" in the main transcript would read as the assistant talking.
    const { updates, session, subscription } = harness()
    await Effect.runPromise(session.create({ id: "ses_parent", cwd: "/repo" }))
    subscription.start()

    publishProviderQueue({ sessionID: "ses_parent", providerID: "openai", state: { type: "waiting", ahead: 1 } })
    await settle()

    expect(updates).toHaveLength(0)
    subscription.stop()
  })

  it("says nothing for a session this connection does not own", async () => {
    // The channel is process-wide: another chat's sub-agent is not this
    // connection's to narrate.
    const { updates, subscription } = harness({ ses_other_child: "ses_other_parent" })
    subscription.start()

    publishProviderQueue({ sessionID: "ses_other_child", providerID: "openai", state: { type: "waiting", ahead: 1 } })
    await settle()

    expect(updates).toHaveLength(0)
    subscription.stop()
  })

  it("stops listening once the subscription is stopped", async () => {
    const { updates, session, subscription } = harness({ ses_child: "ses_parent" })
    await Effect.runPromise(session.create({ id: "ses_parent", cwd: "/repo" }))
    subscription.start()
    subscription.stop()

    publishProviderQueue({ sessionID: "ses_child", providerID: "openai", state: { type: "waiting", ahead: 1 } })
    await settle()

    expect(updates).toHaveLength(0)
  })
})

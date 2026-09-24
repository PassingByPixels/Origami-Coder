// t-po041k. A CHILD'S QUESTION NEVER OPENS A DIALOG ON THE USER.
//
// `acp/question.ts` surfaces a question as the ACP `requestPermission` call —
// the only interactive client call there is — so "no dialog" means exactly
// "requestPermission was not called". That is the assertion here, and it is the
// negative one, which is the one worth having: a later change that starts
// surfacing child questions again passes every other test in the suite.
//
// The positive half is the row's own words. The drawer's activity tail is fed
// by the childChunk text path (see test/acp/provider-queue.test.ts, which
// proves the same channel for a provider wait), so "asking the main agent"
// needs no extension change to appear beside the agent that is waiting.
import { describe, expect, it } from "bun:test"
import type { AgentSideConnection, RequestPermissionRequest } from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, ManagedRuntime } from "effect"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { SubagentQuestion } from "@/session/subagent-question"

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]

const makeSessionService = () =>
  ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )

/** `parents` is the DOMAIN chain the ancestor walk reads; a sub-agent session
 *  exists only there, never in the ACP session store. */
const harness = (parents: Record<string, string> = {}) => {
  const requests: RequestPermissionRequest[] = []
  const updates: SessionUpdateParams[] = []
  const sdk = {
    question: {
      reply: () => Promise.resolve({ data: true }),
      reject: () => Promise.resolve({ data: true }),
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Promise.resolve({ data: { id: sessionID, parentID: parents[sessionID], directory: "/workspace" } }),
    },
  } as unknown as OrigamiClient
  const connection = {
    requestPermission: (params: RequestPermissionRequest) => {
      requests.push(params)
      return Promise.resolve({ outcome: { outcome: "selected" as const, optionId: "Red" } })
    },
    sessionUpdate: (params: SessionUpdateParams) => {
      updates.push(params)
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "requestPermission" | "sessionUpdate">
  const session = makeSessionService()
  return { requests, updates, session, subscription: new ACPEvent.Subscription({ sdk, connection, session }) }
}

const settle = async () => {
  for (let attempt = 0; attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 2))
}

const questionAsked = (sessionID: string) =>
  ({
    id: "evt_q1",
    type: "question.asked",
    properties: {
      id: "que_1",
      sessionID,
      questions: [{ question: "Which store?", header: "Store", options: [{ label: "Red", description: "" }] }],
    },
  }) as Event

const chunkText = (params: SessionUpdateParams) => (params.update as { content: { text: string } }).content.text
const childOf = (params: SessionUpdateParams) =>
  (params.update as { _meta?: { origami_child_session?: string } })._meta?.origami_child_session

describe("a sub-agent's question at the ACP boundary", () => {
  it("opens NO dialog and marks the child's row instead", async () => {
    const { requests, updates, session, subscription } = harness({ ses_child: "ses_parent" })
    await Effect.runPromise(session.create({ id: "ses_parent", cwd: "/workspace" }))

    subscription.handle(questionAsked("ses_child"))
    await settle()

    expect(requests).toHaveLength(0)
    expect(updates).toHaveLength(1)
    // Under the ANCESTOR's id — the only session id the client knows.
    expect(updates[0]!.sessionId).toBe("ses_parent")
    expect(chunkText(updates[0]!)).toBe(SubagentQuestion.ASKING_LINE)
    expect(childOf(updates[0]!)).toBe("ses_child")
  })

  it("a TOP-LEVEL chat's question still opens the dialog", async () => {
    const { requests, updates, session, subscription } = harness()
    await Effect.runPromise(session.create({ id: "ses_main", cwd: "/workspace" }))

    subscription.handle(questionAsked("ses_main"))
    await settle()

    expect(requests).toHaveLength(1)
    expect(requests[0]!.sessionId).toBe("ses_main")
    // And no row line: there is no child row to mark.
    expect(updates.map(chunkText)).not.toContain(SubagentQuestion.ASKING_LINE)
  })
})

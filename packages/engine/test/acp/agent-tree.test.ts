// t-z1xlfy. The agent map's live data: a descendant's status change re-sends
// the chat's roster (parent id + depth of every sub-agent), and a sub-agent's
// background shell reaches the chat as `origami/backgroundTask`.
import { describe, expect, it } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import { Effect, ManagedRuntime } from "effect"
import { SessionStatusEvent } from "@origami/schema/session-status-event"
import { ACPEvent } from "@/acp/event"
import { ACPAgentTree } from "@/acp/agent-tree"
import { ACPSession } from "@/acp/session"

type Notification = { method: string; params: Record<string, unknown> }

function harness(parents: Record<string, string>) {
  const sent: Notification[] = []
  const rosters: Array<{ sessionId: string; cwd: string }> = []
  const sdk = {
    session: {
      get: (input?: { sessionID?: string }) =>
        Promise.resolve({ data: { id: input?.sessionID, parentID: parents[input?.sessionID ?? ""] } }),
    },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: () => Promise.resolve(),
    extNotification: (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params })
      return Promise.resolve()
    },
  }
  const session = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
  const subscription = new ACPEvent.Subscription({
    sdk,
    connection,
    session,
    now: () => 5000,
    roster: (sessionId, cwd) => {
      rosters.push({ sessionId, cwd })
      return Promise.resolve()
    },
  })
  return { sent, rosters, session, subscription }
}

const status = (sessionID: string, type: "busy" | "idle") =>
  ({ id: `evt_${sessionID}_${type}`, type: SessionStatusEvent.Status.type, properties: { sessionID, status: { type } } }) as unknown as Event

const telemetry = (sessionId: string, props: Record<string, unknown>) =>
  ({
    id: `evt_tel_${sessionId}`,
    type: "origami.shell.telemetry",
    properties: { sessionId, toolCallId: "call_1", jobId: "shell-call_1", startedAt: 1000, output: "", ...props },
  }) as unknown as Event

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("agent map live data (t-z1xlfy)", () => {
  it("re-sends the roster of the CHAT when a grandchild changes status, once per burst", async () => {
    const h = harness({ ses_child: "ses_root", ses_grand: "ses_child" })
    await Effect.runPromise(h.session.create({ id: "ses_root", cwd: "/workspace" }))

    await h.subscription.handle(status("ses_grand", "busy"))
    await h.subscription.handle(status("ses_child", "busy"))
    await h.subscription.handle(status("ses_grand", "idle"))
    expect(h.rosters).toEqual([]) // coalesced: nothing yet
    await wait(ACPAgentTree.ROSTER_DEBOUNCE_MS + 100)

    expect(h.rosters).toEqual([{ sessionId: "ses_root", cwd: "/workspace" }])
    // The chat's own status still goes out as before, and a descendant's does not.
    expect(h.sent.filter((n) => n.method === "origami/sessionStatus")).toEqual([])
    h.subscription.stop()
  })

  it("sends no roster for a session with no registered ancestor", async () => {
    const h = harness({ ses_orphan: "ses_gone" })
    await h.subscription.handle(status("ses_orphan", "busy"))
    await wait(ACPAgentTree.ROSTER_DEBOUNCE_MS + 100)
    expect(h.rosters).toEqual([])
    h.subscription.stop()
  })

  it("forwards a sub-agent's background shell to the chat with its owner, on status changes only", async () => {
    const h = harness({ ses_child: "ses_root" })
    await Effect.runPromise(h.session.create({ id: "ses_root", cwd: "/workspace" }))

    const running = { state: "background", status: "running", command: "bun test --watch" }
    await h.subscription.handle(telemetry("ses_child", running))
    await h.subscription.handle(telemetry("ses_child", { ...running, output: "tick" })) // an output tick
    await h.subscription.handle(telemetry("ses_child", { state: "background", status: "cancelled", command: "bun test --watch" }))

    const tasks = h.sent.filter((n) => n.method === ACPAgentTree.BACKGROUND_TASK_METHOD).map((n) => n.params)
    expect(tasks).toEqual([
      { sessionId: "ses_root", ownerSessionId: "ses_child", jobId: "shell-call_1", kind: "shell", title: "bun test --watch", status: "running", startedAt: 1000 },
      { sessionId: "ses_root", ownerSessionId: "ses_child", jobId: "shell-call_1", kind: "shell", title: "bun test --watch", status: "cancelled", startedAt: 1000, endedAt: 5000 },
    ])
    h.subscription.stop()
  })

  it("does not send a sub-agent's FOREGROUND shell as a background task", async () => {
    const h = harness({ ses_child: "ses_root" })
    await Effect.runPromise(h.session.create({ id: "ses_root", cwd: "/workspace" }))
    await h.subscription.handle(telemetry("ses_child", { state: "foreground", status: "running" }))
    expect(h.sent.filter((n) => n.method === ACPAgentTree.BACKGROUND_TASK_METHOD)).toEqual([])
    h.subscription.stop()
  })
})

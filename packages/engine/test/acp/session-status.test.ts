// The chat list's activity ring asks one question — is this chat still
// working? — and until this file the ACP connection had no answer for a turn
// the ENGINE started on its own (a background task result being injected, a
// /loop run, a wakeup). The engine has always KNOWN: SessionStatus writes
// `{type:"busy"}` at every step of any turn the runner drives (session/
// run-state.ts onBusy/onIdle) and publishes `session.status` on the global
// bus. Nothing carried it across the ACP wire, so the client's only
// start-of-turn signal stayed the `prompt()` call it made itself.
//
// `session-status-ring.test.ts` (packages/vscode) proves the CLIENT half.
// This proves the SEND — the two halves a phantom notification needs.
import { describe, expect, it } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { LayerNode } from "@origami/core/effect/layer-node"
import type { OrigamiClient } from "@origami/sdk/v2"
import { Effect, ManagedRuntime } from "effect"
import { SessionStatusEvent } from "@origami/schema/session-status-event"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"

type Notification = { method: string; params: unknown }
type Envelope = { payload?: unknown }

const makeSessionService = () =>
  ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )

/** A hand-fed global event stream — the same shape `sdk.global.event` hands
 *  the subscription in production (server SSE -> `{payload}` envelopes). */
function createEventStream() {
  const queue: Envelope[] = []
  const waiters: Array<(value: Envelope | undefined) => void> = []

  const push = (event: Envelope) => {
    const waiter = waiters.shift()
    if (waiter) return waiter(event)
    queue.push(event)
  }

  const stream = async function* (signal?: AbortSignal) {
    while (true) {
      if (signal?.aborted) return
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      const value = await new Promise<Envelope | undefined>((resolve) => {
        waiters.push(resolve)
        signal?.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      if (!value) return
      yield value
    }
  }

  return { push, stream }
}

/** The bus event `SessionStatus.set` publishes, in the envelope the bridge
 *  wraps it in (event-v2-bridge.ts: `{id, type, properties}`). The type comes
 *  off the DEFINITION, so a rename there breaks this test rather than
 *  silently muting the notification. */
function statusEvent(sessionID: string, status: SessionStatusEvent.Info, queued = 0): Envelope {
  return {
    payload: {
      id: `evt_${sessionID}_${status.type}_${queued}`,
      type: SessionStatusEvent.Status.type,
      properties: { sessionID, status, queued },
    },
  }
}

function harness(options: { extNotification?: boolean } = {}) {
  const sent: Notification[] = []
  const events = createEventStream()
  const sdk = {
    global: {
      event: (opts?: { signal?: AbortSignal }) => Promise.resolve({ stream: events.stream(opts?.signal) }),
    },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: () => Promise.resolve(),
    ...(options.extNotification === false
      ? {}
      : {
          extNotification: (method: string, params: unknown) => {
            sent.push({ method, params })
            return Promise.resolve()
          },
        }),
  } as unknown as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
  const session = makeSessionService()
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })
  return { sent, events, session, subscription }
}

const settle = async () => {
  for (let attempt = 0; attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 2))
}

describe("origami/sessionStatus on the ACP connection", () => {
  it("forwards busy then idle for a session this connection owns", async () => {
    // THE SCREENSHOT CASE. A background job finishes long after the ACP
    // `prompt()` for the user's message returned; the task tool injects the
    // result as a new turn (tool/task.ts drain -> ops.prompt), the runner
    // flips the session busy, and nothing the client already listens to says
    // so. These two notifications are the whole fix.
    const { sent, events, session, subscription } = harness()
    await Effect.runPromise(session.create({ id: "ses_owned", cwd: "/repo" }))
    subscription.start()

    events.push(statusEvent("ses_owned", { type: "busy" }))
    events.push(statusEvent("ses_owned", { type: "idle" }))
    await settle()

    expect(sent).toEqual([
      { method: "origami/sessionStatus", params: { sessionId: "ses_owned", status: "busy" } },
      { method: "origami/sessionStatus", params: { sessionId: "ses_owned", status: "idle" } },
    ])
    subscription.stop()
  })

  it("sends ONE notification per change — the busy re-published at every step is not news", async () => {
    // The processor re-writes `{type:"busy"}` on every step of a turn (see the
    // comment on SessionStatus.set), and `bumpQueued` re-publishes the current
    // status too. A notification per publish would put one message per step on
    // a wire whose only reader flips a ring that is already amber.
    const { sent, events, session, subscription } = harness()
    await Effect.runPromise(session.create({ id: "ses_owned", cwd: "/repo" }))
    subscription.start()

    events.push(statusEvent("ses_owned", { type: "busy" }))
    events.push(statusEvent("ses_owned", { type: "busy" }))
    events.push(statusEvent("ses_owned", { type: "busy" }, 1))
    events.push(statusEvent("ses_owned", { type: "idle" }))
    events.push(statusEvent("ses_owned", { type: "idle" }))
    events.push(statusEvent("ses_owned", { type: "busy" }))
    await settle()

    expect(sent.map((item) => (item.params as { status: string }).status)).toEqual(["busy", "idle", "busy"])
    subscription.stop()
  })

  it("carries a non-terminal variant through under its own label", async () => {
    // `retry` is neither working-is-over nor a new turn: the client's rule is
    // "idle means ready, anything else means still going", so the label has to
    // arrive as itself rather than be flattened into busy here.
    const { sent, events, session, subscription } = harness()
    await Effect.runPromise(session.create({ id: "ses_owned", cwd: "/repo" }))
    subscription.start()

    events.push(statusEvent("ses_owned", { type: "retry", attempt: 1, message: "rate limited", next: 2000 }))
    await settle()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.params).toEqual({ sessionId: "ses_owned", status: "retry" })
    subscription.stop()
  })

  it("stays silent for a session this connection does not own", async () => {
    // The bus is process-wide and carries every session in the instance,
    // sub-agents included. A stray one would spin the ring of a chat that is
    // not this connection's, or of no chat at all.
    const { sent, events, subscription } = harness()
    subscription.start()

    events.push(statusEvent("ses_someone_else", { type: "busy" }))
    await settle()

    expect(sent).toHaveLength(0)
    subscription.stop()
  })

  it("does not fall over on a client with no extNotification", async () => {
    // Every ACP client may omit it (the connection type marks it Partial), and
    // a missing ring is not an error — nothing downstream depends on it.
    const { sent, events, session, subscription } = harness({ extNotification: false })
    await Effect.runPromise(session.create({ id: "ses_owned", cwd: "/repo" }))
    subscription.start()

    events.push(statusEvent("ses_owned", { type: "busy" }))
    await settle()

    expect(sent).toHaveLength(0)
    subscription.stop()
  })

  it("survives a send that rejects, and keeps forwarding after it", async () => {
    const sent: Notification[] = []
    const events = createEventStream()
    const sdk = {
      global: {
        event: (opts?: { signal?: AbortSignal }) => Promise.resolve({ stream: events.stream(opts?.signal) }),
      },
    } as unknown as OrigamiClient
    let first = true
    const connection = {
      sessionUpdate: () => Promise.resolve(),
      extNotification: (method: string, params: unknown) => {
        if (first) {
          first = false
          return Promise.reject(new Error("client went away"))
        }
        sent.push({ method, params })
        return Promise.resolve()
      },
    } as unknown as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
    const session = makeSessionService()
    await Effect.runPromise(session.create({ id: "ses_owned", cwd: "/repo" }))
    const subscription = new ACPEvent.Subscription({ sdk, connection, session })
    subscription.start()

    events.push(statusEvent("ses_owned", { type: "busy" }))
    events.push(statusEvent("ses_owned", { type: "idle" }))
    await settle()

    expect(sent.map((item) => (item.params as { status: string }).status)).toEqual(["idle"])
    subscription.stop()
  })
})

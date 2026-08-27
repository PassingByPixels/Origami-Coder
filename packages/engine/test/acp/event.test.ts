import { describe, expect, it, spyOn } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { LayerNode } from "@origami/core/effect/layer-node"
import type { Event, Message, OrigamiClient, Part, SessionMessageResponse, ToolPart } from "@origami/sdk/v2"
import { Effect, ManagedRuntime } from "effect"
import { ACPEvent } from "@/acp/event"
import * as ACPService from "@/acp/service"
import { Directory } from "@/acp/directory"
import { ACPSession } from "@/acp/session"
import { peerMessageMetadata } from "@/session/peer-message"

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
type ToolSessionUpdateParams = SessionUpdateParams & {
  update: Extract<SessionUpdateParams["update"], { sessionUpdate: "tool_call" | "tool_call_update" }>
}
type GlobalEventEnvelope = {
  payload?: Event
}
type DeltaPartType = Extract<Part, { type: "text" | "reasoning" }>["type"]

const pollUntil = async (
  check: () => boolean | Promise<boolean>,
  message: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
) => {
  const started = Date.now()
  while (true) {
    if (await check()) return
    if (Date.now() - started > (opts?.timeoutMs ?? 2000)) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, opts?.intervalMs ?? 5))
  }
}

function makeSessionService() {
  return ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function createEventStream() {
  const queue: GlobalEventEnvelope[] = []
  const waiters: Array<(value: GlobalEventEnvelope | undefined) => void> = []
  const state = { closed: false }

  const push = (event: GlobalEventEnvelope) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter(event)
      return
    }
    queue.push(event)
  }

  const close = () => {
    state.closed = true
    for (const waiter of waiters.splice(0)) {
      waiter(undefined)
    }
  }

  const stream = async function* (signal?: AbortSignal) {
    while (true) {
      if (signal?.aborted) return
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      if (state.closed) return
      const value = await new Promise<GlobalEventEnvelope | undefined>((resolve) => {
        waiters.push(resolve)
        signal?.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      if (!value) return
      yield value
    }
  }

  return { push, close, stream }
}

function createHarness(
  messages: Record<string, SessionMessageResponse> = {},
  // Domain parent chain, child id -> parent id. Sub-agent sessions live ONLY in
  // the domain store, so this is what the ancestor walk reads.
  parents: Record<string, string> = {},
) {
  const updates: SessionUpdateParams[] = []
  const calls = {
    eventSubscribe: 0,
    message: 0,
    messageSessions: [] as string[],
    sessionGet: 0,
  }
  const events = createEventStream()
  const sdk = {
    global: {
      event: (options?: { signal?: AbortSignal }) => {
        calls.eventSubscribe++
        return Promise.resolve({ stream: events.stream(options?.signal) })
      },
    },
    session: {
      message: (input: { sessionID?: string; messageID: string }) => {
        calls.message++
        calls.messageSessions.push(input.sessionID ?? "")
        return Promise.resolve({ data: messages[input.messageID] })
      },
      get: (input?: { sessionID?: string }) => {
        calls.sessionGet++
        const sessionID = input?.sessionID
        if (!sessionID) return Promise.resolve({ data: { id: "ses_loaded" } })
        return Promise.resolve({ data: { id: sessionID, parentID: parents[sessionID] } })
      },
      messages: () => Promise.resolve({ data: [] }),
    },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: (params: SessionUpdateParams) => {
      updates.push(params)
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "sessionUpdate">
  const session = makeSessionService()
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })

  return { calls, connection, events, sdk, session, subscription, updates }
}

function textDelta(sessionID: string, messageID: string, partID: string, delta: string): Event {
  return {
    id: `evt_${sessionID}_${messageID}_${partID}_${delta}`,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  }
}

function partUpdated(sessionID: string, messageID: string, partID: string, type: DeltaPartType): Event {
  return {
    id: `evt_${sessionID}_${messageID}_${partID}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      time: Date.now(),
      part:
        type === "text"
          ? {
              id: partID,
              sessionID,
              messageID,
              type: "text",
              text: "",
            }
          : {
              id: partID,
              sessionID,
              messageID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
            },
    },
  }
}

function toolUpdated(part: ToolPart): Event {
  return {
    id: `evt_${part.sessionID}_${part.messageID}_${part.id}_${part.state.status}`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      time: Date.now(),
      part,
    },
  }
}

function assistantMessage(sessionID: string, messageID: string, partID: string, type: DeltaPartType) {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "msg_parent",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      type === "text"
        ? {
            id: partID,
            sessionID,
            messageID,
            type: "text",
            text: "",
          }
        : {
            id: partID,
            sessionID,
            messageID,
            type: "reasoning",
            text: "",
            time: { start: Date.now() },
          },
    ],
  } satisfies SessionMessageResponse
}

function assistantToolMessage(part: ToolPart) {
  return {
    info: {
      id: part.messageID,
      sessionID: part.sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "msg_parent",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [part],
  } satisfies SessionMessageResponse
}

function runningTool(
  sessionID: string,
  callID: string,
  output?: string,
  input: Record<string, unknown> = { cmd: "printf hello" },
) {
  return {
    id: `part_${callID}`,
    sessionID,
    messageID: `msg_${callID}`,
    type: "tool",
    callID,
    tool: "bash",
    state: {
      status: "running",
      input,
      title: "bash",
      ...(output !== undefined ? { metadata: { output } } : {}),
      time: { start: Date.now() },
    },
  } satisfies ToolPart
}

function completedTool(
  sessionID: string,
  callID: string,
  output = "done",
  attachments: Extract<ToolPart["state"], { status: "completed" }>["attachments"] = [],
  options: {
    readonly tool?: string
    readonly input?: Record<string, unknown>
    readonly metadata?: Record<string, unknown>
  } = {},
) {
  return {
    id: `part_${callID}`,
    sessionID,
    messageID: `msg_${callID}`,
    type: "tool",
    callID,
    tool: options.tool ?? "bash",
    state: {
      status: "completed",
      input: options.input ?? { cmd: "printf done" },
      output,
      title: "bash",
      metadata: options.metadata ?? { exit: 0 },
      time: { start: Date.now() - 1, end: Date.now() },
      ...(attachments.length ? { attachments } : {}),
    },
  } satisfies ToolPart
}

function errorTool(sessionID: string, callID: string) {
  return {
    id: `part_${callID}`,
    sessionID,
    messageID: `msg_${callID}`,
    type: "tool",
    callID,
    tool: "bash",
    state: {
      status: "error",
      input: { cmd: "exit 1" },
      error: "failed hard",
      metadata: { exit: 1 },
      time: { start: Date.now() - 1, end: Date.now() },
    },
  } satisfies ToolPart
}

function toolUpdates(updates: SessionUpdateParams[]) {
  return updates.filter((item): item is ToolSessionUpdateParams => {
    return item.update.sessionUpdate === "tool_call" || item.update.sessionUpdate === "tool_call_update"
  })
}

/** The text part inside a `message.part.updated` event, writable so a case can
 *  dress it as a peer message. The event union is 80-odd members wide, so this
 *  narrows once instead of at every use. */
function peerPart(event: Event) {
  return (event.properties as { part: { text: string; metadata?: unknown } }).part
}

async function createKnownSession(
  session: ACPSession.Interface,
  sessionId: string,
  part: { messageId: string; partId: string; partType: Part["type"]; role?: Message["role"] },
) {
  await Effect.runPromise(session.create({ id: sessionId, cwd: "/workspace" }))
  await Effect.runPromise(
    session.recordPartMetadata({
      sessionId,
      messageId: part.messageId,
      partId: part.partId,
      partType: part.partType,
      role: part.role ?? "assistant",
    }),
  )
}

describe("acp event routing", () => {
  it("routes message.part.delta by sessionID without cross-session pollution", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })
    await createKnownSession(harness.session, "ses_b", { messageId: "msg_b", partId: "part_b", partType: "text" })

    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "hello"))

    expect(harness.updates.map((update) => update.sessionId)).toEqual(["ses_b"])
    expect(harness.updates[0]?.update.sessionUpdate).toBe("agent_message_chunk")
  })

  it("keeps interleaved sessions isolated for text and reasoning deltas", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })
    await createKnownSession(harness.session, "ses_b", {
      messageId: "msg_b",
      partId: "part_b",
      partType: "reasoning",
    })

    await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", "A1"))
    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "B1"))
    await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", "A2"))
    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "B2"))

    expect(
      harness.updates.filter((update) => update.sessionId === "ses_a").map((update) => update.update.sessionUpdate),
    ).toEqual(["agent_message_chunk", "agent_message_chunk"])
    expect(
      harness.updates.filter((update) => update.sessionId === "ses_b").map((update) => update.update.sessionUpdate),
    ).toEqual(["agent_thought_chunk", "agent_thought_chunk"])
  })

  it("does not create extra subscriptions on repeated loadSession", async () => {
    const harness = createHarness()
    let subscription: ACPEvent.Subscription | undefined
    const service = ACPService.make({
      sdk: harness.sdk,
      connection: harness.connection,
      directory: {
        get: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        refresh: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        variants: Directory.variants,
      },
      session: harness.session,
      eventSubscription: (started) => {
        subscription = started
      },
    })

    await pollUntil(() => harness.calls.eventSubscribe === 1, "event subscription did not start")
    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))
    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))
    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))

    expect(harness.calls.eventSubscribe).toBe(1)
    subscription?.stop()
    harness.events.close()
  })

  it("does not call sdk.session.message repeatedly when metadata is known", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_a", { messageId: "msg_a", partId: "part_a", partType: "text" })

    for (const delta of ["a", "b", "c", "d", "e"]) {
      await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", delta))
    }

    expect(harness.calls.message).toBe(0)
    expect(harness.updates).toHaveLength(5)
  })

  it("fetches unknown part metadata once and reuses it for later deltas", async () => {
    const harness = createHarness({
      msg_a: assistantMessage("ses_a", "msg_a", "part_a", "text"),
    })
    await Effect.runPromise(harness.session.create({ id: "ses_a", cwd: "/workspace" }))

    await harness.subscription.handle(partUpdated("ses_a", "msg_a", "part_a", "text"))
    await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", "a"))
    await harness.subscription.handle(textDelta("ses_a", "msg_a", "part_a", "b"))

    expect(harness.calls.message).toBe(1)
    expect(harness.updates).toHaveLength(2)
  })

  it("replays loaded session messages sequentially and continues after update failures", async () => {
    const events = createEventStream()
    const updates: SessionUpdateParams[] = []
    const connection = {
      sessionUpdate: (params: SessionUpdateParams) => {
        if (params.update.sessionUpdate === "tool_call" && params.update.toolCallId === "call_slow") {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              updates.push(params)
              resolve()
            }, 20)
          })
        }

        if (params.update.sessionUpdate === "tool_call_update" && params.update.toolCallId === "call_slow") {
          return Promise.reject(new Error("replay send failed"))
        }

        updates.push(params)
        return Promise.resolve()
      },
    } satisfies Pick<AgentSideConnection, "sessionUpdate">
    let subscription: ACPEvent.Subscription | undefined
    const service = ACPService.make({
      sdk: {
        global: {
          event: (options?: { signal?: AbortSignal }) => Promise.resolve({ stream: events.stream(options?.signal) }),
        },
        session: {
          get: () => Promise.resolve({ data: { id: "ses_loaded" } }),
          messages: () =>
            Promise.resolve({
              data: [
                assistantToolMessage(completedTool("ses_loaded", "call_slow", "slow")),
                assistantToolMessage(completedTool("ses_loaded", "call_after", "after")),
              ],
            }),
        },
      } as unknown as OrigamiClient,
      connection,
      directory: {
        get: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        refresh: () =>
          Effect.succeed(
            Directory.build({
              directory: "/workspace",
              providers: {},
              modes: [],
              defaultModeID: "build",
              commands: [],
            }),
          ),
        variants: Directory.variants,
      },
      eventSubscription: (started) => {
        subscription = started
      },
    })

    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))

    expect(toolUpdates(updates).map((item) => item.update.toolCallId)).toEqual([
      "call_slow",
      "call_after",
      "call_after",
    ])
    subscription?.stop()
    events.close()
  })

  it("ignores unknown sessions and live user parts without user_message_chunk duplication", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_user", {
      messageId: "msg_user",
      partId: "part_user",
      partType: "text",
      role: "user",
    })

    await harness.subscription.handle(textDelta("ses_missing", "msg_missing", "part_missing", "ignored"))
    await harness.subscription.handle(partUpdated("ses_user", "msg_user", "part_live", "text"))
    await harness.subscription.handle(textDelta("ses_user", "msg_user", "part_user", "hello"))

    expect(harness.updates).toHaveLength(0)
  })

  it("emits a peer agent's message as a user chunk tagged with its sender and reply address", async () => {
    // The one user part nobody in this window typed (tool/agents.ts posted it),
    // so it is also the one that must NOT be dropped like the test above's — and
    // it has to arrive marked, or the receiver renders another agent's words as
    // its own operator's.
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_peer", {
      messageId: "msg_peer",
      partId: "part_peer",
      partType: "text",
      role: "user",
    })

    const event = partUpdated("ses_peer", "msg_peer", "part_live", "text")
    const part = peerPart(event)
    part.text = '<peer_message from="reviewer" reply_to="reviewer#ses_x">\nschema is frozen\n</peer_message>'
    part.metadata = peerMessageMetadata({ from: "reviewer", replyTo: "reviewer#ses_x" })
    await harness.subscription.handle(event)

    expect(harness.updates).toHaveLength(1)
    expect(harness.updates[0]?.update).toMatchObject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: part.text },
      _meta: { origami_peer: { from: "reviewer", replyTo: "reviewer#ses_x" } },
    })
  })

  it("a peer part whose provenance is malformed stays silent rather than badging a stranger", async () => {
    const harness = createHarness()
    await createKnownSession(harness.session, "ses_peer2", {
      messageId: "msg_peer2",
      partId: "part_peer2",
      partType: "text",
      role: "user",
    })

    const event = partUpdated("ses_peer2", "msg_peer2", "part_live", "text")
    const part = peerPart(event)
    part.text = "who sent this?"
    part.metadata = { origami_peer: { from: "reviewer" } }
    await harness.subscription.handle(event)

    expect(harness.updates).toHaveLength(0)
  })

  it("exposes the shell command on the synthetic pending tool call", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_tool", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(runningTool("ses_tool", "call_1", "hello")))

    expect(toolUpdates(harness.updates).map((item) => item.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
    ])
    expect(harness.updates[0]?.update).toMatchObject({
      status: "pending",
      toolCallId: "call_1",
      title: "printf hello",
      kind: "execute",
      locations: [{ path: "/workspace" }],
      rawInput: { cmd: "printf hello", cwd: "/workspace" },
    })
    expect(harness.updates[1]?.update).toMatchObject({ status: "in_progress", toolCallId: "call_1" })
  })

  it("forwards detached shell telemetry to the original tool card", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_background", cwd: "/workspace" }))

    await harness.subscription.handle({
      id: "evt_shell_telemetry",
      type: "origami.shell.telemetry",
      properties: {
        sessionId: "ses_background",
        toolCallId: "call_background",
        jobId: "job_1",
        state: "background",
        status: "running",
        startedAt: 1000,
        lastOutputAt: 1500,
        output: "server ready",
      },
    } as unknown as Event)

    expect(harness.updates).toHaveLength(1)
    expect(harness.updates[0]).toMatchObject({
      sessionId: "ses_background",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_background",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "server ready" } }],
        rawOutput: {
          metadata: {
            background: true,
            jobId: "job_1",
            state: "background",
            startedAt: 1000,
            lastOutputAt: 1500,
          },
        },
      },
    })
  })

  it("includes available input in the synthetic pending tool call", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_pending_input", cwd: "/workspace" }))

    await harness.subscription.handle(
      toolUpdated({
        id: "part_call_read",
        sessionID: "ses_pending_input",
        messageID: "msg_call_read",
        type: "tool",
        callID: "call_read",
        tool: "read",
        state: {
          status: "running",
          input: { filePath: "/workspace/file.ts" },
          title: "Read file.ts",
          time: { start: Date.now() },
        },
      } satisfies ToolPart),
    )

    expect(harness.updates[0]?.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "call_read",
      status: "pending",
      title: "Read file.ts",
      kind: "read",
      rawInput: { filePath: "/workspace/file.ts" },
      locations: [{ path: "/workspace/file.ts" }],
    })
  })

  it("does not emit duplicate synthetic pending after a replayed running tool", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_replay", cwd: "/workspace" }))

    await harness.subscription.replayMessage(assistantToolMessage(runningTool("ses_replay", "call_replay", "first")))
    await harness.subscription.handle(toolUpdated(runningTool("ses_replay", "call_replay", "second")))

    expect(toolUpdates(harness.updates).filter((item) => item.update.sessionUpdate === "tool_call")).toHaveLength(1)
    expect(toolUpdates(harness.updates).map((item) => item.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "tool_call_update",
    ])
  })

  it("dedupes shell output snapshots while still sending status-only running updates", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_shell", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(runningTool("ses_shell", "call_shell", "same")))
    await harness.subscription.handle(toolUpdated(runningTool("ses_shell", "call_shell", "same")))

    const updates = toolUpdates(harness.updates)
    expect(updates).toHaveLength(3)
    expect(updates[1]?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      content: [{ type: "content", content: { type: "text", text: "same" } }],
    })
    expect(updates[2]?.update).toMatchObject({ sessionUpdate: "tool_call_update", status: "in_progress" })
    expect("content" in updates[2]!.update).toBe(false)
  })

  it("forwards the resolved shell family on the first decoded running update", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_shell_family", cwd: "/workspace" }))
    const part = runningTool(
      "ses_shell_family",
      "call_shell_family",
      "",
      { explanation: "Run tests", command: "npm test" },
    )
    part.state.metadata = { output: "", shellDisplay: "PowerShell" } as typeof part.state.metadata

    await harness.subscription.handle(toolUpdated(part))

    expect(toolUpdates(harness.updates)[1]?.update).toMatchObject({
      status: "in_progress",
      rawInput: { explanation: "Run tests", command: "npm test", shellDisplay: "PowerShell" },
    })
  })

  it("clears shell snapshot marker when a tool returns to pending", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_pending", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(runningTool("ses_pending", "call_pending", "repeat")))
    await harness.subscription.handle(
      toolUpdated({
        id: "part_call_pending",
        sessionID: "ses_pending",
        messageID: "msg_call_pending",
        type: "tool",
        callID: "call_pending",
        tool: "bash",
        state: {
          status: "pending",
          input: { cmd: "printf repeat" },
          raw: '{"cmd":"printf repeat"}',
        },
      }),
    )
    await harness.subscription.handle(toolUpdated(runningTool("ses_pending", "call_pending", "repeat")))

    expect(
      toolUpdates(harness.updates)
        .filter((item) => item.update.sessionUpdate === "tool_call_update")
        .map((item) => ("content" in item.update ? item.update.content : undefined)),
    ).toEqual([
      [{ type: "content", content: { type: "text", text: "repeat" } }],
      [{ type: "content", content: { type: "text", text: "repeat" } }],
    ])
  })

  it("emits completed tool output and rawOutput", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_done", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(completedTool("ses_done", "call_done", "finished")))

    expect(harness.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_done",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "finished" } }],
      rawOutput: { output: "finished", metadata: { exit: 0 } },
    })
  })

  it("emits clean read display content and preserves rawOutput", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_read", cwd: "/workspace" }))
    const output = [
      "<path>/workspace/file.ts</path>",
      "<type>file</type>",
      "<content>",
      "1: import { value } from './value'",
      "2: export { value }",
      "",
      "(End of file - total 2 lines)",
      "</content>",
    ].join("\n")
    const metadata = {
      display: {
        type: "file",
        path: "/workspace/file.ts",
        text: "import { value } from './value'\nexport { value }",
        lineStart: 1,
        lineEnd: 2,
        totalLines: 2,
        truncated: false,
      },
    }

    await harness.subscription.handle(
      toolUpdated(
        completedTool("ses_read", "call_read", output, [], {
          tool: "read",
          input: { filePath: "/workspace/file.ts" },
          metadata,
        }),
      ),
    )

    expect(harness.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_read",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "import { value } from './value'\nexport { value }" },
        },
      ],
      rawOutput: { output, metadata },
    })
  })

  it("emits error tool output", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_error", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(errorTool("ses_error", "call_error")))

    expect(harness.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_error",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "failed hard" } }],
      rawOutput: { error: "failed hard", metadata: { exit: 1 } },
    })
  })

  it("emits image attachments as ACP image content for live and replayed completed tool updates", async () => {
    const harness = createHarness()
    const image = Buffer.from("image-data").toString("base64")
    const attachment = {
      id: "file_image",
      sessionID: "ses_image",
      messageID: "msg_image",
      type: "file",
      mime: "image/png",
      filename: "image.png",
      url: `data:image/png;base64,${image}`,
    } as const
    await Effect.runPromise(harness.session.create({ id: "ses_image", cwd: "/workspace" }))

    await harness.subscription.handle(toolUpdated(completedTool("ses_image", "call_live", "live", [attachment])))
    await harness.subscription.replayMessage(
      assistantToolMessage(completedTool("ses_image", "call_replayed", "replayed", [attachment])),
    )

    expect(
      toolUpdates(harness.updates)
        .filter((item) => item.update.sessionUpdate === "tool_call_update" && item.update.status === "completed")
        .map((item) => ("content" in item.update ? item.update.content : [])),
    ).toEqual([
      [
        { type: "content", content: { type: "text", text: "live" } },
        { type: "content", content: { type: "image", mimeType: "image/png", data: image } },
      ],
      [
        { type: "content", content: { type: "text", text: "replayed" } },
        { type: "content", content: { type: "image", mimeType: "image/png", data: image } },
      ],
    ])
  })

  // Phase 2b (SEAMS_PLAN): mode syncs from the AUTHORITATIVE session row.
  // setAgentModel is the single agent write path and every call lands here as a
  // session.updated carrying the projected row — no reconstruction from user
  // messages. The bus is unordered, so a stale row must never drag mode back.
  const sessionUpdated = (sessionID: string, agent: string, timeUpdated: number): Event =>
    ({
      id: `evt_${sessionID}_updated_${timeUpdated}`,
      type: "session.updated",
      properties: {
        sessionID,
        info: { id: sessionID, agent, time: { created: 1, updated: timeUpdated } },
      },
    }) as unknown as Event

  it("syncs mode from the session row's agent (authoritative setAgentModel flow)", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_mode", cwd: "/workspace", modeId: "plan" }))

    await harness.subscription.handle(sessionUpdated("ses_mode", "build", 2000))

    const stored = await Effect.runPromise(harness.session.tryGet("ses_mode"))
    expect(stored?.modeId).toBe("build")
    expect(
      harness.updates.some(
        (item) => item.update.sessionUpdate === "current_mode_update" && item.update.currentModeId === "build",
      ),
    ).toBe(true)
  })

  it("a stale (older time_updated) session row cannot drag the mode backwards", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_stale", cwd: "/workspace", modeId: "plan" }))

    await harness.subscription.handle(sessionUpdated("ses_stale", "build", 2000))
    // A reordered OLDER row (e.g. delivered late after a config.refresh) says "plan".
    await harness.subscription.handle(sessionUpdated("ses_stale", "plan", 1000))

    const stored = await Effect.runPromise(harness.session.tryGet("ses_stale"))
    expect(stored?.modeId).toBe("build")
    expect(
      harness.updates.filter(
        (item) => item.update.sessionUpdate === "current_mode_update" && item.update.currentModeId === "plan",
      ),
    ).toEqual([])
  })
})

// A sub-agent runs in a session the ACP layer never registers, so every part it
// produced used to be dropped at this boundary: the client saw the parent's task
// tool call and, minutes later, the final <task_result> - nothing in between.
describe("acp event routing for sub-agent sessions", () => {
  const childChunks = (updates: SessionUpdateParams[]) =>
    updates.filter(
      (item) =>
        item.update.sessionUpdate === "agent_message_chunk" &&
        typeof (item.update as { _meta?: { origami_child_session?: unknown } })._meta?.origami_child_session ===
          "string",
    )

  it("forwards a sub-agent's text under its registered ancestor, tagged with the child session id", async () => {
    const harness = createHarness(
      { msg_child: assistantMessage("ses_child", "msg_child", "part_child", "text") },
      { ses_child: "ses_parent" },
    )
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    await harness.subscription.handle(partUpdated("ses_child", "msg_child", "part_child", "text"))
    await harness.subscription.handle(textDelta("ses_child", "msg_child", "part_child", "drafting the story"))

    const forwarded = childChunks(harness.updates)
    expect(forwarded).toHaveLength(1)
    // Published under the ANCESTOR's id - the only session id the client knows.
    expect(forwarded[0]?.sessionId).toBe("ses_parent")
    expect((forwarded[0]?.update as { content: { text: string } }).content.text).toBe("drafting the story")
    expect(
      (forwarded[0]?.update as { _meta?: { origami_child_session?: string } })._meta?.origami_child_session,
    ).toBe("ses_child")
    // The message itself must be fetched with the CHILD's id: asking the engine
    // for a sub-agent's message under the parent's id just misses, and the chunk
    // would never resolve to an assistant text part at all.
    expect(harness.calls.messageSessions).toContain("ses_child")
  })

  it("does not forward a sub-agent's reasoning", async () => {
    const harness = createHarness({}, { ses_child: "ses_parent" })
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    await harness.subscription.handle(partUpdated("ses_child", "msg_think", "part_think", "reasoning"))
    await harness.subscription.handle(textDelta("ses_child", "msg_think", "part_think", "maybe I should..."))

    expect(harness.updates.filter((item) => item.update.sessionUpdate === "agent_thought_chunk")).toEqual([])
    expect(childChunks(harness.updates)).toEqual([])
  })

  it("renders a sub-agent's tool as ONE activity line, never a tool card in the parent", async () => {
    const harness = createHarness({}, { ses_child: "ses_parent" })
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    // Same call, three engine ticks (a long shell re-publishes its snapshot).
    await harness.subscription.handle(toolUpdated(runningTool("ses_child", "call_child", "partial")))
    await harness.subscription.handle(toolUpdated(runningTool("ses_child", "call_child", "more output")))
    await harness.subscription.handle(toolUpdated(runningTool("ses_child", "call_child", "even more")))

    // A forwarded tool_call would materialise a top-level card per sub-agent tool
    // in every client - ten sub-agents' inner tools inlined into the parent.
    expect(toolUpdates(harness.updates)).toEqual([])
    const forwarded = childChunks(harness.updates)
    expect(forwarded).toHaveLength(1)
    expect((forwarded[0]?.update as { content: { text: string } }).content.text).toBe("> bash: printf hello\n")
  })

  it("keeps dropping a session with no registered ancestor, and only walks for it once", async () => {
    const harness = createHarness({}, {})
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    await harness.subscription.handle(textDelta("ses_orphan", "msg_o", "part_o", "one"))
    await harness.subscription.handle(textDelta("ses_orphan", "msg_o", "part_o", "two"))
    await harness.subscription.handle(textDelta("ses_orphan", "msg_o", "part_o", "three"))

    expect(harness.updates).toEqual([])
    // Volume guard: the walk is cached per originating session INCLUDING misses.
    // Uncached, this sits on the delta hot path - one sdk.session.get per streamed
    // token, times every concurrent sub-agent.
    expect(harness.calls.sessionGet).toBe(1)
  })

  // A whole session's output going nowhere used to leave no trace at all. The
  // count is throttled because the drop sits on the per-token delta path - but
  // throttled is not silent, and silent is how usage_update went missing.
  it("says out loud when it drops events for an unregistered session, without one line per token", async () => {
    const harness = createHarness({}, {})
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    const lines: string[] = []
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "))
    })
    try {
      for (let index = 0; index < ACPEvent.DROP_LOG_EVERY; index++) {
        await harness.subscription.handle(textDelta("ses_orphan", "msg_o", "part_o", `token ${index}`))
      }
      await harness.subscription.handle(partUpdated("ses_orphan", "msg_o", "part_p", "text"))
    } finally {
      spy.mockRestore()
    }

    expect(harness.updates).toEqual([])
    const deltas = lines.filter((line) => line.includes("message.part.delta"))
    // The FIRST drop and the DROP_LOG_EVERY-th, and nothing in between.
    expect(deltas).toHaveLength(2)
    expect(deltas[0]).toContain("ses_orphan")
    expect(deltas[1]).toContain(`(${ACPEvent.DROP_LOG_EVERY} so far)`)
    // Counted per KIND as well as per session: a part.updated drop is a
    // different loss from a delta drop and must not hide behind its count.
    expect(lines.filter((line) => line.includes("message.part.updated"))).toHaveLength(1)
  })

  it("stamps the child session id on a task tool's RUNNING update, not just the completed one", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    const taskPart = {
      id: "part_task",
      sessionID: "ses_parent",
      messageID: "msg_task",
      type: "tool",
      callID: "call_task",
      tool: "task",
      state: {
        status: "running",
        input: { description: "write story", subagent_type: "general" },
        title: "write story",
        metadata: { parentSessionId: "ses_parent", sessionId: "ses_child", background: true },
        time: { start: Date.now() },
      },
    } satisfies ToolPart

    await harness.subscription.handle(toolUpdated(taskPart))

    // rawOutput carries the same id but ONLY on the completed update - the whole
    // live phase of a foreground sub-agent too late to match its stream to a card.
    const stamped = toolUpdates(harness.updates).filter(
      (item) =>
        (item.update as { _meta?: { origami_task_session?: unknown } })._meta?.origami_task_session === "ses_child",
    )
    expect(stamped).toHaveLength(2)
    expect(stamped.map((item) => item.update.sessionUpdate)).toEqual(["tool_call", "tool_call_update"])
  })

  // A sub-agent's `write` used to forward NOTHING but "> write" - the tool's own
  // title is only set on completion (tool/write.ts), so the file it just put 2,000
  // words into was invisible. The path + an opening content slice makes it visible
  // again without reopening the flood the ONE-line-per-tool-start guard prevents.
  it("forwards a child write's target path and an opening slice of its content", async () => {
    const harness = createHarness({}, { ses_child: "ses_parent" })
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    const writePart = {
      id: "part_write",
      sessionID: "ses_child",
      messageID: "msg_write",
      type: "tool",
      callID: "call_write",
      tool: "write",
      state: {
        status: "running",
        input: { filePath: "/workspace/notes.md", content: "# Notes\nFirst paragraph of a longer note." },
        time: { start: Date.now() },
      },
    } satisfies ToolPart

    await harness.subscription.handle(toolUpdated(writePart))

    const forwarded = childChunks(harness.updates)
    expect(forwarded).toHaveLength(1)
    const text = (forwarded[0]?.update as { content: { text: string } }).content.text
    expect(text).toBe("> write: /workspace/notes.md — # Notes\nFirst paragraph of a longer note.\n")
  })

  it("forwards a child edit's target path and an opening slice of its replacement text", async () => {
    const harness = createHarness({}, { ses_child: "ses_parent" })
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    const editPart = {
      id: "part_edit",
      sessionID: "ses_child",
      messageID: "msg_edit",
      type: "tool",
      callID: "call_edit",
      tool: "edit",
      state: {
        status: "running",
        input: {
          filePath: "/workspace/config.ts",
          oldString: "const x = 1",
          newString: "const x = 2 // bumped",
        },
        time: { start: Date.now() },
      },
    } satisfies ToolPart

    await harness.subscription.handle(toolUpdated(editPart))

    const forwarded = childChunks(harness.updates)
    expect(forwarded).toHaveLength(1)
    const text = (forwarded[0]?.update as { content: { text: string } }).content.text
    expect(text).toBe("> edit: /workspace/config.ts — const x = 2 // bumped\n")
  })

  it("caps a child write's content preview by CODE POINT, never splitting a surrogate pair", async () => {
    const harness = createHarness({}, { ses_child: "ses_parent" })
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    // 250 astral emoji: 250 code points but 500 UTF-16 units. A cut that counts
    // UTF-16 units instead of code points would land mid-surrogate-pair here.
    const emoji = "\u{1F600}"
    const content = emoji.repeat(250)
    const writePart = {
      id: "part_emoji",
      sessionID: "ses_child",
      messageID: "msg_emoji",
      type: "tool",
      callID: "call_emoji",
      tool: "write",
      state: {
        status: "running",
        input: { filePath: "/workspace/emoji.md", content },
        time: { start: Date.now() },
      },
    } satisfies ToolPart

    await harness.subscription.handle(toolUpdated(writePart))

    const forwarded = childChunks(harness.updates)
    expect(forwarded).toHaveLength(1)
    const text = (forwarded[0]?.update as { content: { text: string } }).content.text

    // The whole forwarded chunk must be valid UTF-16 - a lone surrogate half
    // anywhere in it (not just inside the preview) would fail this.
    expect(text.isWellFormed()).toBe(true)
    // Pins the exact cut point: 199 whole emoji kept, then the ellipsis marker -
    // proves the boundary landed between code points, not merely that nothing
    // broke by accident.
    expect(text).toBe(`> write: /workspace/emoji.md — ${emoji.repeat(199)}…\n`)
  })

  it("falls back to the bare tool line when a child write's content argument is missing", async () => {
    const harness = createHarness({}, { ses_child: "ses_parent" })
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    // filePath present, `content` absent - the write schema requires it, so this
    // is a malformed/partial input the preview must not guess at.
    const writePart = {
      id: "part_bad_write",
      sessionID: "ses_child",
      messageID: "msg_bad_write",
      type: "tool",
      callID: "call_bad_write",
      tool: "write",
      state: {
        status: "running",
        input: { filePath: "/workspace/notes.md" },
        time: { start: Date.now() },
      },
    } satisfies ToolPart

    await harness.subscription.handle(toolUpdated(writePart))

    const forwarded = childChunks(harness.updates)
    expect(forwarded).toHaveLength(1)
    const text = (forwarded[0]?.update as { content: { text: string } }).content.text
    // Degrades to exactly the pre-existing bare line - no dangling separator,
    // no thrown error.
    expect(text).toBe("> write\n")
  })

  it("still dedupes a child write's tool-start line on callID across pending-then-running ticks", async () => {
    const harness = createHarness({}, { ses_child: "ses_parent" })
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    const tick = (input: Record<string, unknown>) =>
      ({
        id: "part_write_dup",
        sessionID: "ses_child",
        messageID: "msg_write_dup",
        type: "tool",
        callID: "call_write_dup",
        tool: "write",
        state: { status: "running", input, time: { start: Date.now() } },
      }) satisfies ToolPart

    await harness.subscription.handle(
      toolUpdated(tick({ filePath: "/workspace/notes.md", content: "first draft" })),
    )
    // Same callID, engine re-publishes with more of the content streamed in - the
    // volume guard must still drop this as a running-update tick for a child.
    await harness.subscription.handle(
      toolUpdated(tick({ filePath: "/workspace/notes.md", content: "first draft, now longer" })),
    )

    const forwarded = childChunks(harness.updates)
    expect(forwarded).toHaveLength(1)
    const text = (forwarded[0]?.update as { content: { text: string } }).content.text
    expect(text).toBe("> write: /workspace/notes.md — first draft\n")
  })
})

// A BACKGROUND sub-agent's launcher call returns the moment the child is
// spawned, so its tool card completes minutes before the child does. Nothing on
// the wire said "that child is done" — the real completion arrived as an
// injected <task_result> turn whose text is written for the MODEL. These cover
// the two riders that carry the fact instead: the launcher's own metadata, and
// the stamp on the injected turn.
describe("acp event — the sub-agent lifecycle riders", () => {
  const taskCard = (metadata: Record<string, unknown>, status: "running" | "completed" = "running") =>
    ({
      id: "part_task",
      sessionID: "ses_parent",
      messageID: "msg_task",
      type: "tool",
      callID: "call_task",
      tool: "task",
      state:
        status === "running"
          ? {
              status: "running",
              input: { description: "write story", subagent_type: "general" },
              title: "write story",
              metadata,
              time: { start: Date.now() },
            }
          : {
              status: "completed",
              input: { description: "write story", subagent_type: "general" },
              title: "write story",
              output: "started",
              metadata,
              time: { start: Date.now(), end: Date.now() },
            },
    }) satisfies ToolPart

  const riders = (updates: SessionUpdateParams[]) =>
    toolUpdates(updates).map((item) => (item.update as { _meta?: Record<string, unknown> })._meta)

  /** The span riders, split out of a rider set so the identity riders can be
   *  asserted exactly while the two stamps are checked as VALUES. */
  const span = (meta: Record<string, unknown> | undefined) => ({
    started: meta?.origami_task_started,
    ended: meta?.origami_task_ended,
  })
  const withoutSpan = (meta: Record<string, unknown> | undefined) => {
    const { origami_task_started: _s, origami_task_ended: _e, ...rest } = meta ?? {}
    return rest
  }

  const markers = (updates: SessionUpdateParams[]) =>
    updates
      .filter(
        (item) =>
          item.update.sessionUpdate === "agent_message_chunk" &&
          (item.update as { _meta?: { origami_task_state?: unknown } })._meta?.origami_task_state !== undefined,
      )
      .map((item) => (item.update as { _meta: Record<string, unknown> })._meta)

  it("rides the DETACHED flag and the routed model on every task update", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    await harness.subscription.handle(
      toolUpdated(
        taskCard({
          parentSessionId: "ses_parent",
          sessionId: "ses_child",
          background: true,
          model: { providerID: "openrouter", modelID: "qwen3-coder" },
        }),
      ),
    )

    // A client that retires its roster on the card's own status needs to know
    // the card completes at SPAWN; and the child's model is resolved inside the
    // tool (flock binding / per-chat override), so nothing else can report it.
    const expected = {
      origami_tool_name: "task",
      origami_task_session: "ses_child",
      origami_task_background: true,
      origami_task_model: "openrouter/qwen3-coder",
    }
    expect(riders(harness.updates).map(withoutSpan)).toEqual([expected, expected])

    // The child's START, off the stored tool state. It is the only start that
    // survives a client restart: a reopened chat rebuilds its cards from this
    // replay and stamps them NOW, so without this every row in the shell's
    // sub-agent drawer reported a run of zero seconds.
    const started = span(riders(harness.updates)[0]).started
    expect(typeof started).toBe("number")
    for (const meta of riders(harness.updates)) expect(span(meta).started).toBe(started)

    // And NO end, on a DETACHED child: this card completes ~10ms after it
    // starts while the child works on for minutes. Its honest end arrives with
    // the terminal marker instead (see the injected-result test below).
    for (const meta of riders(harness.updates)) expect(span(meta).ended).toBeUndefined()
  })

  it("a FOREGROUND child rides its real END — its card ending IS the child ending", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    const card = taskCard({ parentSessionId: "ses_parent", sessionId: "ses_child" }, "completed")
    await harness.subscription.handle(toolUpdated(card))

    const time = (card.state as { time: { start: number; end: number } }).time
    for (const meta of riders(harness.updates)) {
      expect(span(meta).started).toBe(time.start)
      expect(span(meta).ended).toBe(time.end)
    }
  })

  it("a FOREGROUND child rides no background flag — absent, never false", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    await harness.subscription.handle(
      toolUpdated(taskCard({ parentSessionId: "ses_parent", sessionId: "ses_child" })),
    )

    for (const meta of riders(harness.updates)) {
      expect(withoutSpan(meta)).toEqual({ origami_tool_name: "task", origami_task_session: "ses_child" })
    }
  })

  it("turns the injected result turn's stamp into one terminal marker per settled child", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    // The drainer folds every sibling that finished during a turn into ONE
    // injected turn, so one part can settle several children at once.
    await harness.subscription.handle({
      id: "evt_inject",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_parent",
        time: Date.now(),
        part: {
          id: "part_inject",
          sessionID: "ses_parent",
          messageID: "msg_inject",
          type: "text",
          synthetic: true,
          text: "<task id=\"ses_child_a\" state=\"completed\">…</task>",
          metadata: {
            origami_task_results: [
              { sessionId: "ses_child_a", state: "completed" },
              { sessionId: "ses_child_b", state: "error" },
            ],
          },
        },
      },
    } as unknown as Event)

    // Each marker carries WHEN, because a detached child's launcher card ended
    // back at spawn — this is the only end it will ever report, and without it
    // a finished row in the shell ages off the wall clock instead of printing
    // its real total.
    expect(markers(harness.updates).map(withoutSpan)).toEqual([
      { origami_task_session: "ses_child_a", origami_task_state: "completed" },
      { origami_task_session: "ses_child_b", origami_task_state: "error" },
    ])
    for (const meta of markers(harness.updates)) expect(typeof span(meta).ended).toBe("number")
  })

  it("an ordinary text part settles nothing", async () => {
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    await harness.subscription.handle(partUpdated("ses_parent", "msg_prose", "part_prose", "text"))

    expect(markers(harness.updates)).toEqual([])
  })

  it("settles the roster on REPLAY too, so a reopened chat is not full of ghosts", async () => {
    // Replay rebuilds every task card from history. Having never seen the live
    // marker, it would otherwise show children that finished an hour ago as out.
    const harness = createHarness()
    await Effect.runPromise(harness.session.create({ id: "ses_parent", cwd: "/workspace" }))

    // An hour ago, not now: the replayed marker must report when the child
    // ACTUALLY settled, or a reopened chat prints a duration of nothing.
    const created = Date.now() - 3_600_000
    await harness.subscription.replayMessage({
      info: {
        id: "msg_inject",
        sessionID: "ses_parent",
        role: "user",
        time: { created },
      },
      parts: [
        {
          id: "part_inject",
          sessionID: "ses_parent",
          messageID: "msg_inject",
          type: "text",
          synthetic: true,
          text: "<task id=\"ses_child_a\" state=\"completed\">…</task>",
          metadata: { origami_task_results: [{ sessionId: "ses_child_a", state: "completed" }] },
        },
      ],
    } as unknown as SessionMessageResponse)

    expect(markers(harness.updates)).toEqual([
      {
        origami_task_session: "ses_child_a",
        origami_task_state: "completed",
        // The injected turn's OWN created time, which is the instant
        // run-steps.ts reads for the same purpose. `Date.now()` here would say
        // the child finished the moment the chat reopened.
        origami_task_ended: created,
      },
    ])
  })
})

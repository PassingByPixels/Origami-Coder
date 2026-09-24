import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import { LayerNode } from "@origami/core/effect/layer-node"
import { createTwoFilesPatch } from "diff"
import { Effect, ManagedRuntime } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ACPEvent } from "@/acp/event"
import { ACPPermission } from "@/acp/permission"
import { ACPSession } from "@/acp/session"

type PermissionEvent = Extract<Event, { type: "permission.asked" }>
type PermissionReplyParams = Parameters<OrigamiClient["permission"]["reply"]>[0]
type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
const cleanupDirs: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

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

function createHarness(
  requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse> = () =>
    Promise.resolve({ outcome: { outcome: "selected", optionId: "once" } }),
) {
  const replies: PermissionReplyParams[] = []
  const requests: RequestPermissionRequest[] = []
  const updates: SessionUpdateParams[] = []
  const session = makeSessionService()
  // Backs sdk.session.get so the handler can walk a subagent's DOMAIN parent chain
  // (these rows are NOT in the ACP session store). Keyed by session id.
  const domainSessions = new Map<string, { id: string; parentID?: string; directory: string }>()
  const registerDomainSession = (id: string, input: { parentID?: string; directory?: string } = {}) => {
    domainSessions.set(id, { id, parentID: input.parentID, directory: input.directory ?? "/workspace" })
  }
  const sdk = {
    permission: {
      reply: (params: PermissionReplyParams) => {
        replies.push(params)
        return Promise.resolve({ data: true })
      },
    },
    session: {
      message: () => Promise.resolve({ data: undefined }),
      get: ({ sessionID }: { sessionID: string }) => Promise.resolve({ data: domainSessions.get(sessionID) }),
    },
  } as unknown as OrigamiClient
  const connection = {
    requestPermission: (params: RequestPermissionRequest) => {
      requests.push(params)
      return requestPermission(params)
    },
    sessionUpdate: (params: SessionUpdateParams) => {
      updates.push(params)
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "requestPermission" | "sessionUpdate">
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })

  return { connection, replies, requests, sdk, session, subscription, updates, registerDomainSession }
}

async function createSession(session: ACPSession.Interface, sessionId: string, cwd = "/workspace") {
  await Effect.runPromise(session.create({ id: sessionId, cwd }))
}

async function createKnownTextPart(
  session: ACPSession.Interface,
  sessionId: string,
  messageId: string,
  partId: string,
) {
  await Effect.runPromise(
    session.recordPartMetadata({
      sessionId,
      messageId,
      partId,
      partType: "text",
      role: "assistant",
    }),
  )
}

function permissionAsked(
  sessionID: string,
  id: string,
  input: {
    permission?: string
    metadata?: Record<string, unknown>
    tool?: { messageID: string; callID: string }
    always?: string[]
  } = {},
) {
  return {
    id: `evt_${id}`,
    type: "permission.asked",
    properties: {
      id,
      sessionID,
      permission: input.permission ?? "bash",
      patterns: ["*"],
      metadata: input.metadata ?? { command: "printf hello" },
      // A real bash ask carries always-able patterns. An EMPTY list now means
      // "no answer covers the next call" and drops the Always button — pass
      // `always: []` explicitly to exercise that (screenshot's contract).
      always: input.always ?? ["*"],
      ...(input.tool ? { tool: input.tool } : {}),
    },
  } as PermissionEvent
}

function textDelta(sessionID: string, messageID: string, partID: string, delta: string) {
  return {
    id: `evt_${sessionID}_${messageID}_${partID}`,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  } as Event
}

function textFromUpdates(updates: SessionUpdateParams[], sessionId: string) {
  return updates
    .filter((item) => item.sessionId === sessionId)
    .map((item) => item.update)
    .filter((update): update is Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }> => {
      return update.sessionUpdate === "agent_message_chunk"
    })
    .map((update) => (update.content.type === "text" ? update.content.text : ""))
    .join("")
}

async function tempFile(name: string, content: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "origami-acp-permission-"))
  cleanupDirs.push(dir)
  const file = path.join(dir, name)
  await Bun.write(file, content)
  return file
}

describe("acp permissions", () => {
  it("sends requestPermission and replies with the selected outcome", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_1", { tool: { messageID: "msg_1", callID: "call_1" } }))

    await pollUntil(() => harness.replies.length === 1, "permission was never replied")

    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_a",
      toolCall: {
        toolCallId: "call_1",
        status: "pending",
        title: "printf hello",
        rawInput: { command: "printf hello" },
        kind: "execute",
        locations: [],
      },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    })
    expect(harness.replies).toEqual([{ requestID: "perm_1", reply: "once", directory: "/workspace" }])
  })

  it("uses permission metadata for non-shell titles", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_fetch", {
        permission: "webfetch",
        metadata: {
          url: "https://example.com/docs",
          format: "markdown",
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "webfetch permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: "https://example.com/docs",
      kind: "fetch",
      rawInput: { url: "https://example.com/docs", format: "markdown" },
    })
  })

  it("includes a diff content block for edit permission metadata", async () => {
    const filepath = await tempFile("file.ts", "before\n")
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_edit", {
        permission: "edit",
        metadata: {
          filepath,
          diff: createTwoFilesPatch(filepath, filepath, "before\n", "after\n"),
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "edit permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: filepath,
      kind: "edit",
      locations: [{ path: filepath }],
      content: [
        {
          type: "diff",
          path: filepath,
          oldText: "before\n",
          newText: "after\n",
        },
      ],
    })
  })

  it("includes per-file diff blocks and locations for apply_patch permission metadata", async () => {
    const first = await tempFile("first.ts", "one\n")
    const second = await tempFile("second.ts", "alpha\n")
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_patch", {
        permission: "edit",
        metadata: {
          filepath: "first.ts, second.ts",
          files: [
            {
              filePath: first,
              relativePath: "first.ts",
              patch: createTwoFilesPatch(first, first, "one\n", "two\n"),
            },
            {
              filePath: second,
              relativePath: "second.ts",
              patch: createTwoFilesPatch(second, second, "alpha\n", "beta\n"),
            },
          ],
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "apply_patch permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: "2 files",
      locations: [{ path: first }, { path: second }],
      content: [
        {
          type: "diff",
          path: first,
          oldText: "one\n",
          newText: "two\n",
        },
        {
          type: "diff",
          path: second,
          oldText: "alpha\n",
          newText: "beta\n",
        },
      ],
    })
  })

  it("forwards external_directory metadata and locations to requestPermission", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_external", {
        permission: "external_directory",
        metadata: {
          command: "mkdir -p /tmp/outside",
          description: "Create external directory",
          directories: ["/tmp/outside"],
          patterns: ["/tmp/outside/*"],
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "external_directory permission was never replied")

    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_a",
      toolCall: {
        toolCallId: "call_1",
        status: "pending",
        title: "Create external directory",
        rawInput: {
          command: "mkdir -p /tmp/outside",
          description: "Create external directory",
          directories: ["/tmp/outside"],
          patterns: ["/tmp/outside/*"],
        },
        locations: [{ path: "/tmp/outside" }],
      },
    })
  })

  it("rejects non-selected outcomes", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "cancelled" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_cancelled"))

    await pollUntil(() => harness.replies.length === 1, "cancelled permission was never replied")

    expect(harness.replies[0]).toMatchObject({ requestID: "perm_cancelled", reply: "reject" })
  })

  it("rejects when requestPermission fails", async () => {
    const harness = createHarness(() => Promise.reject(new Error("client permission UI failed")))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_failed"))

    await pollUntil(() => harness.replies.length === 1, "failed permission was never rejected")

    expect(harness.replies[0]).toMatchObject({ requestID: "perm_failed", reply: "reject" })
  })

  it("does not let a blocked session A permission block session B message updates", async () => {
    let releasePermission: (() => void) | undefined
    const blocked = new Promise<RequestPermissionResponse>((resolve) => {
      releasePermission = () => resolve({ outcome: { outcome: "selected", optionId: "once" } })
    })
    const harness = createHarness(() => blocked)
    await createSession(harness.session, "ses_a")
    await createSession(harness.session, "ses_b")
    await createKnownTextPart(harness.session, "ses_b", "msg_b", "part_b")

    harness.subscription.handle(permissionAsked("ses_a", "perm_blocked"))
    await pollUntil(() => harness.requests.length === 1, "blocked permission was never requested")

    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "session_b_message"))

    expect(textFromUpdates(harness.updates, "ses_b")).toBe("session_b_message")
    expect(harness.replies).toHaveLength(0)

    releasePermission?.()
    await pollUntil(() => harness.replies.length === 1, "blocked permission was never replied after release")
  })

  it("serializes permission requests per session", async () => {
    let releaseFirst: (() => void) | undefined
    const first = new Promise<RequestPermissionResponse>((resolve) => {
      releaseFirst = () => resolve({ outcome: { outcome: "selected", optionId: "once" } })
    })
    const harness = createHarness(() =>
      harness.requests.length === 1 ? first : Promise.resolve({ outcome: { outcome: "selected", optionId: "always" } }),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_1"))
    harness.subscription.handle(permissionAsked("ses_a", "perm_2"))

    await pollUntil(() => harness.requests.length === 1, "first permission was never requested")
    expect(harness.requests.map((request) => request.toolCall.toolCallId)).toEqual(["perm_1"])

    releaseFirst?.()
    await pollUntil(() => harness.requests.length === 2, "second permission was not requested after first resolved")
    await pollUntil(() => harness.replies.length === 2, "serialized permissions were not both replied")

    expect(harness.replies.map((reply) => [reply.requestID, reply.reply])).toEqual([
      ["perm_1", "once"],
      ["perm_2", "always"],
    ])
  })

  it("surfaces a subagent ask under its registered domain parent and resolves the original permission", async () => {
    const harness = createHarness()
    // Parent chat is registered in the ACP store; the subagent session is NOT
    // (the task tool only creates it in the domain store) but names the parent.
    await createSession(harness.session, "ses_parent")
    harness.registerDomainSession("ses_child", { parentID: "ses_parent", directory: "/workspace" })

    harness.subscription.handle(
      permissionAsked("ses_child", "perm_sub", {
        permission: "external_directory",
        metadata: { directories: ["/outside"], patterns: ["/outside/*"] },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "subagent permission was never replied")

    // The ask reaches the client under the PARENT's session id (the only id it
    // knows), carrying the subagent's own tool-call identity.
    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_parent",
      toolCall: { toolCallId: "call_1" },
    })
    // The reply resolves the ORIGINAL permission id, routed to the parent's cwd.
    expect(harness.replies[0]).toMatchObject({ requestID: "perm_sub", reply: "once", directory: "/workspace" })
  })

  it("walks multiple domain hops to the nearest registered ancestor", async () => {
    const harness = createHarness()
    // Only the root is ACP-registered; a subagent (leaf) spawned another subagent
    // (mid). The leaf's ask must climb two domain hops to reach the root.
    await createSession(harness.session, "ses_root")
    harness.registerDomainSession("ses_mid", { parentID: "ses_root", directory: "/workspace" })
    harness.registerDomainSession("ses_leaf", { parentID: "ses_mid", directory: "/workspace" })

    harness.subscription.handle(
      permissionAsked("ses_leaf", "perm_deep", { tool: { messageID: "msg_1", callID: "call_deep" } }),
    )

    await pollUntil(() => harness.replies.length === 1, "deep subagent permission was never replied")

    expect(harness.requests[0]).toMatchObject({ sessionId: "ses_root", toolCall: { toolCallId: "call_deep" } })
    expect(harness.replies[0]).toMatchObject({ requestID: "perm_deep", reply: "once" })
  })

  it("REJECTS rather than dropping the ask when no ancestor is registered", async () => {
    const harness = createHarness()
    // An orphan subagent whose entire domain chain is unregistered in the ACP
    // store. This used to be a silent no-op, and silence is the worst possible
    // answer here: the client never gets a bar, the sub-agent's tool call sits
    // `running` for the life of the session, and the parent's task call hangs
    // behind it with nothing on screen to explain it. There is still no window
    // to ask in — so the ask is REFUSED, which is an answer the agent can
    // report, the same shape the `requestPermission`-less branch already used.
    harness.registerDomainSession("ses_orphan", { parentID: "ses_ghost", directory: "/workspace" })
    harness.registerDomainSession("ses_ghost", { directory: "/workspace" })

    harness.subscription.handle(permissionAsked("ses_orphan", "perm_orphan"))

    await pollUntil(() => harness.replies.length === 1, "orphan permission was never answered")
    // Nothing was ASKED — there was nowhere to ask.
    expect(harness.requests).toHaveLength(0)
    expect(harness.replies[0]).toMatchObject({ requestID: "perm_orphan", reply: "reject" })
  })

  it("terminates on a cyclic domain parent chain", async () => {
    const harness = createHarness()
    // A pathological self-referential chain must not spin: the bounded, cycle-safe
    // walk gives up and no-ops.
    harness.registerDomainSession("ses_x", { parentID: "ses_y", directory: "/workspace" })
    harness.registerDomainSession("ses_y", { parentID: "ses_x", directory: "/workspace" })

    harness.subscription.handle(permissionAsked("ses_x", "perm_cycle"))

    await pollUntil(() => harness.replies.length === 1, "cyclic-chain permission was never answered")
    expect(harness.requests).toHaveLength(0)
    expect(harness.replies[0]).toMatchObject({ requestID: "perm_cycle", reply: "reject" })
  })
})

describe("permissionOptions - the Always button only appears when an answer can stand", () => {
  it("an EMPTY always list drops the Always option (screenshot's contract: nothing covers the next capture)", () => {
    const ids = ACPPermission.permissionOptions([]).map((o) => o.optionId)
    expect(ids).toEqual(["once", "reject"])
  })

  it("a populated or absent always list keeps all three options", () => {
    expect(ACPPermission.permissionOptions(["*"]).map((o) => o.optionId)).toEqual(["once", "always", "reject"])
    expect(ACPPermission.permissionOptions(undefined).map((o) => o.optionId)).toEqual(["once", "always", "reject"])
  })

  it("an ask with an empty always list reaches the client with only once/reject (flow-level)", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")
    harness.subscription.handle(
      permissionAsked("ses_a", "perm_shot", { permission: "screenshot", metadata: { display: "primary" }, always: [] }),
    )
    await pollUntil(() => harness.replies.length === 1, "screenshot permission was never replied")
    expect(harness.requests[0]!.options.map((o) => o.optionId)).toEqual(["once", "reject"])
  })
})

// t-tc2es2. A throw inside the handler used to be eaten by the queue's
// `.catch(() => {})`: the ask was never answered, a main-session ask has no
// timeout, and the turn sat "running" with no bar until Stop.
describe("a handler failure never leaves the ask unanswered", () => {
  const logged: string[] = []
  let restore: (() => void) | undefined
  beforeEach(() => {
    logged.length = 0
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "))
    })
    restore = () => spy.mockRestore()
  })
  afterEach(() => restore?.())
  const loggedAbout = (askID: string, cause: string) =>
    logged.some((line) => line.includes(askID) && line.includes(cause))

  it("an edit whose diff preview cannot be read still reaches the client, with no diff, and the answer stands", async () => {
    // A directory: `exists` is true and `readText` throws (EISDIR), the same
    // shape as a file another Windows process holds without share-read.
    const dir = await mkdtemp(path.join(tmpdir(), "origami-acp-permission-"))
    cleanupDirs.push(dir)
    const cause = await readFile(dir, "utf-8").then(
      () => "",
      (error: Error) => error.message,
    )
    expect(cause).not.toBe("")
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_unreadable", {
        permission: "edit",
        metadata: { filepath: dir, diff: createTwoFilesPatch(dir, dir, "before\n", "after\n") },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "the ask with an unreadable preview was never answered")
    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]?.toolCall.content).toBeUndefined()
    expect(harness.replies[0]).toMatchObject({ requestID: "perm_unreadable", reply: "once" })
    expect(loggedAbout("perm_unreadable", cause)).toBe(true)
  })

  it("a client that THROWS instead of rejecting gets the ask refused with the cause named", async () => {
    const harness = createHarness(() => {
      throw new Error("prompt renderer crashed")
    })
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_throw"))

    await pollUntil(() => harness.replies.length === 1, "a throwing client left the ask unanswered")
    expect(harness.replies[0]).toMatchObject({ requestID: "perm_throw", reply: "reject", directory: "/workspace" })
    // The refusal carries the reason into the tool row (CorrectedError feedback),
    // so the row does not read as a plain "the user rejected".
    expect(harness.replies[0]?.message).toContain("prompt renderer crashed")
    expect(loggedAbout("perm_throw", "prompt renderer crashed")).toBe(true)
  })

  it("a client whose permission call REJECTS is refused with the cause named too", async () => {
    const harness = createHarness(() => Promise.reject(new Error("client permission UI failed")))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_rejects"))

    await pollUntil(() => harness.replies.length === 1, "failed permission was never rejected")
    expect(harness.replies[0]).toMatchObject({ requestID: "perm_rejects", reply: "reject" })
    expect(harness.replies[0]?.message).toContain("client permission UI failed")
    expect(loggedAbout("perm_rejects", "client permission UI failed")).toBe(true)
  })

  it("an answer the engine refuses to take is followed by a refusal, not silence", async () => {
    // The generated SDK does not throw on a non-2xx: it RETURNS `{ error }`. An
    // "once" that came back as an error left the ask pending with no one to answer it.
    const harness = createHarness()
    await createSession(harness.session, "ses_a")
    const replies: PermissionReplyParams[] = []
    ;(harness.sdk.permission as { reply: unknown }).reply = (params: PermissionReplyParams) => {
      replies.push(params)
      return Promise.resolve(replies.length === 1 ? { error: { name: "UnknownError", data: { message: "store busy" } } } : { data: true })
    }

    harness.subscription.handle(permissionAsked("ses_a", "perm_reply_error"))

    await pollUntil(() => replies.length === 2, "a refused reply was not followed by a refusal")
    expect(replies[0]).toMatchObject({ requestID: "perm_reply_error", reply: "once" })
    expect(replies[1]).toMatchObject({ requestID: "perm_reply_error", reply: "reject", directory: "/workspace" })
    expect(loggedAbout("perm_reply_error", "store busy")).toBe(true)
  })
})

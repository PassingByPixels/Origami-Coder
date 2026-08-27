import { describe, expect, it } from "bun:test"
import type {
  AgentSideConnection,
  ForkSessionResponse,
  LoadSessionResponse,
  NewSessionResponse,
  SessionNotification,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk"
import type { AssistantMessage, OrigamiClient } from "@origami/sdk/v2"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Effect, Exit } from "effect"
import * as ACPService from "@/acp/service"
import * as ACPError from "@/acp/error"
import { UsageService } from "@/acp/usage"
import type { Provider } from "@/provider/provider"

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")
const configuredModelID = ModelV2.ID.make("configured-model")
const secondModelID = ModelV2.ID.make("second-model")

const provider: Provider.Info = {
  id: providerID,
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: {
    [modelID]: {
      id: modelID,
      providerID,
      api: {
        id: modelID,
        url: "https://example.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Test Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      variants: {
        default: {},
        high: { reasoningEffort: "high" },
      },
    },
    [configuredModelID]: {
      id: configuredModelID,
      providerID,
      api: {
        id: configuredModelID,
        url: "https://example.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Configured Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
    [secondModelID]: {
      id: secondModelID,
      providerID,
      api: {
        id: secondModelID,
        url: "https://example.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Second Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 128000,
        output: 4096,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      variants: {
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
      },
    },
  },
}

describe("ACP service sessions", () => {
  const makeService = (
    messages: readonly { info: unknown; parts: readonly unknown[] }[] = [],
    options?: {
      abort?: (input: { sessionID: string }) => Promise<{ data: boolean }>
      prompt?: (input: unknown) => Promise<{ data: { info: ReturnType<typeof assistantInfo> } }>
      sessions?: readonly { id: string; directory: string; title: string; time: { created: number; updated: number } }[]
      /** The ENGINE session row `session.get` answers with - the only place a
       *  persisted permission ruleset can be read back from on a reload. */
      sessionRow?: Record<string, unknown>
      /** The STORED todo list `session.todo` answers with - the durable copy a
       *  restore reads, as opposed to whatever the replayed transcript says. */
      todos?: readonly { content: string; status: string; priority: string }[]
      /** Make that read fail, to pin that a restore survives it. */
      todoFails?: boolean
    },
  ) => {
    const updates: SessionNotification[] = []
    const mcpAdds: string[] = []
    const aborts: string[] = []
    const forks: string[] = []
    const prompts: unknown[] = []
    const commands: unknown[] = []
    const summarizes: unknown[] = []
    const usageUpdates: string[] = []
    const deletes: string[] = []
    const reverts: unknown[] = []
    const unreverts: unknown[] = []
    const titleUpdates: unknown[] = []
    const sessions =
      options?.sessions ??
      Array.from({ length: 102 }, (_, index) => ({
        id: `ses_${index + 1}`,
        directory: index % 2 === 0 ? "/workspace" : "/other",
        title: `Session ${index + 1}`,
        time: { created: index + 1, updated: index + 1 },
      }))
    const sdk = {
      config: {
        providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
        get: () => Promise.resolve({ data: {} }),
        refresh: () => Promise.resolve({ data: true }),
      },
      app: {
        agents: () =>
          Promise.resolve({
            data: [
              { name: "build", mode: "primary", permission: [], options: {} },
              { name: "plan", mode: "primary", description: "Plan first", permission: [], options: {} },
              { name: "hidden", mode: "primary", hidden: true, permission: [], options: {} },
            ],
          }),
        skills: () =>
          Promise.resolve({
            data: [{ name: "review-skill", description: "Review", location: "/skills/review", content: "review" }],
          }),
      },
      command: {
        list: () =>
          Promise.resolve({
            data: [{ name: "init", description: "Initialize", source: "command", template: "init", hints: [] }],
          }),
      },
      session: {
        create: () => Promise.resolve({ data: { id: "ses_new" } }),
        get: () => Promise.resolve({ data: options?.sessionRow ?? { id: "ses_loaded" } }),
        // HONOURS `limit`, and defaults it to 100 when the caller omits one,
        // because the real store does: session/session.ts listByProject ends in
        // `.limit(input.limit ?? 100)`. A double that ignored it hid the defect
        // this file now pins — the caller omitted the limit, production silently
        // returned only the 100 most recent roots, and every test still passed
        // because the fake handed back all 102. Most-recently-updated first, as
        // the real query orders.
        list: (input: { directory?: string; limit?: number }) => {
          const rows = input.directory
            ? sessions.filter((session) => session.directory === input.directory)
            : sessions
          const ordered = [...rows].sort((a, b) => b.time.updated - a.time.updated)
          return Promise.resolve({ data: ordered.slice(0, input.limit ?? 100) })
        },
        messages: () => Promise.resolve({ data: messages }),
        todo: () =>
          options?.todoFails
            ? Promise.reject(new Error("todo read failed"))
            : Promise.resolve({ data: options?.todos ?? [] }),
        prompt:
          options?.prompt ??
          ((input: unknown) => {
            prompts.push(input)
            return Promise.resolve({
              data: {
                info: assistantInfo({
                  input: 100,
                  output: 40,
                  reasoning: 7,
                  cache: { read: 11, write: 13 },
                }),
              },
            })
          }),
        command: (input: unknown) => {
          commands.push(input)
          return Promise.resolve({
            data: {
              info: assistantInfo({
                input: 3,
                output: 4,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              }),
            },
          })
        },
        summarize: (input: unknown) => {
          summarizes.push(input)
          return Promise.resolve({ data: true })
        },
        abort:
          options?.abort ??
          ((input: { sessionID: string }) => {
            aborts.push(input.sessionID)
            return Promise.resolve({ data: true })
          }),
        fork: (input: { sessionID: string }) => {
          forks.push(input.sessionID)
          return Promise.resolve({ data: { id: `fork_${input.sessionID}` } })
        },
        delete: (input: { sessionID: string }) => {
          deletes.push(input.sessionID)
          return Promise.resolve({ data: true })
        },
        revert: (input: unknown) => {
          reverts.push(input)
          return Promise.resolve({ data: {} })
        },
        unrevert: (input: unknown) => {
          unreverts.push(input)
          return Promise.resolve({ data: {} })
        },
        update: (input: unknown) => {
          titleUpdates.push(input)
          return Promise.resolve({ data: {} })
        },
      },
      mcp: {
        add: (input: { name?: string }) => {
          if (input.name) mcpAdds.push(input.name)
          return Promise.resolve({ data: {} })
        },
      },
    } as unknown as OrigamiClient
    const extNotifications: { method: string; params: Record<string, unknown> }[] = []
    const connection = {
      sessionUpdate: (update: SessionNotification) => {
        updates.push(update)
        return Promise.resolve()
      },
      extNotification: (method: string, params: Record<string, unknown>) => {
        extNotifications.push({ method, params })
        return Promise.resolve()
      },
    } as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
    const usage = UsageService.Service.of({
      buildUsage: UsageService.buildUsage,
      latestAssistantMessage: UsageService.latestAssistantMessage,
      totalSessionCost: UsageService.totalSessionCost,
      contextLimit: () => Effect.succeed(128000),
      sendUpdate: (input) =>
        Effect.sync(() => {
          usageUpdates.push(input.sessionID)
        }),
    })

    return {
      service: ACPService.make({ sdk, connection, usage }),
      updates,
      extNotifications,
      mcpAdds,
      aborts,
      forks,
      prompts,
      commands,
      summarizes,
      usageUpdates,
      deletes,
      reverts,
      unreverts,
      titleUpdates,
    }
  }

  it("creates a backed session with config options and command update", async () => {
    const { service, updates, mcpAdds } = makeService()
    const result = await Effect.runPromise(
      service.newSession({
        cwd: "/workspace",
        mcpServers: [
          { name: "tools", command: "node", args: ["server.js"], env: [] },
          { name: "tools", command: "node", args: ["server.js"], env: [] },
        ],
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(result.sessionId).toBe("ses_new")
    expect(categories(result)).toContain("model")
    expect(categories(result)).toContain("thought_level")
    expect(categories(result)).toContain("mode")
    expect(updates).toHaveLength(1)
    expect(JSON.stringify(updates[0])).toContain("available_commands_update")
    expect(JSON.stringify(updates[0])).toContain("review-skill")
    expect(mcpAdds).toEqual(["tools"])
  })

  it("loads a session and restores model variant and mode from messages", async () => {
    const { service } = makeService([
      {
        info: {
          role: "assistant",
          providerID: "test",
          modelID: "test-model",
          variant: "high",
          mode: "plan",
        },
        parts: [],
      },
    ])
    const result = await Effect.runPromise(
      service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }),
    )

    expect(result.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe("high")
    expect(result.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe("plan")
  })

  it("replays loaded session transcript chunks", async () => {
    const { service, updates } = makeService([
      {
        info: { id: "msg_user", sessionID: "ses_loaded", role: "user" },
        parts: [{ id: "part_user", sessionID: "ses_loaded", messageID: "msg_user", type: "text", text: "hello" }],
      },
      {
        info: { id: "msg_assistant", sessionID: "ses_loaded", role: "assistant" },
        parts: [
          {
            id: "part_assistant",
            sessionID: "ses_loaded",
            messageID: "msg_assistant",
            type: "text",
            text: "hi there",
          },
        ],
      },
    ])

    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))

    expect(
      updates
        .map((item) => item.update)
        .filter((item) => item.sessionUpdate === "user_message_chunk" || item.sessionUpdate === "agent_message_chunk"),
    ).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        messageId: "msg_user",
        content: { type: "text", text: "hello" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_assistant",
        content: { type: "text", text: "hi there" },
      },
    ])
  })

  it("lists sessions sorted by updated time with cursor support", async () => {
    const { service } = makeService()
    const first = await Effect.runPromise(service.listSessions({ cwd: "/workspace" }))
    const second = await Effect.runPromise(service.listSessions({ cwd: "/workspace", cursor: first.nextCursor }))

    expect(first.sessions).toHaveLength(51)
    expect(first.sessions[0]?.sessionId).toBe("ses_101")
    expect(first.sessions.at(-1)?.sessionId).toBe("ses_1")
    expect(first.nextCursor).toBeUndefined()
    expect(second.sessions).toEqual(first.sessions)
  })

  it("includes live ACP sessions before they appear in server-backed session list", async () => {
    const { service } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const listed = await Effect.runPromise(service.listSessions({ cwd: "/workspace" }))

    expect(listed.sessions[0]?.sessionId).toBe(created.sessionId)
    expect(listed.sessions[0]?.cwd).toBe("/workspace")
  })

  it("reaches sessions past the store's default 100-row cut", async () => {
    // The store answers `limit ?? 100`. Omitting the limit meant the 140 roots
    // here arrived as 100 and the oldest 40 were gone — not paged, GONE, since
    // the cursor filters a list that had already been cut. Paging to exhaustion
    // has to surface every one of them.
    const many = Array.from({ length: 140 }, (_, index) => ({
      id: `ses_deep_${index + 1}`,
      directory: "/workspace",
      title: `Deep ${index + 1}`,
      time: { created: index + 1, updated: index + 1 },
    }))
    const { service } = makeService([], { sessions: many })

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const res = await Effect.runPromise(service.listSessions({ cwd: "/workspace", ...(cursor ? { cursor } : {}) }))
      for (const item of res.sessions) if (!seen.includes(item.sessionId)) seen.push(item.sessionId)
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }

    expect(seen).toHaveLength(140)
    // The oldest row — the one the silent cut used to eat first.
    expect(seen).toContain("ses_deep_1")
  })

  it("never splits a group of sessions that share one updated time", async () => {
    // 101 roots, the last two updated in the SAME millisecond. A page of 100
    // cut between them would strand the second: the cursor is that timestamp
    // and the filter is a strict `<`, so nothing could ever ask for it again.
    const tied = Array.from({ length: 101 }, (_, index) => ({
      id: `ses_tie_${index + 1}`,
      directory: "/workspace",
      title: `Tie ${index + 1}`,
      time: { created: index + 1, updated: index >= 99 ? 1 : 101 - index },
    }))
    const { service } = makeService([], { sessions: tied })

    const first = await Effect.runPromise(service.listSessions({ cwd: "/workspace" }))
    const ids = first.sessions.map((s) => s.sessionId)
    expect(ids).toContain("ses_tie_100")
    expect(ids).toContain("ses_tie_101")
  })

  it("lists all sessions with next cursor when the first page is full", async () => {
    const { service } = makeService()
    const first = await Effect.runPromise(service.listSessions({}))
    const second = await Effect.runPromise(service.listSessions({ cursor: first.nextCursor }))

    expect(first.sessions).toHaveLength(100)
    expect(first.sessions[0]?.sessionId).toBe("ses_102")
    expect(first.sessions.at(-1)?.sessionId).toBe("ses_3")
    expect(first.nextCursor).toBe("3")
    expect(second.sessions.map((session) => session.sessionId)).toEqual(["ses_2", "ses_1"])
  })

  it("resumes a session and stores restored state without replaying transcript chunks", async () => {
    const { service, updates } = makeService([
      {
        info: {
          id: "msg_user",
          sessionID: "ses_resume",
          role: "user",
          model: { providerID: "test", modelID: "test-model", variant: "high" },
          agent: "plan",
        },
        parts: [{ id: "part_user", sessionID: "ses_resume", messageID: "msg_user", type: "text", text: "hello" }],
      },
      {
        info: { id: "msg_assistant", sessionID: "ses_resume", role: "assistant" },
        parts: [
          {
            id: "part_assistant",
            sessionID: "ses_resume",
            messageID: "msg_assistant",
            type: "text",
            text: "hi there",
          },
        ],
      },
    ])
    const resumed = await Effect.runPromise(
      service.resumeSession({ cwd: "/workspace", sessionId: "ses_resume", mcpServers: [] }),
    )
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: "ses_resume", configId: "effort", value: "default" }),
    )

    expect(select(resumed, "effort")?.currentValue).toBe("high")
    expect(select(updated, "effort")?.currentValue).toBe("default")
    expect(
      updates
        .map((item) => item.update)
        .filter((item) => item.sessionUpdate === "user_message_chunk" || item.sessionUpdate === "agent_message_chunk"),
    ).toEqual([])
  })

  it("closes local ACP state and aborts the backing session best-effort", async () => {
    const { service, aborts } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(await Effect.runPromise(service.closeSession({ sessionId: created.sessionId }))).toEqual({})
    const missing = await Effect.runPromise(
      service
        .setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "high" })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )
    expect(missing.code).toBe(-32602)
    expect(aborts).toEqual([created.sessionId])
    expect(await Effect.runPromise(service.closeSession({ sessionId: "missing" }))).toEqual({})
  })

  it("cancel aborts the backing session and keeps the ACP session", async () => {
    const { service, aborts } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(service.cancel({ sessionId: created.sessionId }))

    // The running turn was aborted via the core session API.
    expect(aborts).toEqual([created.sessionId])
    // Unlike closeSession, the ACP session is still present afterwards so
    // the client can keep prompting.
    const stillUsable = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "high" }),
    )
    expect(stillUsable).toBeDefined()
  })

  it("does not fail cancel or close when the backing abort fails", async () => {
    const { service } = makeService([], { abort: () => Promise.reject(new Error("nope")) })
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(service.cancel({ sessionId: created.sessionId }))
    expect(await Effect.runPromise(service.closeSession({ sessionId: created.sessionId }))).toEqual({})
    expect(await Effect.runPromise(service.closeSession({ sessionId: "missing" }))).toEqual({})
  })

  it("forks a session, loads fork state, and returns config options", async () => {
    const { service, forks } = makeService([
      {
        info: {
          role: "assistant",
          providerID: "test",
          modelID: "second-model",
          variant: "medium",
          mode: "plan",
        },
        parts: [],
      },
    ])
    const forked = await Effect.runPromise(
      service.forkSession({ cwd: "/workspace", sessionId: "ses_parent", mcpServers: [] }),
    )
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: forked.sessionId, configId: "effort", value: "low" }),
    )

    expect(forked.sessionId).toBe("fork_ses_parent")
    expect(select(forked, "model")?.currentValue).toBe("test/second-model")
    expect(select(forked, "effort")?.currentValue).toBe("medium")
    expect(select(updated, "effort")?.currentValue).toBe("low")
    expect(forks).toEqual(["ses_parent"])
  })

  // The todo list is durable engine state keyed by the session, and every
  // restore path is a moment where the client has nothing else to go on: `load`
  // gets a replayed transcript that can carry an OLDER todowrite frame,
  // `resume` replays no messages at all, and a `fork` replays the PARENT's
  // writes. Each therefore pushes the stored list.
  describe("todo restore", () => {
    const stored = [
      { content: "reproduce the failure", status: "completed", priority: "high" },
      { content: "fix the parser", status: "in_progress", priority: "high" },
    ]
    const snapshots = (items: { method: string; params: Record<string, unknown> }[]) =>
      items.filter((item) => item.method === "origami/todoSnapshot")

    it("pushes the stored list on load, resume and fork", async () => {
      for (const [label, open] of [
        ["load", (s: ReturnType<typeof makeService>["service"]) => s.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] })],
        ["resume", (s: ReturnType<typeof makeService>["service"]) => s.resumeSession({ cwd: "/workspace", sessionId: "ses_resume", mcpServers: [] })],
        ["fork", (s: ReturnType<typeof makeService>["service"]) => s.forkSession({ cwd: "/workspace", sessionId: "ses_parent", mcpServers: [] })],
      ] as const) {
        const { service, extNotifications } = makeService([], { todos: stored })
        await Effect.runPromise(open(service))

        const sent = snapshots(extNotifications)
        expect(sent, label).toHaveLength(1)
        expect(sent[0]!.params.source, label).toBe("session_restore")
        expect(
          (sent[0]!.params.todos as { content: string; status: string }[]).map((todo) => [todo.content, todo.status]),
          label,
        ).toEqual([
          ["reproduce the failure", "completed"],
          ["fix the parser", "in_progress"],
        ])
      }
    })

    it("says nothing when the session has no todos", async () => {
      const { service, extNotifications } = makeService()
      await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))
      expect(snapshots(extNotifications)).toEqual([])
    })

    it("opens the chat anyway when the todo read fails", async () => {
      // A restore must never be blocked by the task strip: the chat still has
      // to open, just without a list.
      const { service, extNotifications } = makeService([], { todoFails: true })
      const result = await Effect.runPromise(
        service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }),
      )
      expect(result.configOptions).toBeDefined()
      expect(snapshots(extNotifications)).toEqual([])
    })
  })

  it("restores model variant and mode from the latest user message", async () => {
    const { service } = makeService([
      {
        info: {
          role: "user",
          model: { providerID: "test", modelID: "test-model", variant: "default" },
          agent: "build",
        },
        parts: [],
      },
      {
        info: {
          role: "user",
          model: { providerID: "test", modelID: "test-model", variant: "high" },
          agent: "plan",
        },
        parts: [],
      },
    ])
    const result = await Effect.runPromise(
      service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }),
    )

    expect(result.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe("high")
    expect(result.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe("plan")
  })

  it("maps provider auth failures to auth-required request errors", async () => {
    const service = ACPService.make({
      sdk: {
        config: {
          providers: () => Promise.reject({ name: "ProviderAuthError", data: { providerID: "test" } }),
          get: () => Promise.resolve({ data: {} }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () => Promise.resolve({ data: [] }),
        },
        command: {
          list: () => Promise.resolve({ data: [] }),
        },
      } as unknown as OrigamiClient,
    })
    const error = await Effect.runPromise(
      service
        .newSession({ cwd: "/workspace", mcpServers: [] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )

    expect(error.code).toBe(-32000)
  })

  it("does not cache failed directory snapshots", async () => {
    let providersCalls = 0
    const sdk = {
      config: {
        providers: () => {
          providersCalls++
          if (providersCalls === 1) {
            return Promise.reject({ name: "ProviderAuthError", data: { providerID: "test" } })
          }
          return Promise.resolve({ data: { providers: [provider], default: { test: modelID } } })
        },
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: {
        list: () => Promise.resolve({ data: [] }),
      },
      session: {
        create: () => Promise.resolve({ data: { id: "ses_retry" } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })

    const first = await Effect.runPromise(
      service
        .newSession({ cwd: "/workspace", mcpServers: [] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )
    const second = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(first.code).toBe(-32000)
    expect(second.sessionId).toBe("ses_retry")
    expect(providersCalls).toBe(2)
  })

  it("registers same-name MCP servers again for different sessions or configs", async () => {
    const adds: unknown[] = []
    let nextSession = 0
    const sdk = {
      config: {
        providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: {
        list: () => Promise.resolve({ data: [] }),
      },
      session: {
        create: () => {
          nextSession++
          return Promise.resolve({ data: { id: `ses_${nextSession}` } })
        },
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: (input: unknown) => {
          adds.push(input)
          return Promise.resolve({ data: {} })
        },
      },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })

    await Effect.runPromise(
      service.newSession({
        cwd: "/workspace",
        mcpServers: [{ name: "tools", command: "node", args: ["one.js"], env: [] }],
      }),
    )
    await Effect.runPromise(
      service.newSession({
        cwd: "/workspace",
        mcpServers: [{ name: "tools", command: "node", args: ["two.js"], env: [] }],
      }),
    )

    expect(adds).toHaveLength(2)
    expect(JSON.stringify(adds[0])).toContain("one.js")
    expect(JSON.stringify(adds[1])).toContain("two.js")
  })

  it("uses the configured model as the new session default", async () => {
    const sdk = {
      config: {
        providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
        get: () => Promise.resolve({ data: { model: "test/configured-model" } }),
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: {
        list: () => Promise.resolve({ data: [] }),
      },
      session: {
        create: (input: { model?: { id?: string } }) => Promise.resolve({ data: { id: input.model?.id } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(result.sessionId).toBe("configured-model")
    expect(result.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("test/configured-model")
  })

  it("does not scan last-used sessions when resolving the new session default", async () => {
    const historyCalls: string[] = []
    const sdk = {
      config: {
        providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: {
        list: () => Promise.resolve({ data: [] }),
      },
      session: {
        create: (input: { model?: { id?: string } }) => Promise.resolve({ data: { id: input.model?.id } }),
        list: () => {
          historyCalls.push("list")
          return Promise.resolve({ data: [{ id: "ses_recent" }] })
        },
        messages: () => {
          historyCalls.push("messages")
          return Promise.resolve({
            data: [{ info: { role: "user", model: { providerID: "test", modelID: "second-model" } } }],
          })
        },
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })

    const result = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(result.sessionId).toBe("test-model")
    expect(result.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("test/test-model")
    expect(historyCalls).toEqual([])
  })

  it("switches model and returns updated model and effort options", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "test/second-model",
      }),
    )

    expect(select(updated, "model")?.currentValue).toBe("test/second-model")
    expect(select(updated, "effort")?.currentValue).toBe("low")
    expect(flattenSelectOptions(select(updated, "effort")).map((option) => option.value)).toEqual(["low", "medium"])
  })

  // The per-chat SUB-AGENT model override. It rides the same string config
  // channel as `model` and is validated the same way — an override the registry
  // cannot serve would fail at SPAWN time, inside a child session the user
  // cannot see — but it lands somewhere else entirely: the ENGINE's session row,
  // because that is what the task tool reads and what survives a restart.
  it("sets the sub-agent override on the ACP session AND persists it on the row", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "subagentModel",
        value: "test/second-model",
      }),
    )

    expect(titleUpdates.at(-1)).toMatchObject({
      sessionID: session.sessionId,
      metadata: { subagentModel: { providerID: "test", modelID: "second-model" } },
    })
  })

  it("clears the sub-agent override, dropping the key rather than blanking it", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "subagentModel",
        value: "test/second-model",
      }),
    )
    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "subagentModel", value: "" }),
    )

    // A row still carrying `subagentModel: undefined` would read as "set" to
    // anything that tests for the key rather than its value.
    expect((titleUpdates.at(-1) as { metadata: Record<string, unknown> }).metadata).toEqual({})
  })

  it("refuses a sub-agent override the provider registry does not have", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const before = titleUpdates.length

    const exit = await Effect.runPromiseExit(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "subagentModel",
        value: "test/missing-model",
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    // ...and nothing was written: a half-applied override is worse than none.
    expect(titleUpdates.length).toBe(before)
  })

  // t-lmqe0g: a trailing "@<context>" on the SAME value string carries the
  // sub-agent override's context-window override, stripped before model
  // resolution and persisted alongside providerID/modelID on the row.
  it("sets the sub-agent override WITH a context length, persisting both", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "subagentModel",
        value: "test/second-model@131072",
      }),
    )

    expect(titleUpdates.at(-1)).toMatchObject({
      sessionID: session.sessionId,
      metadata: { subagentModel: { providerID: "test", modelID: "second-model", context: 131072 } },
    })
  })

  it("re-picking the model with no context suffix drops a previously-set context", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "subagentModel",
        value: "test/second-model@131072",
      }),
    )
    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "subagentModel",
        value: "test/second-model",
      }),
    )

    expect(titleUpdates.at(-1)).toMatchObject({
      sessionID: session.sessionId,
      metadata: { subagentModel: { providerID: "test", modelID: "second-model" } },
    })
    const last = titleUpdates.at(-1) as { metadata: Record<string, unknown> }
    expect((last.metadata.subagentModel as Record<string, unknown>).context).toBeUndefined()
  })

  it("refuses a zero context length and writes nothing", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const before = titleUpdates.length

    const exit = await Effect.runPromiseExit(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "subagentModel",
        value: "test/second-model@0",
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(titleUpdates.length).toBe(before)
  })

  it("switches effort and returns the updated effort current value", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "high",
      }),
    )

    expect(select(updated, "effort")?.currentValue).toBe("high")
  })

  it("switches mode and returns the updated mode current value", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "mode",
        value: "plan",
      }),
    )

    expect(select(updated, "mode")?.currentValue).toBe("plan")
  })

  it("maps invalid model effort mode and config id to invalid params", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const results = await Promise.all(
      [
        { configId: "model", value: "test/missing-model" },
        { configId: "effort", value: "max" },
        { configId: "mode", value: "missing-mode" },
        { configId: "missing", value: "value" },
      ].map((input) =>
        Effect.runPromise(
          service
            .setSessionConfigOption({ sessionId: session.sessionId, ...input })
            .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
        ),
      ),
    )
    expect(results.map((error) => error.code)).toEqual([-32602, -32602, -32602, -32602])
  })

  it("does not refetch providers modes or commands when switching effort from session snapshot", async () => {
    const calls = {
      providers: 0,
      agents: 0,
      commands: 0,
      skills: 0,
      mcpAdds: 0,
    }
    const sdk = {
      config: {
        providers: () => {
          calls.providers++
          return Promise.resolve({ data: { providers: [provider], default: { test: modelID } } })
        },
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => {
          calls.agents++
          return Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] })
        },
        skills: () => {
          calls.skills++
          return Promise.resolve({ data: [] })
        },
      },
      command: {
        list: () => {
          calls.commands++
          return Promise.resolve({ data: [] })
        },
      },
      session: {
        create: () => Promise.resolve({ data: { id: "ses_fast" } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: () => {
          calls.mcpAdds++
          return Promise.resolve({ data: {} })
        },
      },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(calls).toEqual({ providers: 1, agents: 1, commands: 1, skills: 1, mcpAdds: 0 })

    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "high",
      }),
    )

    expect(calls).toEqual({ providers: 1, agents: 1, commands: 1, skills: 1, mcpAdds: 0 })
  })

  it("switches model against the warm provider snapshot without refetching", async () => {
    const calls = {
      providers: 0,
      agents: 0,
      commands: 0,
      skills: 0,
    }
    const sdk = {
      config: {
        providers: () => {
          calls.providers++
          return Promise.resolve({ data: { providers: [provider], default: { test: modelID } } })
        },
        get: () => Promise.resolve({ data: {} }),
      },
      app: {
        agents: () => {
          calls.agents++
          return Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] })
        },
        skills: () => {
          calls.skills++
          return Promise.resolve({ data: [] })
        },
      },
      command: {
        list: () => {
          calls.commands++
          return Promise.resolve({ data: [] })
        },
      },
      session: {
        create: () => Promise.resolve({ data: { id: "ses_model_fast" } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "test/second-model",
      }),
    )

    expect(select(updated, "model")?.currentValue).toBe("test/second-model")
    expect(calls).toEqual({ providers: 1, agents: 1, commands: 1, skills: 1 })
  })

  it("switches live to a model absent from the frozen snapshot by refreshing config", async () => {
    // Live model switch (no window reload): the model was just written to
    // origami.json AFTER the session snapshot froze, so it is missing from the
    // frozen snapshot. Switching to it must invalidate the config cache
    // (sdk.config.refresh), re-read the directory, and resolve it — not fail.
    const refreshCalls: unknown[] = []
    let providersCalls = 0
    // Provider whose model list GROWS only after a config refresh: the first
    // (frozen) snapshot lacks second-model; a refresh surfaces it.
    const withoutSecond: Provider.Info = {
      ...provider,
      models: { [modelID]: provider.models[modelID], [configuredModelID]: provider.models[configuredModelID] },
    }
    const sdk = {
      config: {
        providers: () => {
          providersCalls++
          return Promise.resolve({
            data: { providers: [providersCalls === 1 ? withoutSecond : provider], default: { test: modelID } },
          })
        },
        get: () => Promise.resolve({ data: {} }),
        refresh: (input: unknown) => {
          refreshCalls.push(input)
          return Promise.resolve({ data: true })
        },
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: { list: () => Promise.resolve({ data: [] }) },
      session: {
        create: () => Promise.resolve({ data: { id: "ses_live" } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: { add: () => Promise.resolve({ data: {} }) },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const updated = await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "test/second-model",
      }),
    )

    // The miss triggered a config invalidation (the core of the live switch)…
    expect(refreshCalls).toHaveLength(1)
    // …and the model resolved live against the refreshed snapshot, no reload.
    expect(select(updated, "model")?.currentValue).toBe("test/second-model")
  })

  it("still rejects a model that is absent even after a config refresh", async () => {
    // Self-heal is bounded: it refreshes once. A model that genuinely does not
    // exist even after the refresh is a real InvalidModelError, not a silent pass.
    const refreshCalls: unknown[] = []
    const sdk = {
      config: {
        providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
        get: () => Promise.resolve({ data: {} }),
        refresh: (input: unknown) => {
          refreshCalls.push(input)
          return Promise.resolve({ data: true })
        },
      },
      app: {
        agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
        skills: () => Promise.resolve({ data: [] }),
      },
      command: { list: () => Promise.resolve({ data: [] }) },
      session: {
        create: () => Promise.resolve({ data: { id: "ses_miss" } }),
        list: () => Promise.resolve({ data: [] }),
      },
      mcp: { add: () => Promise.resolve({ data: {} }) },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const error = await Effect.runPromise(
      service
        .setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: "test/ghost-model" })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )

    expect(refreshCalls).toHaveLength(1) // it tried to self-heal once
    expect(error.code).toBe(-32602) // but the model genuinely does not exist
  })

  it("reuses the warm directory snapshot for a second new session in the same cwd", async () => {
    const calls = {
      providers: 0,
      config: 0,
      agents: 0,
      commands: 0,
      skills: 0,
      sessionList: 0,
      messages: 0,
      creates: 0,
    }
    const sdk = {
      config: {
        providers: () => {
          calls.providers++
          return Promise.resolve({ data: { providers: [provider], default: { test: modelID } } })
        },
        get: () => {
          calls.config++
          return Promise.resolve({ data: {} })
        },
      },
      app: {
        agents: () => {
          calls.agents++
          return Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] })
        },
        skills: () => {
          calls.skills++
          return Promise.resolve({ data: [] })
        },
      },
      command: {
        list: () => {
          calls.commands++
          return Promise.resolve({ data: [] })
        },
      },
      session: {
        create: () => {
          calls.creates++
          return Promise.resolve({ data: { id: `ses_warm_${calls.creates}` } })
        },
        list: () => {
          calls.sessionList++
          return Promise.resolve({ data: [] })
        },
        messages: () => {
          calls.messages++
          return Promise.resolve({ data: [] })
        },
      },
      mcp: {
        add: () => Promise.resolve({ data: {} }),
      },
    } as unknown as OrigamiClient
    const service = ACPService.make({ sdk })

    const first = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const second = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(first.sessionId).toBe("ses_warm_1")
    expect(second.sessionId).toBe("ses_warm_2")
    expect(calls).toEqual({
      providers: 1,
      config: 1,
      agents: 1,
      commands: 1,
      skills: 1,
      sessionList: 0,
      messages: 0,
      creates: 2,
    })
  })

  it("normal text prompt sends model variant mode and converted parts", async () => {
    const { service, prompts, usageUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "high",
      }),
    )
    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "mode",
        value: "plan",
      }),
    )

    const result = await Effect.runPromise(
      service.prompt({
        sessionId: session.sessionId,
        messageId: "00000000-0000-4000-8000-000000000001",
        prompt: [{ type: "text", text: "hello" }],
      }),
    )

    expect(prompts).toEqual([
      {
        sessionID: session.sessionId,
        model: { providerID, modelID },
        variant: "high",
        parts: [{ type: "text", text: "hello" }],
        agent: "plan",
        // The scoped auto-approve preset rides EVERY prompt (default = {}), so an
        // empty map clears any previously-persisted auto/bypass ruleset back to ask.
        tools: {},
        directory: "/workspace",
      },
    ])
    expect(result).toEqual({
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        thoughtTokens: 7,
        cachedReadTokens: 11,
        cachedWriteTokens: 13,
        totalTokens: 171,
      },
      userMessageId: "00000000-0000-4000-8000-000000000001",
      _meta: {},
    })
    expect(usageUpdates).toEqual([session.sessionId])
  })

  it("maps assistant prompt errors to request errors instead of end turn", async () => {
    const { service } = makeService([], {
      prompt: () =>
        Promise.resolve({
          data: {
            info: assistantInfo(
              { input: 8, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              { name: "APIError", data: { message: "Provider request failed", isRetryable: false } },
            ),
          },
        }),
    })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const error = await Effect.runPromise(
      service
        .prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )

    expect(error.code).toBe(-32603)
    expect(error.message).toBe("Internal error: Provider request failed")
    expect(error.data).toEqual({ service: "session", errorName: "APIError" })
  })

  it("maps aborted assistant prompt errors to cancelled", async () => {
    const { service } = makeService([], {
      prompt: () =>
        Promise.resolve({
          data: {
            info: assistantInfo(
              { input: 8, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              { name: "MessageAbortedError", data: { message: "Aborted" } },
            ),
          },
        }),
    })
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const result = await Effect.runPromise(
      service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] }),
    )

    expect(result.stopReason).toBe("cancelled")
  })

  it("prompt maps assistant and user audience annotations", async () => {
    const { service, prompts } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "text", text: "assistant context", annotations: { audience: ["assistant"] } },
          { type: "text", text: "user context", annotations: { audience: ["user"] } },
        ],
      }),
    )

    expect(prompts).toContainEqual({
      sessionID: session.sessionId,
      model: { providerID, modelID },
      variant: "default",
      parts: [
        { type: "text", text: "assistant context", synthetic: true },
        { type: "text", text: "user context", ignored: true },
      ],
      agent: "build",
      // Auto-approve preset rides every prompt; default resolves to an empty map.
      tools: {},
      directory: "/workspace",
    })
  })

  it("prompt sends image and resource parts", async () => {
    const { service, prompts } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "image", data: "AAAA", mimeType: "image/png", uri: "file:///tmp/screenshot.png" },
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/report.pdf",
              mimeType: "application/pdf",
              blob: "JVBERg==",
            },
          },
        ],
      }),
    )

    expect((prompts[0] as { parts?: unknown }).parts).toEqual([
      {
        type: "file",
        url: "data:image/png;base64,AAAA",
        filename: "screenshot.png",
        mime: "image/png",
      },
      {
        type: "file",
        url: "data:application/pdf;base64,JVBERg==",
        filename: "report.pdf",
        mime: "application/pdf",
      },
    ])
  })

  it("slash command prompt calls session command", async () => {
    const { service, prompts, commands } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const result = await Effect.runPromise(
      service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "/init now" }] }),
    )

    expect(prompts).toEqual([])
    expect(commands).toEqual([
      {
        sessionID: session.sessionId,
        command: "init",
        arguments: "now",
        model: "test/test-model",
        variant: "default",
        agent: "build",
        directory: "/workspace",
      },
    ])
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
  })

  it("compact slash command calls summarize path", async () => {
    const { service, prompts, commands, summarizes } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "/compact" }] }),
    )

    expect(prompts).toEqual([])
    expect(commands).toEqual([])
    expect(summarizes).toEqual([
      {
        sessionID: session.sessionId,
        directory: "/workspace",
        providerID,
        modelID,
      },
    ])
  })

  it("maps prompt auth failures to auth-required request errors", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const failing = ACPService.make({
      sdk: {
        config: {
          providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
          get: () => Promise.resolve({ data: {} }),
        },
        app: {
          agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
          skills: () => Promise.resolve({ data: [] }),
        },
        command: {
          list: () => Promise.resolve({ data: [] }),
        },
        session: {
          create: () => Promise.resolve({ data: { id: session.sessionId } }),
          list: () => Promise.resolve({ data: [] }),
          prompt: () => Promise.reject({ name: "ProviderAuthError", data: { providerID: "test" } }),
        },
        mcp: {
          add: () => Promise.resolve({ data: {} }),
        },
      } as unknown as OrigamiClient,
      usage: UsageService.Service.of({
        buildUsage: UsageService.buildUsage,
        latestAssistantMessage: UsageService.latestAssistantMessage,
        totalSessionCost: UsageService.totalSessionCost,
        contextLimit: () => Effect.succeed(128000),
        sendUpdate: () => Effect.void,
      }),
    })
    await Effect.runPromise(failing.newSession({ cwd: "/workspace", mcpServers: [] }))
    const error = await Effect.runPromise(
      failing
        .prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip),
    )

    expect(error.code).toBe(-32000)
  })

  it("reaps only turnless default-titled server sessions older than the age floor", async () => {
    const now = Date.now()
    const old = now - 3 * 24 * 60 * 60 * 1000
    const { service, deletes } = makeService([], {
      sessions: [
        // Qualifies: default title, never had a turn (created === updated), not
        // open in this instance, and older than the 24h floor.
        {
          id: "ses_reap",
          directory: "/workspace",
          title: "New session - 2020-01-01T00:00:00.000Z",
          time: { created: old, updated: old },
        },
        // Default title + turnless but FRESH (< 24h): the age floor must spare it
        // (it may be another live instance's just-created chat).
        {
          id: "ses_fresh",
          directory: "/workspace",
          title: "New session - 2026-07-24T00:00:00.000Z",
          time: { created: now, updated: now },
        },
        // Old + turnless but has a real title: a named chat is never reaped.
        {
          id: "ses_titled",
          directory: "/workspace",
          title: "My real chat",
          time: { created: old, updated: old },
        },
      ],
    })

    const listed = await Effect.runPromise(service.listSessions({ cwd: "/workspace" }))
    const ids = listed.sessions.map((item) => item.sessionId)

    expect(deletes).toEqual(["ses_reap"])
    expect(ids).not.toContain("ses_reap")
    expect(ids).toContain("ses_fresh")
    expect(ids).toContain("ses_titled")
  })

  it("applies auto and bypass permission presets to the prompt tools map", async () => {
    const bypass = makeService()
    const bypassSession = await Effect.runPromise(bypass.service.newSession({ cwd: "/workspace", mcpServers: [] }))
    await Effect.runPromise(
      bypass.service.setSessionConfigOption({
        sessionId: bypassSession.sessionId,
        configId: "permission",
        value: "bypass",
      }),
    )
    await Effect.runPromise(
      bypass.service.prompt({ sessionId: bypassSession.sessionId, prompt: [{ type: "text", text: "hello" }] }),
    )
    expect(bypass.prompts[0] as Record<string, unknown>).toMatchObject({ tools: { "*": true } })

    const auto = makeService()
    const autoSession = await Effect.runPromise(auto.service.newSession({ cwd: "/workspace", mcpServers: [] }))
    await Effect.runPromise(
      auto.service.setSessionConfigOption({ sessionId: autoSession.sessionId, configId: "permission", value: "auto" }),
    )
    await Effect.runPromise(
      auto.service.prompt({ sessionId: autoSession.sessionId, prompt: [{ type: "text", text: "hello" }] }),
    )
    expect(auto.prompts[0] as Record<string, unknown>).toMatchObject({ tools: { edit: true } })
  })

  it("switching back to default sends an empty tools map that clears a persisted preset", async () => {
    // Reset-on-default: the preset rides every prompt, so switching a chat from
    // bypass back to default must send an EMPTY map (not omit `tools`). The engine
    // treats a present-but-empty map as an authoritative clear back to ask; omitting
    // it (the old behaviour) left the persisted bypass ruleset stuck in place.
    const { service, prompts } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "permission", value: "bypass" }),
    )
    await Effect.runPromise(service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "one" }] }))
    expect(prompts[0] as Record<string, unknown>).toMatchObject({ tools: { "*": true } })

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "permission", value: "default" }),
    )
    await Effect.runPromise(service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "two" }] }))
    expect(prompts[1] as object).toHaveProperty("tools")
    expect((prompts[1] as { tools: unknown }).tools).toEqual({})
  })

  // The preset is session STATE, not a rider on the next user prompt. It has to
  // land on the ENGINE's session row the moment it is set: a press mid-turn, an
  // auto-continue turn and a slash command all carry no `tools` map, so a preset
  // that waits for the next ordinary prompt is a preset the user pressed and did
  // not get. Same convention `subagentModel` and `visionProfile` already follow.
  it("writes the bypass preset onto the engine session row with no prompt in between", async () => {
    const { service, titleUpdates, prompts } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "permission", value: "bypass" }),
    )

    expect(prompts).toEqual([])
    expect(titleUpdates.at(-1)).toMatchObject({
      sessionID: session.sessionId,
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
  })

  it("writes an EMPTY ruleset on the row when the user downgrades back to default", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "permission", value: "bypass" }),
    )
    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "permission", value: "default" }),
    )

    // An explicit downgrade still has to be able to CLEAR the grant, or "bypass"
    // becomes a one-way door on a chat the user cannot take back.
    expect(titleUpdates.at(-1)).toMatchObject({ sessionID: session.sessionId, permission: [] })
  })

  it("resumes a session on the preset stored on its row, not on default", async () => {
    // Without this the resumed chat believes it is on `default`, and its next
    // prompt sends `{}` — which prompt.ts treats as an authoritative clear and
    // uses to drop the bypass the row was still carrying.
    const { service, prompts } = makeService([], {
      sessionRow: { id: "ses_resume", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
    })

    await Effect.runPromise(service.resumeSession({ cwd: "/workspace", sessionId: "ses_resume", mcpServers: [] }))
    await Effect.runPromise(service.prompt({ sessionId: "ses_resume", prompt: [{ type: "text", text: "hello" }] }))

    expect((prompts[0] as { tools: unknown }).tools).toEqual({ "*": true })
  })

  it("loads a session on the preset stored on its row, not on default", async () => {
    const { service, prompts } = makeService([], {
      sessionRow: { id: "ses_loaded", permission: [{ permission: "edit", pattern: "*", action: "allow" }] },
    })

    await Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }))
    await Effect.runPromise(service.prompt({ sessionId: "ses_loaded", prompt: [{ type: "text", text: "hello" }] }))

    expect((prompts[0] as { tools: unknown }).tools).toEqual({ edit: true })
  })

  // The read-back half. The preset now survives on the row, so a client that
  // connects, loads or resumes has to be TOLD which one is live - otherwise the
  // composer seeds itself from its own memory and can show "Default" over a
  // session the engine is genuinely bypassing. The value vocabulary is exactly
  // what setConfigOption('permission', ...) accepts, so a client round-trips it
  // verbatim.
  it("advertises the live preset as a config option on a new session", async () => {
    const { service } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    expect(select(created, "permission")?.currentValue).toBe("default")
    expect(flattenSelectOptions(select(created, "permission")).map((option) => option.value)).toEqual([
      "default",
      "auto",
      "bypass",
    ])
  })

  it("advertises the preset stored on the row after a resume and a load", async () => {
    const resumed = makeService([], {
      sessionRow: { id: "ses_resume", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
    })
    const resumeResult = await Effect.runPromise(
      resumed.service.resumeSession({ cwd: "/workspace", sessionId: "ses_resume", mcpServers: [] }),
    )
    expect(select(resumeResult, "permission")?.currentValue).toBe("bypass")

    const loaded = makeService([], {
      sessionRow: { id: "ses_loaded", permission: [{ permission: "edit", pattern: "*", action: "allow" }] },
    })
    const loadResult = await Effect.runPromise(
      loaded.service.loadSession({ cwd: "/workspace", sessionId: "ses_loaded", mcpServers: [] }),
    )
    expect(select(loadResult, "permission")?.currentValue).toBe("auto")
  })

  it("reports the preset back on every config change, including a downgrade", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    const raised = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "permission", value: "bypass" }),
    )
    expect(select(raised, "permission")?.currentValue).toBe("bypass")

    // An unrelated option must carry the preset too, or a client that refreshes
    // its config off a model switch would blank the approve control.
    const unrelated = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "effort", value: "high" }),
    )
    expect(select(unrelated, "permission")?.currentValue).toBe("bypass")

    const lowered = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "permission", value: "default" }),
    )
    expect(select(lowered, "permission")?.currentValue).toBe("default")
  })

  it("rejects an unknown permission preset value", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const result = await Effect.runPromiseExit(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "permission", value: "bogus" }),
    )
    expect(result._tag).toBe("Failure")
  })

  it("forwards revert and title config options to the engine", async () => {
    const { service, reverts, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "revert", value: "msg_42" }),
    )
    expect(reverts[0]).toMatchObject({ sessionID: session.sessionId, messageID: "msg_42", directory: "/workspace" })

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "title", value: "Renamed chat" }),
    )
    expect(titleUpdates[0]).toMatchObject({
      sessionID: session.sessionId,
      title: "Renamed chat",
      directory: "/workspace",
    })
  })

  it("threads per-session temperature/top_p through the prompt and clamps and clears them", async () => {
    // The temperature/topP config options ride the string channel (ACP has no
    // numeric option). A value is parsed + clamped (temp 0..2, top_p 0..1) and
    // carried on every subsequent prompt via current.temperature/topP; ""/"auto"
    // clears the override so the prompt omits it (provider/agent default).
    const { service, prompts } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    // "5" clamps to the max temperature of 2; top_p 0.3 passes through.
    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "temperature", value: "5" }),
    )
    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "topP", value: "0.3" }),
    )
    await Effect.runPromise(service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "one" }] }))
    expect(prompts[0] as Record<string, unknown>).toMatchObject({ temperature: 2, topP: 0.3 })

    // "auto" clears temperature; top_p override remains.
    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "temperature", value: "auto" }),
    )
    await Effect.runPromise(service.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "two" }] }))
    expect(prompts[1] as object).not.toHaveProperty("temperature")
    expect(prompts[1] as Record<string, unknown>).toMatchObject({ topP: 0.3 })
  })

  it("rejects a non-numeric per-session temperature value", async () => {
    const { service } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const result = await Effect.runPromiseExit(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "temperature", value: "hot" }),
    )
    expect(result._tag).toBe("Failure")
  })

  // Per-chat auto-compaction TRIGGER override (t-kgsdsw). Same house pattern as
  // subagentModel above: it rides the session row's metadata, because that is
  // what the overflow check reads (see session/compaction.test.ts), not a
  // display-only ACP field.
  it("persists a percentage compaction threshold on the session row", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "compactionThreshold", value: "60%" }),
    )

    expect(titleUpdates.at(-1)).toMatchObject({
      sessionID: session.sessionId,
      metadata: { compactionThreshold: { kind: "percent", value: 0.6 } },
    })
  })

  it("persists an absolute token compaction threshold on the session row", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "compactionThreshold",
        value: "150000",
      }),
    )

    expect(titleUpdates.at(-1)).toMatchObject({
      sessionID: session.sessionId,
      metadata: { compactionThreshold: { kind: "tokens", value: 150000 } },
    })
  })

  it("clears the compaction threshold, dropping the key rather than blanking it", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "compactionThreshold", value: "60%" }),
    )
    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "compactionThreshold", value: "auto" }),
    )

    expect((titleUpdates.at(-1) as { metadata: Record<string, unknown> }).metadata).toEqual({})
  })

  // Per-chat VISION PROFILE (t-kgtr6c). Same house pattern again: the value has
  // to reach the session ROW, because the prompt loop — not the ACP layer — is
  // what reads it when it decides whether to arm `vision_request`.
  it("persists the vision profile slug on the session row", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "visionProfile", value: "vision-eye" }),
    )

    expect(titleUpdates.at(-1)).toMatchObject({
      sessionID: session.sessionId,
      metadata: { visionProfile: "vision-eye" },
    })
  })

  it("clears the vision profile, dropping the key rather than blanking it", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))

    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "visionProfile", value: "vision-eye" }),
    )
    await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "visionProfile", value: "" }),
    )

    // A blank slug left on the row would name an agent called "", and the tool
    // would refuse every turn with a message about a profile nobody chose.
    expect((titleUpdates.at(-1) as { metadata: Record<string, unknown> }).metadata).toEqual({})
  })

  it("refuses a slug that could not be a def filename, and writes nothing", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const before = titleUpdates.length

    const traversal = await Effect.runPromiseExit(
      service.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "visionProfile",
        value: "../../etc/passwd",
      }),
    )
    const spaced = await Effect.runPromiseExit(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "visionProfile", value: "Vision Eye" }),
    )

    expect(Exit.isFailure(traversal)).toBe(true)
    expect(Exit.isFailure(spaced)).toBe(true)
    expect(titleUpdates.length).toBe(before)
  })

  it("rejects an out-of-range percentage and a non-numeric compaction threshold", async () => {
    const { service, titleUpdates } = makeService()
    const session = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const before = titleUpdates.length

    const overPct = await Effect.runPromiseExit(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "compactionThreshold", value: "150%" }),
    )
    const notANumber = await Effect.runPromiseExit(
      service.setSessionConfigOption({ sessionId: session.sessionId, configId: "compactionThreshold", value: "soon" }),
    )

    expect(Exit.isFailure(overPct)).toBe(true)
    expect(Exit.isFailure(notANumber)).toBe(true)
    // ...and nothing was written: a half-applied override is worse than none.
    expect(titleUpdates.length).toBe(before)
  })
})

function assistantInfo(
  tokens: UsageService.AssistantTokenCost["tokens"],
  error?: AssistantMessage["error"],
): UsageService.AssistantMessage & Pick<AssistantMessage, "error"> {
  return {
    role: "assistant",
    providerID: "test",
    modelID: "test-model",
    cost: 0,
    tokens,
    ...(error ? { error } : {}),
  }
}

function categories(result: NewSessionResponse | LoadSessionResponse) {
  return result.configOptions?.map((option) => option.category) ?? []
}

function select(
  result:
    | SetSessionConfigOptionResponse
    | ResumeSessionResponse
    | NewSessionResponse
    | ForkSessionResponse
    | LoadSessionResponse,
  id: string,
) {
  return result.configOptions?.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.id === id && option.type === "select",
  )
}

function flattenSelectOptions(option: Extract<SessionConfigOption, { type: "select" }> | undefined) {
  return option?.options.flatMap((item): SessionConfigSelectOption[] => ("value" in item ? [item] : item.options)) ?? []
}

import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { FlockRouting } from "@/flock/routing"
import { Provider } from "@/provider/provider"
import { Ripgrep } from "@origami/core/ripgrep"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { TaskStopTool } from "../../src/tool/task_stop"
import {
  enqueueResult,
  queuedResults,
  TASK_TOKENS_KEY,
  taskResults,
} from "@/session/task-result"
import { RunStats } from "@/acp/run-stats"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      // The task tool resolves Flock routes and looks routed bindings up in the
      // provider registry, so both services must be in the tool's context.
      FlockRouting.node,
      // The task tool reads how long a child has been parked on an unanswered
      // ask, so the real permission service has to be in the tool's context.
      Permission.node,
      Provider.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))
// t-d935qk. A 250 ms ceiling standing in for the four-hour one. Nothing but
// `subagentMaxDurationMs` can set a task job's ceiling, so a child that is
// stopped at 250 ms is proof the flag was read here AND applied by the real
// registry - and it makes the stop sentence assertable in a live-clock test.
const capped = testEffect(layer({ experimentalBackgroundSubagents: true, subagentMaxDurationMs: 250 }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    busy: () => Effect.succeed(false),
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      // A REAL resumable child: this parent's own, running the agent the call
      // asks for. Every other shape is refused (see the three tests below), so
      // the one legitimate shape has to be spelled out here.
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child", agent: "general" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute surfaces a subagent turn error instead of a masked empty success", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      // A child whose turn errored (context overflow) - the error rides on the
      // message, the last text part is empty. Old behaviour: job reports
      // "completed" with an empty <task_result> and the parent silently absorbs it.
      const erroredOps: TaskPromptOps = {
        cancel: () => Effect.void,
        busy: () => Effect.succeed(false),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.sync(() => {
            const base = reply(input, "")
            return {
              info: {
                ...base.info,
                error: { name: "UnknownError", data: { message: "Context size has been exceeded." } },
              },
              parts: [],
            } as SessionV1.WithParts
          }),
      }

      const exit = yield* def
        .execute(
          {
            description: "digest the extension",
            prompt: "read the whole corpus",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: erroredOps, bypassAgentCheck: true },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      // Red without the fix: the tool used to succeed with a state="completed"
      // <task_result> and an empty body. The fix must propagate the failure with
      // the child's reason so the parent can retry/escalate.
      expect(Exit.isSuccess(exit)).toBe(false)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Context size has been exceeded")
      }
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        busy: () => Effect.succeed(false),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  // A supplied task_id is a CLAIM: "continue the agent that has already read
  // the file". The old code answered a claim it could not honour by quietly
  // launching a FRESH agent, so the model went on believing it was talking to
  // the one that knew things - and paid to re-derive all of it. A claim that
  // cannot be honoured now fails the call, and nothing is spawned or prompted.
  it.instance("execute refuses a task_id that no longer exists", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      const promptOps = stubOps({ text: "created", onPrompt: () => (prompts += 1) })

      const call = (task_id: string) =>
        def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              task_id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

      const missing = yield* call("ses_missing")
      expect(Exit.isFailure(missing)).toBe(true)
      if (Exit.isFailure(missing)) {
        expect(Cause.pretty(missing.cause)).toContain("ses_missing")
        expect(Cause.pretty(missing.cause)).toContain("no longer exists")
      }

      // ...and an id the model invented out of nothing is the same refusal,
      // not a crash on the way into `SessionID.make`.
      expect(Exit.isFailure(yield* call("not-a-session-id"))).toBe(true)

      expect(prompts).toBe(0)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("execute refuses a task_id that is not this session's own child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const mine = yield* seed("Mine")
      const theirs = yield* seed("Theirs")
      const stranger = yield* sessions.create({ parentID: theirs.chat.id, title: "their child", agent: "general" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      const promptOps = stubOps({ onPrompt: () => (prompts += 1) })

      const call = (task_id: string) =>
        def
          .execute(
            { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general", task_id },
            {
              sessionID: mine.chat.id,
              messageID: mine.assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

      // Another parent's child: prompting it would put this session's words
      // into a conversation the caller cannot see and never started.
      const foreign = yield* call(stranger.id)
      expect(Exit.isFailure(foreign)).toBe(true)
      if (Exit.isFailure(foreign)) expect(Cause.pretty(foreign.cause)).toContain(stranger.id)

      // A ROOT session - here the caller's own chat - is not a task either.
      expect(Exit.isFailure(yield* call(mine.chat.id))).toBe(true)

      expect(prompts).toBe(0)
      expect(yield* sessions.children(mine.chat.id)).toHaveLength(0)
      expect(yield* sessions.children(theirs.chat.id)).toHaveLength(1)
    }),
  )

  it.instance("execute refuses a task_id whose agent is not the one asked for", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child", agent: "reviewer" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let prompts = 0
      const promptOps = stubOps({ onPrompt: () => (prompts += 1) })

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      // Both agents named: the model has to be able to tell whether it picked
      // the wrong id or the wrong subagent_type.
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("reviewer")
        expect(Cause.pretty(exit.cause)).toContain("general")
      }
      expect(prompts).toBe(0)
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      // t-h8s3xg: the ASK now runs first, so a child whose ruleset denies the
      // tool reads the denial instead of a config key it cannot raise. This
      // one is allowed, so the ask passes and the cap stops it - with words
      // that say what to do rather than which key to edit.
      expect(asked).toBe(true)
      if (Exit.isFailure(exit)) {
        const pretty = Cause.pretty(exit.cause)
        expect(pretty).toContain("already a sub-agent and nested sub-agents are off (subagent_depth 1)")
        expect(pretty).toContain("Finish the work yourself or report back to the parent")
        expect(pretty).not.toContain("Subagent depth limit reached")
      }
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  // t-h8s3xg. The order the two checks run in IS the behaviour: a denied child
  // must read its denial. Before the swap the depth check answered first and
  // every denied child - the ordinary case, since `subagent-permissions.ts`
  // denies `task` to any agent whose definition does not name it - was told to
  // raise `subagent_depth`, which would not have helped it at all.
  it.instance("a child whose ruleset DENIES task reads the denial, not the depth cap", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            // What `Permission.ask` does for a `deny` rule, as `session/tools.ts`
            // hands it to a tool: the refusal is raised, not returned (that
            // seam pipes `permission.ask` through `Effect.orDie`).
            ask: () => Effect.die(new Error("The user denied permission to use the task tool")),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const pretty = Cause.pretty(exit.cause)
        expect(pretty).toContain("denied permission")
        expect(pretty).not.toContain("subagent_depth")
      }
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          // The peer tools are closed on every task spawn; only `task` is open
          // here, because this agent's own definition names it.
          {
            permission: "send_message",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "list_agents",
            pattern: "*",
            action: "deny",
          },
          // t-fijeld: side quests are the main agent's list to fill.
          {
            permission: "side_quest",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        busy: () => Effect.succeed(false),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("runs in the background when the caller does not ask for anything", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      // No `background` field at all. The child never finishes, so a foreground
      // run would hang here instead of returning.
      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
    }),
  )

  background.instance("keeps the task in the foreground when the caller passes background:false", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: false,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "foreground done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBeUndefined()
      expect(result.output).toContain(`state="completed"`)
      expect(result.output).toContain("foreground done")
      // A settled task is still resumable, and the id is in front of the model
      // exactly here. Say so once, or the next step launches a replacement that
      // has read none of what this one read.
      expect(result.output).toContain(`Resume this task with task_id=${result.metadata.sessionId}`)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  background.instance("serializes concurrent background result injections onto the parent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      // Track how many parent injections are "inside" their turn at once.
      // Serialized => never more than one; the old racy fork => two.
      let active = 0
      let maxActive = 0
      let injected = 0
      const bothInjected = yield* Deferred.make<void>()

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                active += 1
                if (active > maxActive) maxActive = active
                // Hold the turn open so a second, unserialized inject would
                // overlap here (real clock under `.instance`).
                yield* Effect.sleep("60 millis")
                active -= 1
                injected += 1
                if (injected === 2) yield* Deferred.succeed(bothInjected, undefined)
                return reply(input, "ack")
              })
            : Effect.succeed(reply(input, "child done")),
      }

      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      // Two background sub-agents from the same parent; both children finish
      // immediately, so their result injections race onto the parent session.
      const a = yield* def.execute(
        { description: "task A", prompt: "build A", subagent_type: "general", background: true },
        context,
      )
      const b = yield* def.execute(
        { description: "task B", prompt: "build B", subagent_type: "general", background: true },
        context,
      )

      // Both children complete (guarantees both injections were triggered)...
      yield* jobs.wait({ id: a.metadata.sessionId, timeout: 1_000 })
      yield* jobs.wait({ id: b.metadata.sessionId, timeout: 1_000 })
      // ...then wait for both injections to run to completion.
      yield* awaitWithTimeout(Deferred.await(bothInjected), "both injections did not complete", "3 seconds")

      expect(injected).toBe(2)
      expect(maxActive).toBe(1)
    }),
  )

  background.instance("siblings that finish during an injected turn land in ONE later turn, not one each", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      // Each child blocks on its own gate so completion order is ours to drive.
      const gates: Record<string, Deferred.Deferred<void>> = {
        A: yield* Deferred.make<void>(),
        B: yield* Deferred.make<void>(),
        C: yield* Deferred.make<void>(),
      }
      const firstTurnStarted = yield* Deferred.make<void>()
      const releaseFirstTurn = yield* Deferred.make<void>()
      const allResultsSeen = yield* Deferred.make<void>()
      const turns: string[] = []

      const promptText = (input: SessionPrompt.PromptInput) =>
        (input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n")

      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        busy: () => Effect.succeed(false),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                const text = promptText(input)
                turns.push(text)
                // Hold turn 1 open so B and C finish WHILE the parent is mid-turn -
                // the exact window that used to spawn a separate turn per sibling.
                if (turns.length === 1) {
                  yield* Deferred.succeed(firstTurnStarted, undefined)
                  yield* Deferred.await(releaseFirstTurn)
                }
                if (turns.join("\n").split("<task id=").length - 1 >= 3) {
                  yield* Deferred.succeed(allResultsSeen, undefined)
                }
                return reply(input, "ack")
              })
            : Effect.gen(function* () {
                const label = promptText(input).replace("build ", "").trim()
                yield* Deferred.await(gates[label] ?? gates.A!)
                return reply(input, `${label} done`)
              }),
      }

      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const launched: Record<string, string> = {}
      for (const label of ["A", "B", "C"]) {
        const result = yield* def.execute(
          { description: `task ${label}`, prompt: `build ${label}`, subagent_type: "general", background: true },
          context,
        )
        launched[label] = result.metadata.sessionId
      }

      // A finishes alone -> it opens turn 1 and the parent sits inside it.
      yield* Deferred.succeed(gates.A!, undefined)
      yield* awaitWithTimeout(Deferred.await(firstTurnStarted), "the first injected turn never started", "3 seconds")

      // B and C finish while turn 1 is still open.
      yield* Deferred.succeed(gates.B!, undefined)
      yield* Deferred.succeed(gates.C!, undefined)
      yield* jobs.wait({ id: launched.B!, timeout: 1_000 })
      yield* jobs.wait({ id: launched.C!, timeout: 1_000 })
      // Their notify fibers are unblocked; give them room to enqueue (the enqueue
      // itself never yields, so this only has to cover fiber scheduling).
      yield* Effect.sleep("100 millis")

      yield* Deferred.succeed(releaseFirstTurn, undefined)
      yield* awaitWithTimeout(Deferred.await(allResultsSeen), "not every task result was injected", "3 seconds")

      // The requirement: every result is delivered, in FEWER turns than there were
      // children. Per-child injection gave three turns and three "all done"
      // summaries; batching gives A alone, then B+C together.
      expect(turns.length).toBeLessThan(3)
      expect(turns.length).toBe(2)
      for (const id of Object.values(launched)) {
        expect(turns.join("\n")).toContain(`<task id="${id}"`)
      }
      // ...and the batched turn really is one turn carrying both siblings.
      expect(turns[1]!.split("<task id=").length - 1).toBe(2)
    }),
  )

  background.instance("a failed injected turn does not strand the sibling results queued behind it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      // Batching means ONE drainer serves every sibling of a parent - so a turn
      // that blows up must not take the queue down with it. (ops.prompt turns any
      // failure into a defect, so this is the shape production raises.)
      const gates: Record<string, Deferred.Deferred<void>> = {
        A: yield* Deferred.make<void>(),
        B: yield* Deferred.make<void>(),
        C: yield* Deferred.make<void>(),
      }
      const firstTurnStarted = yield* Deferred.make<void>()
      const releaseFirstTurn = yield* Deferred.make<void>()
      const survivorsInjected = yield* Deferred.make<string>()
      const injects: SessionPrompt.PromptInput[] = []
      let turns = 0

      const promptText = (input: SessionPrompt.PromptInput) =>
        (input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n")

      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        busy: () => Effect.succeed(false),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                turns += 1
                injects.push(input)
                if (turns === 1) {
                  yield* Deferred.succeed(firstTurnStarted, undefined)
                  yield* Deferred.await(releaseFirstTurn)
                  throw new Error("the parent turn blew up")
                }
                // The FIRST batch is rewritten without a turn before the queue
                // moves on, so the survivors are whatever lands after that.
                if (input.noReply !== true) yield* Deferred.succeed(survivorsInjected, promptText(input))
                return reply(input, "ack")
              })
            : Effect.gen(function* () {
                const label = promptText(input).replace("build ", "").trim()
                yield* Deferred.await(gates[label] ?? gates.A!)
                return reply(input, `${label} done`)
              }),
      }

      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const launched: Record<string, string> = {}
      for (const label of ["A", "B", "C"]) {
        const result = yield* def.execute(
          { description: `task ${label}`, prompt: `build ${label}`, subagent_type: "general", background: true },
          context,
        )
        launched[label] = result.metadata.sessionId
      }

      yield* Deferred.succeed(gates.A!, undefined)
      yield* awaitWithTimeout(Deferred.await(firstTurnStarted), "the first injected turn never started", "3 seconds")
      yield* Deferred.succeed(gates.B!, undefined)
      yield* Deferred.succeed(gates.C!, undefined)
      yield* jobs.wait({ id: launched.B!, timeout: 1_000 })
      yield* jobs.wait({ id: launched.C!, timeout: 1_000 })
      yield* Effect.sleep("100 millis")
      yield* Deferred.succeed(releaseFirstTurn, undefined)

      const text = yield* awaitWithTimeout(
        Deferred.await(survivorsInjected),
        "the queued sibling results died with the failed turn",
        "3 seconds",
      )
      expect(text).toContain(`<task id="${launched.B}"`)
      expect(text).toContain(`<task id="${launched.C}"`)

      // ...and the result the failed turn was CARRYING is not lost with it. It
      // used to be spliced off the queue before the write, so a blown-up turn
      // took A's result to the grave: no text for the model, no stamp for the
      // client, and a drawer row for A that never retired.
      const rewritten = injects.find((input) => input.noReply === true)
      expect(rewritten, "the failed batch was never rewritten").toBeDefined()
      expect(promptText(rewritten!)).toContain(`<task id="${launched.A}"`)
      const stamp = (rewritten!.parts ?? [])[0] as { metadata?: unknown }
      expect(taskResults(stamp.metadata)).toEqual([{ sessionId: launched.A!, state: "completed" }])
    }),
  )

  // The whole failure ladder in one case: the parent will not take a turn AT
  // ALL, so there is nothing to fall back to. Every write is RETRIED a bounded
  // number of times first - a parent mid-cancel or mid-restart is back within
  // the second, and "wait for another sibling" is no plan when this batch is
  // the last one - and only then does the result stay QUEUED for the next
  // sibling to carry in, rather than be dropped to keep the loop tidy.
  background.instance("results survive a parent that refuses every write, and ride out with the next sibling", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()

      const gates: Record<string, Deferred.Deferred<void>> = {
        A: yield* Deferred.make<void>(),
        B: yield* Deferred.make<void>(),
      }
      const delivered = yield* Deferred.make<string>()
      let accepting = false
      let refused = 0

      const promptText = (input: SessionPrompt.PromptInput) =>
        (input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n")

      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        busy: () => Effect.succeed(false),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                if (!accepting) {
                  refused += 1
                  throw new Error("the parent will not take a write")
                }
                yield* Deferred.succeed(delivered, promptText(input))
                return reply(input, "ack")
              })
            : Effect.gen(function* () {
                const label = promptText(input).replace("build ", "").trim()
                yield* Deferred.await(gates[label] ?? gates.A!)
                return reply(input, `${label} done`)
              }),
      }

      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const launched: Record<string, string> = {}
      for (const label of ["A", "B"]) {
        const result = yield* def.execute(
          { description: `task ${label}`, prompt: `build ${label}`, subagent_type: "general", background: true },
          context,
        )
        launched[label] = result.metadata.sessionId
      }

      // A finishes while every write fails - both the turn and the rewrite,
      // three attempts of each. POLL until the count stabilises instead of a
      // fixed sleep: the 200ms-spaced ladder finishes in ~400ms on a quiet
      // box, but a fixed 900ms sleep raced it under load (verifier finding).
      // Stability = two consecutive polls with the same non-zero count and no
      // further growth; the ceiling only bounds a hung ladder.
      yield* Deferred.succeed(gates.A!, undefined)
      yield* jobs.wait({ id: launched.A!, timeout: 1_000 })
      yield* Effect.gen(function* () {
        let last = -1
        for (let i = 0; i < 40; i++) {
          yield* Effect.sleep("250 millis")
          if (refused > 0 && refused === last) return
          last = refused
        }
      })

      // Three attempts, each spending both writes on a parent that says no.
      expect(refused).toBe(6)

      // B finishes into a parent that has come back. A's result is still there.
      accepting = true
      yield* Deferred.succeed(gates.B!, undefined)
      yield* jobs.wait({ id: launched.B!, timeout: 1_000 })

      const text = yield* awaitWithTimeout(
        Deferred.await(delivered),
        "nothing was ever delivered to the parent",
        "3 seconds",
      )
      expect(text).toContain(`<task id="${launched.A}"`)
      expect(text).toContain(`<task id="${launched.B}"`)
    }),
  )

  // A second fan-out on the SAME parent, after the first drained. The per-parent
  // inject lock is dropped when the queue empties (it was one semaphore per
  // parent session kept for the life of the process), so this is the case that
  // proves dropping it costs nothing: the next batch has to make its own.
  background.instance("a parent that already drained once still serializes its next batch", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const injected: string[] = []

      const promptText = (input: SessionPrompt.PromptInput) =>
        (input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n")

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.sync(() => {
                injected.push(promptText(input))
                return reply(input, "ack")
              })
            : Effect.succeed(reply(input, "child done")),
      }

      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const ids: string[] = []
      for (const label of ["first", "second"]) {
        const result = yield* def.execute(
          { description: `task ${label}`, prompt: `build ${label}`, subagent_type: "general", background: true },
          context,
        )
        ids.push(result.metadata.sessionId)
        yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
        yield* Effect.sleep("50 millis")
      }

      expect(injected.length).toBe(2)
      expect(injected[0]).toContain(`<task id="${ids[0]}"`)
      expect(injected[1]).toContain(`<task id="${ids[1]}"`)
    }),
  )

  // A write into a BUSY parent does not start a turn of its own - it JOINS the
  // run already in flight (session/run-state.ts). If that run is on its LAST
  // loop iteration it has already read its message window, so the result is
  // persisted, acknowledged, and never spoken about: it waits for the next
  // human message. The turn ending is the moment to check, and to write again.
  background.instance("a result that lands after the parent's last read is re-delivered when the turn ends", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()

      let parentBusy = true
      const injects: string[] = []
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()

      const promptText = (input: SessionPrompt.PromptInput) =>
        (input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n")

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        busy: () => Effect.sync(() => parentBusy),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                injects.push(promptText(input))
                // No assistant message follows it: the joined turn never took
                // another step, which is exactly what "never read" looks like.
                yield* Deferred.succeed(injects.length === 1 ? first : second, undefined)
                return reply(input, "ack")
              })
            : Effect.succeed(reply(input, "child done")),
      }

      const started = yield* def.execute(
        { description: "task A", prompt: "build A", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      yield* awaitWithTimeout(Deferred.await(first), "the result was never written to the parent", "3 seconds")

      // The parent's turn ends without ever having read it.
      parentBusy = false

      yield* awaitWithTimeout(Deferred.await(second), "the stranded result was never re-delivered", "5 seconds")
      expect(injects).toHaveLength(2)
      expect(injects[1]).toContain(`<task id="${started.metadata.sessionId}"`)
    }),
  )

  // The other half of the same requirement: a result the turn DID read must not
  // be shown to the model a second time. An assistant message newer than the
  // injected one is the proof a step ran on it (session/prompt.ts writes one per
  // step), so this parent answers and nothing is re-delivered.
  background.instance("a result the parent's turn actually read is not re-delivered", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()

      let parentBusy = true
      const injects: string[] = []
      const answered = yield* Deferred.make<void>()

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        busy: () => Effect.sync(() => parentBusy),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                injects.push((input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n"))
                yield* sessions.updateMessage({
                  ...assistant,
                  id: MessageID.ascending(),
                  parentID: input.messageID ?? MessageID.ascending(),
                  sessionID: chat.id,
                })
                parentBusy = false
                yield* Deferred.succeed(answered, undefined)
                return reply(input, "ack")
              })
            : Effect.succeed(reply(input, "child done")),
      }

      const started = yield* def.execute(
        { description: "task A", prompt: "build A", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      yield* awaitWithTimeout(Deferred.await(answered), "the result was never written to the parent", "3 seconds")
      yield* Effect.sleep("600 millis")

      expect(injects).toHaveLength(1)
    }),
  )

  // Re-delivery is ONE-SHOT. `busy` alternates here so every write lands in a
  // parent that looks busy and every turn then ends unread - the shape that
  // would re-arm forever. A result that has already been re-delivered must
  // never arm again, or the parent drowns in synthetic turns.
  background.instance("a re-delivered result is never re-delivered a second time", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()

      let busyReads = 0
      const injects: string[] = []
      const redelivered = yield* Deferred.make<void>()

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        // Busy for every pre-write check, idle for every poll after it.
        busy: () => Effect.sync(() => busyReads++ % 2 === 0),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                injects.push((input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n"))
                if (injects.length === 2) yield* Deferred.succeed(redelivered, undefined)
                return reply(input, "ack")
              })
            : Effect.succeed(reply(input, "child done")),
      }

      const started = yield* def.execute(
        { description: "task A", prompt: "build A", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      yield* awaitWithTimeout(Deferred.await(redelivered), "the stranded result was never re-delivered", "5 seconds")
      yield* Effect.sleep("800 millis")

      expect(injects).toHaveLength(2)
    }),
  )

  // The launch briefing the model reads. It used to end the turn ("...and end
  // your response"), which turned four independent launches into four turns,
  // and it never mentioned the resume path at the one moment the id is in
  // front of the model.
  background.instance("the background launch briefing keeps working and teaches task_id resume", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()

      const result = yield* def.execute(
        { description: "task A", prompt: "build A", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps() },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).not.toContain("end your response")
      expect(result.output).toContain("do not poll it")
      expect(result.output).toContain("task_id")
      expect(result.output).toContain("RESUMES")
      // ...and the settled-task resume line stays OFF a running task: this
      // briefing already teaches resume, and a second copy of it here would
      // read as "it is finished".
      expect(result.output).not.toContain("Resume this task with task_id=")
    }),
  )

  // A VISION PROFILE def pins the one model that can see. The per-chat
  // sub-agent override outranks every other tier for a reason - a human set it
  // for this chat - but applying it here sends an image to a model that cannot
  // look at it, and what comes back is a confident description of a picture
  // nobody saw (tool/vision-request.ts refuses outright for the same reason).
  it.instance(
    "a vision profile keeps its pinned model when the chat has a sub-agent override",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        yield* sessions.setSubagentModel({
          sessionID: chat.id,
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("override-model") },
        })
        const def = yield* (yield* TaskTool).init()
        let seen: SessionPrompt.PromptInput | undefined

        const result = yield* def.execute(
          { description: "look at it", prompt: "describe the image", subagent_type: "luma" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(String(seen?.model?.modelID)).toBe("vision-model")
        expect(String(result.metadata.model.modelID)).toBe("vision-model")
      }),
    {
      config: {
        agent: {
          luma: {
            description: "Vision profile",
            mode: "subagent",
            model: "test/vision-model",
            options: { "vision-profile": true },
          },
        },
      },
    },
  )

  // The exemption above has to stay NARROW: an ordinary sub-agent still runs on
  // whatever this chat pinned for its sub-agents.
  it.instance(
    "an ordinary subagent still takes the chat's sub-agent override",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        yield* sessions.setSubagentModel({
          sessionID: chat.id,
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("override-model") },
        })
        const def = yield* (yield* TaskTool).init()
        let seen: SessionPrompt.PromptInput | undefined

        yield* def.execute(
          { description: "look at it", prompt: "read the file", subagent_type: "plain" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ onPrompt: (input) => (seen = input) }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(String(seen?.model?.modelID)).toBe("override-model")
      }),
    {
      config: {
        agent: {
          plain: { description: "Plain subagent", mode: "subagent", model: "test/agent-model" },
        },
      },
    },
  )

  background.instance("an injected result states how many siblings are still running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      // Both children are held until BOTH are launched: a real fan-out launches
      // every sub-agent in one turn and they take seconds to run, so the sibling
      // is always already registered when the first result lands.
      const holdFirst = yield* Deferred.make<void>()
      const holdSecond = yield* Deferred.make<void>()
      const firstInjected = yield* Deferred.make<string>()

      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        busy: () => Effect.succeed(false),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                const text = (input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n")
                yield* Deferred.succeed(firstInjected, text)
                return reply(input, "ack")
              })
            : Effect.gen(function* () {
                const text = (input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n")
                yield* Deferred.await(text.includes("build second") ? holdSecond : holdFirst)
                return reply(input, "child done")
              }),
      }

      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const first = yield* def.execute(
        { description: "task first", prompt: "build first", subagent_type: "general", background: true },
        context,
      )
      yield* def.execute(
        { description: "task second", prompt: "build second", subagent_type: "general", background: true },
        context,
      )

      yield* Deferred.succeed(holdFirst, undefined)
      yield* jobs.wait({ id: first.metadata.sessionId, timeout: 1_000 })
      const text = yield* awaitWithTimeout(
        Deferred.await(firstInjected),
        "the first background result was never injected",
        "3 seconds",
      )

      // The result the model receives must say a sibling is STILL RUNNING -
      // without it the model treated every single notification as the end of the
      // batch and announced overall completion N times over.
      expect(text).toContain(`<task id="${first.metadata.sessionId}"`)
      expect(text).toContain("1 background task launched from this session is still running")
      expect(text).toContain("Do not report overall completion")

      yield* Deferred.succeed(holdSecond, undefined)
    }),
  )

  // The injected turn's TEXT is written for the model (an XML-ish <task_result>
  // blob). A client needs the same fact — WHICH child settled, and how — without
  // parsing it, because the launcher's own tool card completed back when the
  // child was spawned and says nothing about how it ended.
  background.instance("stamps the injected result turn with the child that settled", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                yield* Deferred.succeed(injected, input)
                return reply(input, "ack")
              })
            : Effect.succeed(reply(input, "child done")),
      }

      const started = yield* def.execute(
        { description: "task A", prompt: "build A", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      const input = yield* awaitWithTimeout(
        Deferred.await(injected),
        "the background result was never injected",
        "3 seconds",
      )

      const part = (input.parts ?? [])[0] as { text?: string; metadata?: unknown }
      expect(taskResults(part.metadata)).toEqual([
        { sessionId: started.metadata.sessionId, state: "completed" },
      ])
      // ...and the model still reads exactly what it read before the stamp.
      expect(part.text).toContain(`<task id="${started.metadata.sessionId}" state="completed">`)
      expect(part.text).toContain(`Resume this task with task_id=${started.metadata.sessionId}`)
    }),
  )

  // A cancel is a settled outcome too - the notify fiber that lives in the
  // tool's own scope wakes up on `background.cancel`'s `done` resolution just
  // as it does on completed/error, and without an injected result the drawer
  // and the ring never learn the child is gone: they keep it listed as if it
  // were still running.
  background.instance("a cancelled background sub-agent injects an error result, not a silent drop", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const hold = yield* Deferred.make<void>()

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                yield* Deferred.succeed(injected, input)
                return reply(input, "ack")
              })
            : Effect.gen(function* () {
                yield* Deferred.await(hold)
                return reply(input, "child done")
              }),
      }

      const started = yield* def.execute(
        { description: "task A", prompt: "build A", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // Cancel while the child is still running - `hold` never resolves, so
      // the only way the parent hears about this is the cancel path itself.
      yield* jobs.cancel(started.metadata.sessionId)

      const input = yield* awaitWithTimeout(
        Deferred.await(injected),
        "the cancelled background result was never injected",
        "3 seconds",
      )

      const part = (input.parts ?? [])[0] as { text?: string; metadata?: unknown }
      expect(taskResults(part.metadata)).toEqual([{ sessionId: started.metadata.sessionId, state: "error" }])
      expect(part.text).toContain(`<task id="${started.metadata.sessionId}" state="error">`)
      // t-d935qk: the word "cancelled" alone left the model guessing who did
      // it. The sentence now names the actor.
      expect(part.text).toContain("stopped by the parent")
    }),
  )

  background.instance("stopping a background sub-agent via task_stop also injects an error result", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const stopDef = yield* (yield* TaskStopTool).init()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      const hold = yield* Deferred.make<void>()

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                yield* Deferred.succeed(injected, input)
                return reply(input, "ack")
              })
            : Effect.gen(function* () {
                yield* Deferred.await(hold)
                return reply(input, "child done")
              }),
      }

      const started = yield* def.execute(
        { description: "task B", prompt: "build B", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* stopDef.execute(
        { task_id: started.metadata.sessionId },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const input = yield* awaitWithTimeout(
        Deferred.await(injected),
        "the task_stop-cancelled background result was never injected",
        "3 seconds",
      )

      const part = (input.parts ?? [])[0] as { text?: string; metadata?: unknown }
      expect(taskResults(part.metadata)).toEqual([{ sessionId: started.metadata.sessionId, state: "error" }])
      // task_stop IS the parent stopping its own child, so it reads the same
      // as a turn-stop (t-d935qk).
      expect(part.text).toContain("stopped by the parent")
    }),
  )

  background.instance("a parent turn-stop spares a running detached background sub-agent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // A turn-stop (spareDetached) must leave the detached background sub-agent running.
      yield* runState.cancel(chat.id, true)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
    }),
  )

  it.instance("a parent turn-stop cancels foreground descendants but spares detached ones", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const fgChild = yield* sessions.create({ parentID: chat.id, title: "fg child" })
      const fgGrandchild = yield* sessions.create({ parentID: fgChild.id, title: "fg grandchild" })
      const bgChild = yield* sessions.create({ parentID: chat.id, title: "bg child" })

      yield* jobs.start({
        id: fgChild.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: fgChild.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: fgGrandchild.id,
        type: "task",
        metadata: { parentSessionId: fgChild.id, sessionId: fgGrandchild.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: bgChild.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: bgChild.id, background: true },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id, true)

      // Foreground descendants die with the turn (transitive walk); the detached one survives.
      expect((yield* jobs.get(fgChild.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(fgGrandchild.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(bgChild.id))?.status).toBe("running")
    }),
  )

  // t-d935qk. Five tests for one report: a sub-agent that died at thirty
  // minutes mid-investigation, a sub-agent that died while a permission ask sat
  // unanswered, and a card that said only `MessageAbortedError: Aborted`.
  background.instance(
    "a background sub-agent runs under the four-hour ceiling, not the registry's thirty-minute default",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()

        const result = yield* def.execute(
          { description: "review the cache path", prompt: "read it all", subagent_type: "general", background: true },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: { ...stubOps(), prompt: () => Effect.never } satisfies TaskPromptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        // Read off the REAL registry entry, which is the ceiling the watchdog is
        // actually armed with. The registry default below is the bug the owner
        // reported: nothing on this path ever passed a ceiling of its own.
        expect((yield* jobs.get(result.metadata.sessionId))?.metadata?.max_duration_ms).toBe(4 * 60 * 60 * 1_000)
        expect(BackgroundJob.DEFAULT_MAX_DURATION_MS).toBe(30 * 60 * 1_000)
      }),
  )

  capped.instance("a ceiling stop reaches the parent as a named cause and an elapsed time", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const injected = yield* Deferred.make<string>()

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                yield* Deferred.succeed(
                  injected,
                  (input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n"),
                )
                return reply(input, "ack")
              })
            : // The child never comes back: what a wedged sub-agent looks like.
              Effect.never,
      }

      const result = yield* def.execute(
        { description: "review the cache path", prompt: "read it all", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const settled = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 5_000 })
      expect(settled.timedOut).toBe(false)
      expect(settled.info?.metadata?.expired).toBe(true)

      const text = yield* awaitWithTimeout(
        Deferred.await(injected),
        "the expired task result was never injected",
        "5 seconds",
      )
      // The sentence, not `MessageAbortedError: Aborted`: WHO stopped it, at
      // what limit, and after how long. Built from the registry's numbers, so
      // no part of it is read back out of an error string.
      expect(text).toContain("stopped: 250 ms sub-agent time limit reached after ")
      expect(text).toContain(`state="error"`)
      expect(text).not.toContain("MessageAbortedError")
    }),
  )

  capped.instance("a parent stop reaches the parent as a named stop, not a bare abort", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const injected = yield* Deferred.make<string>()

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          input.sessionID === chat.id
            ? Effect.gen(function* () {
                yield* Deferred.succeed(
                  injected,
                  (input.parts ?? []).map((part) => (part as { text?: string }).text ?? "").join("\n"),
                )
                return reply(input, "ack")
              })
            : Effect.never,
      }

      const result = yield* def.execute(
        { description: "review the cache path", prompt: "read it all", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* jobs.cancel(result.metadata.sessionId)
      const text = yield* awaitWithTimeout(
        Deferred.await(injected),
        "the cancelled task result was never injected",
        "5 seconds",
      )
      expect(text).toContain("stopped by the parent")
      expect(text).not.toContain("MessageAbortedError")
    }),
  )

  capped.instance("a child parked on an unanswered permission ask is not stopped by the ceiling", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const permission = yield* Permission.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        // What a child's turn does when it reaches a gated tool: park on the
        // REAL Permission service for its own session until somebody replies.
        // `parentSessionID` is what marks the ask unattended, so this is the
        // sub-agent shape and not a main session's.
        prompt: (input) =>
          permission
            .ask({
              sessionID: input.sessionID,
              parentSessionID: chat.id,
              permission: "bash",
              patterns: ["rm -rf /"],
              metadata: {},
              always: [],
              ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.as(reply(input, "approved")), Effect.orDie),
      }

      const result = yield* def.execute(
        { description: "review the cache path", prompt: "read it all", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // More than twice the ceiling, every millisecond of it waiting on a human.
      // This is the job that must NOT be stopped: stopping it throws away the
      // child's whole context for the crime of the user being slow.
      yield* Effect.sleep("600 millis")
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")

      const request = (yield* permission.list()).find((item) => item.sessionID === result.metadata.sessionId)
      expect(request).toBeDefined()
      yield* permission.reply({ requestID: request!.id, reply: "once" })

      const settled = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 5_000 })
      expect(settled.timedOut).toBe(false)
      expect(settled.info?.status).toBe("completed")
      expect(settled.info?.output).toContain("approved")
    }),
  )

  capped.instance("resuming a task restarts its ceiling instead of counting the time it already spent", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const hold = yield* Deferred.make<void>()

      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: {
          promptOps: {
            ...stubOps(),
            prompt: (input: SessionPrompt.PromptInput) =>
              input.sessionID === chat.id
                ? Effect.succeed(reply(input, "ack"))
                : Deferred.await(hold).pipe(Effect.as(reply(input, "child done"))),
          } satisfies TaskPromptOps,
        },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const first = yield* def.execute(
        { description: "review the cache path", prompt: "read it all", subagent_type: "general", background: true },
        context,
      )

      yield* Effect.sleep("150 millis")
      const resumed = yield* def.execute(
        {
          description: "review the cache path",
          prompt: "and now check the invalidation",
          subagent_type: "general",
          background: true,
          task_id: first.metadata.sessionId,
        },
        context,
      )
      expect(resumed.output).toContain("Background task updated")

      yield* Effect.sleep("200 millis")
      // 350 ms in, past the ceiling this job STARTED with. A resume is the
      // parent deliberately handing the child new work, so its clock restarts.
      expect((yield* jobs.get(first.metadata.sessionId))?.status).toBe("running")

      yield* Deferred.succeed(hold, undefined)
      expect((yield* jobs.wait({ id: first.metadata.sessionId, timeout: 5_000 })).info?.status).toBe("completed")
    }),
  )
  // --- t-dcl8fe: the registry's stops and losses reach the MODEL, not a stack ---

  capped.instance("a FOREGROUND task stopped by the ceiling returns a readable task_error", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      // A wedged child: the ceiling is the only thing that can end this.
      const promptOps: TaskPromptOps = { ...stubOps(), prompt: () => Effect.never }

      const exit = yield* def
        .execute(
          {
            description: "review the cache path",
            prompt: "read it all",
            subagent_type: "general",
            background: false,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, bypassAgentCheck: true },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      // Red before the fix: this branch was `Effect.fail`, and `execute` is
      // `Effect.orDie`, so the parent's window got a DEFECT card with a stack
      // instead of a tool result - for a stop the engine itself decided on.
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.output).toContain('state="error"')
        expect(exit.value.output).toContain("<task_error>")
        expect(exit.value.output).toContain("250 ms sub-agent time limit reached after ")
        expect(exit.value.output).not.toContain('state="completed"')
      }
    }),
  )

  it.instance("a job the registry has LOST fails the task instead of completing it empty", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const real = yield* BackgroundJob.Service
      // The registry as it behaves for a job it no longer holds: `wait` reports
      // no job at all and `waitForPromotion` never answers. Everything else -
      // the tool, the session store, the permission service - is the real
      // thing; only the loss is staged, because a live registry never drops a
      // job on demand.
      const lost: BackgroundJob.Interface = {
        ...real,
        wait: () => Effect.succeed({ timedOut: false }),
        waitForPromotion: () => Effect.never,
      }
      const tool = yield* TaskTool.pipe(Effect.provideService(BackgroundJob.Service, lost))
      const def = yield* tool.init()

      const result = yield* def.execute(
        { description: "review the cache path", prompt: "read it all", subagent_type: "general" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps(), bypassAgentCheck: true },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // Red before the fix: an absent job was rendered as a COMPLETED task with
      // an empty <task_result>, and the parent read "it finished and said
      // nothing" and carried on.
      expect(result.output).toContain('state="error"')
      expect(result.output).toContain("no longer registered")
      expect(result.output).not.toContain('state="completed"')
    }),
  )

  background.instance("a resume whose job had already settled says it STARTED AGAIN", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: stubOps(), bypassAgentCheck: true },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const first = yield* def.execute(
        { description: "review the cache path", prompt: "read it all", subagent_type: "general", background: true },
        context,
      )
      expect(first.output).toContain("Background task started")
      expect(first.output).not.toContain("STARTED AGAIN")
      // The child answered and its job settled, so there is nothing left to
      // extend: the resume below can only start a new one on the same session.
      expect((yield* jobs.wait({ id: first.metadata.sessionId, timeout: 5_000 })).info?.status).toBe("completed")

      const resumed = yield* def.execute(
        {
          description: "review the cache path",
          prompt: "and now check the invalidation",
          subagent_type: "general",
          background: true,
          task_id: first.metadata.sessionId,
        },
        context,
      )

      // Red before the fix: word for word the launch briefing, so the parent
      // believed the agent it asked to CARRY ON was still mid-thought. It was
      // not - and what it keeps (the context) is worth saying too.
      expect(resumed.output).toContain("Background task started again")
      expect(resumed.output).toContain("STARTED AGAIN")
      expect(resumed.metadata.sessionId).toBe(first.metadata.sessionId)
    }),
  )

  // --- t-dcl8fe: the child's spend, on the parent's tool call ---

  it.instance("carries the child's token totals as origami_task_tokens, posted once when the child settles", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const writes: Array<Record<string, unknown>> = []

      // A child turn that BILLS: one assistant message with two step-finish
      // parts, which is what a two-step tool loop leaves behind.
      const steps = [
        { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 }, cost: 0.25 },
        { input: 200, output: 40, reasoning: 1, cache: { read: 9, write: 0 }, cost: 0.5 },
      ]
      const billingOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.gen(function* () {
            const message = reply(input, "done")
            yield* sessions.updateMessage(message.info)
            for (const step of steps) {
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: message.info.id,
                sessionID: input.sessionID,
                type: "step-finish",
                reason: "stop",
                cost: step.cost,
                tokens: {
                  input: step.input,
                  output: step.output,
                  reasoning: step.reasoning,
                  cache: step.cache,
                },
              })
            }
            return message
          }),
      }

      const result = yield* def.execute(
        { description: "review the cache path", prompt: "read it all", subagent_type: "general" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: billingOps, bypassAgentCheck: true },
          messages: [],
          metadata: (input) => Effect.sync(() => void writes.push(input.metadata ?? {})),
          ask: () => Effect.void,
        },
      )

      const totals = {
        input: 300,
        output: 60,
        reasoning: 6,
        cacheRead: 16,
        cacheWrite: 3,
        cost: 0.75,
        // t-ffziaz. `steps` and `context` are the two that are NOT sums: two
        // step-finish parts, and the LAST one's context — its 200 input plus
        // the 9 it read from cache. 209, not the 316 the run sent in total.
        steps: 2,
        context: 209,
      }
      // The number the drawer will draw, on the call that owns the child.
      expect(result.metadata[TASK_TOKENS_KEY]).toEqual(totals)
      // And it must agree with the child's own stored messages - the same sum
      // the run index reports, not a second figure kept beside it.
      const messages = yield* sessions.messages({ sessionID: result.metadata.sessionId })
      const stat = RunStats.stat(result.metadata.sessionId, messages as unknown as Parameters<typeof RunStats.stat>[1])
      expect({
        input: stat.tokens?.input ?? 0,
        output: stat.tokens?.output ?? 0,
        reasoning: stat.tokens?.reasoning ?? 0,
        cacheRead: stat.tokens?.cacheRead ?? 0,
        cacheWrite: stat.tokens?.cacheWrite ?? 0,
        cost: stat.cost ?? 0,
        steps: stat.steps ?? 0,
        context: stat.context ?? 0,
      }).toEqual(totals)

      // t-f6vig2. The LAUNCH write carries no token key at all: nothing has
      // been measured yet, and an all-zero rider read as a spend of 0 - which
      // is what the drawer printed for the whole run. Every write that HAS the
      // key carries a real figure.
      expect(writes.length).toBeGreaterThanOrEqual(2)
      expect(writes[0]).not.toHaveProperty(TASK_TOKENS_KEY)
      expect(writes.slice(1).every((write) => !!write[TASK_TOKENS_KEY])).toBe(true)
      // t-fijy8a F7. ONE update, when the child settles - not one per
      // step-finish. The live per-step figure travels on the ACP chunk rider
      // (acp/event.ts childTokens), which is the only channel a background
      // child has and the one the extension's card already reads; refreshing
      // here as well meant reading the child's whole transcript twice a step.
      const updates = writes.filter((write) => ((write[TASK_TOKENS_KEY] as { input?: number })?.input ?? 0) > 0)
      expect(updates).toHaveLength(1)
      expect(updates[0]?.[TASK_TOKENS_KEY]).toEqual(totals)
    }),
  )

  it.instance("drops a deleted parent's queued background results", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      // A result that finished after its parent was already on its way out.
      // Nothing could ever write it: `ops.prompt` has no session to write into.
      enqueueResult(chat.id, {
        text: `<task id="ses_child" state="completed"></task>`,
        entry: { sessionId: "ses_child", state: "completed" },
      })
      expect(queuedResults(chat.id)).toBe(1)

      yield* sessions.remove(chat.id)

      // Red before the fix: the entry (and the drainer claim and the semaphore
      // beside it) stayed in a process-global map for the life of the process.
      expect(queuedResults(chat.id)).toBe(0)
    }),
  )
})

import { afterEach, describe, expect } from "bun:test"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { PermissionV1 } from "@origami/core/v1/permission"
import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { Cause, Effect, Exit, Logger } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { FlockRouting } from "@/flock/routing"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Ripgrep } from "@origami/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { APICallError } from "ai"
import { MessageV2 } from "@/session/message-v2"
import { disposeAllInstances, provideInstanceEffect, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    FlockRouting.node,
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
  [[RuntimeFlags.node, RuntimeFlags.layer({})]],
)

const it = testEffect(layer)

afterEach(async () => {
  await disposeAllInstances()
})

/** The parent message's model. Deliberately NOT one of the provider's models:
 *  a child that lands on this has fallen through, not been routed. */
const parent = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const binding = (modelID: string) => ({
  providerID: ProviderV2.ID.make("flock"),
  modelID: ModelV2.ID.make(modelID),
})

// Capability facts declared through real provider config so they travel the
// same sparse-merge that builds Provider.Model in production.
const PROVIDER: Partial<ConfigV1.Info> = {
  provider: {
    flock: {
      name: "Flock Test",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9/v1" },
      models: {
        tooler: { name: "Tooler", tool_call: true, cost: { input: 1, output: 3 } },
        blind: { name: "Blind", tool_call: false, cost: { input: 1, output: 3 } },
        seer: { name: "Seer", attachment: true, tool_call: true, cost: { input: 1, output: 3 } },
        spare: { name: "Spare", tool_call: true, cost: { input: 2, output: 9 } },
      },
    },
  },
}

/** A profile whose ONE binding routes every subagent session under it. */
const profile = (subagents: { use: string; fallback?: string[] }): Partial<ConfigV1.Info> => ({
  ...PROVIDER,
  flock: { profile: "p", profiles: { p: { subagents } } },
})

/** An active profile that binds nothing — routing on, opinion absent (D10). */
const emptyProfile: Partial<ConfigV1.Info> = {
  ...PROVIDER,
  flock: { profile: "p", profiles: { p: { description: "binds nothing" } } },
}

const seed = Effect.fn("FlockTaskTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Pinned" })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: MessageID.ascending(),
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: parent.modelID,
    providerID: parent.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

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
      modelID: input.model?.modelID ?? parent.modelID,
      providerID: input.model?.providerID ?? parent.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

/**
 * Runs one task call and hands back what the child was actually started with:
 * the prompt input carries the model the router chose and the agent it chose.
 */
const dispatch = Effect.fn("FlockTaskTest.dispatch")(function* (
  subagent_type: string,
  /** The parent CHAT's sub-agent override, set on the session row before the
   *  call — where a real one is written by the ACP subagentModel option.
   *  `context` (t-lmqe0g) is the override's context-window field. */
  override?: { providerID: ProviderV2.ID; modelID: ModelV2.ID; context?: number },
) {
  const { chat, assistant } = yield* seed()
  if (override) yield* (yield* Session.Service).setSubagentModel({ sessionID: chat.id, model: override })
  const def = yield* (yield* TaskTool).init()
  let seen: SessionPrompt.PromptInput | undefined
  const result = yield* def.execute(
    { description: "inspect bug", prompt: "look into the cache key path", subagent_type },
    {
      sessionID: chat.id,
      messageID: assistant.id,
      agent: "build",
      abort: new AbortController().signal,
      extra: {
        promptOps: {
          cancel: () => Effect.void,
          busy: () => Effect.succeed(false),
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              seen = input
              return reply(input, "done")
            }),
        } satisfies TaskPromptOps,
      },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    },
  )
  const child = yield* (yield* Session.Service).get(result.metadata.sessionId)
  return { chat, child, model: seen?.model, variant: seen?.variant, contextOverride: seen?.contextOverride }
})

/** Runs a task call that is expected to be refused before anything is spawned. */
const refuse = Effect.fn("FlockTaskTest.refuse")(function* (subagent_type: string) {
  const { chat, assistant } = yield* seed()
  const def = yield* (yield* TaskTool).init()
  const exit = yield* def
    .execute(
      { description: "inspect bug", prompt: "look at the screenshot", subagent_type },
      {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: {
          promptOps: {
            cancel: () => Effect.void,
            busy: () => Effect.succeed(false),
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) => Effect.succeed(reply(input, "done")),
          } satisfies TaskPromptOps,
        },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
    .pipe(Effect.exit)
  return { chat, exit, children: yield* (yield* Session.Service).children(chat.id) }
})

/** The engine's own error shape for an HTTP status, built the way one arrives. */
const apiError = (statusCode: number) =>
  MessageV2.fromError(
    new APICallError({
      message: "boom",
      url: "https://example.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
      responseHeaders: {},
      isRetryable: false,
    }),
    { providerID: ProviderV2.ID.make("flock") },
  )

/** What a scripted child turn does on the model it was handed. */
type Turn = { text: string } | { fails: number; partial?: string }

/**
 * Runs one task call against a scripted child and reports every model the child
 * was actually run on, in order — which is the only honest way to ask whether a
 * chain was walked, walked too far, or walked at all.
 */
const scripted = Effect.fn("FlockTaskTest.scripted")(function* (input: {
  subagent_type: string
  turn: (modelID: string) => Turn
  /** The parent CHAT's sub-agent override, set on the session row before the
   *  call — where a real one is written by the ACP subagentModel option. */
  override?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
}) {
  const { chat, assistant } = yield* seed()
  if (input.override) yield* (yield* Session.Service).setSubagentModel({ sessionID: chat.id, model: input.override })
  const def = yield* (yield* TaskTool).init()
  const tried: string[] = []
  const exit = yield* def
    .execute(
      { description: "inspect bug", prompt: "look into the cache key path", subagent_type: input.subagent_type },
      {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: {
          promptOps: {
            cancel: () => Effect.void,
            busy: () => Effect.succeed(false),
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (prompt) =>
              Effect.sync(() => {
                const modelID = prompt.model?.modelID ?? parent.modelID
                tried.push(modelID)
                const turn = input.turn(modelID)
                if ("text" in turn) return reply(prompt, turn.text)
                const base = reply(prompt, turn.partial ?? "")
                if (base.info.role !== "assistant") throw new Error("reply must be an assistant message")
                return {
                  info: { ...base.info, error: apiError(turn.fails), finish: "error" as const },
                  // A turn that died before saying anything leaves no parts at
                  // all; one that died mid-stream leaves what it had said.
                  parts: turn.partial ? base.parts : [],
                }
              }),
          } satisfies TaskPromptOps,
        },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
    .pipe(Effect.exit)
  return { exit, tried }
})

const captureLogs = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lines: string[] = []
    const value = yield* self.pipe(
      Effect.provide(
        Logger.layer([Logger.make<unknown, void>((options) => lines.push(JSON.stringify(options.message)))]),
      ),
    )
    return { value, lines }
  })

describe("flock task routing", () => {
  it.instance(
    "runs every subagent on the profile's one binding, whatever agent it is",
    () =>
      Effect.gen(function* () {
        // The whole of E1: routing is no longer a question about the WORK, it is
        // one setting — "subagents run over there". Three different agents, one
        // model, no per-agent opinion anywhere.
        expect(yield* dispatch("general").pipe(Effect.map((run) => [run.child.agent, run.model]))).toEqual([
          "general",
          binding("tooler"),
        ])
        expect(yield* dispatch("explore").pipe(Effect.map((run) => [run.child.agent, run.model]))).toEqual([
          "explore",
          binding("tooler"),
        ])
        expect(yield* dispatch("plan").pipe(Effect.map((run) => [run.child.agent, run.model]))).toEqual([
          "plan",
          binding("tooler"),
        ])
      }),
    { config: profile({ use: "flock/tooler" }) },
  )

  it.instance(
    "drops the parent's model variant when it routes the child somewhere else",
    () =>
      Effect.gen(function* () {
        // The variant names a setting of the PARENT's model. Carrying "xhigh"
        // onto another provider's model is the same bug the engine already
        // guards against for an agent with its own `model:`.
        expect(yield* dispatch("general").pipe(Effect.map((run) => run.variant))).toBeUndefined()
      }),
    { config: profile({ use: "flock/tooler" }) },
  )

  it.instance(
    "keeps the parent's variant when it routes the child nowhere",
    () =>
      Effect.gen(function* () {
        expect(yield* dispatch("general").pipe(Effect.map((run) => run.variant))).toBe("xhigh")
      }),
    { config: PROVIDER },
  )

  it.instance(
    "no longer shadows a custom agent that shares an old role name",
    () =>
      Effect.gen(function* () {
        // Before E1 an active profile made `read` mean the ROLE and silently ran
        // `explore` instead of the user's own agent. Role names are ordinary
        // strings again: the agent the caller named is the agent that runs, and
        // it is routed like any other.
        const run = yield* dispatch("read")
        expect(run.child.agent).toBe("read")
        expect(run.model).toEqual(binding("tooler"))
      }),
    {
      config: {
        ...profile({ use: "flock/tooler" }),
        agent: { read: { description: "A custom agent that happens to be called read", mode: "subagent" } },
      },
    },
  )

  it.instance(
    "routes a profile still written in the old slot shape through its executor binding",
    () =>
      Effect.gen(function* () {
        // Read-compat end to end: an origami.json nobody has rewritten still
        // routes subagents, and it routes them to the slot that used to run the
        // work that changes things.
        expect(yield* dispatch("general").pipe(Effect.map((run) => run.model))).toEqual(binding("tooler"))
      }),
    {
      config: {
        ...PROVIDER,
        flock: {
          profile: "p",
          profiles: {
            p: {
              executor: { use: "flock/tooler", fanout: 2 },
              scout: { use: "flock/spare" },
              roles: { read: { use: "flock/seer" } },
            },
          },
        },
      },
    },
  )

  it.instance(
    "still loads and runs an agent whose frontmatter names a legacy role",
    () =>
      Effect.gen(function* () {
        // `role:` buys nothing now, but the agent file must not fail to load —
        // the user would lose the agent, not just the routing. It runs itself,
        // on the profile's one binding like every other subagent.
        const run = yield* dispatch("reviewer")
        expect(run.child.agent).toBe("reviewer")
        expect(run.model).toEqual(binding("tooler"))
      }),
    {
      config: profile({ use: "flock/tooler" }),
      init: (directory) =>
        Effect.promise(() =>
          Bun.write(
            path.join(directory, ".origami", "agent", "reviewer.md"),
            ["---", "description: Reviews things", "mode: subagent", "role: judge", "---", "Be adversarial."].join(
              "\n",
            ),
          ),
        ).pipe(Effect.asVoid),
    },
  )
})

describe("flock task model precedence", () => {
  it.instance(
    "prefers the subagent binding over the agent's own model",
    () =>
      Effect.gen(function* () {
        expect(yield* dispatch("reviewer").pipe(Effect.map((run) => run.model))).toEqual(binding("spare"))
      }),
    {
      config: {
        ...profile({ use: "flock/spare" }),
        agent: { reviewer: { mode: "subagent", model: "flock/tooler" } },
      },
    },
  )

  it.instance(
    "falls back to the agent's own model when the active profile binds nothing",
    () =>
      Effect.gen(function* () {
        expect(yield* dispatch("reviewer").pipe(Effect.map((run) => run.model))).toEqual(binding("tooler"))
      }),
    {
      config: {
        ...emptyProfile,
        agent: { reviewer: { mode: "subagent", model: "flock/tooler" } },
      },
    },
  )

  it.instance(
    "falls back to the parent message's model when neither the profile nor the agent has one",
    () =>
      Effect.gen(function* () {
        expect(yield* dispatch("general").pipe(Effect.map((run) => run.model))).toEqual(parent)
      }),
    { config: emptyProfile },
  )

  // Tier 0, above all three: the chat's OWN sub-agent override. It is the only
  // tier a human set deliberately, for this chat, knowing what it was about to
  // fan out — the others are defaults someone configured once. A fan-out is
  // where the money goes, so "these children run on the cheap model" has to win.
  it.instance(
    "the parent chat's sub-agent override beats the flock binding",
    () =>
      Effect.gen(function* () {
        expect(yield* dispatch("reviewer", binding("seer")).pipe(Effect.map((run) => run.model))).toEqual(
          binding("seer"),
        )
      }),
    {
      config: {
        ...profile({ use: "flock/spare" }),
        agent: { reviewer: { mode: "subagent", model: "flock/tooler" } },
      },
    },
  )

  it.instance(
    "the override beats the agent's own pinned model when no profile binds anything",
    () =>
      Effect.gen(function* () {
        expect(yield* dispatch("reviewer", binding("seer")).pipe(Effect.map((run) => run.model))).toEqual(
          binding("seer"),
        )
      }),
    {
      config: {
        ...emptyProfile,
        agent: { reviewer: { mode: "subagent", model: "flock/tooler" } },
      },
    },
  )

  it.instance(
    "the override beats the parent message's model when nothing else has one",
    () =>
      Effect.gen(function* () {
        expect(yield* dispatch("general", binding("seer")).pipe(Effect.map((run) => run.model))).toEqual(
          binding("seer"),
        )
      }),
    { config: emptyProfile },
  )

  it.instance(
    "no override changes nothing — the binding still wins",
    () =>
      Effect.gen(function* () {
        // The guard on the tier above: reading a MISSING override must not
        // shadow the binding with an empty or half-formed model.
        expect(yield* dispatch("reviewer").pipe(Effect.map((run) => run.model))).toEqual(binding("spare"))
      }),
    {
      config: {
        ...profile({ use: "flock/spare" }),
        agent: { reviewer: { mode: "subagent", model: "flock/tooler" } },
      },
    },
  )

  // t-lmqe0g: the override's context length reaches the child's prompt the
  // same way temperature/topP reach an ordinary prompt — a plain field on the
  // PromptInput every attempt() call sends, read fresh from the parent row.
  it.instance(
    "the override's context length rides every attempt on the child session",
    () =>
      Effect.gen(function* () {
        const run = yield* dispatch("reviewer", { ...binding("seer"), context: 65536 })
        expect(run.model).toEqual(binding("seer"))
        expect(run.contextOverride).toBe(65536)
      }),
    {
      config: {
        ...profile({ use: "flock/spare" }),
        agent: { reviewer: { mode: "subagent", model: "flock/tooler" } },
      },
    },
  )

  it.instance(
    "an override with no context sends no contextOverride — the child keeps its own configured limit",
    () =>
      Effect.gen(function* () {
        const run = yield* dispatch("reviewer", binding("seer"))
        expect(run.contextOverride).toBeUndefined()
      }),
    {
      config: {
        ...profile({ use: "flock/spare" }),
        agent: { reviewer: { mode: "subagent", model: "flock/tooler" } },
      },
    },
  )
})

describe("flock task fallthrough (D10)", () => {
  it.instance(
    "fails on an unknown agent type with no profile active, exactly as it always did",
    () =>
      Effect.gen(function* () {
        const { exit, children } = yield* refuse("read")
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Unknown agent type: read")
        expect(children).toHaveLength(0)
      }),
    { config: PROVIDER },
  )

  it.instance(
    "fails on that same name WITH a profile active, because roles are not agents any more",
    () =>
      Effect.gen(function* () {
        // The regression this pins: a profile must not resurrect the twelve role
        // names as callable subagent types. `read` is an agent or it is nothing.
        const { exit, children } = yield* refuse("read")
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Unknown agent type: read")
        expect(children).toHaveLength(0)
      }),
    { config: profile({ use: "flock/tooler" }) },
  )

  it.instance(
    "runs on the session's own model when the active profile binds nothing",
    () =>
      Effect.gen(function* () {
        const run = yield* dispatch("explore")
        expect(run.child.agent).toBe("explore")
        expect(run.model).toEqual(parent)
      }),
    { config: emptyProfile },
  )

  it.instance(
    "falls through, loudly, when the binding is not available at route time",
    () =>
      Effect.gen(function* () {
        const { value, lines } = yield* captureLogs(dispatch("explore"))
        expect(value.child.agent).toBe("explore")
        expect(value.model).toEqual(parent)
        const warnings = lines.filter((line) => line.includes("flock binding is unavailable"))
        expect(warnings).toHaveLength(1)
      }),
    { config: profile({ use: "ghost/model" }) },
  )
})

describe("flock task health chain — route time", () => {
  it.instance(
    "walks past a candidate the provider registry does not have",
    () =>
      Effect.gen(function* () {
        // The whole reason a chain exists: an unavailable primary must reach the
        // fallback, not skip straight to the session's own model.
        expect(yield* dispatch("general").pipe(Effect.map((run) => run.model))).toEqual(binding("spare"))
      }),
    { config: profile({ use: "ghost/model", fallback: ["flock/spare"] }) },
  )

  it.instance(
    "walks the whole chain in order, taking the first candidate that exists",
    () =>
      Effect.gen(function* () {
        expect(yield* dispatch("general").pipe(Effect.map((run) => run.model))).toEqual(binding("seer"))
      }),
    { config: profile({ use: "ghost/one", fallback: ["ghost/two", "flock/seer", "flock/tooler"] }) },
  )

  it.instance(
    "falls through to the session's model only once the whole chain is unavailable (D10)",
    () =>
      Effect.gen(function* () {
        const { value, lines } = yield* captureLogs(dispatch("general"))
        expect(value.model).toEqual(parent)
        // One warning per dead candidate, so the user can see which is dead.
        expect(lines.filter((line) => line.includes("flock binding is unavailable"))).toHaveLength(2)
      }),
    { config: profile({ use: "ghost/one", fallback: ["ghost/two"] }) },
  )
})

describe("flock task health chain — call time", () => {
  it.instance(
    "retries the child on the next candidate when the binding answers 429",
    () =>
      Effect.gen(function* () {
        const run = yield* scripted({
          subagent_type: "general",
          turn: (modelID) => (modelID === "tooler" ? { fails: 429 } : { text: "read it" }),
        })
        expect(run.tried).toEqual(["tooler", "spare"])
        expect(Exit.isSuccess(run.exit)).toBe(true)
        if (Exit.isSuccess(run.exit)) expect(run.exit.value.output).toContain("read it")
      }),
    { config: profile({ use: "flock/tooler", fallback: ["flock/spare"] }) },
  )

  it.instance(
    "does not retry a request the next binding would reject the same way",
    () =>
      Effect.gen(function* () {
        const run = yield* scripted({ subagent_type: "general", turn: () => ({ fails: 400 }) })
        // A 400 is about the request, not the endpoint. Walking it would spend
        // the spare reproducing the same failure and bury the real cause.
        expect(run.tried).toEqual(["tooler"])
        expect(Exit.isFailure(run.exit)).toBe(true)
        if (Exit.isFailure(run.exit)) expect(Cause.pretty(run.exit.cause)).toContain("Sub-agent failed")
      }),
    { config: profile({ use: "flock/tooler", fallback: ["flock/spare"] }) },
  )

  it.instance(
    "never retries a turn that had already written output",
    () =>
      Effect.gen(function* () {
        const run = yield* scripted({
          subagent_type: "general",
          turn: () => ({ fails: 429, partial: "half an answer" }),
        })
        // Sickness, and the chain has somewhere to go — but the child already
        // said something. A second run would duplicate the output and the bill.
        expect(run.tried).toEqual(["tooler"])
        expect(Exit.isFailure(run.exit)).toBe(true)
      }),
    { config: profile({ use: "flock/tooler", fallback: ["flock/spare"] }) },
  )

  it.instance(
    "tries each candidate at most once, so the bound is the chain length",
    () =>
      Effect.gen(function* () {
        const run = yield* scripted({ subagent_type: "general", turn: () => ({ fails: 503 }) })
        expect(run.tried).toEqual(["tooler", "spare", "seer"])
        // Sick to the last: a chain of dead endpoints is a real, visible failure
        // rather than a silent re-run on the parent's model.
        expect(Exit.isFailure(run.exit)).toBe(true)
        if (Exit.isFailure(run.exit)) expect(Cause.pretty(run.exit.cause)).toContain("Sub-agent failed")
      }),
    { config: profile({ use: "flock/tooler", fallback: ["flock/spare", "flock/seer"] }) },
  )

  it.instance(
    "runs an unrouted child exactly once, on the session's own model",
    () =>
      Effect.gen(function* () {
        const run = yield* scripted({ subagent_type: "general", turn: () => ({ fails: 429 }) })
        // Flock has no opinion here, so there is no chain and nothing to walk:
        // one attempt, one failure, exactly as with Flock off.
        expect(run.tried).toEqual([parent.modelID])
        expect(Exit.isFailure(run.exit)).toBe(true)
      }),
    { config: emptyProfile },
  )

  // The OVERRIDE half of the chain rule (tool/task.ts: `const chain = override ?
  // undefined : routed?.chain`). The walk starts at the FLOCK candidates, never
  // at the pinned model, so a chain left in place would run the children on the
  // profile's binding the moment the pinned one hiccupped — the user's choice
  // holding in the metadata and nowhere else, silently, on the surface where a
  // fan-out spends real money. One pinned model is one attempt.
  //
  // Its other half is "retries the child on the next candidate when the binding
  // answers 429" above: same profile, no override, and the chain IS walked. The
  // two together pin the line from both sides — dropping the chain always would
  // redden that one, never dropping it reddens this one.
  it.instance(
    "an override pins the child to ONE attempt — the profile's chain is not walked",
    () =>
      Effect.gen(function* () {
        const run = yield* scripted({
          subagent_type: "general",
          override: binding("seer"),
          turn: () => ({ fails: 429 }),
        })
        expect(run.tried).toEqual(["seer"])
        expect(Exit.isFailure(run.exit)).toBe(true)
        if (Exit.isFailure(run.exit)) expect(Cause.pretty(run.exit.cause)).toContain("Sub-agent failed")
      }),
    { config: profile({ use: "flock/tooler", fallback: ["flock/spare"] }) },
  )
})

describe("flock task tool description", () => {
  const describeTaskIn = (config: Partial<ConfigV1.Info>, agentName = "build", visionProfile?: string) =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ config })
      return yield* Effect.gen(function* () {
        const caller = yield* (yield* Agent.Service).get(agentName)
        const tools = yield* (yield* ToolRegistry.Service).tools({ ...parent, agent: caller, visionProfile })
        return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
      }).pipe(provideInstanceEffect(directory))
    })

  it.live("tells the model nothing about flock, profile or not", () =>
    Effect.gen(function* () {
      // The roster injection is gone: an active profile changes which MODEL a
      // subagent runs on and nothing the model is ever told. A byte comparison
      // against the live Flock-off text, not against a transcription of it.
      const off = yield* describeTaskIn({ ...PROVIDER, agent: { zebra: { description: "Z", mode: "subagent" } } })
      const on = yield* describeTaskIn({
        ...profile({ use: "flock/tooler" }),
        agent: { zebra: { description: "Z", mode: "subagent" } },
      })
      expect(on).toBe(off)
      expect(off).not.toContain("Available work roles:")
      expect(off).toContain("Available agent types and the tools they have access to:")
      expect(off).toContain("- zebra: Z")
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )
})

// ---------------------------------------------------------------------------
// The ROSTER, as the model reads it.
//
// The defect: every collab bot and every vision profile the Agents pane had
// ever written was `mode: all` + `hidden: true`, and the roster filtered only
// on `mode !== "primary"`. So a dozen character definitions the user created to
// chat with were offered to the model as delegation targets — most of them
// carrying no description, which rendered as `- name: ` with nothing after the
// colon. `session/prompt.ts:393` already filtered on `hidden` when it listed
// the agents a mistyped `task` could have meant; the roster now does the same.
// ---------------------------------------------------------------------------
describe("the task roster names only agents the model may actually delegate to", () => {
  const describeTaskIn = (config: Partial<ConfigV1.Info>, visionProfile?: string) =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ config })
      return yield* Effect.gen(function* () {
        const caller = yield* (yield* Agent.Service).get("build")
        const tools = yield* (yield* ToolRegistry.Service).tools({ ...parent, agent: caller, visionProfile })
        return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
      }).pipe(provideInstanceEffect(directory))
    })

  /** The def shape the Agents pane writes for a collab bot and for a vision
   *  profile: `mode: all`, `hidden: true`, and the marker in `options`. */
  const agents = {
    zebra: { description: "Z", mode: "subagent" as const },
    "collab-crane": { description: "Builds it.", mode: "all" as const, hidden: true, options: { collab: true } },
    "vision-eye": {
      description: "Reads screenshots.",
      mode: "all" as const,
      hidden: true,
      options: { "vision-profile": true },
    },
  }

  it.live("a hidden def is NOT offered as a subagent", () =>
    Effect.gen(function* () {
      const text = yield* describeTaskIn({ ...PROVIDER, agent: agents })
      expect(text).toContain("- zebra: Z")
      expect(text).not.toContain("collab-crane")
      expect(text).not.toContain("vision-eye")
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )

  it.live("the chat's OWN vision profile is re-admitted, with a synthesized description", () =>
    Effect.gen(function* () {
      const text = yield* describeTaskIn({ ...PROVIDER, agent: agents }, "vision-eye")
      // Its own `description:` is written for the Agents pane and says nothing
      // about how to use it, so the roster line is synthesized instead.
      expect(text).toContain("- vision-eye: Your model cannot see images.")
      expect(text).toContain("Send it a path or an attached image")
      expect(text).toContain("you never receive the picture")
      expect(text).not.toContain("Reads screenshots.")
      // Exactly one hidden def gets in. The collab bot beside it stays out.
      expect(text).not.toContain("collab-crane")
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )

  it.live("naming a profile does not let a DIFFERENT hidden def in", () =>
    Effect.gen(function* () {
      // Both halves of the re-admit rule matter: the name alone would let any
      // hidden def called `collab-crane` in if the user typed that slug.
      const text = yield* describeTaskIn({ ...PROVIDER, agent: agents }, "collab-crane")
      expect(text).not.toContain("collab-crane")
      expect(text).not.toContain("vision-eye")
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )

  it.live("an EMPTY description renders the fallback, never a bare `- name:` line", () =>
    Effect.gen(function* () {
      // `??` only catches an absent description; a def saved with the box left
      // empty carries `""`, which passed straight through.
      const text = yield* describeTaskIn({
        ...PROVIDER,
        agent: { blank: { description: "", mode: "subagent" as const } },
      })
      expect(text).not.toContain("- blank: \n")
      expect(text.endsWith("- blank: ")).toBe(false)
      expect(text).toContain("- blank: This subagent should only be called manually by the user.")
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )

  it.live("a whitespace-only description is the same as an empty one", () =>
    Effect.gen(function* () {
      const text = yield* describeTaskIn({
        ...PROVIDER,
        agent: { blank: { description: "   ", mode: "subagent" as const } },
      })
      expect(text).toContain("- blank: This subagent should only be called manually by the user.")
    }).pipe(Effect.provide(testInstanceStoreLayer)),
  )
})

describe("flock task permission gate", () => {
  /** Wired exactly as session/prompt.ts wires it: the tool's own ask request,
   *  plus the CALLING agent's ruleset, through the real permission service. */
  const callAs = Effect.fn("FlockTaskTest.callAs")(function* (agentName: string, subagent_type: string) {
    const { chat, assistant } = yield* seed()
    const def = yield* (yield* TaskTool).init()
    const caller = yield* (yield* Agent.Service).get(agentName)
    const permission = yield* Permission.Service
    return yield* def
      .execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: agentName,
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              cancel: () => Effect.void,
              busy: () => Effect.succeed(false),
              resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
              prompt: (input) => Effect.succeed(reply(input, "done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: (req: any) =>
            permission.ask({ ...req, sessionID: chat.id, ruleset: caller!.permission }) as Effect.Effect<void>,
        },
      )
      .pipe(Effect.exit)
  })

  const wasDenied = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV1.DeniedError

  it.instance(
    "judges permission on the agent named, so an active profile cannot widen plan mode",
    () =>
      Effect.gen(function* () {
        // Plan mode's ruleset is `task: { "*": deny, explore: allow }`. Routing
        // no longer sits between the name and the ruleset, so what the caller
        // asks for is what is judged — and a profile buys no extra reach.
        expect(Exit.isSuccess(yield* callAs("plan", "explore"))).toBe(true)
        for (const name of ["general", "plan"]) {
          const exit = yield* callAs("plan", name)
          expect([name, wasDenied(exit)]).toEqual([name, true])
        }
      }),
    { config: profile({ use: "flock/tooler" }) },
  )
})

describe("flock task ask request", () => {
  const askFor = Effect.fn("FlockTaskTest.askFor")(function* (subagent_type: string) {
    const { chat, assistant } = yield* seed()
    const def = yield* (yield* TaskTool).init()
    const calls: any[] = []
    // The call may fail after the ask. The ask itself is what is under test, so
    // the outcome is discarded.
    yield* def
      .execute(
        { description: "inspect bug", prompt: "look into the cache key path", subagent_type },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              cancel: () => Effect.void,
              busy: () => Effect.succeed(false),
              resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
              prompt: (input) => Effect.succeed(reply(input, "done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }),
        },
      )
      .pipe(Effect.exit)
    return calls[0]
  })

  const EXPECTED = {
    permission: "task",
    patterns: ["explore"],
    always: ["*"],
    metadata: { description: "inspect bug", subagent_type: "explore" },
  }

  it.instance(
    "asks about the agent the caller named, with a profile active",
    () =>
      Effect.gen(function* () {
        expect(yield* askFor("explore")).toEqual(EXPECTED)
      }),
    { config: profile({ use: "flock/tooler" }) },
  )

  it.instance(
    "asks the identical question with no profile active",
    () =>
      Effect.gen(function* () {
        // Routing and permission are fully separate now, so the two must not
        // differ by a byte.
        expect(yield* askFor("explore")).toEqual(EXPECTED)
      }),
    { config: PROVIDER },
  )
})

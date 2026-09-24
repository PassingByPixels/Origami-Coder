import { PermissionV1 } from "@origami/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@origami/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import { AgentBot } from "@/agent/bot"
import { CollabSystem } from "@/collab/collab-system"
import { ToolSearch } from "@/tool/tool-search"
import { SessionDegrade } from "../degrade"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ProviderEffortDemotion } from "@/provider/effort-demotion"
import { SessionEffortTier } from "../effort-tier"
import { SystemPrompt } from "../system"
import { SessionPromptCapture } from "../prompt-capture"
import { SessionCachePolicy } from "../cache-policy"
import { SessionCacheWarm } from "../cache-warm"
import { SessionWindowFit } from "../window-fit"
import { InstallationVersion } from "@origami/core/installation/version"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `origami/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
  /** A CACHE WARM (session/cache-warm.ts), not a turn: the same prefix, one
   *  output token. Everything else about the request is identical on purpose —
   *  a warm that changed the system prompt, the tools or the options would miss
   *  the cache it exists to refresh. */
  readonly warm?: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly frequencyPenalty?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  // A collab turn brings two layers of its own and the order is the point: the
  // collab base prompt above the agent's persona (a persona says who is speaking,
  // not what the room is), this turn's live room state below it.
  const collab = yield* CollabSystem.Turn
  // origami_change-start (prompt matrix): the composition matrix, three rows:
  //
  //   normal chat   base agent prompt + the workspace instruction files
  //   bot session   base agent prompt + persona   (no instruction files)
  //   collab turn   collab base prompt + persona  (no instruction files)
  //
  // A persona composes, it does not replace: upstream lets an agent's own prompt
  // occupy the base slot, leaving a bot with a character and no statement of what
  // it is for. The instruction files are dropped at the source (session/prompt.ts)
  // rather than filtered here, because the transparency capture is drafted from
  // that same list and would otherwise report a block the model never received.
  const bot = collab === undefined && AgentBot.isBot(input.agent)
  const persona = input.agent.prompt
    ? bot
      ? [...SystemPrompt.provider(input.model), input.agent.prompt]
      : [input.agent.prompt]
    : SystemPrompt.provider(input.model)
  const basePrompt = collab ? [collab.base, ...persona] : persona
  const system = [
    [
      ...basePrompt,
      ...(collab ? [collab.state] : []),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]
  // origami_change-end

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  // origami_change-start (t-46a74d, t-48ffvz): a withdrawn effort tier is
  // remapped, never dropped and never sent. A tier is withdrawn either as a
  // retired OpenAI tier that stored sessions still hold, or because the model
  // answered 400 on it (provider/effort-demotion.ts) — which is what makes the
  // self-healing retry send a different request. Either way the variant lookup
  // returns undefined, which would silently send no effort and let the endpoint
  // pick; the repair is one step down the ladder, logged once.
  const requested = input.small ? undefined : input.user.model.variant
  const variants = input.model.variants
  const available = variants
    ? ProviderEffortDemotion.ladder(input.model.providerID, input.model.id, Object.keys(variants))
    : []
  const withdrawn =
    requested !== undefined &&
    !available.includes(requested) &&
    ((ProviderTransform.OPENAI_RETIRED_EFFORTS as readonly string[]).includes(requested) ||
      ProviderEffortDemotion.demoted(input.model.providerID, input.model.id).includes(requested))
  const remapped = withdrawn && requested ? ProviderEffortDemotion.replacement(requested, available) : undefined
  if (remapped) {
    yield* Effect.logInfo("reasoning effort remapped", {
      "session.id": input.sessionID,
      modelID: input.model.id,
      from: requested,
      to: remapped,
      reason: "the tier is no longer offered for this model",
    })
  }
  const resolved = remapped ?? requested
  const variant = !input.small && variants && resolved ? (variants[resolved] ?? {}) : {}
  // The tier this request actually carries, told to the retry policy: only this
  // line knows it, and a 400 that refuses a tier has to be matched against the
  // tier that was sent, not against whichever tier the endpoint's reply names.
  if (!input.small && !input.warm)
    SessionEffortTier.sent(
      input.sessionID,
      SessionEffortTier.key(input.model.providerID, input.model.id),
      resolved,
    )
  // origami_change-end
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  // Every writer of a request option converges here, so this is the one place a
  // knob the endpoint already refused can be taken back out — and it holds for the
  // degraded retry (which re-runs `prepare`) and for every later turn.
  const options = SessionDegrade.strip(
    input.sessionID,
    mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant),
  )
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const hooked = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      // An explicit per-agent temperature is always sent; otherwise the
      // capability-gated default, so a model that refuses one gets `undefined`.
      temperature:
        input.agent.temperature ??
        (input.model.capabilities.temperature ? ProviderTransform.temperature(input.model) : undefined),
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      frequencyPenalty: input.agent.frequencyPenalty ?? ProviderTransform.frequencyPenalty(input.model),
      // A warm wants the provider's cheapest reply. It is the one request whose
      // OUTPUT is worthless; only the cached-prefix read matters.
      maxOutputTokens: input.warm ? 1 : ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  // Alias our "tool_search" tool off the exact name @ai-sdk/openai's Responses
  // converter reserves for OpenAI's own hosted tool_search (mechanism in
  // ProviderTransform.renameCollidingTool). Must run before the tools map reaches
  // streamText/native-runtime so the declared tool and every replayed call agree.
  const tools = ProviderTransform.renameCollidingTool(resolveTools(input, collab !== undefined), input.model)
  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const origamiProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  const sortedTools = Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b)))

  // origami_change-start (t-tc20mj): the window holds the prompt AND the reply,
  // and a self-hosted endpoint refuses a request whose max_tokens does not fit
  // what the prompt leaves (a model with no declared output limit is sent a flat
  // 32k). Clamped here, after the chat.params hook, because only here are the
  // final messages and tool block known. When not even the floor fits, nothing
  // is sent: the step fails as a context overflow and the processor routes it to
  // compaction, instead of the endpoint refusing the same request again.
  const estimated = SessionWindowFit.estimate({
    messages,
    system: isOpenaiOauth || input.isWorkflow ? system : [],
    tools: sortedTools,
  })
  const window =
    input.warm || hooked.maxOutputTokens === undefined
      ? undefined
      : SessionWindowFit.fit({
          context: input.model.limit.context,
          estimate: SessionWindowFit.calibrate(input.sessionID, estimated),
          requested: hooked.maxOutputTokens,
        })
  if (window?.short) {
    return yield* Effect.fail(
      new SessionV1.ContextOverflowError({
        message: `The request does not fit the model's context window (${input.model.limit.context} tokens): the prompt is about ${SessionWindowFit.calibrate(input.sessionID, estimated)} tokens and less than ${SessionWindowFit.floor(input.model.limit.context)} would be left for the reply.`,
      }),
    )
  }
  // The title request runs beside the turn, and a warm is not measured.
  if (!input.small && !input.warm) SessionWindowFit.sent(input.sessionID, estimated)
  const params = window ? { ...hooked, maxOutputTokens: window.maxOutputTokens } : hooked
  // origami_change-end

  // Transparency capture: the last point at which the real outgoing prompt exists
  // — the system-transform plugin has had its chance and `basePrompt`/`user.system`
  // are only known here, so recording elsewhere would report an assembly the model
  // may never have seen. No-ops unless the session staged a draft, so the title
  // generator (`small`) and compaction never overwrite the turn.
  // `small` and `warm` alike must not overwrite the turn's captured prompt.
  if (!input.small && !input.warm)
    SessionPromptCapture.record({
      sessionID: input.sessionID,
      capturedAt: new Date().toISOString(),
      model: `${input.model.providerID}/${input.model.id}`,
      base: persona,
      ...(collab ? { collab: { base: collab.base, state: collab.state } } : {}),
      userSystem: input.user.system,
      finalSystem: system,
      tools: sortedTools,
      // The array this function is about to return, so the step digest measures
      // what was really sent rather than what was assembled upstream.
      messages,
      // origami_change-start (t-rylleg)
      // The window the engine will judge an idle gap against, and the last warm
      // that refreshed the prefix. Resolved HERE because the inline cache hint
      // is what separates Anthropic's 1-hour form from its 5-minute one, and
      // the hint only exists once `options` is settled.
      ttlSeconds: SessionCachePolicy.windowSeconds({
        providerID: input.model.providerID,
        // The provider's own id, which is what the OpenAI family table reads
        // (t-rz0amv): `gpt-5.6` and `gpt-4o` do not share a window.
        modelID: input.model.api.id,
        hintTtlSeconds: SessionCacheWarm.ttlSeconds(input.model, options),
      }),
      warmedAt: SessionCacheWarm.warmedAt(input.sessionID),
      // origami_change-end
    })

  return {
    system,
    messages,
    tools: sortedTools,
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            // origami_change-start: these four are not ours to rename. They are
            // the Zen gateway's wire protocol — its handler reads exactly
            // `x-opencode-{project,session,request,client}` and ignores anything
            // else. Every other x-origami-* header in this repo is our own.
            ...(origamiProjectID ? { "x-opencode-project": origamiProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            // origami_change-end
            "User-Agent": USER_AGENT,
          }
        : {
            // These two are also read back IN-PROCESS: the AI SDK client is
            // built once per provider, so provider.ts reads the identity of the
            // step off the request headers to decide permit priority and which
            // row a queue wait is reported on (provider/request-identity.ts).
            "x-session-affinity": input.sessionID,
            "X-Session-Id": input.sessionID,
            ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
            "User-Agent": USER_AGENT,
          }),
      ...input.model.headers,
      ...headers,
    },
  }
})

/**
 * The tools that survive the ruleset and this message's `tools` map.
 *
 * Exported for the deferral tests: `SessionTools.resolve` builds the map and
 * decides the catalog, this decides what is finally declared, and a caged agent
 * only provably carries neither a denied tool nor its catalog line where both
 * have run.
 */
export function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">, collab = false) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  // The collab tools (on a collab turn) and `tool_search` survive the ruleset:
  // both are protocol, not capability. Collab agent definitions are authored
  // deny-by-default, so the ruleset would take `ask`, `handoff` and `done` away
  // and leave a turn with no way to address anyone or stop; `tool_search` grants
  // nothing, since every tool it can reveal already passed this same cage in
  // `SessionTools.resolve`. An explicit per-message `tools` map still wins.
  const exempt: ReadonlySet<string> = collab
    ? new Set([...CollabSystem.TOOL_IDS, ToolSearch.TOOL_SEARCH_TOOL])
    : new Set([ToolSearch.TOOL_SEARCH_TOOL])
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && (exempt.has(k) || !disabled.has(k)))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"

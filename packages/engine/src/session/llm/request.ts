import { PermissionV1 } from "@origami/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@origami/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import { AgentBot } from "@/agent/bot"
import { CollabSystem } from "@/collab/collab-system"
import { SessionDegrade } from "../degrade"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { SessionPromptCapture } from "../prompt-capture"
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
  // A collab turn brings two layers of its own, and the ORDER is the point: the
  // collab base prompt above the agent's persona (a persona says who is
  // speaking, not what the room is), this turn's live room state below it.
  // Undefined for every other call - see `CollabSystem.Turn`.
  const collab = yield* CollabSystem.Turn
  // origami_change-start (prompt matrix): THE COMPOSITION MATRIX, the owner's
  // ruling, three rows and nothing else:
  //
  //   normal chat   base agent prompt + the workspace instruction files
  //   bot session   base agent prompt + persona   (no instruction files)
  //   collab turn   collab base prompt + persona  (no instruction files)
  //
  // A PERSONA COMPOSES, IT DOES NOT REPLACE. Upstream lets an agent's own
  // prompt occupy the base slot, which left a bot with a character and no
  // statement of what it is or what its tools are for - the same hole the
  // collab base prompt was written to close, and a bot session is not a room,
  // so it takes the CHAT base instead.
  //
  // The instruction files are dropped at the SOURCE (session/prompt.ts), not
  // filtered here: the transparency capture is drafted from that same list, so
  // excluding them upstream is what stops the capture reporting a block the
  // model never received.
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

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  // Every writer of a request option converges here — the name-derived defaults
  // from `ProviderTransform.options`, the provider/model config, the agent, and
  // the selected variant body. So this is the one place a knob the endpoint has
  // already REFUSED can be taken back out, and it holds for the degraded retry
  // (which re-runs `prepare`) and for every later turn of the same session.
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

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      // An explicit per-agent temperature is always sent (the user opted into it,
      // e.g. via the sampling settings); otherwise fall back to the
      // capability-gated provider default so models that don't accept a
      // temperature still get `undefined`.
      temperature:
        input.agent.temperature ??
        (input.model.capabilities.temperature ? ProviderTransform.temperature(input.model) : undefined),
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      frequencyPenalty: input.agent.frequencyPenalty ?? ProviderTransform.frequencyPenalty(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
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

  // Alias OUR "tool_search" tool off the exact name @ai-sdk/openai's Responses
  // converter reserves for OpenAI's own hosted tool_search — see the matching
  // comment on ProviderTransform.renameCollidingTool / renameToolSearchCalls
  // in provider/transform.ts for the full mechanism and the owner sessions
  // this was reproduced from. Must run before the tools map reaches
  // streamText/native-runtime so the declared tool and every replayed call
  // agree on one name for the whole conversation.
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

  // Transparency capture: this is the LAST point at which the real outgoing
  // prompt exists: the plugin `experimental.chat.system.transform` above has
  // already had its chance to reshape it, and `basePrompt`/`user.system` are
  // only known here. Recording anywhere else would report an assembly the
  // model may never have seen. No-ops unless the session staged a draft, so
  // the title generator (`small`) and compaction never overwrite the turn.
  if (!input.small)
    SessionPromptCapture.record({
      sessionID: input.sessionID,
      capturedAt: new Date().toISOString(),
      model: `${input.model.providerID}/${input.model.id}`,
      base: persona,
      ...(collab ? { collab: { base: collab.base, state: collab.state } } : {}),
      userSystem: input.user.system,
      finalSystem: system,
      tools: sortedTools,
      // The array this function is about to return, so the step digest
      // measures what was really sent rather than what was assembled upstream.
      // Everything below this point only reads it.
      messages,
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
            // origami_change-start: these four are NOT ours to rename. They are the
            // Zen gateway's wire protocol — its handler reads exactly
            // `x-opencode-{project,session,request,client}` and ignores anything else,
            // so the fork-wide x-origami-* sweep silently blanked Zen's telemetry.
            // Every OTHER x-origami-* header in this repo is our own server's and stays.
            ...(origamiProjectID ? { "x-opencode-project": origamiProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            // origami_change-end
            "User-Agent": USER_AGENT,
          }
        : {
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

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">, collab = false) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  // On a collab turn the flock tools survive the ruleset. They are the room's
  // PROTOCOL, not a capability: collab agent definitions are authored
  // deny-by-default, so leaving them to the ruleset would take `ask`, `handoff`
  // and `done` away from every one of them and leave a turn with no way to
  // address anyone or stop. An explicit per-message `tools` map still wins.
  const exempt: ReadonlySet<string> = collab ? new Set(CollabSystem.TOOL_IDS) : new Set()
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

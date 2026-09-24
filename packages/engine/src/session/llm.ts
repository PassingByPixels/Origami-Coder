import { LayerNode } from "@origami/core/effect/layer-node"
import { llmClient } from "@origami/core/effect/app-node-platform"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@origami/core/v1/session"
import { serviceUse } from "@origami/core/effect/service-use"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@origami/llm"
import { LLMClient } from "@origami/llm/route"
import type { LLMClientService } from "@origami/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@origami/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMNativeRoute } from "./llm/native-route"
import { SessionImageCap } from "./image-cap"
import { LLMRequestPrep } from "./llm/request"
import { SessionCachePolicy } from "./cache-policy"
import { SessionCacheState } from "./cache-state"
import { SessionCacheWarm } from "./cache-warm"
// The offered-tools rule lives beside the transparency capture so the set the
// model is really given and the set the shell REPORTS cannot drift apart.
import { SessionPromptCapture } from "./prompt-capture"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  /** A CACHE WARM rather than a turn (session/cache-warm.ts). It reaches the
   *  provider through this same path so the prefix is byte-identical, but it is
   *  drained here and never handed to the session processor — so it appears in
   *  no transcript, no usage pill and no token total, only in the debug log. */
  warm?: boolean
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@origami/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      // Live sampling: temperature / top_p / frequency_penalty are read fresh from
      // the global config file at request time, so a settings change applies on the
      // next message with no engine respawn. Priority: the per-chat override, then
      // the live global agent sampling, then the agent default.
      const liveSampling = yield* config.getLiveAgentSampling(input.agent.name)
      const sessionTemp = input.user.temperature ?? liveSampling.temperature
      const sessionTopP = input.user.topP ?? liveSampling.topP
      const freqPenalty = liveSampling.frequencyPenalty
      const agent =
        sessionTemp !== undefined || sessionTopP !== undefined || freqPenalty !== undefined
          ? {
              ...input.agent,
              ...(sessionTemp !== undefined ? { temperature: sessionTemp } : {}),
              ...(sessionTopP !== undefined ? { topP: sessionTopP } : {}),
              ...(freqPenalty !== undefined ? { frequencyPenalty: freqPenalty } : {}),
            }
          : input.agent
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        agent,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via origami's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      // The AI SDK's warnings are the only notice it gives that it dropped part of
      // the request it was about to send. Two modules silence that channel at
      // import time; this puts it back on the engine log rather than on stdout.
      LLMAISDK.installWarningLogger((effect) => void bridge.fork(effect))

      // Arm the next cache warm off THIS request (t-ntmmvh). Here rather than at
      // the call site because this is where the resolved options exist, and the
      // options decide whether the prefix carries a cache breakpoint at all.
      // A title generation (`small`) never arms: it is a different, tiny prefix.
      if (!input.small && !input.warm) {
        // The window the composer's warm badge counts against (t-rylyhm).
        // RECORDED HERE for the same reason the warm is armed here: the inline
        // cache hint is what separates Anthropic's 1-hour form from its
        // 5-minute one, and the hint only exists once `options` is settled.
        // ONE table answers it (cache-policy.ts, t-rylleg), so the badge and
        // the step's `idle` cause can never disagree about the window. A
        // provider that publishes none gets `undefined`, and the badge then
        // reports a hit with no countdown rather than inventing one.
        SessionCacheState.request({
          sessionID: input.sessionID,
          ttlSeconds: SessionCachePolicy.windowSeconds({
            providerID: input.model.providerID,
            modelID: input.model.api.id,
            hintTtlSeconds: SessionCacheWarm.ttlSeconds(input.model, prepared.messageTransformOptions),
          }),
        })
        SessionCacheWarm.armed({
          sessionID: input.sessionID,
          model: input.model,
          options: prepared.messageTransformOptions,
          messages: input.messages,
          // The warm goes out through this same service, so `prepare` rebuilds a
          // byte-identical prefix; only `warm` differs, and that buys one output
          // token. The stream is DRAINED here, which is what keeps the warm out
          // of the transcript, the usage pills and the token totals.
          // Drained through `runForEach` rather than `runDrain` for ONE value:
          // the warm's own cache read. A warm that came back with nothing
          // refreshed nothing, so only a read above zero extends the badge
          // (session/cache-state.ts). Everything else about the warm stays as
          // invisible as it was - nothing here reaches the transcript.
          send: (request) =>
            Effect.runPromise(
              Stream.runForEach(stream({ ...input, messages: request.messages, warm: true, retries: 0 }), (event) => {
                if (event.type === "step-finish")
                  SessionCacheState.warmed({
                    sessionID: input.sessionID,
                    cacheRead: event.usage?.cacheReadInputTokens,
                  })
                return Effect.void
              }),
            ).then(() => undefined),
          log: (message, fields) => void bridge.fork(Effect.logInfo(message, fields)),
        })
      }
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // The model the message transform sees, with any image cap this endpoint has
      // already refused this session applied to it. Identity until an endpoint has
      // said "at most N images"; only `limit.images` ever differs.
      const capped = SessionImageCap.clamp(input.sessionID, input.model)

      // Runtime seam: native is a per-family route over @origami/llm (see
      // native-route.ts for the table). It either returns a ready LLMEvent
      // stream or a concrete fallback reason.
      if (LLMNativeRoute.enabled(input.model, flags)) {
        const native = LLMNativeRuntime.stream({
          model: capped,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          // Same split as the AI SDK's `activeTools` below: the repair-only
          // `invalid` tool can be dispatched to but is never offered.
          activeTools: SessionPromptCapture.offeredToolNames(prepared.tools),
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          frequencyPenalty: prepared.params.frequencyPenalty,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
          // Identity for the per-provider concurrency cap: which row a queue wait
          // is reported on, and whether this step is a parent (no parentSessionID)
          // and therefore takes priority in the permit queue.
          sessionID: input.sessionID,
          ...(input.parentSessionID ? { parentSessionID: input.parentSessionID } : {}),
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            // Everything past the tool-name casing fix is a JSON syntax failure:
            // every tool is built with `jsonSchema(plainObject)`, whose `validate`
            // is undefined, so the SDK only reaches this hook when it could not
            // parse the input at all. Shape repair belongs in Tool.wrap, which sees
            // the parsed arguments.
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          frequencyPenalty: prepared.params.frequencyPenalty,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: SessionPromptCapture.offeredToolNames(prepared.tools),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      capped,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            // The think-tag scanner holds a trailing partial tag back until the next
            // chunk proves it was prose, and nothing inside the adapter runs again
            // when a stream ends with no `finish` or fails mid-reply. Drain on both
            // exits so the held characters land in the text block that is still
            // open; `drain` resets the scanner, so the two cannot double-emit.
            const drained = () => Stream.fromIterable(LLMAISDK.drain(state))
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
              Stream.concat(Stream.suspend(drained)),
              Stream.catchCause((cause) => drained().pipe(Stream.concat(Stream.failCause(cause)))),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
  ],
})

export * as LLM from "./llm"

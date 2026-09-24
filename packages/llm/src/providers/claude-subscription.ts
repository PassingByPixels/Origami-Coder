import { Effect, Schema } from "effect"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { Protocol } from "../route/protocol"
import { ClaudeCli, type Options as ClaudeCliOptions } from "../route/transport/claude-cli"
import * as AnthropicMessages from "../protocols/anthropic-messages"
import * as ProviderShared from "../protocols/shared"
import { ProviderID, Usage, type LLMEvent, type ModelID } from "../schema"

/**
 * Claude through the owner's Claude subscription: the Anthropic Messages
 * protocol over the `claude-cli` process transport. Origami drives the turn;
 * the installed CLI is only the model client. Never shares the `anthropic`
 * API-key facade or its auth.
 */
export const id = ProviderID.make("claude-subscription")

/** Not a URL anything is sent to: the transport spawns a process. `Route.model` needs a base. */
const PROCESS_BASE = "process://claude-cli"

/**
 * The Anthropic decoder with one addition: `message_delta` carries
 * `usage.output_tokens_details.thinking_tokens`, and the plain decoder drops it
 * (thinking bills inside `output_tokens`). This route reports it as
 * `reasoningTokens` so the gauge and the Labyrinth can show it. The shared
 * decoder is left alone: the anthropic family's parity cassettes pin it.
 */
const decodeEvent = Schema.decodeUnknownEffect(AnthropicMessages.protocol.stream.event)

const thinkingTokens = (frame: string) => {
  // Runs after the frame decoded, so it is JSON.
  const value: unknown = JSON.parse(frame)
  if (!ProviderShared.isRecord(value) || value.type !== "message_delta" || !ProviderShared.isRecord(value.usage))
    return undefined
  const details = value.usage.output_tokens_details
  const count = ProviderShared.isRecord(details) ? details.thinking_tokens : undefined
  return typeof count === "number" ? count : undefined
}

const withReasoning = (event: LLMEvent, reasoningTokens: number): LLMEvent => {
  if ((event.type !== "step-finish" && event.type !== "finish") || !event.usage) return event
  return { ...event, usage: new Usage({ ...event.usage, reasoningTokens }) }
}

type State = ReturnType<typeof AnthropicMessages.protocol.stream.initial>

export const protocol = Protocol.make({
  id: AnthropicMessages.protocol.id,
  body: AnthropicMessages.protocol.body,
  stream: {
    event: Schema.String,
    initial: AnthropicMessages.protocol.stream.initial,
    step: (state: State, frame: string) =>
      decodeEvent(frame).pipe(
        Effect.mapError(() => ProviderShared.eventError("claude-cli", "Invalid claude-cli stream event", frame)),
        Effect.flatMap((event) => AnthropicMessages.protocol.stream.step(state, event)),
        Effect.map(([next, events]) => {
          const reasoning = thinkingTokens(frame)
          return [
            next,
            reasoning === undefined ? events : events.map((event) => withReasoning(event, reasoning)),
          ] as const
        }),
      ),
    onHalt: AnthropicMessages.protocol.stream.onHalt,
  },
})

export type Config = RouteDefaultsInput & ClaudeCliOptions

export const route = (options: ClaudeCliOptions) =>
  Route.make({
    id: "claude-cli",
    provider: id,
    protocol,
    endpoint: Endpoint.path("/messages", { baseURL: PROCESS_BASE }),
    auth: Auth.none,
    transport: ClaudeCli.transport(options),
  })

export const configure = (input: Config) => {
  const { command, mcpCommand, idleTimeoutMs, env, ...defaults } = input
  const configured = route({ command, mcpCommand, idleTimeoutMs, env }).with(defaults)
  return {
    id,
    model: (modelID: string | ModelID) => configured.model({ id: modelID }),
    configure,
  }
}

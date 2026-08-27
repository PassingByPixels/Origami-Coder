import { PermissionV1 } from "@origami/core/v1/permission"
import { Effect, Schema } from "effect"
import { SessionV1 } from "@origami/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { ToolJsonSchema } from "./json-schema"
import { ToolNormalize } from "./normalize"
import { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. This is the canonical "rewrite the input" tool error: the typed
 * error class makes it matchable upstream, and its `message` getter produces
 * the model-facing prose that the AI SDK feeds back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: unknown): string
  /**
   * Refuse a call carrying a top-level key this tool does not declare, instead
   * of letting the decoder drop it. OFF by default, and deliberately per-tool:
   * for a tool whose parameters are all required an excess key is harmless,
   * because the decode fails on the missing ones anyway. It matters for a tool
   * whose OPTIONAL fields can go missing without the call failing — chart,
   * where a `xLabels` no alias rule could place is dropped, the chart draws
   * unlabelled, and the answer comes back ok:true with nothing said.
   */
  rejectUnknownKeys?: boolean
  /**
   * This builtin is safe to hide behind the `tool_search` catalog: the model
   * sees its name and one line of description, and pays for its schema only
   * after searching for it. OFF by default and deliberately per-tool — a tool
   * the loop cannot function without (read, edit, shell) must never be a
   * catalog line, and MCP tools get the same treatment from config instead,
   * since they have no Def to mark.
   */
  deferrable?: boolean
  /**
   * Where this tool's definition lives, for a shell that wants to show or
   * link to it (t-kgtaac round 3, the Tools pane's source badge). Left
   * undefined by every BUILTIN — registry.ts sets it only on a tool it built
   * from `custom` (a `.origami/tool/*.ts` file or a plugin's `tool` map), so
   * "undefined" is read as "builtin" by every consumer rather than repeating
   * that literal at each of the ~25 builtin call sites.
   */
  source?: "user-file" | "plugin"
  /**
   * Absolute path to the file this tool was scanned from. Set only alongside
   * `source: "user-file"` — a plugin tool has no file of its own to point at,
   * the plugin package does — and it is what the Tools pane's copy-path
   * button hands to an agent.
   */
  location?: string
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      // What THIS tool declares: its JSON Schema and the top-level key names
      // taken from it, resolved once on first use like the parser above. An
      // exotic schema the converter cannot handle throws, and neither the key
      // list nor the corrective message is worth failing a call over, so a
      // throw degrades to "no schema" and normalisation only unwraps.
      let declared: { schema: unknown; keys: readonly string[] } | undefined
      const parameters = () => {
        if (!declared) {
          let schema: unknown
          try {
            schema = toolInfo.jsonSchema ?? ToolJsonSchema.fromSchema(toolInfo.parameters as Schema.Top)
          } catch {
            schema = undefined
          }
          declared = { schema, keys: ToolNormalize.parameterKeys(schema) }
        }
        return declared
      }
      // Effect's formatter names the offending path; this names the flat keys
      // the tool actually wants, which is what the model needs to rewrite the
      // call. Built from the payload the DECODER saw: by then the wrapper is
      // gone and the aliases are applied, so a sentence built from the args as
      // sent reports the keys normalisation already fixed as missing.
      const expectation = (input: unknown) => ToolNormalize.describeExpectedInput(id, parameters().schema, input)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          // Untyped → typed boundary, and the ONLY structural guard on either
          // runtime: the AI SDK builds tools with `jsonSchema(plainObject)`,
          // whose `validate` is undefined, so it rejects unparseable JSON and
          // nothing else — a wrapper or a snake_case key reaches this line
          // unexamined. Models routinely send the right values in the wrong
          // shape, so repair it here, bounded by this tool's own parameters.
          const normalized = ToolNormalize.normalizeToolInput(args, { keys: parameters().keys })
          // The opt-in second guard, for a tool that cannot afford a dropped
          // key. It has to be its own check: the decoder drops an excess key
          // and SUCCEEDS whenever the tool's remaining fields are optional, so
          // the corrective message below — which lives in the decode-failure
          // branch — can never fire for that call. Runs after normalisation, so
          // only a key no alias rule could place gets here.
          const unknown = toolInfo.rejectUnknownKeys
            ? ToolNormalize.unrecognisedKeys(normalized, parameters().keys)
            : []
          if (unknown.length > 0) {
            return yield* Effect.fail(
              new InvalidArgumentsError({
                tool: id,
                detail: [
                  `it does not declare ${unknown.length === 1 ? "the key" : "the keys"} ${unknown.join(", ")}`,
                  expectation(normalized),
                ]
                  .filter(Boolean)
                  .join(". "),
              }),
            )
          }
          const decoded = yield* decode(normalized).pipe(
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: [
                    toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
                    expectation(normalized),
                  ]
                    .filter(Boolean)
                    .join(" "),
                }),
            ),
          )
          const result = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx)
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      return toolInfo
    })
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

export * as Tool from "./tool"

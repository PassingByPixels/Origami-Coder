import { Agent } from "@/agent/agent"
import { SessionV1 } from "@origami/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { McpElicitation } from "@/mcp/elicitation"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { ToolSearch } from "@/tool/tool-search"
import { ToolEnabled } from "@/tool/tool-enabled"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { isRecord } from "@/util/record"
import { RuntimeFlags } from "@/effect/runtime-flags"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  /**
   * Tools this ONE turn adds, outside the registry: the collab flock tools,
   * injected only when the turn is a collab turn. They go through the same
   * wrapper as every registry tool, so they get argument decoding, output
   * truncation, the abort signal and the plugin hooks for free - a
   * hand-rolled `tool()` here would quietly have none of that.
   */
  extraTools?: readonly Tool.Def[]
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const sessions = yield* Session.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const flags = yield* RuntimeFlags.Service
  const search = yield* ToolSearch.Service
  const config = yield* Config.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      Effect.gen(function* () {
        // The session ruleset is read HERE, per tool call, not from the snapshot
        // the turn started with. Approve/YOLO writes land on the session store
        // mid-turn (acp setPermissionMode writes the preset rules onto the row
        // itself; an ordinary prompt's `tools` map rewrites them), and a turn
        // that closed over its opening ruleset kept prompting for the rest of
        // the turn - the button visibly did nothing until the user sent another
        // message. One row read per ask.
        const live = yield* sessions.get(input.session.id).pipe(Effect.orDie)
        return yield* permission.ask({
          ...req,
          sessionID: input.session.id,
          // Read off the LIVE row, like the ruleset above. Its presence is what
          // tells the permission service this ask has no window of its own and
          // must not wait forever - see `Permission.ask`.
          parentSessionID: live.parentID,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, live.permission ?? []),
        })
      }).pipe(Effect.orDie),
  })

  const resolved = yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    permission: input.session.permission,
    // The chat's OWN vision profile, read off the session row rather than off
    // the turn's arming gate: the roster question is "may the model delegate to
    // this profile", which is answered by the user having picked one, not by
    // whether this particular turn also carries a picture.
    visionProfile: Session.visionProfile(input.session),
  })

  // Deferred tool catalog (t-kgtaac). A deferred tool is left OUT of the map
  // built below and advertised as one line on `tool_search` instead, so its
  // schema costs nothing until the model asks for it. Two facts make that
  // safe: this resolve runs once per STEP of the agent loop (session/prompt.ts
  // calls it inside `while (true)`), so a tool found on step N is callable on
  // step N+1 of the same turn; and the loaded ids are session state, so it
  // stays callable for every later turn without searching again.
  //
  // Code mode replaces the whole MCP tool list with one `execute` tool, so
  // there is nothing left to defer there — the empty record below is what
  // keeps the two features from fighting over the same tools.
  const mcpEntries = flags.experimentalCodeMode ? {} : yield* mcp.tools()

  // OFF (`tools: { <id>: false }`) is applied HERE, before the deferral
  // decision, and that order is the whole point: a switched-off tool must not
  // become a `tool_search` catalog line either, or "off" would mean "one line
  // cheaper and still callable". Off is absence.
  //
  // Registry tools and MCP tools both go through it — those are the two
  // populations a user can name. `input.extraTools` deliberately does NOT:
  // the collab flock tools are injected for the duration of one collab turn
  // and never appear in any catalog, so the only thing a pattern could do
  // there is break a running flock from a config file that never listed them.
  const off = ToolEnabled.offPatterns(yield* config.get())
  const offered = ToolEnabled.keepEnabled(resolved, off)
  const mcpOffered = Object.fromEntries(
    Object.entries(mcpEntries).filter(([id]) => !ToolEnabled.isOff(id, off)),
  ) as typeof mcpEntries

  const searchSettings = yield* search.settings()
  const hidden = new Set(
    ToolSearch.deferred(
      [
        ...offered.map((item) => ({
          id: item.id,
          kind: "builtin" as const,
          ...(item.deferrable ? { deferrable: true } : {}),
        })),
        ...Object.keys(mcpOffered).map((id) => ({ id, kind: "mcp" as const })),
      ],
      searchSettings,
      yield* search.loaded(input.session.id),
    ),
  )
  const catalog: { candidate: ToolSearch.Candidate; schema: JSONSchema7 }[] = []

  for (const item of [...offered, ...(input.extraTools ?? [])]) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    if (hidden.has(item.id)) {
      catalog.push({ candidate: candidateOf(item.id, "builtin", item.description, schema), schema })
      continue
    }
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    tools[MCP_RESOURCE_TOOLS.list] = tool({
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Optional MCP server name. When omitted, lists resources from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(parsed.server))
            const filtered = resources
              .filter((resource) => !parsed.server || resource.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.listTemplates] = tool({
      description:
        "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "Optional MCP server name. When omitted, lists resource templates from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const templates = Object.values(yield* mcp.resourceTemplates(parsed.server))
            const filtered = templates
              .filter((template) => !parsed.server || template.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
                ),
              )
            const content = JSON.stringify({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.read] = tool({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "MCP server name exactly as returned by list_mcp_resources.",
            },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseReadMcpResourceArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  for (const [key, entry] of Object.entries(mcpOffered)) {
    const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout)
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    if (hidden.has(key)) {
      catalog.push({ candidate: candidateOf(key, "mcp", item.description ?? "", transformed), schema: transformed })
      continue
    }
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask(pluginAsk(entry.plugin, entry.def.name) ?? mcpAsk(key))
            // An MCP elicitation surfaces INSIDE this call (the SDK fulfils
            // `input_required` before `callTool` resolves), so the session it
            // belongs to has to be established here — see mcp/elicitation.ts.
            return yield* Effect.promise(() =>
              McpElicitation.withCaller(
                { sessionID: ctx.sessionID, messageID: input.processor.message.id, callID: opts.toolCallId },
                () => execute(args, opts),
              ),
            )
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                const mime = resource.mimeType ?? "application/octet-stream"
                const size = base64Size(resource.blob)
                if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
                  )
                  continue
                }
                if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                  )
                  continue
                }
                attachments.push({
                  type: "file",
                  mime,
                  url: `data:${mime};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  // The one tool that pays for all the ones above it. Offered only when
  // something is actually deferred: an empty catalog would be a tool whose
  // every call can only answer "there is nothing to find".
  if (catalog.length > 0) {
    const candidates = catalog.map((entry) => entry.candidate)
    const schemas = new Map(catalog.map((entry) => [entry.candidate.id, entry.schema]))
    tools[ToolSearch.TOOL_SEARCH_TOOL] = tool({
      description: ToolSearch.describe(candidates),
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "What you need the tool to do, in words: the intent plus the key nouns. An empty string lists the catalog.",
            },
            limit: {
              type: "integer",
              description: `How many tools to load. Defaults to ${ToolSearch.DEFAULT_SEARCH_LIMIT}, capped at ${ToolSearch.MAX_SEARCH_LIMIT}.`,
            },
          },
          required: ["query"],
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseToolSearchArgs(args)
            const ctx = context(toRecord(args), opts)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: ToolSearch.TOOL_SEARCH_TOOL, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            const matched = ToolSearch.rank(candidates, parsed.query, parsed.limit)
            // Written BEFORE the reply is rendered: the next step re-runs this
            // whole resolve, and it is the session state - not this output -
            // that decides whether the tool is in the map by then.
            yield* search.load(
              input.session.id,
              matched.map((entry) => entry.id),
            )
            const text = ToolSearch.report(
              matched.map((entry) => ({ candidate: entry, schema: schemas.get(entry.id) })),
              parsed.query,
              candidates.length - matched.length,
            )
            const truncated = yield* truncate.output(text, {}, input.agent)
            const output = {
              title:
                matched.length > 0
                  ? `Loaded ${matched.length} tool${matched.length === 1 ? "" : "s"}`
                  : `No tool matched "${parsed.query}"`,
              metadata: {
                query: parsed.query,
                loaded: matched.map((entry) => entry.id),
                deferred: candidates.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: ToolSearch.TOOL_SEARCH_TOOL, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  return tools
})

type Ask = Parameters<Tool.Context["ask"]>[0]

/**
 * Permission shape for an MCP tool that an agent-plugins.org plugin supplied.
 *
 * The plain MCP gate is `mcpAsk` below: `permission` is the flattened tool key
 * and the pattern is `*`, so a rule can name one exact tool or every tool and
 * nothing in between. A plugin needs the middle - one decision covering the
 * whole package. So plugin tools follow the convention the MCP RESOURCE tools
 * already use in this file (`permission: "read"`, `patterns: ["mcp:<server>:*"]`):
 * the permission names the CATEGORY, the pattern names the TARGET. That is what
 * lets `permission: { plugin: { "plugin:qwen-mm-plugins-blender:*": "allow" } }`
 * mean "trust this plugin" without also meaning "trust every plugin".
 *
 * `always` widens to the whole plugin on purpose. Approving one Blender tool and
 * then being asked again for each of the other twenty-one is the behaviour users
 * report as the prompt being broken.
 */
function pluginAsk(plugin: string | undefined, tool: string): Ask | undefined {
  if (!plugin) return undefined
  return {
    permission: "plugin",
    metadata: { plugin, tool },
    patterns: [`plugin:${plugin}:${tool}`],
    always: [`plugin:${plugin}:*`],
  }
}

function mcpAsk(key: string): Ask {
  return { permission: key, metadata: {}, patterns: ["*"], always: ["*"] }
}

/** A catalog entry with its search haystack built from the schema it is hiding. */
function candidateOf(
  id: string,
  kind: ToolSearch.Kind,
  description: string,
  schema: JSONSchema7,
): ToolSearch.Candidate {
  return {
    id,
    kind,
    description,
    text: ToolSearch.searchText(id, description, schema.properties as Record<string, unknown> | undefined),
  }
}

function parseToolSearchArgs(value: unknown) {
  const args = toRecord(value)
  const raw = args["limit"]
  return {
    query: typeof args["query"] === "string" ? args["query"] : "",
    ...(typeof raw === "number" && Number.isFinite(raw) ? { limit: raw } : {}),
  }
}

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"

import { LayerNode } from "@origami/core/effect/layer-node"
import { httpClient } from "@origami/core/effect/app-node-platform"
import { AppProcess } from "@origami/core/process"
import { Ripgrep } from "@origami/core/ripgrep"
import { Git } from "@/git"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { FileTool } from "./file"
import { GitDiffTool } from "./git-diff"
import { GoalTool } from "./goal"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { WikiRelatedTool, WikiSearchTool } from "./wiki"
import { ProcessTool } from "./process"
import { SessionSearchTool } from "./session-search"
import { RememberTool } from "./remember"
import { DreamTool } from "./dream"
import {
  BoardCreateTool,
  BoardRegisterTool,
  BoardReposTool,
  BoardTicketsTool,
  BoardUpdateTool,
  BoardWorktreesTool,
} from "./board"
import { ListAgentsTool, SendMessageTool } from "./agents"
import { BrowserTool } from "./browser"
import { ChartTool } from "./chart"
import { ReadTool } from "./read"
import { ScreenshotTool } from "./screenshot"
import { TaskTool } from "./task"
import { TaskStopTool } from "./task_stop"
import { TaskListTool } from "./task_list"
import { Database } from "@origami/core/database/database"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@origami/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { WebSearchTool } from "./websearch"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@origami/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { FSUtil } from "@origami/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { FlockRouting } from "@/flock/routing"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { Interject } from "@/origami/interject" // origami_change
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@origami/core/v1/permission"
import { McpCatalog } from "@/mcp/catalog"

export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) {
  return providerID === ProviderV2.ID.opencode || flags.exa || flags.parallel
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

/**
 * A user tool FILE that was found but did not load, kept so the user can see
 * why. Mirrors `AgentPlugins.Problem` — same shape, same reason: a file that
 * was skipped must be able to say WHICH file and WHAT went wrong, or the user
 * is left with a tool that silently is not there.
 *
 * `file` is the absolute path the glob found. It is the user's OWN file, so it
 * is safe to show verbatim in the client — see the redaction note in
 * `acp/service.ts`.
 */
export type ToolProblem = {
  readonly file: string
  readonly message: string
}

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  problems: ToolProblem[]
  task: TaskDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  /** User tool files that were found but failed to load. Empty when all loaded. */
  readonly problems: () => Effect.Effect<ToolProblem[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
    /**
     * The chat's VISION PROFILE slug, or undefined. The only hidden agent the
     * task roster is allowed to name - see `describeTask`.
     */
    visionProfile?: string
  }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@origami/ToolRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const mcp = yield* MCP.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const taskStop = yield* TaskStopTool
    const taskList = yield* TaskListTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const goaltool = yield* GoalTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const filetool = yield* FileTool
    const processtool = yield* ProcessTool
    const gitdifftool = yield* GitDiffTool
    const greptool = yield* GrepTool
    const wikisearch = yield* WikiSearchTool
    const wikirelated = yield* WikiRelatedTool
    const sessionsearch = yield* SessionSearchTool
    const remembertool = yield* RememberTool
    const dreamtool = yield* DreamTool
    const boardrepos = yield* BoardReposTool
    const boardtickets = yield* BoardTicketsTool
    const boardcreate = yield* BoardCreateTool
    const boardupdate = yield* BoardUpdateTool
    const boardregister = yield* BoardRegisterTool
    const boardworktrees = yield* BoardWorktreesTool
    const listagents = yield* ListAgentsTool
    const sendmessage = yield* SendMessageTool
    const browsertool = yield* BrowserTool
    const screenshottool = yield* ScreenshotTool
    const charttool = yield* ChartTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const agent = yield* Agent.Service
    const codeMode = flags.experimentalCodeMode ? yield* Effect.promise(() => import("./code-mode")) : undefined
    const codeModeTool = codeMode ? yield* codeMode.CodeModeTool : undefined

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(
          id: string,
          def: ToolDefinition,
          origin?: { source: "user-file" | "plugin"; location?: string },
        ): Tool.Def {
          // Plugin tools still expose Zod args publicly; keep that compatibility
          // boxed at the registry boundary and give the LLM the original JSON Schema.
          // Normalize missing args to `{}` once — pre-1.14.49 the code was
          // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
          const args = def.args ?? {}
          const entries = Object.entries(args)
          const allZod = entries.every((entry) => isZodType(entry[1]))
          const zodParams = allZod ? z.object(args) : undefined
          const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
          const parameters = zodParams
            ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
            : Schema.Unknown
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            ...(origin ? { source: origin.source, ...(origin.location ? { location: origin.location } : {}) } : {}),
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                // Bridge the host's Effect-based `ask` into a Promise-returning
                // function for the plugin to make sure context persists
                const bridge = yield* EffectBridge.make()
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => bridge.promise(toolCtx.ask(req)),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const attachments = typeof result === "string" ? undefined : result.attachments
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: typeof result === "string" ? "" : (result.title ?? ""),
                  output: out.truncated ? out.content : output,
                  attachments,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        const problems: ToolProblem[] = []
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          //
          // ONE BAD FILE MUST NOT TAKE THE WORKSPACE DOWN. An unresolvable import,
          // a syntax error and a throw at module init all REJECT this promise, and
          // `Effect.promise` turns a rejection into a DEFECT — which escaped
          // `ToolRegistry.state` and so killed every caller of it: `all()`, `ids()`,
          // `tools()`, and through `SessionTools.resolve` the whole of
          // `SessionPrompt.run`. The observed symptom was every prompt in the
          // workspace failing with a redacted "Origami service failure" and the
          // Tools pane answering "Could not read the tool list" — all from one file
          // the user had just scaffolded from that same pane.
          //
          // The file is skipped and RECORDED instead. `problems` is what the Tools
          // pane renders, so the failure is visible where the user created it,
          // exactly as the Plugins pane already does for a plugin that would not
          // load (agent-plugins/index.ts).
          const loaded = yield* Effect.tryPromise({
            try: () => import(pathToFileURL(match).href) as Promise<Record<string, unknown>>,
            catch: (cause) => cause,
          }).pipe(
            Effect.map((mod) => ({ ok: true as const, mod })),
            Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
          )
          if (!loaded.ok) {
            const message = loaded.cause instanceof Error ? loaded.cause.message : String(loaded.cause)
            yield* Effect.logWarning("user tool skipped", { file: match, reason: message })
            problems.push({ file: match, message })
            continue
          }
          for (const [id, def] of Object.entries(loaded.mod)) {
            if (!isPluginTool(def)) continue
            custom.push(
              fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def, {
                source: "user-file",
                location: match,
              }),
            )
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def, { source: "plugin" }))
          }
        }

        yield* config.get()
        // "acp" (the VS Code shell) surfaces questions via acp/question.ts ->
        // the ACP permission-prompt channel (same path plan_exit already uses),
        // so the model-facing question tool is safe to enable here too.
        const questionEnabled = ["app", "cli", "desktop", "acp"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          wiki_search: Tool.init(wikisearch),
          wiki_related: Tool.init(wikirelated),
          sessionSearch: Tool.init(sessionsearch),
          remember: Tool.init(remembertool),
          dream: Tool.init(dreamtool),
          board_repos: Tool.init(boardrepos),
          board_tickets: Tool.init(boardtickets),
          board_create: Tool.init(boardcreate),
          board_update: Tool.init(boardupdate),
          board_register: Tool.init(boardregister),
          board_worktrees: Tool.init(boardworktrees),
          list_agents: Tool.init(listagents),
          send_message: Tool.init(sendmessage),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          file: Tool.init(filetool),
          process: Tool.init(processtool),
          git_diff: Tool.init(gitdifftool),
          task: Tool.init(task),
          task_stop: Tool.init(taskStop),
          task_list: Tool.init(taskList),
          fetch: Tool.init(webfetch),
          browser: Tool.init(browsertool),
          screenshot: Tool.init(screenshottool),
          chart: Tool.init(charttool),
          todo: Tool.init(todo),
          goal: Tool.init(goaltool),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          ...(codeModeTool ? { execute: Tool.init(codeModeTool) } : {}),
        })

        return {
          custom,
          problems,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.wiki_search,
            tool.wiki_related,
            tool.sessionSearch,
            tool.remember,
            ...(questionEnabled ? [tool.dream] : []),
            tool.board_repos,
            tool.board_tickets,
            tool.board_create,
            tool.board_update,
            tool.board_register,
            tool.board_worktrees,
            tool.list_agents,
            tool.send_message,
            tool.edit,
            tool.write,
            tool.file,
            tool.process,
            tool.git_diff,
            tool.task,
            // Background task control — only useful (and only offered) when
            // background subagents are enabled, so gate on the same flag.
            ...(flags.experimentalBackgroundSubagents ? [tool.task_stop, tool.task_list] : []),
            tool.fetch,
            tool.browser,
            // The chart tool is offered to every client. The VS Code shell drives
            // the engine over `origami acp`, which stamps ORIGAMI_CLIENT="acp"
            // (cli/cmd/acp.ts), and the renderer lives in packages/vscode/ only.
            // On a TUI/CLI client the tool still completes with SVG text output
            // (ok:true, no picture card) — better than the tool being invisible.
            tool.chart,
            // Offered to every client, like chart: the capture happens in the
            // ENGINE process (PowerShell / screencapture), not in the shell, so
            // it works wherever the engine runs a desktop session — the VS Code
            // client is not a prerequisite the way it is for `browser`.
            tool.screenshot,
            tool.todo,
            tool.goal,
            tool.search,
            tool.skill,
            tool.patch,
            ...(tool.execute ? [tool.execute] : []),
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && (flags.client === "cli" || flags.client === "acp") ? [tool.plan] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const problems: Interface["problems"] = Effect.fn("ToolRegistry.problems")(function* () {
      return (yield* InstanceState.get(state)).problems
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (
      agent: Agent.Info,
      visionProfile?: string,
    ) {
      const items = (yield* agents.list()).filter((item) => {
        if (item.mode === "primary") return false
        // HIDDEN MEANS HIDDEN. `hidden: true` is what the Agents pane stamps on
        // every collab bot and every vision profile, and session/prompt.ts:393
        // already filters on exactly this field when it lists the agents a
        // mistyped `task` call could have meant. The roster did not, so a
        // dozen character defs the user never meant as subagents were offered
        // to the model as delegation targets - most of them with no
        // description at all.
        if (item.hidden === true) return isVisionProfile(item, visionProfile)
        return true
      })
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list.map((item) => `- ${item.name}: ${describeAgent(item, visionProfile)}`).join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const describeCodeMode = Effect.fn("ToolRegistry.describeCodeMode")(function* (input: {
      agent: Agent.Info
      permission?: PermissionV1.Ruleset
    }) {
      if (!codeMode) return
      const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
      const tools = Permission.visibleTools(yield* mcp.tools(), ruleset)
      if (Object.keys(tools).length === 0) return
      return codeMode.describeCatalog(tools, Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize))
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const filtered = (yield* all()).filter((tool) => {
        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      const codeModeDescription = filtered.some((tool) => tool.id === "execute")
        ? yield* describeCodeMode(input)
        : undefined
      const visible = filtered.filter((tool) => tool.id !== "execute" || codeModeDescription)

      return yield* Effect.forEach(
        visible,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          return {
            id: tool.id,
            description: [
              output.description,
              tool.id === TaskTool.id ? yield* describeTask(input.agent, input.visionProfile) : undefined,
              tool.id === "execute" ? codeModeDescription : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
            // Carried through deliberately: this projection REBUILDS the def,
            // so a field it forgets is a field the session layer never sees —
            // and a tool marked deferrable would silently stay in every prompt.
            deferrable: tool.deferrable,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, problems, tools })
  }),
)

/**
 * What a roster line says when the definition said nothing.
 *
 * The old code reached for this with `??`, which only catches an ABSENT
 * description - so a def whose `description:` was written empty rendered as
 * `- name: ` with nothing after the colon. A roster line that names an agent
 * and then says nothing about it is worse than no line: the model has a
 * delegation target it cannot judge.
 */
const TASK_DESCRIPTION_FALLBACK = "This subagent should only be called manually by the user."

/**
 * The line the RE-ADMITTED VISION PROFILE gets, synthesized rather than read
 * off the def.
 *
 * A vision profile's own `description:` is written for the Agents pane ("Reads
 * screenshots") and says nothing about how to use it or what comes back. This
 * says the three things the calling model cannot work out for itself: that it
 * is blind, that a path or an attachment is the input, and that the reply is
 * words - so it does not sit waiting for a picture that is never coming.
 */
const VISION_PROFILE_TASK_DESCRIPTION = [
  "Your model cannot see images.",
  "Send it a path or an attached image and ask what it shows —",
  "say exactly what you need read out (text verbatim, colours, layout).",
  "It replies in words; you never receive the picture.",
].join(" ")

/** The one hidden def the roster may name: the chat's OWN vision profile. Both
 *  halves are required - the name alone would let any hidden def called
 *  `vision-eye` in, and the option alone would name every profile on disk when
 *  the user picked one. */
function isVisionProfile(item: Agent.Info, visionProfile: string | undefined): boolean {
  if (!visionProfile) return false
  return item.name === visionProfile && Boolean(item.options["vision-profile"])
}

function describeAgent(item: Agent.Info, visionProfile: string | undefined): string {
  if (isVisionProfile(item, visionProfile)) return VISION_PROFILE_TASK_DESCRIPTION
  return (item.description ?? "").trim() || TASK_DESCRIPTION_FALLBACK
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Config.node,
    Plugin.node,
    Question.node,
    Todo.node,
    Agent.node,
    // The registry itself asks Flock nothing since E1, but the task tool it
    // builds still resolves the subagent binding through it.
    FlockRouting.node,
    Skill.node,
    Session.node,
    BackgroundJob.node,
    Interject.node, // origami_change
    Provider.node,
    LSP.node,
    Instruction.node,
    FSUtil.node,
    EventV2Bridge.node,
    httpClient,
    CrossSpawnSpawner.node,
    Format.node,
    Truncate.node,
    RuntimeFlags.node,
    MCP.node,
    Database.node,
    Ripgrep.node,
    Git.node,
    AppProcess.node,
  ],
})

export * as ToolRegistry from "./registry"

import { LayerNode } from "@origami/core/effect/layer-node"
import { httpClient } from "@origami/core/effect/app-node-platform"
import { AppProcess } from "@origami/core/process"
import { Ripgrep } from "@origami/core/ripgrep"
import { Git } from "@/git"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { QuestionReplyTool } from "./question-reply"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { FileTool } from "./file"
import { GitDiffTool } from "./git-diff"
import { GoalTool } from "./goal"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { WikiRelatedTool, WikiSearchTool } from "./wiki"
import { FlockAskTool, FlockReplyTool, FlockWhoTool } from "./flock"
import { ProcessTool } from "./process"
import { SessionSearchTool } from "./session-search"
import { RememberTool } from "./remember"
import { SideQuestTool } from "./side-quest"
import { DreamTool } from "./dream"
import {
  BoardCreateTool,
  BoardRegisterTool,
  BoardReposTool,
  BoardTicketsTool,
  BoardUpdateTool,
  BoardWorktreesTool,
} from "./board"
import { ArtifactDiffTool, ArtifactGetTool, ArtifactListTool, ArtifactPublishTool } from "./artifact"
import { WebmcpCallTool, WebmcpLaunchTool, WebmcpListTool, WebmcpNoteTool, WebmcpToolsTool } from "./webmcp"
import { ListAgentsTool, SendMessageTool } from "./agents"
import { BrowserTool } from "./browser"
import { ChartTool } from "./chart"
import { ReadTool } from "./read"
import { ScreenshotTool } from "./screenshot"
import { ShowImageTool } from "./show-image"
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
import { McpBrowser } from "@/mcp/browser"
import { WebMcpBridge } from "@/webmcp/bridge"
import { PermissionV1 } from "@origami/core/v1/permission"
import { McpCatalog } from "@/mcp/catalog"

export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) {
  return providerID === ProviderV2.ID.opencode || flags.exa || flags.parallel
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

/**
 * A user tool file that was found but did not load, kept so the user can see
 * why. Mirrors `AgentPlugins.Problem`. `file` is the absolute path the glob
 * found; it is the user's own file, so it is safe to show verbatim in the
 * client — see the redaction note in `acp/service.ts`.
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
     * The chat's vision profile slug, or undefined. The only hidden agent the
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
    const questionReply = yield* QuestionReplyTool
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
    const flockwho = yield* FlockWhoTool
    const flockask = yield* FlockAskTool
    const flockreply = yield* FlockReplyTool
    const wikisearch = yield* WikiSearchTool
    const wikirelated = yield* WikiRelatedTool
    const sessionsearch = yield* SessionSearchTool
    const remembertool = yield* RememberTool
    const sidequesttool = yield* SideQuestTool
    const dreamtool = yield* DreamTool
    const boardrepos = yield* BoardReposTool
    const boardtickets = yield* BoardTicketsTool
    const boardcreate = yield* BoardCreateTool
    const boardupdate = yield* BoardUpdateTool
    const boardregister = yield* BoardRegisterTool
    const boardworktrees = yield* BoardWorktreesTool
    const artifactpublish = yield* ArtifactPublishTool
    const artifactlist = yield* ArtifactListTool
    const artifactget = yield* ArtifactGetTool
    const artifactdiff = yield* ArtifactDiffTool
    const webmcplist = yield* WebmcpListTool
    const webmcplaunch = yield* WebmcpLaunchTool
    const webmcptools = yield* WebmcpToolsTool
    const webmcpcall = yield* WebmcpCallTool
    const webmcpnote = yield* WebmcpNoteTool
    const listagents = yield* ListAgentsTool
    const sendmessage = yield* SendMessageTool
    const browsertool = yield* BrowserTool
    const screenshottool = yield* ScreenshotTool
    const showimagetool = yield* ShowImageTool
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
          // Missing args normalise to `{}` — Zod no longer tolerates undefined.
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
                // function so context persists across the plugin call.
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
          // `match` is an absolute filesystem path, so import it as `file://` or
          // Node on Windows rejects the dynamic import.
          //
          // One bad file must not take the workspace down. An unresolvable
          // import, a syntax error and a throw at module init all reject this
          // promise, and `Effect.promise` would turn that into a defect escaping
          // `ToolRegistry.state` — killing `all()`, `ids()`, `tools()` and the
          // whole of `SessionPrompt.run`. Skip and record instead; `problems` is
          // what the Tools pane renders.
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
        // the ACP permission-prompt channel, so the question tool is safe here.
        const questionEnabled = ["app", "cli", "desktop", "acp"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          flock_who: Tool.init(flockwho),
          flock_ask: Tool.init(flockask),
          flock_reply: Tool.init(flockreply),
          wiki_search: Tool.init(wikisearch),
          wiki_related: Tool.init(wikirelated),
          sessionSearch: Tool.init(sessionsearch),
          remember: Tool.init(remembertool),
          side_quest: Tool.init(sidequesttool),
          dream: Tool.init(dreamtool),
          board_repos: Tool.init(boardrepos),
          board_tickets: Tool.init(boardtickets),
          board_create: Tool.init(boardcreate),
          board_update: Tool.init(boardupdate),
          board_register: Tool.init(boardregister),
          board_worktrees: Tool.init(boardworktrees),
          artifact_publish: Tool.init(artifactpublish),
          artifact_list: Tool.init(artifactlist),
          artifact_get: Tool.init(artifactget),
          artifact_diff: Tool.init(artifactdiff),
          webmcp_list: Tool.init(webmcplist),
          webmcp_launch: Tool.init(webmcplaunch),
          webmcp_tools: Tool.init(webmcptools),
          webmcp_call: Tool.init(webmcpcall),
          webmcp_note: Tool.init(webmcpnote),
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
          show_image: Tool.init(showimagetool),
          chart: Tool.init(charttool),
          todo: Tool.init(todo),
          goal: Tool.init(goaltool),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          question_reply: Tool.init(questionReply),
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
            // t-po041k. The PARENT's end of a sub-agent's question. Gated with
            // `question` because the two are one path: a client that cannot
            // surface a question has no child routing a question to it either.
            ...(questionEnabled ? [tool.question_reply] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.wiki_search,
            tool.wiki_related,
            // Offered to every client: asking a friend is an engine-side network
            // act, not a shell one, and each stops when no transport is set up.
            tool.flock_who,
            tool.flock_ask,
            tool.flock_reply,
            tool.sessionSearch,
            tool.remember,
            // t-f89g49, default-ON since t-ffjau8. Main-agent only: the natives
            // deny it, and ORIGAMI_EXPERIMENTAL_SIDE_QUESTS=false takes it out
            // of the catalog entirely, so the model cannot read even the name.
            ...(flags.experimentalSideQuests ? [tool.side_quest] : []),
            ...(questionEnabled ? [tool.dream] : []),
            tool.board_repos,
            tool.board_tickets,
            tool.board_create,
            tool.board_update,
            tool.board_register,
            tool.board_worktrees,
            // Offered to every client and ON by default. The store is a local
            // SQLite file plus a blob directory in the user's data dir; the
            // sidebar pill is how a person opens one, not a prerequisite for
            // publishing, so a TUI/CLI client still gets a correct result.
            tool.artifact_publish,
            tool.artifact_list,
            tool.artifact_get,
            tool.artifact_diff,
            // Offered to every client: the registry is a plain file in the user's
            // home and the launch runs `open` in the engine process.
            tool.webmcp_list,
            tool.webmcp_launch,
            tool.webmcp_tools,
            tool.webmcp_call,
            tool.webmcp_note,
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
            // Offered to every client. The picture card renderer lives in
            // packages/vscode/ only; on a TUI/CLI client the tool still completes
            // with SVG text output, which beats the tool being invisible.
            tool.chart,
            // Offered to every client, like chart: the capture happens in the
            // engine process (PowerShell / screencapture), not in the shell, so
            // the VS Code client is not a prerequisite the way it is for `browser`.
            tool.screenshot,
            // Offered to every client. On a client with no picture card the
            // model still gets a correct "showed <file>" result; the card is a
            // bonus, not a prerequisite - same reasoning as chart above.
            tool.show_image,
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
        // Hidden means hidden. `hidden: true` is what the Agents pane stamps on
        // every collab bot and every vision profile, and session/prompt.ts
        // filters on the same field; without this, character defs the user never
        // meant as subagents get offered as delegation targets.
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
            // Carried through deliberately: this projection rebuilds the def, so
            // a field it forgets is one the session layer never sees — a tool
            // marked deferrable would silently stay in every prompt.
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
 * What a roster line says when the definition said nothing. It must cover an
 * EMPTY description as well as an absent one: a line that names an agent and
 * then says nothing gives the model a delegation target it cannot judge.
 */
const TASK_DESCRIPTION_FALLBACK = "This subagent should only be called manually by the user."

/**
 * The line a re-admitted vision profile gets, synthesized rather than read off
 * the def, whose own `description:` is written for the Agents pane. It says what
 * the calling model cannot work out: that it is blind, that a path or attachment
 * is the input, and that the reply is words, not a picture.
 */
const VISION_PROFILE_TASK_DESCRIPTION = [
  "Your model cannot see images.",
  "Send it a path or an attached image and ask what it shows —",
  "say exactly what you need read out (text verbatim, colours, layout).",
  "It replies in words; you never receive the picture.",
].join(" ")

/** The one hidden def the roster may name: the chat's own vision profile. Both
 *  halves are required - the name alone would let any hidden def called
 *  `vision-eye` in, the option alone would name every profile on disk. */
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
    // The registry asks Flock nothing, but the task tool it builds still
    // resolves the subagent binding through it.
    FlockRouting.node,
    Skill.node,
    Session.node,
    BackgroundJob.node,
    // The registry evaluates rulesets as pure functions, but the task tool it
    // builds resolves the SERVICE: it asks how long a child has been parked on
    // an unanswered ask so the job ceiling can refuse to count that wait.
    Permission.node,
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
    // A transitive dep is not a provided service: webmcp_launch resolves
    // McpBrowser itself, so the registry has to name it.
    McpBrowser.node,
    // The CDP bridge behind webmcp_launch/_tools/_call, named for the same
    // reason: the tools resolve it themselves.
    WebMcpBridge.node,
    Database.node,
    Ripgrep.node,
    Git.node,
    AppProcess.node,
  ],
})

export * as ToolRegistry from "./registry"

import { LayerNode } from "@origami/core/effect/layer-node"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Config } from "@/config/config"
import { ConfigAgent } from "@/config/agent"
import { serviceUse } from "@origami/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_GOAL_CRITIC from "./prompt/goal-critic.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { AgentBot } from "./bot"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@origami/core/global"
import { FSUtil } from "@origami/core/fs-util"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@origami/core/schema"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@origami/core/location-services"
import { Reference } from "@origami/core/reference"
import { Location } from "@origami/core/location"
import { PluginV2 } from "@origami/core/plugin"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  frequencyPenalty: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  /**
   * Re-read the agent DEFINITION FILES from disk and rebuild the registry, so a
   * definition written after the engine started can back a session with no
   * restart. See the implementation for exactly what this does and does not
   * refresh.
   */
  readonly rescan: () => Effect.Effect<void>
  /**
   * The definition FILE a name would load from, or undefined when no config
   * directory holds one. Answers for a file whose frontmatter failed to parse
   * too - that file is absent from the registry, and naming it is the only way
   * a human can find what to fix.
   */
  readonly definitionFile: (agent: string) => Effect.Effect<string | undefined>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate" | "definitionFile">

export class Service extends Context.Service<Service, Interface>()("@origami/Agent") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = Object.keys(cfg.references ?? cfg.reference ?? {}).length
          ? yield* Effect.gen(function* () {
              yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
              return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
          : []
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          // Origami's own home (~/.origami): global plans, cross-project memory,
          // sessions, skills, settings. Reading/writing it back is core to
          // non-linear + resumable workflow — a non-git workspace keeps its plans
          // there and all cross-project memory lives there — so never prompt for
          // it. One "*" glob covers the whole subtree: Wildcard turns * into .*
          // which spans path separators (wildcard.ts). Generalises the plan
          // agent's plans-only grant below to every agent. Normalize on win32 the
          // same way the external-directory ask does (FSUtil.normalizePath =
          // realpath), so a junctioned/relocated ~/.origami still matches.
          path.join(
            process.platform === "win32" ? FSUtil.normalizePath(Global.Path.origami) : Global.Path.origami,
            "*",
          ),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          // A whole-screen grab can hold anything that is on the desktop, so it
          // is never taken without a fresh answer. This line is what makes that
          // true: `"*": "allow"` above MATCHES an unnamed permission id, so the
          // `ask` fallback in Permission.evaluate never fires for one, and a new
          // tool that says nothing here is silently allowed. The tool pairs this
          // with `always: []` so even an "Always allow" answer does not carry to
          // the next capture.
          screenshot: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        // A FACTORY, not a shared literal: `build` below mutates the entries it
        // overlays and deletes the disabled ones, so every rebuild needs its own
        // copies or a rescan would inherit the previous pass's edits.
        const natives = (): Record<string, Info> => ({
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
                // Allow plan_exit so a stray call in build mode (the model
                // reaching for it out of habit after a plan→build switch) lands
                // on the tool — which no-ops gracefully — instead of a scary
                // "unavailable tool" error. See tool/plan.ts.
                plan_exit: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  // Plan mode delegates only to the READ-ONLY 'explore' sub-agent
                  // (research + report back, no edits/execution). Deny 'general',
                  // build, and custom types so planning can't fan out
                  // execute-capable sub-agents mid-plan. Feedback still flows: the
                  // task tool returns the sub-agent's final text to the planner.
                  "*": "deny",
                  explore: "allow",
                },
                external_directory: {
                  [path.join(Global.Path.origami, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".origami", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.origami, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          /**
           * DEEP PLAN mode. Plan mode's shape, widened in exactly three places
           * and for one reason each - it is for work large or new enough that
           * starting off the cuff buys technical debt, so the plan itself has to
           * be researched, argued against, and handed over as evidence.
           *
           * 1. `edit` covers the plan FOLDER TREE, not one `.md`. The
           *    deliverable is a directory (PLAN.md, map.json, DECISIONS.md,
           *    research/ and research/critiques/), so the glob drops `.md`.
           *    `"*": "deny"` still stands ahead of it: this agent may write
           *    inside its plan folder and NOWHERE else, which is what stops a
           *    "deep plan" for a brand-new project from quietly scaffolding
           *    that project.
           * 2. `task` allows `general` as well as `explore`. Plan mode denies
           *    `general` so a plan cannot fan out execute-capable children;
           *    here the research fan-out and the adversarial critics ARE the
           *    feature, and `explore` alone cannot read the web or hold a
           *    critique brief. The children write nothing the parent does not:
           *    a subagent's own ruleset governs it, and the plan folder is the
           *    only place the parent will paste their findings.
           * 3. Nothing is added for the web. `websearch`/`webfetch` are already
           *    open through the `"*": "allow"` base (same as plan mode), and a
           *    redundant allow would only invite the next reader to think one
           *    of them was ever closed.
           *
           * NOT hidden and `mode: "primary"`, which is the whole of the ACP
           * wiring: `acp/directory.ts` modeOptionsFrom() lists every non-hidden
           * non-subagent agent, so the mode picker gains it with no ACP change.
           */
          "deep-plan": {
            name: "deep-plan",
            description:
              "Deep Plan mode. Researches a large or new piece of work, drafts a phased plan, attacks it with adversarial critics, and DELIVERS a plan folder. Never executes.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  "*": "deny",
                  explore: "allow",
                  general: "allow",
                },
                external_directory: {
                  [path.join(Global.Path.origami, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".origami", "plans", "*")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.origami, path.join("plans", "*")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                // Read-only metadata retrieval over `wiki/` and
                // `.origami/memory/`. Explore is the agent this exists for:
                // a bare `"*": deny` would leave it grepping for phrasing when
                // the workspace already files the answer under a tag.
                wiki_search: "allow",
                wiki_related: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          /**
           * The blind verifier behind GOAL MODE (session/goal.ts). Hidden: the
           * engine spawns it itself at every turn end of a session carrying an
           * active goal, and a model that could ALSO reach for it by name would
           * be grading its own homework with the transcript in hand - which is
           * the one thing this agent exists not to do.
           *
           * Permissions are `explore`'s shape plus WRITE-TO-VALIDATE. `bash`
           * was always open, for the reason `explore` has it and more so:
           * verifying "the tests pass" means running the tests. `edit` - the id
           * `edit`, `write` and `apply_patch` all ask under - is open for the
           * same reason taken one step further: a condition whose only honest
           * check is a test that does not exist yet cannot be verified by
           * reading. The contract that makes an editor safe here is written in
           * the PROMPT, not in the ruleset - write only to validate, never to
           * make the condition true, and name every file you touched in the
           * evidence. A ruleset cannot tell those two apart; a reader of the
           * evidence can.
           *
           * The denies that still matter are the ones no reviewer may have: it
           * cannot delegate the judgement (`task`) or lobby anyone about it
           * (`send_message`). The `"*": "deny"` base closes both, and
           * `subagent-permissions.ts` plus `criticPermission` close them again
           * at spawn so a parent chat on bypass cannot re-open them.
           *
           * `steps: 15` is the cost cap. A verification is a bounded read: find
           * the artefacts, run the check, report. A critic that needs fifty
           * steps is re-doing the work, not reviewing it.
           */
          "goal-critic": {
            name: "goal-critic",
            mode: "subagent",
            native: true,
            hidden: true,
            steps: 15,
            description:
              "Blind adversarial verifier for goal mode. Checks a completion condition against the workspace using its own evidence, and reports MET or NOT MET.",
            prompt: PROMPT_GOAL_CRITIC,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                read: "allow",
                bash: "allow",
                // WRITE TO VALIDATE. One id covers `edit`, `write` and
                // `apply_patch` - all three ask under "edit". Scoped by the
                // prompt, not by a path glob: the test a condition needs may
                // live anywhere the project keeps its tests, and a glob that
                // guessed wrong would send the critic back to reading.
                edit: "allow",
                git_diff: "allow",
                lsp: "allow",
                wiki_search: "allow",
                wiki_related: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        })

        const build = (overrides: NonNullable<typeof cfg.agent>) => {
          const agents = natives()

          for (const [key, value] of Object.entries(overrides)) {
            if (value.disable) {
              delete agents[key]
              continue
            }
            let item = agents[key]
            if (!item)
              item = agents[key] = {
                name: key,
                mode: "all",
                permission: Permission.merge(defaults, user),
                options: {},
                native: false,
              }
            if (value.model) item.model = Provider.parseModel(value.model)
            item.variant = value.variant ?? item.variant
            item.prompt = value.prompt ?? item.prompt
            item.description = value.description ?? item.description
            item.temperature = value.temperature ?? item.temperature
            item.topP = value.top_p ?? item.topP
            item.mode = value.mode ?? item.mode
            item.color = value.color ?? item.color
            item.hidden = value.hidden ?? item.hidden
            item.name = value.name ?? item.name
            item.steps = value.steps ?? item.steps
            item.options = mergeDeep(item.options, value.options ?? {})
            // THREE layers, in precedence order. The BOT CONTRACT sits in the
            // middle: a `permissions:` tier and a `skills:` allowlist are a
            // starting point the definition asked for by name, so they overlay
            // the engine's defaults but lose to any explicit `permission:` line
            // the same file wrote. Absent contract keys expand to an empty
            // ruleset, so a definition that declares none is untouched.
            item.permission = Permission.merge(
              item.permission,
              AgentBot.rulesetFor(item.options),
              Permission.fromConfig(value.permission ?? {}),
            )
          }

          // Ensure Truncate.GLOB is allowed unless explicitly configured
          for (const name in agents) {
            const agent = agents[name]
            const explicit = agent.permission.some((r) => {
              if (r.permission !== "external_directory") return false
              if (r.action !== "deny") return false
              return r.pattern === Truncate.GLOB
            })
            if (explicit) continue

            agents[name].permission = Permission.merge(
              agents[name].permission,
              Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
            )
          }

          return agents
        }

        /** The definitions as of engine start: JSON `agent` blocks AND markdown. */
        let agents = build(cfg.agent ?? {})

        /**
         * The `agent` blocks the CONFIG FILES declared, without the markdown.
         * The base every rescan rebuilds from - see below for why the boot-time
         * `cfg.agent` cannot be that base.
         */
        const declared = yield* config.getDeclaredAgents()

        /**
         * Re-read the agent DEFINITION FILES and rebuild the registry.
         *
         * Rebuilt as "what the CONFIG declares, plus what is ON DISK NOW",
         * never as a merge over the previous pass. That is what makes the
         * disk the truth for everything the files own:
         *
         *  - A definition file ADDED since the engine started becomes visible
         *    to `get`/`list`, so it can back a session immediately.
         *  - A field EDITED in an existing file takes its new value.
         *  - A definition file DELETED loses its registry entry, because
         *    nothing puts it back. It used to survive for the life of the
         *    process: the base was `cfg.agent`, which is the UNION of the
         *    markdown and the origami.json `agent` blocks, so dropping the
         *    entries the disk no longer had would have deleted the
         *    config-declared agents along with them. `getDeclaredAgents` is
         *    that union split by provenance, which is the whole fix.
         *  - A field REMOVED from a file is really removed, for the same
         *    reason - there is no previous pass left to inherit it from.
         *
         * A CONFIG-declared agent is never dropped, whatever the disk says. An
         * agent both sources name falls back to the config block when its file
         * goes, rather than disappearing.
         *
         * STILL needs an engine restart: `permission`, `skill` and `reference`
         * config, and the `agent` blocks themselves. Those are captured once
         * above, and a definition file cannot change them.
         *
         * An `Info` a caller ALREADY holds is never mutated - it is a plain
         * value, and this replaces the record wholesale. A turn in flight
         * therefore finishes on the definition it started with, which is what
         * stops one edit from changing an agent mid-turn.
         */
        const rescan = Effect.fnUntraced(function* () {
          agents = build(mergeDeep(declared, yield* config.getLiveAgents()))
        })

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          rescan,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      rescan: Effect.fn("Agent.rescan")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.rescan())
      }),
      definitionFile: Effect.fn("Agent.definitionFile")(function* (agent: string) {
        for (const dir of yield* config.directories()) {
          const found = yield* Effect.promise(() => ConfigAgent.fileFor(dir, agent).catch(() => undefined))
          if (found) return found
        }
        return undefined
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Auth.node, Plugin.node, Skill.node, Provider.node, locationServiceMapNode],
})

export * as Agent from "./agent"

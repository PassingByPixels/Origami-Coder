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
import PROMPT_FRONT_DESK from "./prompt/front-desk.txt"
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
  /**
   * The archetype's OWN deferral defaults, in the same vocabulary as
   * `experimental.tool_search` and the per-agent `tool_search` block of
   * origami.json: `defer` = one catalog line, `always` = full schema.
   *
   * Here so a NATIVE can ship a default deferred list with no config file
   * present - a file-defined agent already has one, its frontmatter, which
   * reaches the spawn path through `config.agent[name].tool_search`. The two
   * are overlaid in that order (`ToolSearch.forSpawn`), so a user block wins
   * over the archetype default on the tools it names and leaves the rest.
   */
  tool_search: Schema.optional(
    Schema.Struct({
      defer: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
      always: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    }),
  ),
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
   * restart. The implementation states what it does and does not refresh.
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
          // Origami's own home (~/.origami): plans, cross-project memory,
          // sessions, skills, settings — never prompt for it. One "*" glob
          // covers the whole subtree, because Wildcard turns * into .* which
          // spans path separators (wildcard.ts). Normalized on win32 so a
          // junctioned/relocated ~/.origami still matches.
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
          // A whole-screen grab can hold anything on the desktop, so it is never
          // taken without a fresh answer, and THIS line is what makes that true:
          // `"*": "allow"` above matches an unnamed permission id, so the `ask`
          // fallback in Permission.evaluate never fires and a new tool that says
          // nothing here is silently allowed. The tool pairs this with
          // `always: []` so an "Always allow" answer does not carry to the next
          // capture.
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

        // A FACTORY, not a shared literal: `build` mutates and deletes entries,
        // so every rebuild needs its own copies or a rescan inherits the
        // previous pass's edits.
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
                // Allow plan_exit so a stray call in build mode (habit, after a
                // plan→build switch) lands on the tool, which no-ops gracefully,
                // instead of an "unavailable tool" error. See tool/plan.ts.
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
                  // Plan mode delegates only to the READ-ONLY 'explore'
                  // sub-agent. Deny 'general', build and custom types so
                  // planning cannot fan out execute-capable sub-agents mid-plan.
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
           * DEEP PLAN mode. Plan mode's shape, widened in exactly two places:
           *
           * 1. `edit` covers the plan FOLDER TREE, not one `.md`, since the
           *    deliverable is a directory. `"*": "deny"` still stands ahead of
           *    it: this agent may write inside its plan folder and NOWHERE else,
           *    which stops a "deep plan" for a new project from scaffolding it.
           * 2. `task` allows `general` as well as `explore`, because the
           *    research fan-out and the adversarial critics ARE the feature and
           *    `explore` alone cannot read the web or hold a critique brief. A
           *    subagent's own ruleset governs it, and the plan folder is the
           *    only place the parent pastes their findings.
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
            /**
             * todowrite is NAMED, not merely left out. Leaving it out would not
             * grant it: `subagent-permissions.ts` appends a todowrite deny to
             * every spawned child whose own ruleset does not name the tool, so
             * silence reads as deny. Naming it `allow` is what actually lifts
             * the old blanket deny - a general child plans its own multi-step
             * work now (owner-approved default matrix, t-f39xs2).
             */
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "allow",
                // A delegate may ASK. The `defaults` above deny `question` so a
                // primary agent cannot interrogate the user mid-turn; a child
                // that hits an ambiguity has nobody else to put it to, and the
                // parent is waiting on its answer either way.
                question: "allow",
                // The OWNER'S TOOLS, closed to a delegate: a child does not
                // curate the user's memory (`remember`, `dream`), does not draw
                // in the user's chat (`chart`), does not set the session's goal
                // (`goal`), and does not address strangers on the flock
                // (`flock_who`, `flock_ask`). Each is the user's own instrument,
                // not a unit of delegated work.
                remember: "deny",
                dream: "deny",
                chart: "deny",
                goal: "deny",
                flock_who: "deny",
                flock_ask: "deny",
                // The task SIDECARS follow `task` itself, which
                // subagent-permissions.ts denies to any child that does not name
                // it: with no way to spawn, listing and stopping other people's
                // background work is reach, not capability.
                task_list: "deny",
                task_stop: "deny",
                // t-f89g49. A side quest is a note to the OWNER about work
                // outside the current job. A delegate's job IS the current
                // job, and it already reports back in its result text.
                side_quest: "deny",
              }),
              user,
            ),
            /**
             * The archetype's default catalog lines: reachable, but not worth a
             * schema every turn for an agent whose usual job is code. A user
             * `tool_search` block for `general` overlays this and wins.
             */
            tool_search: {
              defer: ["webfetch", "websearch", "session_search", "browser", "board_*", "webmcp_*", "screenshot"],
            },
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
                // `.origami/memory/`. A bare `"*": deny` would leave explore
                // grepping for phrasing when the workspace already files the
                // answer under a tag.
                wiki_search: "allow",
                wiki_related: "allow",
                list: "allow",
                // NO `bash`. The description this archetype ships says
                // read-only, and a shell is the one allow that makes that untrue
                // (t-f39xs2, owner-approved matrix).
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                // t-f39xs2, owner-approved matrix: both are DEFERRED for
                // explore, not off, and a tool this cage denies never reaches
                // the deferral decision at all. So they are named here - the
                // presentation the ledger shows needs the tool to exist first.
                // `skill` also puts the skill roster back in explore's system
                // prompt (session/system.ts hides it when skill is disabled).
                skill: "allow",
                screenshot: "allow",
                // Reading what CHANGED and what a symbol IS are both searching.
                git_diff: "allow",
                lsp: "allow",
                // Its own catalog. Without this explore is handed a deferred
                // list it has no tool to open - the D list below would be dead
                // weight rather than one round trip.
                tool_search: "allow",
                // Allowed so it can be DEFERRED: a denied tool never reaches the
                // deferral decision. On explore's defer list just below.
                session_search: "allow",
                // t-f89g49. Redundant under the `"*": deny` above and named
                // anyway: the deny list a reader checks is this one.
                side_quest: "deny",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            /** Same idea as `general`, narrower: a searcher pays for no schema
             *  it does not open with. */
            tool_search: {
              defer: ["skill", "webfetch", "websearch", "session_search", "screenshot"],
            },
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
           * Permissions are `explore`'s shape plus WRITE-TO-VALIDATE: `bash`
           * because verifying "the tests pass" means running them, `edit`
           * because a condition whose only honest check is a test that does not
           * exist yet cannot be verified by reading. The contract that makes an
           * editor safe here is in the PROMPT, not the ruleset - write only to
           * validate, never to make the condition true, and name every file
           * touched in the evidence. A ruleset cannot tell those two apart; a
           * reader of the evidence can.
           *
           * The denies that matter are the ones no reviewer may have: it cannot
           * delegate the judgement (`task`) or lobby anyone about it
           * (`send_message`). The `"*": "deny"` base closes both, and
           * `subagent-permissions.ts` plus `criticPermission` close them again
           * at spawn so a parent chat on bypass cannot re-open them.
           *
           * `steps: 15` is the cost cap: a verification is a bounded read.
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
                // WRITE TO VALIDATE. Scoped by the prompt, not a path glob: the
                // test a condition needs may live anywhere, and a glob that
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
          /**
           * THE FRONT DESK: the only agent in this registry that answers to
           * someone who is not the owner.
           *
           * A flock question (`flock/frontdesk.ts`) is run by this archetype in
           * a child session, never in the owner's chat. Two departures from
           * every other native above, and both are the security story:
           *
           * 1. `user` IS NOT MERGED. Every other archetype ends
           *    `Permission.merge(defaults, …, user)` so the owner's config has
           *    the last word — correct when the owner is the one being served.
           *    Here the caller is a stranger, and an owner running
           *    `permission: {"*": "allow"}` for their own convenience would
           *    hand that stranger a shell. The owner's say over this agent is
           *    the `flock.frontDesk.scope` block, which `policy.ts` turns into
           *    read rules appended AFTER these — narrowing only, never widening.
           * 2. `external_directory: "deny"`, unlike `explore`'s read-only ask.
           *    This is the FLOOR, not the final answer: the scope ruleset
           *    (`flock/policy.ts scopeRuleset`) re-allows it for EXACTLY the
           *    folders and out-of-worktree repos the owner marked shareable,
           *    and appends those rules after these, so the deny stands for
           *    everywhere else. Written as a blanket deny here so that a desk
           *    with an empty scope — or a caller who forgot to compose the
           *    scope at all — leaves the worktree nowhere.
           *
           * `hidden`, because the owner's own model has no reason to reach for
           * it: it is spawned by an inbound question and by nothing else.
           * `steps: 12` caps what one stranger's question can cost.
           */
          "front-desk": {
            name: "front-desk",
            mode: "subagent",
            native: true,
            hidden: true,
            steps: 12,
            description:
              "Answers a question from a flock contact using only the files the owner marked shareable. Read-only, no shell, no network.",
            prompt: PROMPT_FRONT_DESK,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                wiki_search: "allow",
                wiki_related: "allow",
                // Skills are NOT a permission: a skill is instructions, not a
                // secret, so there is no meaningful "no" to offer. Allowing it
                // also puts the skill roster back in the desk's system prompt
                // (`session/system.ts` hides it whenever `skill` is disabled).
                skill: "allow",
                external_directory: "deny",
              }),
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
            // middle: a tier and a skills allowlist overlay the engine defaults
            // but lose to any explicit `permission:` line the same file wrote.
            // Absent contract keys expand to an empty ruleset.
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

        /** The `agent` blocks the CONFIG FILES declared, without the markdown —
         *  the base every rescan rebuilds from. */
        const declared = yield* config.getDeclaredAgents()

        /**
         * Re-read the agent DEFINITION FILES and rebuild the registry.
         *
         * Rebuilt as "what the CONFIG declares, plus what is ON DISK NOW", never
         * as a merge over the previous pass. That makes the disk the truth for
         * everything the files own: a file ADDED becomes visible to `get`/`list`,
         * an EDITED field takes its new value, and a DELETED file or REMOVED
         * field is really gone. The base is `getDeclaredAgents` - the union split
         * by provenance - not `cfg.agent`, which would take the config-declared
         * agents down with the disk ones. A CONFIG-declared agent is never
         * dropped, whatever the disk says.
         *
         * STILL needs an engine restart: `permission`, `skill` and `reference`
         * config, and the `agent` blocks themselves.
         *
         * An `Info` a caller ALREADY holds is never mutated - this replaces the
         * record wholesale, so a turn in flight finishes on the definition it
         * started with and one edit cannot change an agent mid-turn.
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

import { LayerNode } from "@origami/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import fs from "fs"
import path from "path"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_DEFAULT from "./prompt/default.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { FlockRouting } from "@/flock/routing"
import { SessionVision } from "./vision"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@origami/core/schema"
import { Location } from "@origami/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@origami/core/location-services"
import { Reference } from "@origami/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Global } from "@origami/core/global"

/** The file a user writes to replace the built-in base prompt. */
export const BASE_PROMPT_FILE = "base-prompt.md"

/** The built-in base prompt: `default.txt`, the ONE model-agnostic text every
 *  model gets, and what `base-prompt.md` replaces. */
export const BASE_PROMPT_BUILTIN: string = PROMPT_DEFAULT

/**
 * Where the override lives: the same directory the engine resolves its global
 * config from, so one root holds everything hand-editable.
 *
 * Resolved through `Global.make()` on each call, not a module-load constant:
 * `ORIGAMI_CONFIG_DIR` is a lazy `Flag` getter, and a constant would freeze the
 * path before a test or a wrapper could redirect it.
 */
export function basePromptPath(): string {
  return path.join(Global.make().config, BASE_PROMPT_FILE)
}

/**
 * The user's base prompt, or undefined when there is none. A missing,
 * unreadable or whitespace-only file is NOT an override: saving a half-cleared
 * buffer would otherwise send every model an empty system prompt instead of
 * falling back. Read synchronously per send - a few KB off local disk against
 * an LLM round trip - so an edit takes effect on the NEXT turn, with no restart.
 */
export function basePromptOverride(): string | undefined {
  try {
    const text = fs.readFileSync(basePromptPath(), "utf8")
    return text.trim().length === 0 ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * The base prompt for a turn: the user's override when there is one, otherwise
 * the single built-in.
 *
 * The model is accepted and DELIBERATELY ignored: one model-agnostic base
 * prompt, so the id must not change the text. The parameter is kept on purpose
 * as the seam the "every family gets the same prompt" test drives.
 */
export function provider(_model: Provider.Model) {
  const override = basePromptOverride()
  if (override !== undefined) return [override]
  return [PROMPT_DEFAULT]
}

/** FLOCK_SPEC §5, verbatim shipping copy. It must never mention Flock, roles,
 *  models or prices - this nudge is the only lever on the main agent. */
export const DELEGATION = [
  `If you can state what "done" looks like and you don't need to witness the steps,`,
  "delegate it — you keep the result, and your context stays on the goal itself.",
  "Hand out the groundwork: reading, locating, transforming, verifying,",
  "researching. Your context is the scarce resource; spend it on the goal, not the",
  "groundwork.",
].join(" ")

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
  readonly flock: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly vision: (profile: string | undefined) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@origami/SystemPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const flock = yield* FlockRouting.Service
    const locations = yield* LocationServiceMap.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // Name + first-line description only: the skill tool takes the name, so
          // that is what invocation needs. The XML `verbose` form is still in Skill.fmt.
          Skill.fmt(list, { verbose: false }),
        ].join("\n")
      }),

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),

      flock: Effect.fn("SystemPrompt.flock")(function* (agent: Agent.Info) {
        // Main agent only: subagents are denied the task tool, so delegation copy
        // in their context is dead weight.
        if (agent.mode !== "primary") return
        if (!(yield* flock.active())) return
        return DELEGATION
      }),

      // The gate is resolved by the CALLER (SessionVision.activeProfile) and handed
      // down, because whether a vision turn qualifies is three turn facts
      // session/prompt.ts must test anyway to decide on the tool. A second copy of
      // that test here is how a model ends up told about a tool it was not given.
      vision: Effect.fn("SystemPrompt.vision")(function* (profile: string | undefined) {
        if (!profile) return
        return SessionVision.guidance(profile)
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
  deps: [Skill.node, MCP.node, FlockRouting.node, locationServiceMapNode],
})

export * as SystemPrompt from "./system"

import { LayerNode } from "@origami/core/effect/layer-node"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { Global } from "@origami/core/global"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_VERIFY_PLAN from "./template/verify-plan.txt"
import PROMPT_DREAM from "./template/dream.txt"
import PROMPT_GOAL from "./template/goal.txt"
import { LegacyEvent } from "@origami/schema/legacy-event"

type State = {
  commands: Record<string, Info>
  /**
   * origami_change: resolves once background MCP prompt discovery has folded
   * its commands into `commands`. Never rejects — a server that fails to
   * connect contributes no prompts and is not an error here (mcp/index.ts
   * `create` catches the failure into a `failed` status, and `prompts()` reads
   * CONNECTED clients only), which is exactly the pre-existing failure mode.
   */
  mcpSettled: Promise<void>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  VERIFY_PLAN: "verify-plan",
  DREAM: "dream",
  GOAL: "goal",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  /**
   * Every command KNOWN NOW. MCP-contributed prompts are discovered in the
   * background (see `mcpSettled`), so a call made in the first moments of an
   * instance can answer before they land — `listSettled` is the reader that
   * waits for them. origami_change.
   */
  readonly list: () => Effect.Effect<Info[]>
  /** origami_change: every command, INCLUDING MCP prompts, waiting for discovery if it is still in flight. */
  readonly listSettled: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@origami/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }
      commands[Default.VERIFY_PLAN] = {
        name: Default.VERIFY_PLAN,
        description: "audit changes against this session's todo list [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_VERIFY_PLAN
        },
        subtask: true,
        hints: hints(PROMPT_VERIFY_PLAN),
      }
      commands[Default.DREAM] = {
        name: Default.DREAM,
        description:
          "curate memory: reorganise the store(s) from recent sessions, then approve/revise/disapprove" +
          " [project only|global only], defaults to both",
        source: "command",
        // Inline (no subtask) so the diff + approval question reach the user in the
        // main session. ${path} = worktree root, ${origami} = ~/.origami (store + sessions).
        get template() {
          return PROMPT_DREAM.replaceAll("${path}", ctx.worktree).replaceAll("${origami}", Global.Path.origami)
        },
        hints: hints(PROMPT_DREAM),
      }

      // GOAL MODE (session/goal.ts). Assigned HERE, above the config loop, so
      // precedence is unchanged: a user `command.goal`, and an MCP prompt named
      // `goal`, both still overwrite it, and only a SKILL named `goal` is now
      // shadowed (the skill loop below skips a name that already exists).
      //
      // A built-in rather than a seeded skill on purpose: the VS Code shell only
      // writes its default skills into a workspace that re-runs /firstfold, so a
      // skill would reach neither an existing workspace nor a CLI/TUI user at all.
      // This ships inside the engine binary, to everyone, at once.
      commands[Default.GOAL] = {
        name: Default.GOAL,
        description: "keep working until a completion condition is verified met [condition|clear], no args = status",
        source: "command",
        get template() {
          return PROMPT_GOAL
        },
        hints: hints(PROMPT_GOAL),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      // origami_change-start: MCP prompt commands are folded in OFF the
      // critical path. Reading `mcp.prompts()` here forces MCP.state, which
      // CONNECTS every configured and every plugin-declared server — measured
      // at 3248ms of a 3295ms `session/new` on the owner's real config, and
      // never amortised because each chat spawns its own engine. The connect
      // still happens on exactly the same terms; the difference is that no
      // caller waits for it. `commands` is captured by reference, so the fold
      // writes into the SAME map the fast readers already hold.
      //
      // Precedence is unchanged. An MCP prompt still beats a config command and
      // a skill of the same name: the fold assigns unconditionally, where the
      // skill loop below skips a name that already exists. The only difference
      // is ordering in time — a colliding skill can be visible for the width of
      // the discovery window before the MCP entry replaces it.
      const foldMcpPrompts = Effect.gen(function* () {
        for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
          commands[name] = {
            name,
            source: "mcp",
            description: prompt.description,
            get template() {
              return bridge.promise(
                mcp
                  .getPrompt(
                    prompt.client,
                    prompt.name,
                    prompt.arguments
                      ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                      : {},
                  )
                  .pipe(
                    Effect.map(
                      (template) =>
                        template?.messages
                          .map((message) => (message.content.type === "text" ? message.content.text : ""))
                          .join("\n") || "",
                    ),
                  ),
              )
            },
            hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
          }
        }
      })
      const mcpSettled = bridge.promise(foldMcpPrompts.pipe(Effect.catchCause(() => Effect.void))).catch(() => {})
      // origami_change-end

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            if (!dir) return item.content
            return [
              item.content,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
            ].join("\n")
          },
          hints: [],
        }
      }

      return {
        commands,
        mcpSettled,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      // origami_change-start: a HIT answers with no MCP wait at all. Only a MISS
      // waits for discovery, because an unknown name is precisely the case an
      // in-flight MCP prompt could still explain — so a slash command resolves
      // to the same command it always did, just one await later in the window
      // where the servers have not answered yet.
      const known = s.commands[name]
      if (known) return known
      yield* Effect.promise(() => s.mcpSettled)
      // origami_change-end
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    // origami_change: the waiting reader, for a consumer that must present the
    // COMPLETE vocabulary (the ACP shell folds this into its directory snapshot
    // and re-pushes `available_commands_update` when it lands).
    const listSettled = Effect.fn("Command.listSettled")(function* () {
      const s = yield* InstanceState.get(state)
      yield* Effect.promise(() => s.mcpSettled)
      return Object.values(s.commands)
    })

    return Service.of({ get, list, listSettled })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, MCP.node, Skill.node] })

export * as Command from "."

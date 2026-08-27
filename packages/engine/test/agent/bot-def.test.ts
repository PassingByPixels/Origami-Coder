import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Global } from "@origami/core/global"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { AgentBotMemory } from "@/agent/bot-memory"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * THE BOT CONTRACT, END TO END THROUGH THE REAL LOADER.
 *
 * The pure tests prove the vocabulary expands correctly. These prove the two
 * things only the real registry can answer: that the frontmatter SURVIVES the
 * loader (it rides `options`, which is a normalisation behaviour, not a schema
 * field), and that the tier lands UNDER the definition's own `permission:`
 * block rather than over it.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

const withAgentDir = {
  init: (directory: string) =>
    Effect.promise(() => fs.mkdir(path.join(directory, ".origami", "agent"), { recursive: true })),
}

const writeDef = (directory: string, slug: string, body: string) =>
  Effect.promise(() => fs.writeFile(path.join(directory, ".origami", "agent", `${slug}.md`), body))

const act = (info: Agent.Info | undefined, permission: string, pattern = "*") =>
  info ? Permission.evaluate(permission, pattern, info.permission).action : undefined

const load = (slug: string) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.rescan()
    return yield* agents.get(slug)
  })

describe("a definition's bot contract reaches the registry", () => {
  it.instance(
    "a definition declaring NO contract keeps today's permissive defaults",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* writeDef(directory, "plain", "---\ndescription: Plain\n---\nYou are plain.\n")
        const info = yield* load("plain")
        expect(act(info, "edit")).toBe("allow")
        expect(act(info, "bash")).toBe("allow")
      }),
    withAgentDir,
  )

  it.instance(
    "`permissions: strict` closes the doors the observer preset closes",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* writeDef(directory, "watcher", "---\ndescription: Watcher\npermissions: strict\n---\nYou watch.\n")
        const info = yield* load("watcher")
        expect(act(info, "read")).toBe("allow")
        expect(act(info, "edit")).toBe("deny")
        expect(act(info, "bash")).toBe("deny")
        expect(act(info, "task")).toBe("deny")
        expect(act(info, "todowrite")).toBe("deny")
      }),
    withAgentDir,
  )

  it.instance(
    "`permissions: standard` lets a bot build",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* writeDef(directory, "builder", "---\ndescription: Builder\npermissions: standard\n---\nYou build.\n")
        const info = yield* load("builder")
        expect(act(info, "edit")).toBe("allow")
        expect(act(info, "bash")).toBe("allow")
        expect(act(info, "task")).toBe("deny")
      }),
    withAgentDir,
  )

  it.instance(
    "an EXPLICIT permission line beats the tier that asked for the opposite",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* writeDef(
          directory,
          "hybrid",
          "---\ndescription: Hybrid\npermissions: strict\npermission:\n  bash: allow\n---\nYou are a hybrid.\n",
        )
        const info = yield* load("hybrid")
        // The tier is a starting point: the file's own block is the last word.
        expect(act(info, "bash")).toBe("allow")
        // …and everything the file did not restate still comes from the tier.
        expect(act(info, "edit")).toBe("deny")
      }),
    withAgentDir,
  )

  it.instance(
    "a skills allowlist lands on the SAME `skill` permission Skill.available reads",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* writeDef(
          directory,
          "narrow",
          "---\ndescription: Narrow\nskills:\n  - alpha\n---\nYou may load one skill.\n",
        )
        const info = yield* load("narrow")
        expect(act(info, "skill", "alpha")).toBe("allow")
        expect(act(info, "skill", "beta")).toBe("deny")
      }),
    withAgentDir,
  )

  it.instance(
    "a definition with no skills key leaves every skill reachable",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* writeDef(directory, "wide", "---\ndescription: Wide\npermissions: standard\n---\nYou are wide.\n")
        const info = yield* load("wide")
        expect(act(info, "skill", "anything")).not.toBe("deny")
      }),
    withAgentDir,
  )
})

describe("a bot's memory directory", () => {
  /** The store the real registry resolves for one definition name. */
  const dirForSlug = (slug: string) =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.rescan()
      return yield* AgentBotMemory.dirFor({
        name: slug,
        info: yield* agents.get(slug),
        definitionFile: (name) => agents.definitionFile(name),
      })
    })

  it.instance(
    "a definition on disk resolves to a store beside its own agent directory",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* writeDef(directory, "crane", "---\ndescription: Crane\n---\nYou are Crane.\n")
        const dir = yield* dirForSlug("crane")
        expect(dir?.replace(/\\/g, "/")).toBe(`${path.join(directory, ".origami").replace(/\\/g, "/")}/bot/crane/memory`)
      }),
    withAgentDir,
  )

  it.instance(
    "a NATIVE agent — what a MAIN session runs — has no bot store at all",
    () =>
      Effect.gen(function* () {
        expect(yield* dirForSlug("build")).toBeUndefined()
      }),
    withAgentDir,
  )

  it.instance(
    "`memory: false` opts a definition out of having one",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* writeDef(directory, "amnesiac", "---\ndescription: Amnesiac\nmemory: false\n---\nYou forget.\n")
        expect(yield* dirForSlug("amnesiac")).toBeUndefined()
      }),
    withAgentDir,
  )

  it.instance(
    "a definition with no FILE (declared in origami.json) has nothing to key a store to",
    () =>
      Effect.gen(function* () {
        expect(yield* load("gull")).toBeDefined()
        expect(yield* dirForSlug("gull")).toBeUndefined()
      }),
    {
      ...withAgentDir,
      config: { agent: { gull: { description: "Gull from origami.json" } } },
    },
  )
})

describe("test isolation", () => {
  it.instance(
    "the GLOBAL bot store resolves inside the preload's redirected config home, never a real one",
    () =>
      Effect.gen(function* () {
        // The preload sets XDG_CONFIG_HOME to a per-process temp directory, and
        // Global.Path.config is derived from it. A bot store keyed to a global
        // definition therefore cannot touch the developer's own ~/.config.
        const redirected = process.env["XDG_CONFIG_HOME"]
        expect(redirected).toBeTruthy()
        const dir = AgentBotMemory.memoryDir(Global.Path.config, "crane")
        expect(path.resolve(dir).startsWith(path.resolve(redirected!))).toBe(true)
      }),
    withAgentDir,
  )
})

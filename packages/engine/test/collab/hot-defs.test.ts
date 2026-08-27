import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Global } from "@origami/core/global"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { Directory } from "@/acp/directory"
import { ACPCollab } from "@/collab/acp"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

/**
 * Agent definitions written while the engine RUNS.
 *
 * The defect these cover: definitions used to be read once at engine start, so
 * a definition the extension had just written was invisible to `collab_agents`
 * and could not be invited until the engine restarted. Every test here builds
 * the registry FIRST and writes the definition SECOND - that ordering is the
 * bug, and a test that wrote the file first would pass with or without the fix.
 */
const it = testEffect(
  LayerNode.compile(LayerNode.group([CollabStore.node, CollabRunner.node, Agent.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({})],
  ]),
)

/**
 * `.origami` has to EXIST before the instance loads: the list of config
 * directories is resolved once, by walking up for directories that are already
 * there. The real target - the global `~/.config/origami` the extension writes
 * to - is in that list unconditionally, so this only reproduces the lookup, not
 * the defect.
 */
const withAgentDir = {
  init: (directory: string) =>
    Effect.promise(() => fs.mkdir(path.join(directory, ".origami", "agent"), { recursive: true })),
}

/**
 * The same, plus a collab-capable agent declared in `origami.json`.
 *
 * The point of the pairing: a rescan re-reads the DEFINITION FILES, and it must
 * be able to tell an entry that came from one of those apart from an entry the
 * config declared - the config block is not on the disk it is re-reading.
 */
const withConfigAgent = {
  ...withAgentDir,
  config: {
    agent: {
      gull: {
        description: "Gull from origami.json",
        model: "anthropic/sonnet-test",
        options: { collab: true },
      },
    },
  },
}

const agentDir = (directory: string) => path.join(directory, ".origami", "agent")

/** Write one definition file and answer with its path. */
const writeDef = (directory: string, slug: string, body: string) =>
  Effect.promise(async () => {
    const file = path.join(agentDir(directory), `${slug}.md`)
    await fs.writeFile(file, body)
    return file
  })

const HERON = `---
description: Heron the planner
model: anthropic/sonnet-test
steps: 7
collab: true
permission:
  bash: deny
---
You are Heron. Plan the work, then hand it over.
`

/** The same, on a model whose author says it can see. */
const SIGHTED = `---
description: Falcon the eye
model: anthropic/sonnet-test
collab: true
vision: true
---
You are Falcon. Look at what you are shown.
`

/** Collab-capable, and nobody has picked a model for it yet - the shipped seeds. */
const UNPINNED = `---
description: Wren the unpinned
collab: true
---
You are Wren. Nobody has picked a model for you.
`

/** Valid frontmatter, but it never opted in. */
const NOT_COLLAB = `---
description: A plain subagent
mode: subagent
---
You are not a collab agent.
`

/** Frontmatter that does not parse: the loader skips the file entirely. */
const BAD_FRONTMATTER = `---
description: "unterminated
  model: [oops
---
Body.
`

const slugsOf = (result: { agents: readonly ACPCollab.AgentEntry[] }) => result.agents.map((entry) => entry.slug)

/** The safe message a refused ext method carries, or undefined when it succeeded. */
const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.map(() => undefined as string | undefined),
    Effect.catch((error: E) => Effect.succeed((error as { safeMessage?: string }).safeMessage ?? String(error))),
  )

describe("collab_agents re-scans", () => {
  it.instance(
    "lists a definition written after the registry was already built",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory

        // Builds the registry. Everything after this point used to need a restart.
        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual([])

        yield* writeDef(directory, "heron", HERON)

        const listed = (yield* ACPCollab.agents(directory)).agents
        expect(listed).toEqual([{ slug: "heron", displayName: "Heron the planner", model: "anthropic/sonnet-test" }])
      }),
    withAgentDir,
  )

  it.instance(
    "lists one written to the GLOBAL agent directory, which is where the extension writes",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory

        // Registry built FIRST, as in every test here - the write has to land
        // on an engine that has already scanned.
        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual([])

        // The real target. The per-instance `.origami` the other tests use is a
        // stand-in; this is the path the Collab agents CRUD actually writes to,
        // so without this the fix would only be proven on a proxy surface.
        const file = path.join(Global.Path.config, "agent", "globalist.md")
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(file, HERON.replace("Heron the planner", "Globalist"))
          }),
          // Removed again: this directory is shared by every test in the
          // process, and a definition left behind would leak into their rosters.
          () => Effect.promise(() => fs.rm(file, { force: true })),
        )

        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual(["globalist"])
      }),
    withAgentDir,
  )

  it.instance(
    "leaves out a definition that did not opt in, however many times it is asked",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        yield* ACPCollab.agents(directory)
        yield* writeDef(directory, "plainly", NOT_COLLAB)

        // Twice: the re-scan must not accumulate or promote anything.
        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual([])
        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual([])
      }),
    withAgentDir,
  )

  it.instance(
    "picks up an edit to a definition it has already loaded",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        yield* writeDef(directory, "heron", HERON)
        expect((yield* ACPCollab.agents(directory)).agents[0]?.displayName).toBe("Heron the planner")

        yield* writeDef(directory, "heron", HERON.replace("Heron the planner", "Heron, renamed"))
        expect((yield* ACPCollab.agents(directory)).agents[0]?.displayName).toBe("Heron, renamed")
      }),
    withAgentDir,
  )
})

/**
 * A definition file DELETED while the engine runs.
 *
 * The registry used to be additive-only: the rescan merged the markdown OVER a
 * boot-time snapshot that already held BOTH the markdown and the `agent` blocks
 * inside origami.json, so dropping the entries the disk no longer had would
 * have taken the config-declared agents with them. The snapshot is now split by
 * PROVENANCE - `Config.getDeclaredAgents` answers with the config blocks alone -
 * so a rebuild can drop what no file backs and keep what no file ever did.
 */
describe("a definition file deleted while the engine runs", () => {
  it.instance(
    "drops the agent it backed, instead of keeping it for the life of the process",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const registry = yield* Agent.Service
        const file = yield* writeDef(directory, "heron", HERON)
        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual(["heron"])

        yield* Effect.promise(() => fs.rm(file))

        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual([])
        // Not just missing from the collab-capable projection: gone from the
        // registry, so nothing can resolve it into a session either.
        expect(yield* registry.get("heron")).toBeUndefined()
      }),
    withAgentDir,
  )

  it.instance(
    "leaves an agent origami.json declared exactly where it was",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const file = yield* writeDef(directory, "heron", HERON)
        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual(["gull", "heron"])

        yield* Effect.promise(() => fs.rm(file))

        // The config block is not on the disk the rescan re-reads, so a rebuild
        // that asked the disk alone would delete it silently.
        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual(["gull"])
      }),
    withConfigAgent,
  )

  it.instance(
    "falls back to the config block when BOTH sources named the same agent",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        // The case a key-by-key subtraction gets wrong: `gull` is on the disk
        // AND in origami.json, so its presence in the file scan says nothing
        // about whether the config also declared it.
        const file = yield* writeDef(directory, "gull", HERON.replace("Heron the planner", "Gull, refined"))
        expect((yield* ACPCollab.agents(directory)).agents[0]?.displayName).toBe("Gull, refined")

        yield* Effect.promise(() => fs.rm(file))

        const listed = (yield* ACPCollab.agents(directory)).agents
        expect(listed.map((entry) => entry.slug)).toEqual(["gull"])
        expect(listed[0]?.displayName).toBe("Gull from origami.json")
      }),
    withConfigAgent,
  )

  it.instance(
    "un-sets a field the file no longer carries, rather than keeping the old value",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const registry = yield* Agent.Service
        yield* writeDef(directory, "heron", HERON)
        yield* ACPCollab.agents(directory)
        expect((yield* registry.get("heron")).steps).toBe(7)

        // The same file with `steps:` taken out. A rescan that merged over the
        // previous pass would keep 7 forever.
        yield* writeDef(directory, "heron", HERON.replace("steps: 7\n", ""))
        yield* ACPCollab.agents(directory)
        expect((yield* registry.get("heron")).steps).toBeUndefined()
      }),
    withAgentDir,
  )
})

describe("inviting a definition the running registry never loaded", () => {
  it.instance(
    "accepts the slug and carries the FILE's settings into the roster",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const registry = yield* Agent.Service

        // Registry built with no definitions, exactly as a running engine would
        // have it when the extension writes a new one.
        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual([])
        yield* writeDef(directory, "heron", HERON)

        const created = yield* ACPCollab.create(directory, { title: "Ship it", agentSlugs: ["heron"] })

        // The roster projection reads the registry, so this is the definition
        // resolved fresh - not the slug echoed back.
        const state = yield* ACPCollab.state(directory, { collabId: created.collab.id })
        expect(state.participants).toHaveLength(1)
        expect(state.participants[0]?.displayName).toBe("Heron the planner")
        expect(state.participants[0]?.model).toBe("anthropic/sonnet-test")

        // The exact values the runner's child session and its first prompt read
        // out of the registry: model, step cap, persona and permission.
        const info = yield* registry.get("heron")
        expect(ACPCollab.modelOf(info)).toBe("anthropic/sonnet-test")
        expect(info.steps).toBe(7)
        expect(info.prompt).toContain("You are Heron")
        expect(info.permission).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
      }),
    withAgentDir,
  )

  it.instance(
    "carries a `vision: true` line into the registry, the same sweep `collab:` rides",
    () =>
      // The claim under test is that the frontmatter key needs no schema field
      // of its own: `ConfigAgentV1.normalize` sweeps every key it does not know
      // into `options`. Asserted through the REAL loader, because a unit test
      // of `visionCapable` would prove only that it reads a record.
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const registry = yield* Agent.Service
        yield* writeDef(directory, "falcon", SIGHTED)
        yield* writeDef(directory, "heron", HERON)
        yield* ACPCollab.agents(directory)

        expect(CollabRunner.visionCapable(yield* registry.get("falcon"))).toBe(true)
        // A def that never said it: blind, and told about images rather than
        // sent them. There is no capability table behind this.
        expect(CollabRunner.visionCapable(yield* registry.get("heron"))).toBe(false)
      }),
    withAgentDir,
  )

  it.instance(
    "takes a turn in the room it was invited to",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const store = yield* CollabStore.Service

        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual([])
        yield* writeDef(directory, "heron", HERON)

        // Invited through the SHIPPING method, so the accept is the real one.
        const created = yield* ACPCollab.create(directory, { title: "Ship it", agentSlugs: ["heron"] })

        // Only the model is stubbed. The store, the queue, the wake rules and
        // the roster reads are the shipping ones.
        const turns: string[] = []
        const runner = yield* CollabRunner.make({
          store,
          displayName: () => Effect.succeed("Heron the planner"),
          createSession: ({ agentSlug }) => Effect.succeed(`ses_${agentSlug}`),
          turn: ({ agentSlug }) =>
            Effect.sync(() => {
              turns.push(agentSlug)
              return { text: "planned it" }
            }),
        })
        yield* runner.post({ collabId: created.collab.id, text: "kick off", mentions: ["heron"] })
        yield* awaitWithTimeout(runner.settle, "collab did not settle", "10 seconds")

        expect(turns).toEqual(["heron"])
        const said = (yield* store.listMessages(created.collab.id)).filter((m) => m.authorKind === "agent")
        expect(said.map((m) => m.text)).toEqual(["planned it"])
      }),
    withAgentDir,
  )

  it.instance(
    "accepts it through collab_add_participant too",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        yield* writeDef(directory, "heron", HERON)
        const created = yield* ACPCollab.create(directory, { title: "Ship it", agentSlugs: ["heron"] })

        // Written AFTER the room existed and after the registry was last read.
        yield* writeDef(directory, "crane", HERON.replace("Heron the planner", "Crane the builder"))
        expect(
          yield* failure(ACPCollab.addParticipant(directory, { collabId: created.collab.id, agentSlug: "crane" })),
        ).toBeUndefined()

        const state = yield* ACPCollab.state(directory, { collabId: created.collab.id })
        expect(state.participants.map((entry) => entry.displayName)).toEqual(["Heron the planner", "Crane the builder"])
      }),
    withAgentDir,
  )
})

describe("a definition that cannot back a member is refused, and the refusal names the file", () => {
  it.instance(
    "names the file when it never set collab: true",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const file = yield* writeDef(directory, "plainly", NOT_COLLAB)

        const refusal = yield* failure(ACPCollab.create(directory, { title: "No", agentSlugs: ["plainly"] }))
        // The slug alone is unfixable: the human has to be told WHICH file.
        expect(refusal).toContain(file)
        expect(refusal).toContain("collab: true")
      }),
    withAgentDir,
  )

  it.instance(
    "names the file when the frontmatter does not parse",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const file = yield* writeDef(directory, "broken", BAD_FRONTMATTER)

        const refusal = yield* failure(ACPCollab.create(directory, { title: "No", agentSlugs: ["broken"] }))
        expect(refusal).toContain(file)
      }),
    withAgentDir,
  )

  it.instance(
    "says there is no file at all when there is none",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const refusal = yield* failure(ACPCollab.create(directory, { title: "No", agentSlugs: ["ghost"] }))
        expect(refusal).toContain("ghost")
        expect(refusal).toContain("no definition file")
        // No stale directory path is invented for a slug that has no file.
        expect(refusal).not.toContain(".md")
      }),
    withAgentDir,
  )

  it.instance(
    "refuses one bad slug without taking the good ones with it, and creates nothing",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        yield* writeDef(directory, "heron", HERON)
        const bad = yield* writeDef(directory, "plainly", NOT_COLLAB)

        const refusal = yield* failure(
          ACPCollab.create(directory, { title: "Mixed", agentSlugs: ["heron", "plainly"] }),
        )
        expect(refusal).toContain(bad)
        expect(refusal).not.toContain("heron is not")
        // Fail-closed: a half-built room would read as one member ignoring everyone.
        expect((yield* ACPCollab.list(directory)).collabs).toEqual([])
      }),
    withAgentDir,
  )
})

describe("a roster entry no definition backs", () => {
  it.instance(
    "still renders, with the slug standing in for the name",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const store = yield* CollabStore.Service
        // Straight to the store: this is the state left behind when a definition
        // file is DELETED under a room that already named it. A re-scan now
        // drops the REGISTRY entry (see the describe above), and the ROSTER row
        // in the store is exactly what it leaves behind - so the read path has
        // to cope with it rather than assume it away.
        const collab = yield* store.create({ title: "Orphaned", agentSlugs: ["vanished"] })

        const state = yield* ACPCollab.state(directory, { collabId: collab.id })
        expect(state.participants).toEqual([{ agentSlug: "vanished", displayName: "vanished", model: null }])
      }),
    withAgentDir,
  )

  it.instance(
    "fails that agent's turn with a reason instead of crashing the room",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const store = yield* CollabStore.Service
        const collab = yield* store.create({ title: "Orphaned", agentSlugs: ["vanished"] })

        // The REAL runner: the turn reaches the shipping `createSession`, which
        // has no definition to resolve. It must refuse before it builds a
        // session, never dereference the missing definition.
        yield* ACPCollab.post(directory, { collabId: collab.id, text: "anyone?", mentions: ["vanished"] })
        yield* awaitWithTimeout((yield* CollabRunner.Service).settle, "collab did not settle", "30 seconds")

        const state = yield* ACPCollab.state(directory, { collabId: collab.id })
        expect(state.agents).toHaveLength(1)
        expect(state.agents[0]?.lastError).toContain("vanished")
        // The human's post survives; only the turn failed.
        expect((yield* store.listMessages(collab.id)).map((m) => m.text)).toEqual(["anyone?"])
      }),
    withAgentDir,
  )
})

/**
 * A participant whose definition pins NO model.
 *
 * The shipped seeds are unpinned on purpose, so this is the out-of-the-box
 * state, not an edge case. It has to read as a condition the human can fix -
 * see `CollabRunner.needsModelReason` for what it used to do instead.
 */
describe("a participant whose definition pins no model", () => {
  it.instance(
    "fails that agent's turn with the fix in the reason, and leaves the room standing",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const store = yield* CollabStore.Service
        yield* writeDef(directory, "wren", UNPINNED)
        const created = yield* ACPCollab.create(directory, { title: "Ship it", agentSlugs: ["wren"] })

        // The REAL runner and the REAL turn dispatch: nothing about the model is
        // stubbed, which is the whole point - the check has to happen before the
        // prompt path reaches for a default that may not exist.
        yield* ACPCollab.post(directory, { collabId: created.collab.id, text: "kick off", mentions: ["wren"] })
        yield* awaitWithTimeout((yield* CollabRunner.Service).settle, "collab did not settle", "30 seconds")

        const state = yield* ACPCollab.state(directory, { collabId: created.collab.id })
        expect(state.agents).toHaveLength(1)
        expect(state.agents[0]?.state).toBe("idle")
        expect(state.agents[0]?.lastError).toContain(CollabRunner.needsModelReason("wren"))
        // Nothing was said on wren's behalf, and the human's post is still there.
        expect((yield* store.listMessages(created.collab.id)).map((m) => m.text)).toEqual(["kick off"])
      }),
    withAgentDir,
  )

  it.instance(
    "never raises it against a definition that DOES pin one",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        yield* writeDef(directory, "heron", HERON)
        const created = yield* ACPCollab.create(directory, { title: "Ship it", agentSlugs: ["heron"] })

        yield* ACPCollab.post(directory, { collabId: created.collab.id, text: "kick off", mentions: ["heron"] })
        yield* awaitWithTimeout((yield* CollabRunner.Service).settle, "collab did not settle", "30 seconds")

        // A GUARD, not a proof the turn ran: this harness has no reachable
        // model, so heron's turn still fails - for its own reason, further down
        // the prompt path. What must never happen is the gate claiming it, which
        // would make every PINNED agent unrunnable. Proven able to fail by
        // widening the gate's condition to always-true and watching this go red.
        const state = yield* ACPCollab.state(directory, { collabId: created.collab.id })
        expect(state.agents[0]?.lastError).not.toContain(CollabRunner.needsModelReason("heron"))
      }),
    withAgentDir,
  )
})

/**
 * THE SHAPE A BOTS-PANE DEFINITION REALLY HAS, read by the real registry off a
 * real file in the real directory that pane writes to.
 *
 * The W7 ACP test asserted its route against a hand-written agent record, and
 * that record was missing the one key every saved def carries - `hidden: true`.
 * The route was refused in UAT for exactly that key, and the test stayed green
 * because its fixture was not the thing. This is the join: whatever the ACP
 * stub is fed, THIS says what the registry hands the ACP loader for the file
 * the Bots pane wrote, and `Directory.modeOptionsFrom` is the same function
 * that loader calls.
 */
describe("a definition saved by the Bots pane", () => {
  /**
   * VERBATIM from the extension's serializer
   * (packages/vscode/src/dashboard/collabAgentSerialize.ts): the `mode: all` +
   * `hidden: true` header, the `collab: true` marker, the contract keys and the
   * tick-set permission block. Copied rather than imported - the two packages
   * do not share a build - so its drift guard is
   * packages/vscode/webview/dashboard/__tests__/botsManager.test.ts, which
   * asserts the serializer still emits these lines.
   */
  const BOTS_PANE_DEF = [
    "---",
    'description: "Deep thinker"',
    "mode: all",
    "hidden: true",
    "collab: true",
    "model: anthropic/sonnet-test",
    "permissions: standard",
    "steps: 40",
    "permission:",
    '  "*": deny',
    "  read: allow",
    "---",
    "",
    "You are Deepseek the bot.",
    "",
  ].join("\n")

  it.instance(
    "is loaded as a hidden, non-native agent - and is therefore a mode a session may be created as",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const registry = yield* Agent.Service

        // THE REAL TARGET: `globalAgentDir()` in the extension is exactly this
        // path, and the loader reaches it because ConfigPaths.directories lists
        // Global.Path.config unconditionally (config/paths.ts). Registry built
        // first, as everywhere in this file.
        expect(slugsOf(yield* ACPCollab.agents(directory))).toEqual([])
        const file = path.join(Global.Path.config, "agent", "deepseek.md")
        yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(file, BOTS_PANE_DEF)
          }),
          () => Effect.promise(() => fs.rm(file, { force: true })),
        )
        yield* ACPCollab.agents(directory)

        const info = yield* registry.get("deepseek")
        // The three fields the ACP mode filter reads. `hidden` is the one that
        // broke the route; `native: false` is what tells it apart from the
        // engine's own hidden prompt agents.
        expect(info.mode).toBe("all")
        expect(info.hidden).toBe(true)
        expect(info.native).toBe(false)

        // …and through the ACP loader's own rule: the bot IS a session-capable
        // mode, flagged so the picker can still leave it out.
        const modes = Directory.modeOptionsFrom(yield* registry.list())
        expect(modes.find((mode) => mode.id === "deepseek")).toEqual({
          id: "deepseek",
          name: "deepseek",
          description: "Deep thinker",
          hidden: true,
        })
        // The engine's own prompt agents stay out of it entirely.
        expect(modes.map((mode) => mode.id)).not.toContain("title")
        expect(modes.map((mode) => mode.id)).not.toContain("summary")
        expect(modes.map((mode) => mode.id)).not.toContain("compaction")
      }),
    withAgentDir,
  )
})

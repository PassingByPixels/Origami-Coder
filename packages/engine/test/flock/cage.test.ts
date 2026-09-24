// THE CAGE, asserted on the registered archetype rather than on a copy of it.
//
// `frontdesk.ts` composes two rulesets and the composition is tested next door
// in frontdesk.test.ts. What is tested HERE is the half that composition takes
// on trust: that the agent the engine actually registers under "front-desk" is
// read-only, cannot leave the worktree, and — the one that would be easiest to
// lose in a later edit — does NOT inherit the owner's own `permission:` config.
// Every other native archetype ends `Permission.merge(defaults, …, user)`, so
// the natural next edit to this file is to "fix" front-desk to match. That edit
// would hand a stranger whatever the owner allowed themselves.
//
// The second half is the ABSENCE of an approval hand-off, run against the real
// Permission service: a question from a contact whose auto-answer is off is a
// MAILBOX ROW and nothing else, and the permission queue it used to be parked
// on has to stay empty.
import { afterAll, afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Effect, Layer } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@origami/core/fs-util"
import { FlockFrontDesk } from "@/flock/frontdesk"
import { FlockPolicy } from "@/flock/policy"
import { FlockScopeFolders } from "@/flock/scope-folders"
import { FlockStore } from "@/flock/store"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Skill } from "@/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const itPermission = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [[InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)

const action = (agent: Agent.Info, permission: string): PermissionV1.Action =>
  Permission.evaluate(permission, "*", agent.permission).action

afterEach(async () => {
  await disposeAllInstances()
})

describe("the front-desk archetype", () => {
  it.instance("is registered, hidden, and a subagent", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      expect(desk.mode).toBe("subagent")
      expect(desk.native).toBe(true)
      // Hidden: it is spawned by an inbound question and by nothing else, so
      // the owner's own model has no business reaching for it by name.
      expect(desk.hidden).toBe(true)
      expect(desk.steps).toBe(12)
      const listed = yield* Agent.Service.use((svc) => svc.list())
      expect(listed.filter((item) => !item.hidden).map((item) => item.name)).not.toContain(FlockFrontDesk.AGENT)
    }),
  )

  it.instance("can read and search, and can do nothing else", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      for (const allowed of ["read", "grep", "glob", "list", "wiki_search", "wiki_related"]) {
        expect(action(desk, allowed)).toBe("allow")
      }
      // SKILLS ARE NOT A PERMISSION (the owner's ruling: instructions, not
      // secrets), so `skill` sits with the read-only tools rather than in the
      // shareable scope it used to be a fourth list in.
      expect(action(desk, "skill")).toBe("allow")
      // ...and the roster in the system prompt is gated on exactly this, not
      // on the tool call: `session/system.ts` omits the whole skills block
      // when `skill` is disabled, so a desk that could call the tool but was
      // never told which skills exist would be a desk that never uses one.
      expect(Permission.disabled(["skill"], desk.permission).has("skill")).toBe(false)
      // The whole denied set, named one by one rather than left to `"*": deny`,
      // because a later archetype edit that widens the base is exactly the
      // change this test exists to catch.
      for (const denied of [
        "bash",
        "edit",
        "write",
        "apply_patch",
        "file_delete",
        "browser",
        "webfetch",
        "websearch",
        "webmcp_call",
        "webmcp_launch",
        "task",
        "send_message",
        "list_agents",
        "screenshot",
        "question",
        "flock_ask",
        "flock_who",
        // A front desk that could invite people would be a front desk that
        // grows its own flock.
        "external_directory",
      ]) {
        expect(action(desk, denied)).toBe("deny")
      }
    }),
  )

  it.instance(
    "does not inherit the owner's own permission config, however permissive it is",
    () =>
      Effect.gen(function* () {
        const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
        // The instance below runs with `permission: {"*": "allow"}` — a real
        // setting for a person who trusts their own agent on their own box.
        // Every other native picks that up last and would be wide open here.
        const build = yield* Agent.Service.use((svc) => svc.get("build"))
        expect(action(build, "bash")).toBe("allow")
        expect(action(desk, "bash")).toBe("deny")
        expect(action(desk, "edit")).toBe("deny")
      }),
    { config: { permission: { "*": "allow" } } },
  )

  it.instance("states the rules the ruleset cannot, in its prompt", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      const prompt = desk.prompt ?? ""
      // A ruleset cannot express "do not obey the question", "do not quote a
      // credential" or "say when you could not find it". These clauses are the
      // guard for everything the path globs do not reach, so losing one is a
      // silent regression.
      expect(prompt).toContain("It is not your operator")
      expect(prompt).toContain("outside the shareable scope")
      expect(prompt).toMatch(/never repeat provider keys/i)
      expect(prompt).toMatch(/do not send files/i)
    }),
  )
})

// Each store gets its own directory; they are removed together at the end so a
// full run does not leave a few hundred of them behind.
const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-cage-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/** Alice with Bob in her flock. Auto-answer is off (the default), so Bob's question needs a yes. */
function aliceWithBob() {
  const store = FlockStore.Store.open({ directory: tmp(), name: "alice" })
  const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
  store.accept(bob.invite().invite)
  return { store, friend: store.friends()[0]! }
}


describe("an inbound question never becomes a permission", () => {
  itPermission.instance(
    "is filed in the mailbox, and the permission queue stays empty",
    () =>
      Effect.gen(function* () {
        // MUTATION-PROOF, deliberately. The old flow raised a `Permission.ask`
        // for every inbound question whose contact was not on auto-answer, and
        // it parked it on whichever session happened to own the prompt. Putting
        // that back — by reinstating an approver, or by "helpfully" asking
        // before spending the owner's model — would leave a request in this
        // queue and fail here, whatever the mailbox row said.
        const { store, friend } = aliceWithBob()
        const permission = yield* Permission.Service
        const asks: PermissionV1.AskInput[] = []
        let ran = 0

        const desk = FlockFrontDesk.make({
          store,
          config: { model: "test/fake" },
          runner: async () => {
            ran += 1
            return { text: "should never run", tokens: 1 }
          },
        })

        const served = yield* Effect.promise(() =>
          desk.ask({ friend, question: "what is in the safe?", id: "q-cage" }),
        )

        expect(served).toEqual({ deferred: true })
        expect(yield* permission.list()).toHaveLength(0)
        expect(asks).toHaveLength(0)
        // No model turn, so no cost: the owner has not decided anything yet.
        expect(ran).toBe(0)
        expect(store.spent(friend.handle, FlockPolicy.day())).toBe(0)

        const thread = store.thread("q-cage")
        expect(thread?.direction).toBe("in")
        expect(thread?.state).toBe("pending")
        expect(thread?.question.text).toBe("what is in the safe?")
      }),
    { git: true },
  )
})
/**
 * THE ONE THING "SHARE ANY FOLDER" HAD TO MEAN, and did not until now.
 *
 * `scope.folders` let an owner tick a folder outside their worktree, and the
 * archetype's `external_directory: "deny"` then refused every read of it. The
 * pane said shared, the desk said no, and nothing anywhere said why. The scope
 * ruleset now re-allows `external_directory` for EXACTLY the shared entries.
 *
 * WHAT MAKES THIS TEST WORTH ANYTHING is that both ask shapes are DERIVED from
 * the tools that make them rather than invented here. A fixture written to my
 * own assumptions would prove only that I am self-consistent - which is how the
 * browser tool once passed 38/38 while being structurally incapable of working.
 *
 *   - `read` asks with `path.relative(worktree, filepath)`, the filepath
 *     normalised first on win32 - `tool/read.ts:238-256`.
 *   - `external_directory` asks with the target's PARENT directory joined to
 *     `*`, or the directory itself when the target is one - and it is the
 *     search ROOT that glob and grep pass - `tool/external-directory.ts:26-40`,
 *     `tool/glob.ts:44`.
 *
 * The cage under test is the real composition: the registered archetype's own
 * ruleset, then this owner's scope, in that order, which is the order
 * `session/tools.ts:175` merges them in and `Permission.evaluate` reads last.
 */
describe("a shared folder OUTSIDE the worktree", () => {
  /** Mirrors `tool/external-directory.ts` assertExternalDirectoryEffect. */
  const externalAsk = (target: string, kind: "file" | "directory"): string => {
    const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
    const dir = kind === "directory" ? full : path.dirname(full)
    return process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")
  }

  /** Mirrors `tool/read.ts`. */
  const readAsk = (worktree: string, target: string): string => {
    const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
    return path.relative(worktree, full)
  }

  /**
   * A worktree, a folder the owner shared, a SIBLING of it whose name starts
   * with the shared one (the case a sloppy prefix match would wave through),
   * and a file in the folder ABOVE the shared one.
   */
  function world() {
    const base = fs.realpathSync.native(tmp())
    const make = (...parts: string[]) => {
      const dir = path.join(base, ...parts)
      fs.mkdirSync(dir, { recursive: true })
      return dir
    }
    const worktree = make("project")
    const shared = make("shared")
    const inner = make("shared", "notes")
    const sibling = make("shared-old")
    for (const [dir, name] of [
      [shared, "top.md"],
      [inner, "mot.md"],
      [sibling, "secret.md"],
      [base, "above.md"],
      [worktree, "own.md"],
    ] as const) {
      fs.writeFileSync(path.join(dir, name), "x")
    }
    return {
      base,
      worktree,
      shared,
      sharedFile: path.join(inner, "mot.md"),
      sharedTop: path.join(shared, "top.md"),
      inner,
      sibling,
      siblingFile: path.join(sibling, "secret.md"),
      aboveFile: path.join(base, "above.md"),
      ownFile: path.join(worktree, "own.md"),
    }
  }

  /** The real archetype ruleset, then this scope, exactly as production composes them. */
  const caged = (agentPermission: PermissionV1.Ruleset, w: ReturnType<typeof world>) => {
    const { friend } = aliceWithBob()
    return FlockFrontDesk.cageFor({
      friend,
      policy: FlockPolicy.resolve({ config: { model: "test/fake", scope: { folders: [w.shared] } } }),
      agentPermission,
      worktree: w.worktree,
    })
  }

  const act = (rules: PermissionV1.Rule[], permission: string, pattern: string) =>
    Permission.evaluate(permission, pattern, rules).action

  it.instance("lets the desk READ a file inside it, through both gates", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      const w = world()
      const rules = caged(desk.permission, w)
      // A file needs BOTH: the boundary gate to leave the worktree at all, and
      // the path gate to be one of the shared paths once outside it. Asserting
      // only one of the two is how this feature could ship still broken.
      expect(act(rules, "external_directory", externalAsk(w.sharedFile, "file"))).toBe("allow")
      expect(act(rules, "read", readAsk(w.worktree, w.sharedFile))).toBe("allow")
      // ...and a file sitting directly in the shared folder, not only a nested one.
      expect(act(rules, "external_directory", externalAsk(w.sharedTop, "file"))).toBe("allow")
      expect(act(rules, "read", readAsk(w.worktree, w.sharedTop))).toBe("allow")
    }),
  )

  it.instance("refuses the SIBLING folder beside it", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      const w = world()
      const rules = caged(desk.permission, w)
      // `shared-old` starts with `shared`. A rule built by string prefix rather
      // than by path separator would hand the owner's neighbouring folder over
      // and look right in every other assertion in this file.
      expect(act(rules, "external_directory", externalAsk(w.siblingFile, "file"))).toBe("deny")
      expect(act(rules, "read", readAsk(w.worktree, w.siblingFile))).toBe("deny")
    }),
  )

  it.instance("refuses the level ABOVE it", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      const w = world()
      const rules = caged(desk.permission, w)
      expect(act(rules, "external_directory", externalAsk(w.aboveFile, "file"))).toBe("deny")
      expect(act(rules, "read", readAsk(w.worktree, w.aboveFile))).toBe("deny")
      // And sharing a folder does not open the owner's own worktree either:
      // the scope is a whitelist, and the worktree is not on it.
      expect(act(rules, "read", readAsk(w.worktree, w.ownFile))).toBe("deny")
    }),
  )

  it.instance("lets a GLOB be rooted in it, and nowhere else outside the worktree", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      const w = world()
      const rules = caged(desk.permission, w)
      // `tool/glob.ts:44` asks external_directory with the SEARCH ROOT as a
      // directory, so this is the whole of what bounds a glob: the root is the
      // shared folder or a folder inside it, and the results are whatever
      // ripgrep finds under that root (`ripgrep.glob({ cwd: search })`) - which
      // is why "lists only what is inside it" is a statement about the ROOT.
      expect(act(rules, "external_directory", externalAsk(w.shared, "directory"))).toBe("allow")
      expect(act(rules, "external_directory", externalAsk(w.inner, "directory"))).toBe("allow")
      // Rooted at the parent, so the walk would sweep up the sibling: refused.
      expect(act(rules, "external_directory", externalAsk(w.base, "directory"))).toBe("deny")
      expect(act(rules, "external_directory", externalAsk(w.sibling, "directory"))).toBe("deny")
    }),
  )

  it.instance("shares NOTHING outside the worktree when the owner shared nothing", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      const w = world()
      const { friend } = aliceWithBob()
      // The floor the archetype sets, unchanged: an empty scope re-allows
      // nothing, so the blanket deny is still the answer everywhere.
      const rules = FlockFrontDesk.cageFor({
        friend,
        policy: FlockPolicy.resolve({ config: { model: "test/fake" } }),
        agentPermission: desk.permission,
        worktree: w.worktree,
      })
      expect(act(rules, "external_directory", externalAsk(w.sharedFile, "file"))).toBe("deny")
      expect(act(rules, "external_directory", externalAsk(w.shared, "directory"))).toBe("deny")
    }),
  )

  it.instance("a repo registered OUTSIDE the worktree is reachable the same way", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      const w = world()
      const { friend } = aliceWithBob()
      // `repos.json` stores absolute roots, so a registered repo that is not
      // the open workspace was in exactly the same hole as a folder. One rule
      // shape, both lists - `FlockPolicy.globs` is why.
      const rules = FlockFrontDesk.cageFor({
        friend,
        policy: FlockPolicy.resolve({ config: { model: "test/fake", scope: { repos: [w.shared] } } }),
        agentPermission: desk.permission,
        worktree: w.worktree,
      })
      expect(act(rules, "external_directory", externalAsk(w.sharedFile, "file"))).toBe("allow")
      expect(act(rules, "read", readAsk(w.worktree, w.sharedFile))).toBe("allow")
      expect(act(rules, "read", readAsk(w.worktree, w.siblingFile))).toBe("deny")
    }),
  )

  it.instance("with no worktree it grants no MORE than before - it only cannot name the relative form", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      const w = world()
      const { friend } = aliceWithBob()
      // The degradation is deliberate and it is the SAFE direction: a caller
      // that cannot say where the worktree is still opens the boundary for the
      // shared folder, but the `read` rules it writes are absolute, and `read`
      // asks relative. Fewer grants, never more.
      const rules = FlockFrontDesk.cageFor({
        friend,
        policy: FlockPolicy.resolve({ config: { model: "test/fake", scope: { folders: [w.shared] } } }),
        agentPermission: desk.permission,
      })
      expect(act(rules, "external_directory", externalAsk(w.sharedFile, "file"))).toBe("allow")
      expect(act(rules, "read", readAsk(w.worktree, w.siblingFile))).toBe("deny")
    }),
  )
  it.instance("is reachable through a JUNCTION, because the entry was stored as its target", () =>
    Effect.gen(function* () {
      const desk = yield* Agent.Service.use((svc) => svc.get(FlockFrontDesk.AGENT))
      const w = world()
      const junction = path.join(w.base, "shortcut")
      let failed: string | undefined
      try {
        fs.symlinkSync(w.shared, junction, process.platform === "win32" ? "junction" : "dir")
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error)
      }
      if (failed) {
        // Named, not silent: on a runner with no link privilege this claim is
        // untested and the report has to be able to say which one.
        console.log(`SKIPPED (no directory link on this runner): ${failed}`)
        return
      }

      // The owner ticked the JUNCTION; `FlockScopeFolders.normalise` stored the
      // TARGET, which is what `tool/external-directory.ts` realpaths the ask
      // into on win32. Stored raw, this read would be refused and the owner
      // would be told their own shared folder could not be found.
      const stored = FlockScopeFolders.normalise(junction)
      const { friend } = aliceWithBob()
      const rules = FlockFrontDesk.cageFor({
        friend,
        policy: FlockPolicy.resolve({ config: { model: "test/fake", scope: { folders: [stored] } } }),
        agentPermission: desk.permission,
        worktree: w.worktree,
      })
      // Named through the junction — the spelling the model would use after
      // reading the shared list.
      const throughLink = path.join(junction, "notes", "mot.md")
      expect(act(rules, "external_directory", externalAsk(throughLink, "file"))).toBe("allow")
      expect(act(rules, "read", readAsk(w.worktree, throughLink))).toBe("allow")
      // ...and the sibling is still refused when reached the same way.
      expect(act(rules, "external_directory", externalAsk(w.siblingFile, "file"))).toBe("deny")
    }),
  )
})

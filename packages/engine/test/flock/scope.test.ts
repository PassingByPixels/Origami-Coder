// SKILLS ARE NOT A PERMISSION, AND A FOLDER IS.
//
// Two rulings in one file, because they are one change: the fourth shareable
// list went away and a third one arrived in its place.
//
// The SKILLS half is a MIGRATION test above all. Both stores are hand-editable
// files that already hold `skills` lists written under the old rule, and the
// failure mode if they were merely stopped from GROWING is invisible: the list
// stays on disk, keeps adding read globs to a cage, and there is no longer any
// control anywhere that could take it out again. So the assertion is that a
// read DROPS it, not that a write refuses it.
//
// The FOLDERS half is about the two paths a file picker hands back on a bad
// day. A drive root and the owner's home directory are not "a wide scope" —
// they are every credential, key store and browser profile on the machine —
// and the refusal has to be a sentence the pane can show, not a throw.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Permission } from "@/permission"
import { ACPFlock } from "@/acp/flock"
import { FlockCard } from "@/flock/card"
import { FlockConfigWrite } from "@/flock/config-write"
import { FlockPolicy } from "@/flock/policy"
import { FlockScopeFolders } from "@/flock/scope-folders"
import { FlockStore } from "@/flock/store"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-scope-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("sanitiseScope — what an old config still on disk is allowed to say", () => {
  test("drops a stored `skills` list and keeps the three that are still shareable", () => {
    expect(
      FlockPolicy.sanitiseScope({ repos: ["a"], wiki: ["wiki/pages"], folders: ["D:/notes"], skills: ["wrap"] }),
    ).toEqual({ repos: ["a"], wiki: ["wiki/pages"], folders: ["D:/notes"] })
  })

  test("drops any other key too, so a newer build cannot smuggle a list past an older one", () => {
    expect(FlockPolicy.sanitiseScope({ repos: ["a"], secrets: ["keys"] })).toEqual({ repos: ["a"] })
  })

  test("a non-list, a non-string entry and a blank entry are not a share", () => {
    expect(FlockPolicy.sanitiseScope({ repos: "a" })).toEqual({})
    expect(FlockPolicy.sanitiseScope({ repos: ["a", 7, "", "  "] })).toEqual({ repos: ["a"] })
    expect(FlockPolicy.sanitiseScope(undefined)).toEqual({})
    expect(FlockPolicy.sanitiseScope(["a"])).toEqual({})
  })
})

describe("the ruleset and the card no longer know what a skill is", () => {
  const evaluate = (rules: ReturnType<typeof FlockPolicy.scopeRuleset>, file: string) =>
    Permission.evaluate("read", file, rules).action

  test("a `skills` list in a scope grants NOTHING, however it got there", () => {
    // Cast: the field is gone from the type, which is exactly why this has to
    // be asserted against the value a file on disk still holds.
    const rules = FlockPolicy.scopeRuleset({ skills: ["skills/wrap"] } as unknown as FlockPolicy.Scope)
    expect(evaluate(rules, "skills/wrap/SKILL.md")).toBe("deny")
    expect(rules).toEqual([{ permission: "read", pattern: "*", action: "deny" }])
  })

  test("the published card advertises repos, wiki and folders — and only those", () => {
    const store = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const identity = store.identity()
    const card = FlockCard.build({
      identity,
      specialties: [],
      policy: FlockPolicy.resolve({
        config: { model: "test/fake", scope: { repos: ["work/api"], wiki: ["wiki/pages"], folders: ["D:/notes"] } },
      }),
      signPrivateKey: identity.sign.privateKey,
    })
    expect(card.shareable).toEqual(["work/api", "wiki/pages", "D:/notes"])
  })
})

describe("the config file migration", () => {
  test("origami.json: a stored skills list is dropped on READ, not merely on write", () => {
    const directory = tmp()
    fs.writeFileSync(
      path.join(directory, "origami.json"),
      JSON.stringify({ flock: { frontDesk: { model: "m", scope: { repos: ["a"], skills: ["wrap", "delegate"] } } } }),
    )
    expect(FlockConfigWrite.read(directory).scope).toEqual({ repos: ["a"] })
    // ...and the desk built from it cages the skill path it used to allow.
    const rules = FlockPolicy.scopeRuleset(FlockConfigWrite.read(directory).scope ?? {})
    expect(rules.some((rule) => String(rule.pattern).includes("wrap"))).toBe(false)
  })

  test("origami.json: a desk with no scope block at all is untouched", () => {
    const directory = tmp()
    fs.writeFileSync(path.join(directory, "origami.json"), JSON.stringify({ flock: { frontDesk: { model: "m" } } }))
    expect(FlockConfigWrite.read(directory)).toEqual({ model: "m" })
  })

  test("flock.json: a per-contact skills override is dropped, and the rest of the override survives", () => {
    const directory = tmp()
    const store = FlockStore.Store.open({ directory, name: "alice" })
    store.accept(FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite)
    const handle = store.friends()[0]!.handle
    // Written the way a build BEFORE this change wrote it.
    store.setPolicy(handle, {
      autoAnswer: true,
      scope: { repos: ["a"], skills: ["wrap"] },
    } as unknown as FlockPolicy.Overrides)

    // A fresh open re-reads the file from disk and re-runs `migrate`.
    const reopened = FlockStore.Store.open({ directory, name: "alice" })
    const friend = reopened.friends()[0]!
    expect(friend.policy?.scope).toEqual({ repos: ["a"] })
    expect(friend.policy?.autoAnswer).toBe(true)
  })
})

describe("a folder a file picker handed back", () => {
  test("a real folder is accepted, trailing separator and all", () => {
    const folder = tmp()
    expect(FlockScopeFolders.refusal(folder)).toBeUndefined()
    expect(FlockScopeFolders.check([folder + "/"])).toEqual({
      ok: true,
      folders: [FlockScopeFolders.normalise(folder)],
    })
  })

  test("a whole drive is refused by name", () => {
    const root = path.parse(process.cwd()).root
    expect(FlockScopeFolders.refusal(root)).toContain("whole drive")
  })

  test("the home directory itself is refused, in any case the shell types it", () => {
    const home = tmp()
    expect(FlockScopeFolders.refusal(home, home)).toContain("home folder")
    if (process.platform === "win32") {
      expect(FlockScopeFolders.refusal(home.toUpperCase(), home)).toContain("home folder")
    }
    // A folder INSIDE the home directory is what the refusal points at, so it must pass.
    const inside = path.join(home, "notes")
    fs.mkdirSync(inside)
    expect(FlockScopeFolders.refusal(inside, home)).toBeUndefined()
  })

  test("a relative path, a missing folder and a file are each refused with their own reason", () => {
    const folder = tmp()
    const file = path.join(folder, "note.md")
    fs.writeFileSync(file, "x")
    expect(FlockScopeFolders.refusal("notes/2026")).toContain("absolute")
    expect(FlockScopeFolders.refusal(path.join(folder, "nope"))).toContain("does not exist")
    expect(FlockScopeFolders.refusal(file)).toContain("not a folder")
    expect(FlockScopeFolders.refusal("   ")).toContain("needs a path")
  })

  test("check reports the FIRST refusal and stores nothing", () => {
    const folder = tmp()
    const result = FlockScopeFolders.check([folder, path.join(folder, "nope")])
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain("does not exist")
  })

  test("one folder written two ways is stored once", () => {
    const folder = tmp()
    expect(FlockScopeFolders.check([folder, folder + path.sep, path.join(folder, ".")])).toEqual({
      ok: true,
      folders: [FlockScopeFolders.normalise(folder)],
    })
  })
})

describe("the two writers refuse the same folder", () => {
  const inviteFrom = (name: string) => FlockStore.Store.open({ directory: tmp(), name }).invite().invite

  test("flock_front_desk stores a good folder and refuses a drive root", () => {
    const directory = tmp()
    const folder = tmp()
    expect(ACPFlock.frontDesk({ directory, model: "m", scope: { folders: [folder] } }).ok).toBe(true)
    expect(ACPFlock.state({ directory }).frontDesk.scope).toEqual({ folders: [FlockScopeFolders.normalise(folder)] })

    const refused = ACPFlock.frontDesk({ directory, scope: { folders: [path.parse(process.cwd()).root] } })
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("whole drive")
    // NOT half-written: the good scope is still exactly what it was.
    expect(ACPFlock.state({ directory }).frontDesk.scope).toEqual({ folders: [FlockScopeFolders.normalise(folder)] })
  })

  test("flock_set_policy refuses it too — one config, two doors", () => {
    const directory = tmp()
    ACPFlock.frontDesk({ directory, model: "m" })
    ACPFlock.accept({ directory, invite: inviteFrom("ivy") })
    const handle = ACPFlock.state({ directory }).friends[0]!.handle

    const refused = ACPFlock.setPolicy({ directory, handle, scope: { folders: [path.join(tmp(), "nope")] } })
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain("does not exist")
    expect(ACPFlock.state({ directory }).friends[0]!.policy.scope).toBeUndefined()
  })

  test("a skills list posted by an older pane is dropped rather than stored", () => {
    const directory = tmp()
    ACPFlock.frontDesk({
      directory,
      model: "m",
      scope: { repos: ["a"], skills: ["wrap"] } as unknown as FlockPolicy.Scope,
    })
    expect(ACPFlock.state({ directory }).frontDesk.scope).toEqual({ repos: ["a"] })
  })
})
/**
 * A JUNCTION IS NOT A SECOND FOLDER, and the cage is the reason it matters.
 *
 * `tool/external-directory.ts` resolves its target through
 * `FSUtil.normalizePath` — `realpathSync.native` on win32 — so a read under a
 * junction reaches the permission gate named by its TARGET. A scope entry
 * stored as the junction path would therefore match nothing at all, and the
 * owner would be told the folder they had just ticked could not be found.
 *
 * The link is created here rather than mocked, because the whole claim is about
 * what the filesystem hands back and a fake link would prove only that the
 * helper returns what the fake said.
 */
describe("a folder shared through a junction or a symlink", () => {
  /** A directory link, or the reason this runner could not make one. */
  function link(target: string, at: string): string | undefined {
    try {
      // "junction" on win32 needs no elevation; "dir" elsewhere.
      fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir")
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  test("is accepted, and STORED AS THE TARGET the cage will be asked about", () => {
    const base = fs.realpathSync.native(tmp())
    const target = path.join(base, "notes")
    fs.mkdirSync(target)
    const junction = path.join(base, "shortcut")
    const failed = link(target, junction)
    if (failed) {
      // A named skip, not a silent pass: on a runner with no link privilege
      // this claim is untested and the report has to be able to say so.
      console.log(`SKIPPED (no directory link on this runner): ${failed}`)
      return
    }

    expect(FlockScopeFolders.refusal(junction)).toBeUndefined()
    expect(FlockScopeFolders.normalise(junction)).toBe(target)
    expect(FlockScopeFolders.check([junction])).toEqual({ ok: true, folders: [target] })
    // The two spellings are ONE share, not two rows in the pane.
    expect(FlockScopeFolders.check([junction, target])).toEqual({ ok: true, folders: [target] })
  })

  test("the pane is handed the resolved path back, through the real write", () => {
    const base = fs.realpathSync.native(tmp())
    const target = path.join(base, "notes")
    fs.mkdirSync(target)
    const junction = path.join(base, "shortcut")
    const failed = link(target, junction)
    if (failed) {
      console.log(`SKIPPED (no directory link on this runner): ${failed}`)
      return
    }

    const directory = tmp()
    expect(ACPFlock.frontDesk({ directory, model: "m", scope: { folders: [junction] } }).ok).toBe(true)
    // What `flock_state` sends the pane is the TARGET: the pane names the
    // folder whose contents are actually handed over, not the door to it.
    expect(ACPFlock.state({ directory }).frontDesk.scope).toEqual({ folders: [target] })
  })

  test("a repo root registered through a link is resolved the same way, and NOT refused", () => {
    const base = fs.realpathSync.native(tmp())
    const target = path.join(base, "repo")
    fs.mkdirSync(target)
    const junction = path.join(base, "repo-link")
    const failed = link(target, junction)
    if (failed) {
      console.log(`SKIPPED (no directory link on this runner): ${failed}`)
      return
    }

    const directory = tmp()
    // Repos come from the Folds registry, not from a picker. They are resolved
    // — the cage measures them against the same realpathed ask — but never put
    // through the folder refusals, because rejecting a repo the owner
    // registered elsewhere would break a share that worked yesterday.
    expect(ACPFlock.frontDesk({ directory, model: "m", scope: { repos: [junction] } }).ok).toBe(true)
    expect(ACPFlock.state({ directory }).frontDesk.scope).toEqual({ repos: [target] })
  })

  test("a path that cannot be resolved keeps its readable form for the refusal", () => {
    // realpath throws on a missing path. Falling through to the tidied form is
    // what lets the owner read "<path> does not exist" instead of a stack.
    const missing = path.join(fs.realpathSync.native(tmp()), "nope")
    expect(FlockScopeFolders.normalise(missing)).toBe(missing)
    expect(FlockScopeFolders.refusal(missing)).toContain("does not exist")
  })
})

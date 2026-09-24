// ONE ENGINE HOLDS THE FLOCK LINKS.
//
// Each VS Code window spawns its own engine, and `service.ts` opens one relay
// socket per friend per ENGINE. The relay allows one socket per role per rid, so
// two windows evicted each other's Flock socket in a loop — known since 0.4.83
// and never fixed because the pane had no way to say what was happening.
//
// The lease is a file in the engine's DATA directory (not the config directory:
// `flock.json` holds the owner's private keys and is reviewed by a person; a
// heartbeat is machine state). These are its tests, over temp directories only —
// nothing here reads or writes the real `~/.local/share/origami`.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockOwnerLease } from "@/flock/owner-lease"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-owner-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/** An engine, named by pid, over a directory the test owns. `alive` is injected
 *  so a dead owner is a fact the test states rather than a process it kills. */
const engine = (directory: string, pid: number, now: () => number, living: number[] = []) =>
  new FlockOwnerLease.Owner({
    directory,
    pid,
    now,
    alive: (other) => living.includes(other),
  })

describe("flock owner lease", () => {
  test("the first engine claims, and the file names its pid", () => {
    const directory = tmp()
    const first = engine(directory, 101, () => 1_000, [101])
    expect(first.claim()).toBe(true)
    expect(first.holds).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(directory, FlockOwnerLease.FILE), "utf8"))).toMatchObject({
      pid: 101,
      heartbeatAt: 1_000,
    })
  })

  test("a SECOND engine, with the owner alive and beating, is refused", () => {
    const directory = tmp()
    expect(engine(directory, 101, () => 1_000, [101, 202]).claim()).toBe(true)

    const second = engine(directory, 202, () => 1_000 + FlockOwnerLease.STALE_MS - 1, [101, 202])
    expect(second.claim()).toBe(false)
    expect(second.holds).toBe(false)
    // ...and it did not overwrite the owner.
    expect(FlockOwnerLease.read(directory)?.pid).toBe(101)
  })

  test("an owner whose PROCESS is gone loses the lease at once, stale window or not", () => {
    const directory = tmp()
    expect(engine(directory, 101, () => 1_000, [101, 202]).claim()).toBe(true)

    // The owning window was killed: its heartbeat is a second old, but nothing
    // is behind the pid. Waiting out STALE_MS for that would leave the flock
    // silent for fifteen seconds after every window close.
    const second = engine(directory, 202, () => 1_001, [202])
    expect(second.claim()).toBe(true)
    expect(FlockOwnerLease.read(directory)?.pid).toBe(202)
  })

  test("a lease nobody has beaten for STALE_MS is dead even if the pid is reused", () => {
    const directory = tmp()
    expect(engine(directory, 101, () => 1_000, [101, 202]).claim()).toBe(true)
    // 101 still exists — a recycled pid, or an engine that hung — but it has
    // not said so for three beats.
    const second = engine(directory, 202, () => 1_000 + FlockOwnerLease.STALE_MS, [101, 202])
    expect(second.claim()).toBe(true)
  })

  test("releasing hands over immediately: the next engine claims on its first try", () => {
    const directory = tmp()
    const first = engine(directory, 101, () => 1_000, [101, 202])
    expect(first.claim()).toBe(true)
    first.release()
    expect(FlockOwnerLease.read(directory)).toBeUndefined()
    expect(engine(directory, 202, () => 1_000, [101, 202]).claim()).toBe(true)
  })

  test("a release by a NON-owner leaves the owner's lease alone", () => {
    const directory = tmp()
    expect(engine(directory, 101, () => 1_000, [101, 202]).claim()).toBe(true)
    const second = engine(directory, 202, () => 1_000, [101, 202])
    expect(second.claim()).toBe(false)
    second.release()
    expect(FlockOwnerLease.read(directory)?.pid).toBe(101)
  })

  test("the owner's beat refreshes the file so a second engine never reads it as stale", () => {
    const directory = tmp()
    let clock = 1_000
    const first = engine(directory, 101, () => clock, [101, 202])
    expect(first.claim()).toBe(true)
    clock += FlockOwnerLease.HEARTBEAT_MS
    first.beat()
    expect(FlockOwnerLease.read(directory)?.heartbeatAt).toBe(clock)
    expect(engine(directory, 202, () => clock, [101, 202]).claim()).toBe(false)
  })

  test("a beat that finds ANOTHER pid in the file drops the claim rather than stealing it back", () => {
    const directory = tmp()
    const first = engine(directory, 101, () => 1_000, [101, 202])
    expect(first.claim()).toBe(true)
    // A second engine took it while this one was busy (its beat was late).
    fs.writeFileSync(
      path.join(directory, FlockOwnerLease.FILE),
      JSON.stringify({ pid: 202, startedAt: "2026-09-03T00:00:00.000Z", heartbeatAt: 1_000 }),
    )
    first.beat()
    expect(first.holds).toBe(false)
    expect(FlockOwnerLease.read(directory)?.pid).toBe(202)
  })

  test("junk on disk is ABSENT, not an eternal lease", () => {
    const directory = tmp()
    fs.writeFileSync(path.join(directory, FlockOwnerLease.FILE), "{ not json")
    expect(FlockOwnerLease.read(directory)).toBeUndefined()
    expect(engine(directory, 101, () => 1_000, [101]).claim()).toBe(true)
  })

  test("a record with no numeric pid is dead material a new engine may take", () => {
    const directory = tmp()
    fs.writeFileSync(path.join(directory, FlockOwnerLease.FILE), JSON.stringify({ pid: "many", heartbeatAt: 1_000 }))
    expect(FlockOwnerLease.read(directory)).toBeUndefined()
    expect(engine(directory, 101, () => 1_000, [101]).claim()).toBe(true)
  })

  test("a directory that does not exist yet is created rather than refused", () => {
    const directory = path.join(tmp(), "nested", "data")
    expect(engine(directory, 101, () => 1_000, [101]).claim()).toBe(true)
    expect(FlockOwnerLease.read(directory)?.pid).toBe(101)
  })

  // MUTATION PROOF for the liveness check itself. Remove it — treat every
  // existing record as claimable — and the second engine takes a lease its
  // living owner is beating, which is the eviction loop back again.
  test("MUTATION PROOF — the claim really turns on liveness, not on the file existing", () => {
    const directory = tmp()
    expect(engine(directory, 101, () => 1_000, [101, 202]).claim()).toBe(true)
    const beating = engine(directory, 202, () => 1_001, [101, 202])
    const dead = engine(directory, 202, () => 1_001, [202])
    expect([beating.claim(), dead.claim()]).toEqual([false, true])
  })
})

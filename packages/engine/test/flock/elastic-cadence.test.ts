// t-w2qlop: the flock's timers follow the engine's elastic class.
//
// Before this, every engine polled for `flock.json` every 5 s and read its
// fingerprint every 5 s - the two 5 s wake-ups of an idle engine on a machine
// with no flock at all. Now a resting engine (background / idle) waits at least
// ElasticState.REST_MIN_MS between them, an active one keeps the 5 s beat, and
// the lease HOLDER keeps its 5 s beat in every class (a slower beat would let a
// sibling read a live lease as stale).
//
// Timers are captured with their period and fired by hand, so every claim is
// about the number the engine asked for, not a sleep.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ElasticOs } from "@/elastic/os"
import { ElasticState } from "@/elastic/state"
import { FlockBoot } from "@/flock/boot"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockRelayTransport } from "@/flock/relay-transport"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"
import { FlockWatch } from "@/flock/watch"

const REST = ElasticState.REST_MIN_MS
const BEAT = FlockOwnerLease.HEARTBEAT_MS

/** A scheduler that keeps each armed timer with its period, drops cleared ones,
 *  and fires what is armed on request. */
function scheduler() {
  let next = 1
  const armed = new Map<number, { fn: () => void; ms: number }>()
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++
      armed.set(id, { fn, ms })
      return id
    },
    clearTimer: (id: unknown) => {
      armed.delete(id as number)
    },
    /** The periods of the timers armed right now. */
    periods: () => [...armed.values()].map((timer) => timer.ms),
    /** Fire every armed timer once, as if its period passed. */
    fire: () => {
      const due = [...armed.entries()]
      for (const [id] of due) armed.delete(id)
      for (const [, timer] of due) timer.fn()
    },
  }
}

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-elastic-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const stops: Array<() => void> = []
beforeEach(() => {
  // No real OS call from a test that moves the class.
  ElasticOs.setForTest({ apply: () => ({ priority: "normal", ecoqos: false }), trim: () => ({ trimmed: false }) })
})
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  ElasticState.resetForTest()
  ElasticOs.setForTest(undefined)
})

describe("the no-flock.json poll (every engine, default settings)", () => {
  test("5 s while active, the rest period while background or idle, and back to 5 s the moment it is active", () => {
    const clock = scheduler()
    const handle = FlockBoot.waitForFile({
      exists: () => false,
      begin: () => FlockService.idleHandle("not-started", false),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    stops.push(() => handle.stop())
    expect(clock.periods()).toEqual([BEAT])

    ElasticState.request("idle")
    expect(clock.periods()).toEqual([REST])
    clock.fire()
    expect(clock.periods()).toEqual([REST])

    ElasticState.request("background")
    expect(clock.periods()).toEqual([REST])

    ElasticState.request("active")
    expect(clock.periods()).toEqual([BEAT])
  })
})

describe("the flock.json fingerprint poll", () => {
  test("follows the class, and an engine that becomes active reads the file at once", () => {
    const clock = scheduler()
    let print = "a"
    let changes = 0
    const watcher = FlockWatch.start({
      file: path.join(tmp(), "flock.json"),
      onChange: () => changes++,
      deps: {
        watchDirectory: () => ({ close: () => {} }),
        fingerprint: () => print,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    })
    stops.push(() => watcher.stop())
    expect(clock.periods()).toEqual([FlockWatch.POLL_MS])

    ElasticState.request("idle")
    expect(clock.periods()).toEqual([REST])

    // A write the rest period has not seen yet is announced when the engine
    // wakes, not a whole rest period later.
    print = "b"
    ElasticState.request("active")
    expect(changes).toBe(1)
    expect(clock.periods()).toEqual([FlockWatch.POLL_MS])
  })
})

/** ONE `flock.json` with one friend: what two windows on a machine share. */
function ready(): string {
  const directory = tmp()
  const mine = FlockStore.Store.open({ directory, name: "alice" })
  mine.accept(FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite)
  return directory
}

function engine(flock: string, lease: string, pid: number, living: number[]) {
  const clock = scheduler()
  const deps: FlockRelayTransport.RelayDeps = {
    connect: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  }
  const handle = FlockService.start({
    store: FlockStore.Store.open({ directory: flock }),
    config: { model: "test/fake" },
    relayUrl: "ws://relay.test",
    runner: async () => ({ text: "", tokens: 0 }),
    deps,
    owner: new FlockOwnerLease.Owner({ directory: lease, pid, alive: (other) => living.includes(other) }),
    leaseDirectory: lease,
    publish: false,
    log: () => {},
  })
  stops.push(() => handle.stop())
  return { handle, clock }
}

describe("the flock service beat", () => {
  test("the lease holder beats every 5 s in every class; a non-holder's retry rests with the engine", () => {
    const lease = tmp()
    const flock = ready()
    const living = [101, 202]
    const holder = engine(flock, lease, 101, living)
    const waiting = engine(flock, lease, 202, living)
    expect(holder.handle.kind).toBe("relay")
    expect(waiting.handle.kind).toBe("other-engine")
    // The relay transport arms its own timers on the same clock; the beat is
    // the one at the heartbeat period.
    expect(holder.clock.periods()).toContain(BEAT)
    expect(waiting.clock.periods()).toEqual([BEAT])

    ElasticState.request("idle")
    expect(holder.clock.periods()).toContain(BEAT)
    expect(waiting.clock.periods()).toEqual([REST])
  })

  test("when the holder dies, an ACTIVE sibling takes the lease on its next beat, 5 s later", () => {
    const lease = tmp()
    const flock = ready()
    const living = [101, 202]
    const holder = engine(flock, lease, 101, living)
    const waiting = engine(flock, lease, 202, living)
    expect(holder.handle.kind).toBe("relay")

    // The holder's process is gone: no release, no more beats. Its lease file
    // stays, fresh, until its pid is found dead.
    living.splice(living.indexOf(101), 1)
    expect(waiting.clock.periods()).toEqual([BEAT])
    waiting.clock.fire()
    expect(waiting.handle.kind).toBe("relay")
    expect(FlockOwnerLease.read(lease)?.pid).toBe(202)
  })

  test("a RESTING sibling takes the dead holder's lease on its next rest beat, and at once when it becomes active", () => {
    const lease = tmp()
    const flock = ready()
    const living = [101, 202]
    engine(flock, lease, 101, living)
    const waiting = engine(flock, lease, 202, living)
    ElasticState.request("idle")
    living.splice(living.indexOf(101), 1)
    expect(waiting.clock.periods()).toEqual([REST])

    // Promoted before the rest period ran out: back on the short beat now.
    ElasticState.request("active")
    expect(waiting.clock.periods()).toEqual([BEAT])
    waiting.clock.fire()
    expect(waiting.handle.kind).toBe("relay")
  })
})

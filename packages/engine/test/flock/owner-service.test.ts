// TWO ENGINES, ONE FLOCK — the service half of the multi-window fix.
//
// `owner-lease.test.ts` proves the arbiter. This proves what `service.ts` does
// with it: the second engine registers NO routes and dials NO socket, it says
// which state it is in rather than looking broken, and when the owner goes away
// it takes over on its next beat without anybody restarting anything.
//
// Everything is over temp directories with a scripted clock and scripted pids;
// the socket factory is a fake that RECORDS, so "did not dial" is asserted
// against the factory rather than against a flag.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockBoot } from "@/flock/boot"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockRelayTransport } from "@/flock/relay-transport"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-owner-svc-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const handles: FlockService.Handle[] = []
afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop()
})

/** ONE `flock.json` with one friend and a desk model, which is what two windows
 *  on a machine really share. Both engines open the SAME directory, so their
 *  rendezvous ids collide exactly the way they do in the bug. */
function ready(): string {
  const directory = tmp()
  const mine = FlockStore.Store.open({ directory, name: "alice" })
  mine.accept(FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite)
  return directory
}

/** A socket factory that records every URL and connects nothing. */
function fakeDeps() {
  const urls: string[] = []
  const timers: Array<() => void> = []
  const deps: FlockRelayTransport.RelayDeps = {
    connect: (url) => {
      urls.push(url)
      return {
        send: () => {},
        close: () => {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      }
    },
    // Timers are CAPTURED, not run: a heartbeat has to be something the test
    // fires, or "takes over on the next beat" would be a sleep.
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  }
  return { deps, urls, timers }
}

function startFor(flock: string, lease: string, owner: FlockOwnerLease.Owner) {
  const wire = fakeDeps()
  const handle = FlockService.start({
    store: FlockStore.Store.open({ directory: flock }),
    config: { model: "test/fake" },
    relayUrl: "ws://relay.test",
    runner: async () => ({ text: "", tokens: 0 }),
    deps: wire.deps,
    owner,
    leaseDirectory: lease,
    // Two engines in ONE process: neither may publish to the module slots, or
    // they would report each other's state.
    publish: false,
    log: () => {},
  })
  handles.push(handle)
  return { handle, ...wire }
}

const owner = (lease: string, pid: number, now: () => number, living: number[]) =>
  new FlockOwnerLease.Owner({ directory: lease, pid, now, alive: (other) => living.includes(other) })

describe("flock service — one engine holds the links", () => {
  test("the FIRST engine claims and dials; the SECOND does neither", () => {
    const lease = tmp()
    const flock = ready()
    const first = startFor(flock, lease, owner(lease, 101, () => 1_000, [101, 202]))
    expect(first.handle.active).toBe(true)
    expect(first.handle.kind).toBe("relay")
    expect(first.handle.routes.size).toBe(1)
    expect(first.urls).toHaveLength(1)

    const second = startFor(flock, lease, owner(lease, 202, () => 1_000, [101, 202]))
    expect(second.handle.active).toBe(false)
    expect(second.handle.kind).toBe("other-engine")
    expect(second.handle.reason).toBe(FlockService.OTHER_ENGINE_REASON)
    expect(second.handle.routes.size).toBe(0)
    expect(second.urls).toEqual([])
    expect(second.handle.transport).toBeUndefined()
  })

  test("when the owner stops, the waiting engine takes over on its very next beat", () => {
    const lease = tmp()
    const flock = ready()
    const first = startFor(flock, lease, owner(lease, 101, () => 1_000, [101, 202]))
    const second = startFor(flock, lease, owner(lease, 202, () => 1_000, [101, 202]))
    expect(second.urls).toEqual([])

    // The owning window closes: stop() releases the lease.
    first.handle.stop()
    handles.splice(handles.indexOf(first.handle), 1)

    // ...and the waiting engine's next heartbeat is when it finds out.
    second.timers.at(-1)!()
    expect(second.handle.active).toBe(true)
    expect(second.handle.kind).toBe("relay")
    expect(second.urls).toHaveLength(1)
  })

  test("an owner that was KILLED (no release) is taken over too, on the same beat", () => {
    const lease = tmp()
    // 101 wrote the lease and then died: the file is there, the process is not.
    const flock = ready()
    startFor(flock, lease, owner(lease, 101, () => 1_000, [101, 202]))
    const second = startFor(flock, lease, owner(lease, 202, () => 1_000, [202]))
    expect(second.urls).toHaveLength(1)
    expect(second.handle.kind).toBe("relay")
  })

  test("the kill switch still wins: ORIGAMI_DISABLE_FLOCK takes no lease at all", () => {
    const lease = tmp()
    const handle = FlockService.start({
      store: FlockStore.Store.open({ directory: ready() }),
      config: { model: "test/fake" },
      runner: async () => ({ text: "", tokens: 0 }),
      leaseDirectory: lease,
      publish: false,
      env: { ORIGAMI_DISABLE_FLOCK: "1" },
      log: () => {},
    })
    handles.push(handle)
    expect(handle.active).toBe(false)
    expect(handle.kind).toBe("none")
    expect(FlockOwnerLease.read(lease)).toBeUndefined()
  })

  test("a box with no friends takes no lease either — the cheap refusals come first", () => {
    const lease = tmp()
    const handle = FlockService.start({
      store: FlockStore.Store.open({ directory: tmp(), name: "alice" }),
      config: { model: "test/fake" },
      runner: async () => ({ text: "", tokens: 0 }),
      leaseDirectory: lease,
      publish: false,
      log: () => {},
    })
    handles.push(handle)
    expect(handle.kind).toBe("none")
    expect(FlockOwnerLease.read(lease)).toBeUndefined()
  })

  // MUTATION PROOF for the gate in `start()`. Give the second engine an owner
  // that always claims — which is what removing the check amounts to — and it
  // dials the same friend the first engine is already holding, which is the
  // eviction loop this whole lane exists to stop.
  test("MUTATION PROOF — without the claim, the second engine dials the same rid", () => {
    const lease = tmp()
    const flock = ready()
    const first = startFor(flock, lease, owner(lease, 101, () => 1_000, [101, 202]))
    // `alive: []` says nothing is running, so every claim succeeds: the
    // unguarded behaviour, expressed as data.
    const second = startFor(flock, lease, owner(lease, 202, () => 1_000, []))
    expect(second.urls).toHaveLength(1)
    expect(first.urls[0]).toBe(second.urls[0]!)
  })

  test("stopping the owner releases the lease file, so nothing has to time out", () => {
    const lease = tmp()
    const first = startFor(ready(), lease, owner(lease, 101, () => 1_000, [101]))
    expect(FlockOwnerLease.read(lease)?.pid).toBe(101)
    first.handle.stop()
    handles.splice(handles.indexOf(first.handle), 1)
    expect(FlockOwnerLease.read(lease)).toBeUndefined()
  })
})

// A STORE-REASON IDLE IS NOT A VERDICT. Three engines run per workspace here,
// and the owner accepts an invite in whichever window they happen to have open.
// An engine that booted with an empty `flock.json` used to arm no timer at all,
// so it went on telling its model "no contacts in flock.json" for the rest of
// its life while the lease holder was already connected to the new contact.
describe("an idle engine re-reads the file", () => {
  /** An engine on a directory that has no contacts YET. */
  function idleOn(flock: string, lease: string, pid: number, living: number[]) {
    const wire = fakeDeps()
    const handle = FlockService.start({
      store: FlockStore.Store.open({ directory: flock }),
      config: { model: "test/fake" },
      relayUrl: "ws://relay.test",
      runner: async () => ({ text: "", tokens: 0 }),
      deps: wire.deps,
      owner: owner(lease, pid, () => 1_000, living),
      leaseDirectory: lease,
      publish: false,
      log: () => {},
    })
    handles.push(handle)
    return { handle, ...wire }
  }

  test("a store gate that refused keeps its tick, and comes up one beat after a contact lands", () => {
    const lease = tmp()
    const flock = tmp()
    FlockStore.Store.open({ directory: flock, name: "alice" })
    const engine = idleOn(flock, lease, 101, [101])

    expect(engine.handle.active).toBe(false)
    expect(engine.handle.reason).toContain("no contacts")
    // THE TICK IS ARMED. Before this, a gate refusal armed nothing and there
    // was no beat to come back on.
    expect(engine.timers.length).toBeGreaterThan(0)

    // Another window accepts an invite — a different `Store` object, the same
    // file, exactly as the pane does it.
    FlockStore.Store.open({ directory: flock }).accept(
      FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite,
    )
    // Still idle until a beat: nothing watches the file.
    expect(engine.handle.active).toBe(false)

    engine.timers.at(-1)!()
    expect(engine.handle.active).toBe(true)
    expect(engine.handle.kind).toBe("relay")
    expect(engine.urls).toHaveLength(1)
  })

  test("a SECOND idle engine falls through to forwarding rather than fighting for the lease", () => {
    const lease = tmp()
    const flock = tmp()
    FlockStore.Store.open({ directory: flock, name: "alice" })
    const first = idleOn(flock, lease, 101, [101, 202])
    const second = idleOn(flock, lease, 202, [101, 202])

    FlockStore.Store.open({ directory: flock }).accept(
      FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite,
    )
    first.timers.at(-1)!()
    second.timers.at(-1)!()

    expect(first.handle.kind).toBe("relay")
    // The one that lost the race forwards, which is what `tool/flock.ts` needs
    // to reach the holder over loopback. It must NOT dial the same rendezvous.
    expect(second.handle.kind).toBe("other-engine")
    expect(second.urls).toEqual([])
  })

  test("the kill switch is NOT re-checked: no write to flock.json can lift it", () => {
    const lease = tmp()
    const flock = tmp()
    FlockStore.Store.open({ directory: flock, name: "alice" })
    const wire = fakeDeps()
    const handle = FlockService.start({
      store: FlockStore.Store.open({ directory: flock }),
      config: { model: "test/fake" },
      runner: async () => ({ text: "", tokens: 0 }),
      deps: wire.deps,
      leaseDirectory: lease,
      publish: false,
      env: { ORIGAMI_DISABLE_FLOCK: "1" },
      log: () => {},
    })
    handles.push(handle)
    // No tick at all: an env var is not going to change under this process, and
    // a beat that re-read the file every thirty seconds for it would be work
    // done to reach the same answer for ever.
    expect(wire.timers).toEqual([])
    expect(handle.kind).toBe("none")
  })

  test("the idle sentence is logged once per REASON, not once per beat", () => {
    const lease = tmp()
    const flock = tmp()
    FlockStore.Store.open({ directory: flock, name: "alice" })
    const wire = fakeDeps()
    const lines: string[] = []
    const handle = FlockService.start({
      store: FlockStore.Store.open({ directory: flock }),
      config: { model: "test/fake" },
      runner: async () => ({ text: "", tokens: 0 }),
      deps: wire.deps,
      owner: owner(lease, 101, () => 1_000, [101]),
      leaseDirectory: lease,
      publish: false,
      log: (line) => lines.push(line),
    })
    handles.push(handle)
    for (let beat = 0; beat < 5; beat++) wire.timers.at(-1)!()
    expect(lines.filter((line) => line.includes("no contacts"))).toHaveLength(1)
  })
})

// AND ONE STEP EARLIER: no `flock.json` AT ALL.
//
// `boot.start` refused once, at boot, and returned an inert handle — so an
// engine already running when the owner accepted their first invite said "no
// flock.json on this box" until it was restarted. `waitForFile` is the smallest
// tick that fixes it: one `exists` per heartbeat, and the real service the beat
// the file appears.
describe("a box with no flock.json waits for one", () => {
  /** The wait, with the file check and the hand-over both scripted. */
  function waiting(input: { exists: () => boolean; begin: () => FlockService.Handle }) {
    const timers: Array<() => void> = []
    const handle = FlockBoot.waitForFile({
      exists: input.exists,
      begin: input.begin,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    })
    handles.push(handle)
    return { handle, timers }
  }

  test("becomes the real service one beat after the file is created", () => {
    const lease = tmp()
    const flock = tmp()
    const file = path.join(flock, FlockStore.FILE)
    let started = 0
    const wait = waiting({
      exists: () => fs.existsSync(file),
      begin: () => {
        started++
        const wire = fakeDeps()
        return FlockService.start({
          store: FlockStore.Store.open({ directory: flock }),
          config: { model: "test/fake" },
          relayUrl: "ws://relay.test",
          runner: async () => ({ text: "", tokens: 0 }),
          deps: wire.deps,
          owner: owner(lease, 101, () => 1_000, [101]),
          leaseDirectory: lease,
          publish: false,
          log: () => {},
        })
      },
    })

    expect(wait.handle.active).toBe(false)
    expect(wait.handle.reason).toContain("no flock.json")
    // A beat with still no file starts nothing and keeps the tick.
    wait.timers.at(-1)!()
    expect(started).toBe(0)
    expect(wait.timers.length).toBeGreaterThan(1)

    // The owner accepts their first invite in another window: the file appears.
    const mine = FlockStore.Store.open({ directory: flock, name: "alice" })
    mine.accept(FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite)

    wait.timers.at(-1)!()
    expect(started).toBe(1)
    expect(wait.handle.active).toBe(true)
    expect(wait.handle.kind).toBe("relay")
    expect(wait.handle.routes.size).toBe(1)
  })

  test("the poll stops once the service is up — the service owns the beat from there", () => {
    let started = 0
    const wait = waiting({
      exists: () => true,
      begin: () => {
        started++
        return FlockService.idleHandle("no-contacts", false)
      },
    })
    const before = wait.timers.length
    wait.timers.at(-1)!()
    expect(started).toBe(1)
    // No new timer was armed: a poll that went on asking "is the file there"
    // for ever would be work done to reach an answer that cannot change back.
    expect(wait.timers.length).toBe(before)
    // ...and a second beat cannot start a second service.
    wait.timers.at(-1)!()
    expect(started).toBe(1)
  })

  test("stopping before the file appears starts nothing afterwards", () => {
    let started = 0
    const wait = waiting({
      exists: () => true,
      begin: () => {
        started++
        return FlockService.idleHandle("no-contacts", false)
      },
    })
    wait.handle.stop()
    handles.splice(handles.indexOf(wait.handle), 1)
    wait.timers.at(-1)!()
    wait.handle.refresh()
    expect(started).toBe(0)
  })
})

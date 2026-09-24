// HANDOVER — what happens to the flock when the window holding it goes away.
//
// `owner-service.test.ts` proves a second engine stands down and takes over on
// a beat. This is the other half of the same problem, and it is the half the
// owner actually hits: the holder LEAVES. Before this, the only exit that gave
// the lease back was `origami acp`'s stdin ending, so closing a VS Code window
// left a record behind and the two surviving windows waited it out.
//
// Everything is scripted — pids, clock, sockets, the process object the exit
// hooks are registered on — because "the holder was killed" has to be a fact
// the test states, not something it does to a real process.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockExit } from "@/flock/exit"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockRelayTransport } from "@/flock/relay-transport"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-handover-"))
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

/** One `flock.json` with one contact, shared by every window on the machine. */
function ready() {
  const directory = tmp()
  const mine = FlockStore.Store.open({ directory, name: "alice" })
  const friend = mine.accept(FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite)
  return { directory, friend }
}

/** A socket factory whose sockets the test opens, closes and reads frames off. */
function fakeDeps() {
  const urls: string[] = []
  const timers: Array<() => void> = []
  const sockets: Array<{ url: string; sent: Uint8Array[]; socket: FlockRelayTransport.RelaySocket }> = []
  const deps: FlockRelayTransport.RelayDeps = {
    connect: (url) => {
      urls.push(url)
      const record = {
        url,
        sent: [] as Uint8Array[],
        socket: {
          send: (data: Uint8Array) => record.sent.push(data),
          close: () => {},
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        } as FlockRelayTransport.RelaySocket,
      }
      sockets.push(record)
      return record.socket
    },
    // CAPTURED, not run. "Takes over on the next beat" has to be a beat the
    // test fires, or it would be a sleep.
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  }
  /** Fire every beat armed so far, once. */
  const beat = () => {
    for (const fn of timers.splice(0)) fn()
  }
  return { deps, urls, sockets, beat }
}

function startFor(input: {
  flock: string
  lease: string
  owner: FlockOwnerLease.Owner
  exit?: FlockExit.Target
}) {
  const wire = fakeDeps()
  const handle = FlockService.start({
    store: FlockStore.Store.open({ directory: input.flock }),
    config: { model: "test/fake" },
    relayUrl: "ws://relay.test",
    runner: async () => ({ text: "", tokens: 0 }),
    deps: wire.deps,
    owner: input.owner,
    leaseDirectory: input.lease,
    ...(input.exit ? { exit: input.exit } : {}),
    // Two engines in ONE process: neither may publish to the module slots.
    publish: false,
    log: () => {},
  })
  handles.push(handle)
  return { handle, ...wire }
}

const owner = (lease: string, pid: number, now: () => number, living: number[]) =>
  new FlockOwnerLease.Owner({ directory: lease, pid, now, alive: (other) => living.includes(other) })

/** A `process` the test drives: it records listeners and delivers signals. */
function fakeProcess(pid = 4242) {
  const listeners = new Map<string, Array<() => void>>()
  const raised: string[] = []
  const target: FlockExit.Target = {
    pid,
    once: (event, handler) => listeners.set(event, [...(listeners.get(event) ?? []), handler]),
    off: (event, handler) =>
      listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== handler)),
    kill: (_pid, signal) => raised.push(signal),
  }
  return {
    target,
    raised,
    count: () => [...listeners.values()].reduce((total, list) => total + list.length, 0),
    fire: (event: string) => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler()
    },
  }
}

describe("the exit hooks", () => {
  test("a normal exit releases, once, however many ways out fire", () => {
    const proc = fakeProcess()
    let released = 0
    FlockExit.onExit(() => released++, proc.target)
    proc.fire("beforeExit")
    proc.fire("exit")
    expect(released).toBe(1)
  })

  test("a signal releases AND re-raises itself, so the process still dies", () => {
    const proc = fakeProcess(99)
    let released = 0
    FlockExit.onExit(() => released++, proc.target)
    proc.fire("SIGTERM")
    expect(released).toBe(1)
    // THE PART THAT MATTERS. A handler that swallowed the signal would stop
    // Ctrl-C killing `origami acp` — a far worse bug than the one being fixed.
    expect(proc.raised).toEqual(["SIGTERM"])
    // And it took itself off first, so the re-raise finds no listener.
    proc.fire("SIGTERM")
    expect(proc.raised).toEqual(["SIGTERM"])
  })

  test("a release that throws does not escape an exit path", () => {
    const proc = fakeProcess()
    FlockExit.onExit(() => {
      throw new Error("the lease file is gone")
    }, proc.target)
    expect(() => proc.fire("exit")).not.toThrow()
  })

  test("the unregister leaves NO listeners — a suite must not accrete them", () => {
    const proc = fakeProcess()
    let released = 0
    const off = FlockExit.onExit(() => released++, proc.target)
    expect(proc.count()).toBe(FlockExit.EVENTS.length + FlockExit.SIGNALS.length)
    off()
    expect(proc.count()).toBe(0)
    proc.fire("exit")
    expect(released).toBe(0)
  })
})

describe("the holder leaves", () => {
  test("a window closing gives the lease back AT ONCE, and the next engine claims on its next beat", () => {
    const { directory } = ready()
    const lease = tmp()
    const clock = { at: 1_000_000 }
    const now = () => clock.at
    const living = [1, 2]

    const first = startFor({ flock: directory, lease, owner: owner(lease, 1, now, living), exit: fakeProcess(1).target })
    expect(first.handle.active).toBe(true)

    const second = startFor({ flock: directory, lease, owner: owner(lease, 2, now, living) })
    expect(second.handle.active).toBe(false)
    expect(second.handle.kind).toBe("other-engine")

    // The window closes. NOT a kill: pid 1 is still a live process as far as
    // anybody can tell, which is exactly the case the stale window would have
    // made the other engine sit out.
    first.handle.stop()
    expect(FlockOwnerLease.read(lease)).toBeUndefined()

    second.beat()
    expect(second.handle.active).toBe(true)
    expect(FlockOwnerLease.read(lease)?.pid).toBe(2)
  })

  test("the exit hook alone releases it — the handle is never stopped", () => {
    const { directory } = ready()
    const lease = tmp()
    const clock = { at: 1_000_000 }
    const proc = fakeProcess(1)

    const first = startFor({ flock: directory, lease, owner: owner(lease, 1, () => clock.at, [1, 2]), exit: proc.target })
    expect(FlockOwnerLease.read(lease)?.pid).toBe(1)

    // The engine is going down the way a closed window takes it down: a signal,
    // and no chance to reach `cli/cmd/acp.ts`'s own `flock.stop()`.
    proc.fire("SIGTERM")
    expect(FlockOwnerLease.read(lease)).toBeUndefined()
    first.handle.stop()
  })

  test("a KILLED holder is replaced on the next beat, with its routes and its unsent questions", async () => {
    const { directory, friend } = ready()
    const lease = tmp()
    const clock = { at: 1_000_000 }
    const now = () => clock.at
    // Pid 1 is ALIVE for now; the array is what the test edits to kill it.
    const living = [1, 2]

    const first = startFor({ flock: directory, lease, owner: owner(lease, 1, now, living) })
    expect(first.handle.active).toBe(true)
    const second = startFor({ flock: directory, lease, owner: owner(lease, 2, now, living) })
    expect(second.handle.active).toBe(false)
    // It dialled NOTHING while it was standing down.
    expect(second.urls).toEqual([])

    // A question the owner asked before the holder died. It is a row in the
    // shared file, which is the only reason the next holder can re-send it.
    const store = FlockStore.Store.open({ directory })
    store.openOut({ id: "q-before", contact: friend.handle, question: "still owed an answer" })

    // KILLED. The record is still fresh — this is the whole point: liveness,
    // not the stale window, is what lets the next engine in immediately.
    living.splice(living.indexOf(1), 1)
    expect(FlockOwnerLease.read(lease)?.pid).toBe(1)

    second.beat()
    expect(second.handle.active).toBe(true)
    expect(FlockOwnerLease.read(lease)?.pid).toBe(2)
    expect(second.handle.routes.has(friend.handle)).toBe(true)
    expect(second.urls.some((url) => url.startsWith("ws://relay.test/r/"))).toBe(true)

    // AND THE QUESTION GOES BACK OUT. `service.ts` flushes the pending list on
    // the connect edge, so the row survives the window that asked it.
    const socket = second.sockets[0]!
    socket.socket.onopen?.()
    await Bun.sleep(20)
    expect(socket.sent.length).toBeGreaterThan(0)
  })

  test("inbound questions keep landing on the engine that took over", async () => {
    const { directory, friend } = ready()
    const lease = tmp()
    const clock = { at: 1_000_000 }
    const living = [1, 2]

    const first = startFor({ flock: directory, lease, owner: owner(lease, 1, () => clock.at, living) })
    expect(first.handle.active).toBe(true)
    const second = startFor({ flock: directory, lease, owner: owner(lease, 2, () => clock.at, living) })

    living.splice(living.indexOf(1), 1)
    second.beat()
    expect(second.handle.active).toBe(true)

    // A LISTENER on the contact's rid is what "inbound still lands" means at
    // this layer: the peer opened a channel, so a frame arriving on the socket
    // reaches the front desk rather than nobody.
    const rid = second.handle.routes.get(friend.handle)!.rid
    expect(second.handle.transport?.status(rid)).not.toBe("idle")
    expect(second.handle.peer).toBeDefined()
  })
})

describe("a beat that lost the lease", () => {
  test("the old holder stands down instead of holding sockets it no longer owns", () => {
    const { directory } = ready()
    const lease = tmp()
    const clock = { at: 1_000_000 }
    const living = [1, 2]

    const first = startFor({ flock: directory, lease, owner: owner(lease, 1, () => clock.at, living) })
    expect(first.handle.active).toBe(true)

    // The machine SLEPT: nothing beat, the record went stale, and the other
    // window claimed on wake. This engine wakes up believing it is the holder.
    clock.at += FlockOwnerLease.STALE_MS * 10
    const other = owner(lease, 2, () => clock.at, living)
    expect(other.claim()).toBe(true)

    first.beat()
    // Not merely inactive — it must have GIVEN THE SOCKETS UP, or the two
    // engines evict each other on the relay for the rest of the session.
    expect(first.handle.active).toBe(false)
    expect(first.handle.kind).toBe("other-engine")
    expect(FlockOwnerLease.read(lease)?.pid).toBe(2)
  })
})

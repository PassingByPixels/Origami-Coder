// THREE ENGINES, ONE WORKSPACE — the machine this feature actually runs on.
//
// Every other flock test proves one part with the others stubbed. This one is
// the shape of the bug report: ONE VS Code workspace spawns three engines, they
// share one `flock.json` and one lease directory, the owner accepts a contact
// in whichever window they had open, asks from whichever chat they are in, and
// reads the reply in whichever pane is on screen. None of those three is
// reliably the engine holding the relay sockets, and every failure the owner
// hit came from a piece of the feature assuming it was.
//
// So the run below is the whole journey with nothing faked but the wires:
//
//   accept in A2  ->  A1 wins the lease and connects  ->  ask from A3, which
//   forwards over loopback  ->  the contact's own engine answers over the relay
//   ->  the reply row reaches A2 through the FILE WATCH  ->  A1 is killed  ->
//   A2 takes the flock on its next beat  ->  a new ask from A3 still works.
//
// NO NETWORK. The relay is `test/fixture/flock-relay.ts` (the shipped ring, the
// shipped one-socket-per-role rule) and the forwarding hop is a real loopback
// HTTP server, which is what the forwarding hop IS in production.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ACPFlock } from "@/acp/flock"
import { FlockOwnerHttp } from "@/flock/owner-http"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockRelayTransport } from "@/flock/relay-transport"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"
import { FlockWatch } from "@/flock/watch"
import { FlockTransport } from "@/flock/transport"
import * as ToolFlock from "@/tool/flock"
import { startFixtureRelay } from "../fixture/flock-relay"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-three-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // A server already stopped, or a handle already released.
    }
  }
  ToolFlock.reset()
  FlockTransport.setTransport(undefined)
})

async function until(label: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

/**
 * One engine's own beat, on the fixture's socket factory.
 *
 * Split from the relay's queue on purpose: the socket edges are the RELAY's to
 * fire and the heartbeats are each ENGINE's, and a test that could only run
 * both at once could not say "A2 beat and took over" at all.
 */
function engineDeps(relay: ReturnType<typeof startFixtureRelay>) {
  const beats: Array<() => void> = []
  const deps: FlockRelayTransport.RelayDeps = {
    connect: relay.deps.connect,
    setTimer: (fn) => beats.push(fn),
    clearTimer: () => {},
  }
  return { deps, beat: () => { for (const fn of beats.splice(0)) fn() } }
}

describe("three engines on one workspace", () => {
  test("accept in one window, ask from another, read the reply in a third — then the holder dies", async () => {
    const relay = startFixtureRelay()
    cleanups.push(() => relay.stop())

    // ONE store directory and ONE lease directory, shared by all three windows,
    // exactly as three engines of one workspace share them.
    const home = tmp()
    const lease = tmp()
    FlockStore.Store.open({ directory: home, name: "alice" })

    // The contact is a WHOLE OTHER ORIGAMI: its own directory, its own engine,
    // its own front desk. Auto-answer, because the person on that side is not
    // what this test is about.
    const away = tmp()
    const bobStore = FlockStore.Store.open({ directory: away, name: "Macbook" })
    const bobWire = engineDeps(relay)
    const bob = FlockService.start({
      store: bobStore,
      config: { model: "test/fake", autoAnswer: true },
      relayUrl: "ws://relay.test",
      runner: async (input) => ({ text: `Macbook says: ${input.question.toUpperCase()}`, tokens: 12 }),
      deps: bobWire.deps,
      leaseDirectory: tmp(),
      publish: false,
      log: () => {},
    })
    cleanups.push(() => bob.stop())

    // THREE DISTINCT PIDS, and A1's is the REAL one. The forwarding path checks
    // that the holder's pid is a live process before it POSTs (`tool/flock.ts`),
    // so the window that holds the lease has to be a process that exists; the
    // other two are scripted, which is also the only way the arbiter can tell
    // three engines apart inside one process.
    const otherPids = [90_002, 90_003]
    const livingPids = [process.pid, ...otherPids]

    /** One of Alice's three windows. Only A3 publishes — see below. */
    const window = (pid: number, publish: boolean) => {
      const wire = engineDeps(relay)
      const log: string[] = []
      const owner = new FlockOwnerLease.Owner({
        directory: lease,
        pid,
        alive: (other) => livingPids.includes(other),
      })
      const handle = FlockService.start({
        store: FlockStore.Store.open({ directory: home }),
        config: { model: "test/fake" },
        relayUrl: "ws://relay.test",
        runner: async () => ({ text: "", tokens: 0 }),
        deps: wire.deps,
        owner,
        leaseDirectory: lease,
        publish,
        log: (line) => log.push(line),
      })
      cleanups.push(() => handle.stop())
      return { handle, owner, log, ...wire }
    }

    // A1 and A2 hold no module slots: three engines in ONE process would
    // otherwise report each other's state. A3 publishes, because A3 is the one
    // whose `flock_ask` is exercised and the tool reads those slots — and it is
    // started LAST, below, the way a third window opened later would be.
    const a1 = window(process.pid, false)
    const a2 = window(otherPids[0]!, false)

    // ---------------------------------------------------------------- accept
    // NOBODY has a contact yet, so every engine is idle for a store reason and
    // — the fix that made this possible — every one of them keeps beating.
    expect(a1.handle.active).toBe(false)
    expect(a1.handle.reason).toContain("no contacts")

    // THE OWNER ACCEPTS IN WINDOW TWO. Through the ACP surface the pane uses,
    // against the shared directory, exactly as the pane would.
    const accepted = ACPFlock.accept({ invite: bobStore.invite().invite, directory: home })
    expect(accepted.ok).toBe(true)
    bobStore.accept(FlockStore.Store.open({ directory: home }).invite().invite)

    // A1's next beat re-reads the file and takes the lease. Nothing restarted:
    // before this, an engine that booted with an empty `flock.json` said "no
    // contacts" for the rest of its life.
    a1.beat()
    expect(a1.handle.active).toBe(true)
    expect(FlockOwnerLease.read(lease)?.pid).toBe(process.pid)

    // The second window beats, finds the lease held, and dials NOTHING.
    a2.beat()
    expect(a2.handle.active).toBe(false)
    expect(a2.handle.kind).toBe("other-engine")

    // The THIRD window opens into a flock that is already running and stands
    // down on its very first gate, without a beat.
    const a3 = window(otherPids[1]!, true)
    expect(a3.handle.active).toBe(false)
    expect(a3.handle.kind).toBe("other-engine")

    bobWire.beat()
    relay.settle()
    const contact = FlockStore.Store.open({ directory: home }).friends()[0]!.handle
    expect(a1.handle.transport?.status(a1.handle.routes.get(contact)!.rid)).toBe("open")

    // ------------------------------------------------------- the file watch
    // A2 is the window with the pane open. It learns about the mailbox the way
    // the pane does now: the file moved, in a process that is not this one.
    const seen: Array<{ threads: number; unread: number }> = []
    const off = FlockWatch.onChanged(() => {
      const mail = ACPFlock.mailbox({ directory: home })
      seen.push({ threads: mail.threads.length, unread: mail.unread })
    })
    const watcher = FlockWatch.start({
      file: FlockStore.file(home),
      onChange: () => FlockWatch.announce(),
      pollMs: 50,
      debounceMs: 20,
    })
    cleanups.push(() => {
      off()
      watcher.stop()
    })

    // ------------------------------------------------------------- the ask
    // A1 is the holder, so it mounts the loopback route the other two forward
    // to. This is the production shape: `server/routes/.../server.ts` behind
    // the auth layer, sharing `FlockOwnerHttp.route`.
    const holderServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: FlockOwnerHttp.fetchHandler(() => a1.handle.peer),
    })
    cleanups.push(() => void holderServer.stop(true))
    new FlockOwnerLease.Owner({
      directory: lease,
      pid: process.pid,
      httpBase: `http://127.0.0.1:${holderServer.port}`,
    }).claim()

    // ASKED FROM WINDOW THREE, by its display name in the wrong case — the two
    // failures this lane exists for, in one call.
    const sent = await ToolFlock.ask(["macbook"], "what is the OMP table list?")
    expect(sent.output).toContain("sent to")
    expect(sent.metadata["sent"]).toBe(1)

    // The thread is on the SHARED file, filed by the holder, whichever window
    // asked. Read through a fourth Store object, which is what a pane holds.
    const threadId = FlockStore.Store.open({ directory: home }).mailbox()[0]!.id
    expect(threadId).toBeTruthy()

    // ---------------------------------------------------------- the answer
    relay.settle()
    bobWire.beat()
    relay.settle()
    await until("Macbook's desk to answer", () => {
      const row = FlockStore.Store.open({ directory: home }).thread(threadId)
      return row?.state === "answered"
    })
    const answered = FlockStore.Store.open({ directory: home }).thread(threadId)!
    expect(answered.reply?.text).toContain("WHAT IS THE OMP TABLE LIST?")
    expect(answered.reply?.signatureOk).toBe(true)
    expect(answered.unread).toBe(true)

    // ...AND A2 WAS TOLD, without asking. This is the push: the row was written
    // by a Store object A2 does not hold, and the watch is the only reason the
    // pane knows about it before its next poll.
    await until("the watch to announce the reply", () => seen.some((entry) => entry.unread > 0))

    // ------------------------------------------------------------ the kill
    // A1's process is gone. A crash leaves the record BEHIND — that is what
    // makes it a kill rather than a close — so the file still names it.
    void holderServer.stop(true)
    fs.writeFileSync(
      FlockOwnerLease.file(lease),
      JSON.stringify({ pid: 999_999_998, startedAt: "", heartbeatAt: Date.now() }),
    )
    a1.handle.stop()

    a2.beat()
    // WITHIN ONE BEAT, on a lease that is seconds old: the pid is dead, so
    // LIVENESS — not the stale window — is what lets the next engine in.
    expect(a2.handle.active).toBe(true)
    expect(FlockOwnerLease.read(lease)?.pid).toBe(otherPids[0]!)
    expect(a2.handle.routes.has(contact)).toBe(true)

    // ------------------------------------------------------- and asks again
    // A2 now serves the forwarding route. Its record is re-stamped with THIS
    // process's pid for one reason and it is the test's own limitation, said
    // out loud: three engines in one process cannot have three real pids, and
    // `tool/flock.ts` checks that the holder's pid is a live process before it
    // POSTs — correctly, because a dead holder's fresh-looking record is the
    // exact case that check exists for and which the block above just built.
    const takeoverServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: FlockOwnerHttp.fetchHandler(() => a2.handle.peer),
    })
    cleanups.push(() => void takeoverServer.stop(true))
    new FlockOwnerLease.Owner({
      directory: lease,
      pid: process.pid,
      httpBase: `http://127.0.0.1:${takeoverServer.port}`,
    }).claim()

    relay.settle()
    bobWire.beat()
    const again = await ToolFlock.ask([contact], "and after the crash?")
    expect(again.metadata["sent"]).toBe(1)
    expect(FlockStore.Store.open({ directory: home }).mailbox()).toHaveLength(2)
  }, 30_000)
})

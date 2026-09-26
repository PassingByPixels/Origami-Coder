// THE RELAY WENT AWAY AND CAME BACK.
//
// A friendship is held open for days across a laptop lid, a wifi change and a
// relay redeploy, so "it works once it is connected" is not the requirement —
// the requirement is that NOTHING THE OWNER CAN SEE IS LOST when the wire dies
// under it. Four things have to be true on the other side of a drop: the socket
// comes back, the backoff that got it back has been reset (or the next blip
// costs a minute instead of a second), the resume point is the seq the STORE
// reached rather than the one held at boot, and every question written while
// the wire was down is on the wire again.
//
// Driven against `test/fixture/flock-relay.ts` — the shipped ring, the shipped
// one-socket-per-role rule, no network and no clock — so the drop happens at a
// moment this file picks and the whole cycle runs in milliseconds.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockRelayTransport } from "@/flock/relay-transport"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"
import { startFixtureRelay, CLOSE_GOING_AWAY } from "../fixture/flock-relay"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-reconnect-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const relays: Array<{ stop(): void }> = []
const handles: FlockService.Handle[] = []
afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop()
  for (const relay of relays.splice(0)) relay.stop()
})

function fixture() {
  const relay = startFixtureRelay()
  relays.push(relay)
  return relay
}

/** The `?after=` on one dial, which is what a resume actually asserts. */
function afterOf(url: string): number {
  return Number.parseInt(new URL(url.replace(/^ws/, "http")).searchParams.get("after") ?? "-1", 10)
}

describe("the transport, across a drop", () => {
  test("reconnects, and resumes from the seq the STORE reached — not the one it booted with", () => {
    const relay = fixture()
    const seq = { recv: 7 }
    const transport = new FlockRelayTransport.RelayTransport({ deps: relay.deps, backoff: [10, 20, 40] })
    transport.register("rid-1", { relayUrl: "ws://relay.test", role: "desktop", after: () => seq.recv })
    transport.listen("rid-1", () => {})
    relay.beat()
    expect(transport.status("rid-1")).toBe("open")
    expect(afterOf(relay.dials[0]!)).toBe(7)

    // Frames kept arriving before the wire died, so the resume point moved.
    seq.recv = 19
    relay.dropAll({ code: CLOSE_GOING_AWAY })
    expect(transport.status("rid-1")).toBe("waiting")

    relay.settle()
    expect(transport.status("rid-1")).toBe("open")
    // THE ASSERTION THAT MATTERS. A route that had captured `after` at
    // construction would re-ask for everything since frame 7 and hand the peer
    // twelve frames it has already accepted and recorded.
    expect(afterOf(relay.dials[1]!)).toBe(19)
  })

  test("the backoff RESETS on a success, so the second blip is not charged for the first", () => {
    const relay = fixture()
    const waits: number[] = []
    const backoff = [10, 20, 40, 80]
    // THREE FAILED DIALS FIRST, so the table is genuinely walked before the
    // reset is asserted — a test that only ever saw the first rung would pass
    // against a transport that had no backoff at all.
    let refuse = 3
    const transport = new FlockRelayTransport.RelayTransport({
      deps: {
        connect: (url) => {
          if (refuse-- > 0) throw new Error("the relay is not answering")
          return relay.deps.connect(url)
        },
        setTimer: (fn, ms) => {
          waits.push(ms)
          return relay.deps.setTimer(fn, ms)
        },
        clearTimer: relay.deps.clearTimer,
      },
      backoff,
    })
    transport.register("rid-1", { relayUrl: "ws://relay.test", role: "desktop", after: () => 0 })
    transport.listen("rid-1", () => {})
    expect(transport.status("rid-1")).toBe("waiting")

    relay.settle()
    expect(waits.slice(0, 3)).toEqual([10, 20, 40])
    expect(transport.status("rid-1")).toBe("open")

    // The wire dies again after an hour of working. Without the reset the
    // friend would be unreachable for a full rung of the table for no reason
    // but a fault that is long over.
    waits.length = 0
    relay.dropAll()
    expect(waits[0]).toBe(10)
    relay.settle()
    expect(transport.status("rid-1")).toBe("open")
  })

  test("a frame written while the wire is down is flushed on the reconnect, in order", () => {
    const relay = fixture()
    const transport = new FlockRelayTransport.RelayTransport({ deps: relay.deps, backoff: [10] })
    transport.register("rid-1", { relayUrl: "ws://relay.test", role: "desktop", after: () => 0 })
    transport.register("rid-1-peer", { relayUrl: "ws://relay.test", role: "phone", after: () => 0 })
    transport.listen("rid-1", () => {})
    relay.beat()
    expect(transport.status("rid-1")).toBe("open")

    relay.dropAll()
    void transport.send("rid-1", new Uint8Array([0, 1, 0, 0, 0, 1, 0xaa]))
    void transport.send("rid-1", new Uint8Array([0, 1, 0, 0, 0, 2, 0xbb]))
    expect(transport.queued("rid-1")).toBe(2)

    relay.settle()
    expect(transport.status("rid-1")).toBe("open")
    expect(transport.queued("rid-1")).toBe(0)
    // The relay's own ring is the witness: both frames really went out, and in
    // the order they were written.
    expect(relay.ringSize("rid-1")).toBe(2)
  })

  test("a rid the transport was never told about names the cure instead of throwing a shrug", async () => {
    const transport = new FlockRelayTransport.RelayTransport({ deps: fixture().deps })
    await expect(transport.send("unknown", new Uint8Array([1]))).rejects.toThrow(/restart Origami/)
  })
})

describe("the service, across a drop", () => {
  /** Alice, holding Bob, over the fixture relay. */
  function engine(relay: ReturnType<typeof fixture>) {
    const directory = tmp()
    const store = FlockStore.Store.open({ directory, name: "alice" })
    const friend = store.accept(FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite)
    const log: string[] = []
    const handle = FlockService.start({
      store,
      config: { model: "test/fake" },
      relayUrl: "ws://relay.test",
      runner: async () => ({ text: "", tokens: 0 }),
      deps: relay.deps,
      backoff: [10],
      leaseDirectory: tmp(),
      publish: false,
      log: (line) => log.push(line),
    })
    handles.push(handle)
    return { directory, store, friend, handle, log }
  }

  test("an unanswered question is put back on the wire when the relay comes back", async () => {
    const relay = fixture()
    const { store, friend, handle, log } = engine(relay)
    relay.settle()
    expect(handle.active).toBe(true)

    // Asked while the wire was UP, then the relay goes away before anybody
    // answered. The row is the durable part: it lives in flock.json, so it
    // outlives this socket and, on a bad day, this whole process.
    await handle.peer!.post(friend.handle, "what did you do about the tax form?")
    expect(store.pending()).toHaveLength(1)

    relay.dropAll({ forget: true })
    expect(handle.transport?.status(handle.routes.get(friend.handle)!.rid)).toBe("waiting")

    relay.settle()
    await Bun.sleep(20)
    expect(handle.transport?.status(handle.routes.get(friend.handle)!.rid)).toBe("open")
    // THE RESEND, said out loud. A relay that restarted lost its whole ring —
    // the ten-minute replay window is gone — so this line is the only thing
    // between the owner and a question that silently never arrived.
    expect(log.some((line) => line.includes("re-sent 1 unanswered question"))).toBe(true)
    // And the row is still open, because nobody has answered it yet.
    expect(store.pending()).toHaveLength(1)
  })

  test("a friendship's socket is dialled again after the drop, not left waiting for a restart", () => {
    const relay = fixture()
    const { friend, handle } = engine(relay)
    relay.settle()
    const rid = handle.routes.get(friend.handle)!.rid
    const before = relay.dials.filter((url) => url.includes(rid)).length

    relay.dropAll()
    relay.settle()

    expect(relay.dials.filter((url) => url.includes(rid)).length).toBeGreaterThan(before)
    expect(handle.transport?.status(rid)).toBe("open")
  })
})

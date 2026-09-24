// WHAT SURVIVES A RESTART, AND WHAT THE SERVICE REFUSES TO DO.
//
// The loopback transport hid one whole class of bug: both peers were built
// together, so a sequence counter that restarted at 1 never met a friend whose
// replay counter had not. These are the tests for the state that now lives in
// `flock.json` — the two counters, the 24-hour pending list, and the answered
// ids a resend is deduped against — plus the three ways `service.ts` stays off.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockCard } from "@/flock/card"
import { FlockEnvelope } from "@/flock/envelope"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockPeer } from "@/flock/peer"
import { FlockPolicy } from "@/flock/policy"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"
import { FlockTransport } from "@/flock/transport"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-relay-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const peers: FlockPeer.Peer[] = []
afterEach(() => {
  for (const peer of peers.splice(0)) peer.stop()
  FlockTransport.setTransport(undefined)
})

/** A friendship on disk: two stores that each hold the other, in two directories. */
function friendship() {
  const aliceDir = tmp()
  const bobDir = tmp()
  const alice = FlockStore.Store.open({ directory: aliceDir, name: "alice" })
  const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
  alice.accept(bob.invite().invite)
  bob.accept(alice.invite().invite)
  return { aliceDir, bobDir, alice, bob }
}

const echo = (store: FlockStore.Store, calls: { count: number }): FlockPeer.Serve => ({
  async ask({ question }) {
    calls.count++
    return { ok: true, text: `answer ${calls.count} to "${question}"`, tokens: 10 }
  },
  async card() {
    const identity = store.identity()
    return FlockCard.build({
      identity,
      specialties: [],
      policy: FlockPolicy.resolve({ config: { model: "test/fake" } }),
      signPrivateKey: identity.sign.privateKey,
    })
  },
})

const track = (peer: FlockPeer.Peer) => {
  peers.push(peer)
  return peer
}

describe("the sequence counters", () => {
  test("are reserved on disk and keep climbing across a restart", async () => {
    const { aliceDir, alice, bob } = friendship()
    const transport = new FlockTransport.LoopbackTransport()
    const first = track(new FlockPeer.Peer(alice, transport))
    const bobPeer = track(new FlockPeer.Peer(bob, transport, echo(bob, { count: 0 })))
    first.start()
    bobPeer.start()
    expect((await first.ask("bob", "one", 5000)).ok).toBe(true)
    const afterFirst = alice.seq(bob.identity().handle).send
    expect(afterFirst).toBeGreaterThan(0)
    first.stop()

    // A NEW process: a fresh Store from the same directory, a fresh Peer.
    const restarted = FlockStore.Store.open({ directory: aliceDir })
    const second = track(new FlockPeer.Peer(restarted, transport))
    second.start()
    expect((await second.ask("bob", "two", 5000)).ok).toBe(true)

    // The counter continued rather than restarting at 1, which is the only
    // reason Bob accepted the second question at all.
    expect(restarted.seq(bob.identity().handle).send).toBeGreaterThan(afterFirst)
  })

  test("record the highest sequence accepted from a friend, and never move back", () => {
    const { alice, bob } = friendship()
    const handle = bob.identity().handle
    alice.noteRecvSeq(handle, 5)
    expect(alice.seq(handle).recv).toBe(5)
    alice.noteRecvSeq(handle, 3)
    expect(alice.seq(handle).recv).toBe(5)
    alice.noteRecvSeq(handle, 9)
    expect(alice.seq(handle).recv).toBe(9)
  })

  test("are what the relay route hands to ?after=", () => {
    const { alice, bob } = friendship()
    alice.noteRecvSeq(bob.identity().handle, 42)
    const handle = FlockService.start({
      store: alice,
      config: { model: "test/fake" },
      relayUrl: "ws://127.0.0.1:9",
      runner: async () => ({ text: "", tokens: 0 }),
      publish: false,
      log: () => {},
      // Never dial: this test is about the value, not the socket.
      deps: {
        connect: () => {
          throw new Error("no dialling in this test")
        },
        setTimer: () => 0,
        clearTimer: () => {},
      },
    })
    expect(handle.active).toBe(true)
    expect(alice.seq(bob.identity().handle).recv).toBe(42)
    handle.stop()
  })
})

describe("a replayed frame", () => {
  test("is dropped on its sequence alone, and the channel is not poisoned", async () => {
    const { alice, bob } = friendship()
    const transport = new FlockTransport.LoopbackTransport()
    const calls = { count: 0 }
    const alicePeer = track(new FlockPeer.Peer(alice, transport))
    const bobPeer = track(new FlockPeer.Peer(bob, transport, echo(bob, calls)))
    alicePeer.start()
    bobPeer.start()
    expect((await alicePeer.ask("bob", "one", 5000)).ok).toBe(true)
    expect(calls.count).toBe(1)
    const used = alice.seq(bob.identity().handle).send

    // A frame Alice really could have written — her key, her keys, a question
    // Bob has NEVER seen — carrying a sequence he has already accepted. A
    // FRESH id on purpose: replaying the original bytes would also be stopped
    // by the answered-id dedup, and then this would prove nothing about seq.
    const keys = FlockPeer.keysFor(alice.identity(), alice.find("bob")!)
    const frame = (seq: number, id: string) =>
      FlockEnvelope.seal({
        keys,
        role: FlockEnvelope.ROLE_ASK,
        seq,
        payload: FlockEnvelope.signPayload(
          { type: "flock/ask", v: 1, id, from: alice.identity().handle, question: "smuggled", at: new Date().toISOString() },
          alice.identity().sign.privateKey,
        ),
      })

    await transport.send(keys.rid, frame(used, "replayed-id"))
    await Bun.sleep(50)
    expect(calls.count).toBe(1)

    // The CONTROL. Same frame, same signature, same everything but a sequence
    // above the counter — and it is served. Without this the test above would
    // pass just as well if Bob had stopped answering anything at all.
    await transport.send(keys.rid, frame(used + 50, "fresh-id"))
    await Bun.sleep(50)
    expect(calls.count).toBe(2)
  })
})

describe("an unanswered question", () => {
  test("is kept, re-sent under its own id, and answered from the record the second time", async () => {
    const { alice, bob } = friendship()
    const transport = new FlockTransport.LoopbackTransport()
    const calls = { count: 0 }
    const alicePeer = track(new FlockPeer.Peer(alice, transport))
    const bobPeer = track(new FlockPeer.Peer(bob, transport, echo(bob, calls)))
    alicePeer.start()
    bobPeer.start()
    const answer = await alicePeer.ask("bob", "still there?", 5000)
    expect(answer.ok).toBe(true)
    // Answered, so nothing is pending.
    expect(alice.pending()).toHaveLength(0)

    // Put it back as if Alice's side had never seen the answer, then flush.
    const remembered = bob.answered()
    expect(remembered).toHaveLength(1)
    alice.openOut({ id: remembered[0]!.id, contact: bob.identity().handle, question: "still there?" })
    expect(await alicePeer.flushPending("bob")).toBe(1)
    await Bun.sleep(50)

    // Bob did NOT run his desk a second time — the resend was served from the
    // recorded answer — and the pending entry is retired.
    expect(calls.count).toBe(1)
    expect(alice.pending()).toHaveLength(0)
  })

  test("expires 24 hours after it was asked", () => {
    const { alice, bob } = friendship()
    const start = Date.parse("2026-09-02T00:00:00.000Z")
    alice.openOut({ id: "q1", contact: bob.identity().handle, question: "?" }, start)
    expect(alice.pending(undefined, start + FlockStore.PENDING_TTL_MS - 1)).toHaveLength(1)
    expect(alice.pending(undefined, start + FlockStore.PENDING_TTL_MS + 1)).toHaveLength(0)
  })

  test("is filtered by friend", () => {
    const { alice, bob } = friendship()
    alice.openOut({ id: "q1", contact: bob.identity().handle, question: "?" })
    expect(alice.pending("nobody@somewhere")).toHaveLength(0)
    expect(alice.pending(bob.identity().handle)).toHaveLength(1)
  })
})

describe("the service stays off", () => {
  const options = (store: FlockStore.Store) => ({
    store,
    runner: async () => ({ text: "", tokens: 0 }),
    publish: false,
    log: () => {},
  })

  // ASSERTED ON THE TWO SIDE EFFECTS, not on `active` alone. "Off" has to mean
  // NO SOCKET WAS DIALLED and NO LEASE WAS TAKEN: the first is what the VS Code
  // setting promises the owner (nothing of theirs reaches a relay), and the
  // second is what would make a window with Flock switched off go on evicting
  // the window that has it switched on. `active: false` with a dialled socket
  // would have passed the old version of this test.
  test("when the kill switch is set: no socket is dialled and no lease is taken", () => {
    const { alice } = friendship()
    const leaseDirectory = tmp()
    const urls: string[] = []
    const handle = FlockService.start({
      ...options(alice),
      config: { model: "test/fake" },
      env: { [FlockService.DISABLE_ENV]: "1" },
      relayUrl: "ws://relay.test",
      leaseDirectory,
      deps: {
        connect: (url) => {
          urls.push(url)
          return { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }
        },
        setTimer: () => 0,
        clearTimer: () => {},
      },
    })
    expect(handle.active).toBe(false)
    expect(handle.reason).toContain(FlockService.DISABLE_ENV)
    // The words the owner reads name the SETTING, not only the variable.
    expect(handle.reason).toContain("origamicoder.flock.enabled")
    expect(urls).toEqual([])
    expect(FlockOwnerLease.read(leaseDirectory)).toBeUndefined()
    expect(fs.existsSync(FlockOwnerLease.file(leaseDirectory))).toBe(false)
  })

  test("when there are no friends", () => {
    const store = FlockStore.Store.open({ directory: tmp(), name: "lonely" })
    const handle = FlockService.start({ ...options(store), config: { model: "test/fake" }, env: {} })
    expect(handle.active).toBe(false)
    expect(handle.reason).toContain("no contacts")
  })

  // AND THE ONE IT NO LONGER STAYS OFF FOR. A missing Front Desk model used to
  // be a start gate, which meant an owner who had never set one could not ASK
  // anybody anything — the failure this whole lane exists to end. Asserted on
  // the DIALLED URL rather than on `active` alone: "it started" has to mean a
  // socket was actually opened for the contact, which is the half that carries
  // the question.
  test("but NOT when there is no front desk model — asking never needed one", () => {
    const { alice, bob } = friendship()
    const urls: string[] = []
    const handle = FlockService.start({
      ...options(alice),
      env: {},
      relayUrl: "ws://relay.test",
      leaseDirectory: tmp(),
      deps: {
        connect: (url) => {
          urls.push(url)
          return { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }
        },
        setTimer: () => 0,
        clearTimer: () => {},
      },
    })
    try {
      expect(handle.active).toBe(true)
      expect(handle.reason).toBeUndefined()
      expect(handle.routes.has(bob.identity().handle)).toBe(true)
      expect(urls.some((url) => url.startsWith("ws://relay.test/r/"))).toBe(true)
    } finally {
      handle.stop()
    }
  })

  test("but starts when a single friend carries a model of their own", () => {
    const { alice, bob } = friendship()
    alice.setPolicy(bob.identity().handle, { model: "test/fake" })
    expect(FlockService.hasFrontDeskModel(alice)).toBe(true)
  })
})

describe("where a friendship's frames go", () => {
  test("the invite's relay wins, then the config, then the built-in default", () => {
    const friend = { relay: "ws://from-invite" } as never
    expect(FlockService.relayFor(friend, "ws://from-config")).toBe("ws://from-invite")
    expect(FlockService.relayFor({} as never, "ws://from-config")).toBe("ws://from-config")
    expect(FlockService.relayFor({} as never)).toBe(FlockService.DEFAULT_RELAY_URL)
  })
})

// THE SECOND ENGINE ASKS ANYWAY — the forwarding half of the multi-window fix.
//
// `owner-service.test.ts` proves that only one engine dials. This proves what
// the OTHERS do afterwards. Until now they told their model the flock rode on
// "a relay that is not built yet", which was false on the owner's own machine:
// three engines were running, one held the lease, and the two that did not
// reported a feature that does not exist.
//
// The owner engine here is a REAL loopback HTTP server running the production
// `FlockOwnerHttp.route`, and behind it a REAL peer answering from a real front
// desk over the loopback transport. So "returns the owner's answers" is
// asserted on text that came out of the answering side and crossed a socket,
// not on a stub agreeing with the test.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockCard } from "@/flock/card"
import { FlockOwnerHttp } from "@/flock/owner-http"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockPeer } from "@/flock/peer"
import { FlockPolicy } from "@/flock/policy"
import { FlockRelayTransport } from "@/flock/relay-transport"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"
import { FlockTransport } from "@/flock/transport"
import {
  NO_LEASE_MESSAGE,
  ask,
  idleMessage,
  ownerGoneMessage,
  ownerUnaddressableMessage,
  reset,
  who,
} from "@/tool/flock"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-owner-http-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/**
 * REAL processes, because the tool asks the OS whether the lease's owner is
 * still running and gives no way to stub that. `test/tool/agents.test.ts` spawns
 * idle children for the same reason: `process.pid + 1` is not a pid the OS
 * agrees about — Windows aliases the low two bits onto the same process, so it
 * reads ALIVE there and ESRCH on POSIX.
 */
let livePid: number
let deadPid: number
let idleProc: ReturnType<typeof spawnIdle> | undefined

const spawnIdle = () =>
  Bun.spawn({
    cmd: [process.execPath, "-e", "await new Promise(() => {})"],
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })

beforeAll(async () => {
  idleProc = spawnIdle()
  livePid = idleProc.pid
  const doomed = spawnIdle()
  deadPid = doomed.pid
  doomed.kill()
  await doomed.exited
})

afterAll(async () => {
  idleProc?.kill()
  await idleProc?.exited
  idleProc = undefined
})

const handles: FlockService.Handle[] = []
const servers: Array<{ stop: (close?: boolean) => void }> = []
const peers: FlockPeer.Peer[] = []

beforeEach(() => {
  // The tool reads module-level slots. A previous file in this process may have
  // left a transport behind, and a leaked one would make the OWNING path run
  // where the forwarding path is under test.
  reset()
  FlockTransport.setTransport(undefined)
})

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop()
  for (const server of servers.splice(0)) server.stop(true)
  for (const peer of peers.splice(0)) peer.stop()
  reset()
  FlockTransport.setTransport(undefined)
})

/** ONE `flock.json` with one contact and a desk model — what two windows on a
 *  machine really share. Returns the directory and the contact's full handle. */
function ready(): { directory: string; contact: string } {
  const directory = tmp()
  const mine = FlockStore.Store.open({ directory, name: "alice" })
  const theirs = FlockStore.Store.open({ directory: tmp(), name: "bob" })
  mine.accept(theirs.invite().invite)
  return { directory, contact: theirs.identity().handle }
}

/** A socket factory that records and connects nothing; timers are captured, not run. */
function fakeDeps() {
  const urls: string[] = []
  const timers: Array<() => void> = []
  const deps: FlockRelayTransport.RelayDeps = {
    connect: (url) => {
      urls.push(url)
      return { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }
    },
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  }
  return { deps, urls, timers }
}

function startService(input: {
  flock: string
  lease: string
  owner?: FlockOwnerLease.Owner
  publish?: boolean
  env?: Record<string, string | undefined>
  config?: { model?: string }
}) {
  const wire = fakeDeps()
  const handle = FlockService.start({
    store: FlockStore.Store.open({ directory: input.flock }),
    ...(input.config === undefined ? { config: { model: "test/fake" } } : { config: input.config }),
    relayUrl: "ws://relay.test",
    runner: async () => ({ text: "", tokens: 0 }),
    deps: wire.deps,
    ...(input.owner ? { owner: input.owner } : {}),
    leaseDirectory: input.lease,
    publish: input.publish ?? false,
    ...(input.env ? { env: input.env } : { env: {} }),
    log: () => {},
  })
  handles.push(handle)
  return { handle, ...wire }
}

const scriptedOwner = (input: { lease: string; pid: number; alive: number[]; httpBase?: string }) =>
  new FlockOwnerLease.Owner({
    directory: input.lease,
    pid: input.pid,
    ...(input.httpBase ? { httpBase: input.httpBase } : {}),
    now: () => Date.now(),
    alive: (other) => input.alive.includes(other),
  })

/**
 * The OWNER engine's asking side: a real peer over a loopback transport, with a
 * real answering Origami behind it. Served by the production route handler.
 */
function ownerEngine(text = "the answer") {
  const transport = new FlockTransport.LoopbackTransport()
  const askerStore = FlockStore.Store.open({ directory: tmp(), name: "alice" })
  const deskStore = FlockStore.Store.open({ directory: tmp(), name: "bob" })
  askerStore.accept(deskStore.invite().invite)
  deskStore.accept(askerStore.invite().invite)

  const serve: FlockPeer.Serve = {
    async ask({ friend }) {
      return { ok: true, text: `${text} (for ${friend.handle})`, tokens: 42 }
    },
    async card() {
      const identity = deskStore.identity()
      return FlockCard.build({
        identity,
        specialties: ["tax rules"],
        policy: FlockPolicy.resolve({ config: { model: "test/fake", dailyBudgetTokens: 200_000 } }),
        signPrivateKey: identity.sign.privateKey,
      })
    },
  }
  const asker = new FlockPeer.Peer(askerStore, transport)
  const desk = new FlockPeer.Peer(deskStore, transport, serve)
  peers.push(asker, desk)
  asker.start()
  desk.start()

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: FlockOwnerHttp.fetchHandler(() => asker) })
  servers.push(server)
  return {
    asker,
    store: askerStore,
    deskStore,
    base: `http://127.0.0.1:${server.port}`,
    contact: deskStore.identity().handle,
  }
}

describe("the owner engine publishes where it can be reached", () => {
  test("the lease record carries the owner's loopback httpBase", () => {
    const lease = tmp()
    const flock = ready().directory
    const first = startService({
      flock: flock,
      lease,
      owner: scriptedOwner({ lease, pid: livePid, alive: [livePid, 202], httpBase: "http://127.0.0.1:41234" }),
    })
    expect(first.handle.kind).toBe("relay")
    expect(FlockOwnerLease.read(lease)?.httpBase).toBe("http://127.0.0.1:41234")

    // ...and the SECOND engine on the same directory stands down, exactly as
    // before. The address is extra information on the record, not a new claim.
    const second = startService({ flock, lease, owner: scriptedOwner({ lease, pid: 202, alive: [livePid, 202] }) })
    expect(second.handle.kind).toBe("other-engine")
    expect(second.urls).toEqual([])
  })

  test("a lease written without one reads back with httpBase absent, not with a broken value", () => {
    const lease = tmp()
    const flock = ready().directory
    startService({ flock, lease, owner: scriptedOwner({ lease, pid: livePid, alive: [livePid] }) })
    expect(FlockOwnerLease.read(lease)?.httpBase).toBeUndefined()
    // A hand-edited or older record must not be trusted into a fetch target.
    fs.writeFileSync(
      FlockOwnerLease.file(lease),
      JSON.stringify({ pid: livePid, startedAt: "", heartbeatAt: Date.now(), httpBase: 7 }),
    )
    expect(FlockOwnerLease.read(lease)?.httpBase).toBeUndefined()
  })
})

describe("a second engine's flock_ask", () => {
  test("forwards to the owner over HTTP, and the thread is recorded on the HOLDER's store", async () => {
    const owner = ownerEngine("bob says hello")
    const lease = tmp()
    const flock = ready().directory

    // TWO SERVICES, ONE LEASE DIRECTORY. The first claims with the address of
    // the server that is actually answering; the second finds a live pid on the
    // record and stands down, which is the state the owner's machine was in.
    startService({
      flock,
      lease,
      owner: scriptedOwner({ lease, pid: livePid, alive: [livePid], httpBase: owner.base }),
    })
    const second = startService({ flock, lease, publish: true })
    expect(second.handle.kind).toBe("other-engine")
    expect(FlockService.kind()).toBe("other-engine")
    expect(FlockTransport.getTransport()).toBeUndefined()

    const result = await ask([owner.contact], "what does the tax form cover?")

    // FIRE AND RETURN, through the forward as well: what comes back is the
    // receipt, never the answer. An answer here would mean the forwarding
    // engine had blocked its model on a stranger's owner being awake.
    expect(result.output).toContain(`sent to ${owner.contact} (thread `)
    expect(result.output).toContain("The answer will NOT come back to this chat")
    expect(result.output).not.toContain("bob says hello")
    expect(result.metadata.sent).toBe(1)

    // The row lives on the engine that HOLDS the flock — that is whose peer put
    // the frame on the wire — and it is the row the owner's mailbox renders.
    const threads = owner.store.mailbox().filter((thread) => thread.direction === "out")
    expect(threads).toHaveLength(1)
    expect(threads[0]!.contact).toBe(owner.contact)
    expect(threads[0]!.question.text).toBe("what does the tax form cover?")
    expect(result.output).toContain(threads[0]!.id)
  })

  // THE CHAT THAT ASKED HAS TO SURVIVE THE FORWARD, or the reply has no home
  // on the machine that matters. The thread is filed on the HOLDER's store, and
  // the holder is not the engine the chat is running in — so a session id kept
  // only where the tool ran would be kept nowhere the reply can read it.
  test("carries the asking chat's session id across the forward, onto the holder's row", async () => {
    const owner = ownerEngine()
    const lease = tmp()
    const flock = ready().directory
    startService({
      flock,
      lease,
      owner: scriptedOwner({ lease, pid: livePid, alive: [livePid], httpBase: owner.base }),
    })
    startService({ flock, lease, publish: true })

    await ask([owner.contact], "what does the tax form cover?", { sessionID: "ses_engine_7", title: "chat 3" })

    const thread = owner.store.mailbox().find((row) => row.direction === "out")
    expect(thread!.origin).toEqual({ sessionID: "ses_engine_7", title: "chat 3" })
  })

  test("an ask with no origin files a row with none, which is every row before this", async () => {
    const owner = ownerEngine()
    const lease = tmp()
    const flock = ready().directory
    startService({
      flock,
      lease,
      owner: scriptedOwner({ lease, pid: livePid, alive: [livePid], httpBase: owner.base }),
    })
    startService({ flock, lease, publish: true })

    await ask([owner.contact], "no chat asked this")
    expect(owner.store.mailbox().find((row) => row.direction === "out")!.origin).toBeUndefined()
  })

  // The body is ordinary JSON on a loopback port. A malformed `origin` must
  // become NO origin rather than a session id this engine then delivers into.
  test("a malformed origin on the wire is dropped, not half-believed", async () => {
    const owner = ownerEngine()
    for (const origin of [{ title: "chat 3" }, { sessionID: 7 }, "ses_1", null]) {
      const response = await fetch(`${owner.base}${FlockOwnerHttp.ASK_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: [owner.contact], question: `q ${JSON.stringify(origin)}`, origin }),
      })
      expect(response.ok).toBe(true)
    }
    const rows = owner.store.mailbox().filter((row) => row.direction === "out")
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(row.origin).toBeUndefined()
  })

  test("forwards flock_who and renders the owner's cards", async () => {
    const owner = ownerEngine()
    const lease = tmp()
    const flock = ready().directory
    startService({
      flock,
      lease,
      owner: scriptedOwner({ lease, pid: livePid, alive: [livePid], httpBase: owner.base }),
    })
    startService({ flock, lease, publish: true })

    const result = await who()

    expect(result.output).toContain(owner.contact)
    expect(result.output).toContain("specialties: tax rules")
    expect(result.metadata.reached).toBe(1)
  })

  test("says WHO is holding it and what went wrong when the owner does not answer", async () => {
    const lease = tmp()
    const flock = ready().directory
    // A live pid with an address nothing is listening on: the honest failure is
    // "the other engine did not answer", never "the feature does not exist".
    startService({
      flock,
      lease,
      owner: scriptedOwner({ lease, pid: livePid, alive: [livePid], httpBase: "http://127.0.0.1:1" }),
    })
    startService({ flock, lease, publish: true })

    const result = await ask(["bob@whoever"], "anything?")

    expect(result.output).toStartWith(
      `Another engine on this machine holds the Flock connection (pid ${livePid}) and did not answer:`,
    )
    expect(result.output).not.toContain("not built yet")
  })

  test("an owner whose PROCESS is gone gets the takeover sentence, not a timeout", async () => {
    const lease = tmp()
    const flock = ready().directory
    // The lease file outlives the process for up to STALE_MS. Forwarding into it
    // would stall and be reported as the contact's silence rather than ours.
    fs.mkdirSync(lease, { recursive: true })
    fs.writeFileSync(
      FlockOwnerLease.file(lease),
      JSON.stringify({ pid: deadPid, startedAt: "", heartbeatAt: Date.now(), httpBase: "http://127.0.0.1:41999" }),
    )
    startService({ flock, lease, publish: true, owner: scriptedOwner({ lease, pid: 303, alive: [deadPid] }) })
    expect(FlockService.kind()).toBe("other-engine")

    expect((await ask(["bob@whoever"], "anything?")).output).toBe(ownerGoneMessage(deadPid))
  })

  test("an owner on an older build, with no address on the record, says exactly that", async () => {
    const lease = tmp()
    const flock = ready().directory
    startService({ flock, lease, owner: scriptedOwner({ lease, pid: livePid, alive: [livePid] }) })
    startService({ flock, lease, publish: true })

    expect((await ask(["bob@whoever"], "anything?")).output).toBe(ownerUnaddressableMessage(livePid))
  })

  test("a lease that vanished between the stand-down and the ask is its own sentence", async () => {
    const lease = tmp()
    const flock = ready().directory
    startService({ flock, lease, owner: scriptedOwner({ lease, pid: livePid, alive: [livePid] }) })
    startService({ flock, lease, publish: true })
    expect(FlockService.kind()).toBe("other-engine")

    // The owning window closed cleanly while this call was being prepared:
    // `release()` removes the record. Nothing here may claim a pid it cannot see.
    fs.rmSync(FlockOwnerLease.file(lease), { force: true })

    expect((await ask(["bob@whoever"], "anything?")).output).toBe(NO_LEASE_MESSAGE)
  })
})

describe("the owner-side route contract", () => {
  test("answers 503 rather than 404 when this engine is not the one holding the flock", async () => {
    const reply = await FlockOwnerHttp.route(
      { method: "POST", pathname: FlockOwnerHttp.ASK_PATH, query: new URLSearchParams(), body: { to: ["x"], question: "?" } },
      undefined,
    )
    expect(reply.status).toBe(503)
  })

  test("refuses a body that is not { to: string[], question: string }", async () => {
    const owner = ownerEngine()
    const reply = await FlockOwnerHttp.route(
      { method: "POST", pathname: FlockOwnerHttp.ASK_PATH, query: new URLSearchParams(), body: { to: [], question: "" } },
      owner.asker,
    )
    expect(reply.status).toBe(400)
  })

  test("`to` naming somebody outside the flock comes back as found:false, not as an error", async () => {
    const owner = ownerEngine()
    const reply = await FlockOwnerHttp.route(
      { method: "GET", pathname: FlockOwnerHttp.WHO_PATH, query: new URLSearchParams("to=nobody@nowhere"), body: undefined },
      owner.asker,
    )
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ found: false, cards: [] })
  })

  test("a non-loopback address is refused before anything is sent", async () => {
    expect(FlockOwnerHttp.reachable("http://10.0.0.5:8080")).toBe(false)
    expect(FlockOwnerHttp.reachable(undefined)).toBe(false)
    expect(FlockOwnerHttp.reachable("http://127.0.0.1:8080")).toBe(true)
    const forwarded = await FlockOwnerHttp.askOwner({ httpBase: "http://10.0.0.5:8080", to: ["x"], question: "?" })
    expect(forwarded).toEqual({ error: "http://10.0.0.5:8080 is not a loopback address" })
  })
})

describe("what an idle engine tells its model", () => {
  const cases: Array<[FlockService.IdleCode, string]> = [
    // The disabled sentence NAMES THE SETTING as well as the variable: the owner
    // of an editor window never set ORIGAMI_DISABLE_FLOCK themselves, and a
    // sentence naming only it sent them looking for a shell they never opened.
    ["disabled", `Flock is idle on this machine: Flock is switched off (ORIGAMI_DISABLE_FLOCK, the origamicoder.flock.enabled setting). Turn on origamicoder.flock.enabled and reload the window (or unset ORIGAMI_DISABLE_FLOCK and restart Origami).`],
    ["no-contacts", "Flock is idle on this machine: no contacts in flock.json. Add a contact in the FLO pane."],
    [
      "no-model",
      "Flock is idle on this machine: no front desk model is set (flock.frontDesk.model). Set the Front Desk model in the FLO pane.",
    ],
    ["no-flock-file", "Flock is idle on this machine: no flock.json on this box. Add a contact in the FLO pane."],
  ]

  for (const [code, expected] of cases) {
    test(`${code} reads as its own sentence with its own fix`, () => {
      FlockService.idleHandle(code)
      expect(FlockService.reasonCode()).toBe(code)
      expect(idleMessage()).toBe(expected)
    })
  }

  test("the kill switch, reached through a real start, publishes the disabled reason", async () => {
    const lease = tmp()
    startService({ flock: ready().directory, lease, publish: true, env: { ORIGAMI_DISABLE_FLOCK: "1" } })
    expect(FlockService.kind()).toBe("none")
    expect(FlockService.reason()).toBe("Flock is switched off (ORIGAMI_DISABLE_FLOCK, the origamicoder.flock.enabled setting)")
    expect((await ask(["bob@whoever"], "anything?")).output).toBe(
      "Flock is idle on this machine: Flock is switched off (ORIGAMI_DISABLE_FLOCK, the origamicoder.flock.enabled setting). Turn on origamicoder.flock.enabled and reload the window (or unset ORIGAMI_DISABLE_FLOCK and restart Origami).",
    )
  })

  test("an engine with no contacts says so, and never that the relay is unbuilt", async () => {
    const lease = tmp()
    startService({ flock: tmp(), lease, publish: true })
    expect(FlockService.reason()).toBe("no contacts in flock.json")
    const output = (await ask(["bob@whoever"], "anything?")).output
    expect(output).toBe("Flock is idle on this machine: no contacts in flock.json. Add a contact in the FLO pane.")
    expect(output).not.toContain("not built yet")
    expect(output).not.toContain("No flock transport is configured")
  })

  // THE SENTENCE IS NEVER OLDER THAN THE FILE. `reason()` is a module slot a
  // heartbeat writes, so a tool that read it straight would print "no contacts"
  // for up to a beat after another window accepted an invite — and, before the
  // tick outlived a store gate, for ever. `who` and `ask` re-check first.
  test("a tool call after a contact lands does NOT print the stale reason", async () => {
    const lease = tmp()
    const flock = tmp()
    FlockStore.Store.open({ directory: flock, name: "alice" })
    startService({ flock, lease, publish: true, owner: scriptedOwner({ lease, pid: livePid, alive: [livePid] }) })
    expect(FlockService.reason()).toBe("no contacts in flock.json")

    // Another window's `Store.open()`, the same file — how the pane does it.
    const contact = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    FlockStore.Store.open({ directory: flock }).accept(contact.invite().invite)

    // No beat has been fired. The tool's own re-check is what has to catch it.
    const output = (await ask([contact.identity().handle], "anything?")).output
    expect(output).not.toContain("Flock is idle")
    expect(output).not.toContain("no contacts")
    expect(FlockService.reason()).toBeUndefined()
    reset()
  })

  test("no lease message names the state rather than the feature", () => {
    expect(NO_LEASE_MESSAGE).toContain("holds the Flock connection")
    expect(NO_LEASE_MESSAGE).not.toContain("not built yet")
  })
})

describe("refresh — a contact added after boot gets its route", () => {
  test("registers the new contact's route and keeps the lease this engine holds", () => {
    const lease = tmp()
    const flock = ready().directory
    const owner = scriptedOwner({ lease, pid: livePid, alive: [livePid], httpBase: "http://127.0.0.1:41234" })
    const engine = startService({ flock, lease, owner })
    expect(engine.handle.routes.size).toBe(1)
    const before = FlockOwnerLease.read(lease)!

    // Accepted through a SEPARATE Store handle, which is what the pane and the
    // CLI both do — the running service's own object never sees the row.
    const carol = FlockStore.Store.open({ directory: tmp(), name: "carol" })
    FlockStore.Store.open({ directory: flock }).accept(carol.invite().invite)
    expect(engine.handle.routes.size).toBe(1)

    engine.handle.refresh()

    expect(engine.handle.routes.size).toBe(2)
    expect(engine.handle.routes.get(carol.identity().handle)).toBeDefined()
    expect(engine.handle.kind).toBe("relay")
    // SAME lease: same pid, same address, and the arbiter still holds it.
    const after = FlockOwnerLease.read(lease)!
    expect(after.pid).toBe(before.pid)
    expect(after.httpBase).toBe(before.httpBase)
    expect(owner.holds).toBe(true)
  })

  test("an engine that started with no contacts takes the flock on refresh, without a restart", () => {
    const lease = tmp()
    const flock = tmp()
    const mine = FlockStore.Store.open({ directory: flock, name: "alice" })
    const engine = startService({ flock, lease, publish: true })
    expect(engine.handle.kind).toBe("none")
    expect(FlockService.reason()).toBe("no contacts in flock.json")
    // The gates refused, so no lease was ever taken — the cheap refusals come first.
    expect(FlockOwnerLease.read(lease)).toBeUndefined()

    mine.accept(FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite)
    engine.handle.refresh()

    expect(engine.handle.kind).toBe("relay")
    expect(engine.handle.routes.size).toBe(1)
    expect(FlockService.kind()).toBe("relay")
    expect(FlockService.reason()).toBeUndefined()
    expect(FlockOwnerLease.read(lease)?.pid).toBe(process.pid)
  })

  test("a contact revoked to nothing gives the lease back on refresh", () => {
    const lease = tmp()
    const { directory: flock, contact } = ready()
    const engine = startService({ flock, lease, publish: true })
    expect(FlockOwnerLease.read(lease)?.pid).toBe(process.pid)

    FlockStore.Store.open({ directory: flock }).revoke(contact)
    engine.handle.refresh()

    expect(engine.handle.kind).toBe("none")
    expect(FlockService.reason()).toBe("no contacts in flock.json")
    // Given back rather than left to go stale: the next window claims on its
    // first try instead of waiting out STALE_MS for an engine that is idle.
    expect(FlockOwnerLease.read(lease)).toBeUndefined()
  })
})

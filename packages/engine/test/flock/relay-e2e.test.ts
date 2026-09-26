// TWO REAL ENGINES, ONE REAL RELAY, OVER A REAL SOCKET.
//
// `peer.test.ts` proves the protocol on a loopback that both peers share. This
// file proves the three things a loopback structurally cannot: that a frame
// survives a process boundary, that a friend who was OFFLINE still gets the
// question when they come back (the relay's replay ring), and that a peer which
// RESTARTED is not mistaken for a replay by the friend it was talking to.
//
// The relay is the shipped `origami relay` verb in its own process, bound to
// 127.0.0.1 on a port the OS picks. If it cannot be started the whole file says
// so loudly and stops — a green run that silently tested nothing is worse than
// a red one.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"

const ENGINE_ROOT = path.resolve(import.meta.dir, "../..")

/** Poll observable state instead of sleeping for a guessed duration. */
async function until(label: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

interface RelayProcess {
  readonly base: string
  stop(): void
}

/** Start `origami relay` and read the port off its first line of stdout. */
async function startRelayProcess(): Promise<RelayProcess> {
  const child = Bun.spawn(["bun", "run", "src/index.ts", "relay", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: ENGINE_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  let text = ""
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + 60_000
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(60_000).then(() => null)])
      if (!chunk || chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
      const match = /listening on (\d+\.\d+\.\d+\.\d+):(\d+)/.exec(text)
      if (match) {
        return {
          base: `ws://${match[1]}:${match[2]}`,
          stop: () => child.kill(),
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  child.kill()
  throw new Error(`origami relay never announced a port. stdout so far: ${JSON.stringify(text)}`)
}

const dirs: string[] = []
const tmp = () => {
  // NEVER the owner's real config directory: every store below is opened with
  // an explicit `directory`, which is the only reason two whole engines can
  // exist in one process at all.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-e2e-"))
  dirs.push(directory)
  return directory
}

let relay: RelayProcess | undefined
let skipped: string | undefined

beforeAll(async () => {
  try {
    relay = await startRelayProcess()
  } catch (error) {
    skipped = error instanceof Error ? error.message : String(error)
    console.warn(`[flock e2e] SKIPPED — ${skipped}`)
  }
})

afterAll(() => {
  relay?.stop()
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const running: FlockService.Handle[] = []
afterEach(() => {
  for (const handle of running.splice(0)) handle.stop()
})

/** One engine's answering desk: deterministic text, a real token count, no provider. */
function desk(name: string, log: string[]) {
  return {
    runner: async (input: { question: string; from: string; model: string }) => {
      log.push(`${name} answered "${input.question}" from ${input.from} on ${input.model}`)
      return { text: `${name} says: ${input.question.toUpperCase()}`, tokens: 42 }
    },
    approver: async () => true,
  }
}

/** Boot one engine against the live relay. Same call the production seam makes. */
function boot(directory: string, name: string, log: string[], base: string): FlockService.Handle {
  const handle = FlockService.start({
    store: FlockStore.Store.open({ directory, name }),
    // A model has to be set or the desk refuses everything; `test/fake` never
    // reaches a provider because `runner` is the seam that would have.
    config: { model: "test/fake", autoAnswer: true },
    relayUrl: base,
    ...desk(name, log),
    // Two engines in ONE process: the module-level transport slot holds one
    // value, so neither of them may claim it.
    publish: false,
    log: () => {},
  })
  running.push(handle)
  return handle
}

/**
 * The counters AS THEY ARE ON DISK.
 *
 * Deliberately a fresh `Store` every time: the test's own handle and the one
 * inside the service are two objects over one file, and reading the test's
 * cached copy would assert what this process remembered rather than what was
 * persisted — which is the entire thing under test here.
 */
const seqOf = (directory: string, handle: string) => FlockStore.Store.open({ directory }).seq(handle)

/** A friendship is two invites: an invite lets them reach you, not you them. */
function befriend(a: FlockStore.Store, b: FlockStore.Store) {
  a.accept(b.invite().invite)
  b.accept(a.invite().invite)
}

async function connected(handle: FlockService.Handle, friendHandle: string): Promise<void> {
  const route = handle.routes.get(friendHandle)
  if (!route) throw new Error(`no route for ${friendHandle}`)
  await until(`a socket to ${friendHandle}`, () => handle.transport!.status(route.rid) === "open")
}

describe("flock over a real relay", () => {
  test("a question crosses two engines and the signed answer comes back", async () => {
    if (!relay) return expect(skipped).toBeTruthy()
    const aliceDir = tmp()
    const bobDir = tmp()
    const alice = FlockStore.Store.open({ directory: aliceDir, name: "alice" })
    const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
    befriend(alice, bob)
    const aliceHandle = alice.identity().handle
    const bobHandle = bob.identity().handle

    const log: string[] = []
    const a = boot(aliceDir, "alice", log, relay.base)
    const b = boot(bobDir, "bob", log, relay.base)
    expect(a.active).toBe(true)
    expect(b.active).toBe(true)

    // BOTH SIDES AGREE ON ONE RENDEZVOUS AND ON OPPOSITE SLOTS. The relay has
    // exactly two, neither side asked the other, and a rid it would reject is
    // a friendship that never connects.
    const aRoute = a.routes.get(bobHandle)!
    const bRoute = b.routes.get(aliceHandle)!
    expect(aRoute.rid).toBe(bRoute.rid)
    expect(aRoute.rid).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(aRoute.role).not.toBe(bRoute.role)

    await connected(a, bobHandle)
    await connected(b, aliceHandle)

    const answer = await a.peer!.ask(bobHandle, "what does the tax form cover?", 20_000)
    expect(answer.ok).toBe(true)
    expect(answer.from).toBe(bobHandle)
    expect(answer.signatureOk).toBe(true)
    expect(answer.tokens).toBe(42)
    expect(answer.text).toBe("bob says: WHAT DOES THE TAX FORM COVER?")
    expect(log).toContain(`bob answered "what does the tax form cover?" from ${aliceHandle} on test/fake`)

    // The counters moved on BOTH sides, which is the state the next two tests
    // are entirely about.
    expect(seqOf(aliceDir, bobHandle).send).toBeGreaterThan(0)
    expect(seqOf(bobDir, aliceHandle).recv).toBeGreaterThan(0)
  }, 90_000)

  test("a friend who was offline gets the question from the relay's ring", async () => {
    if (!relay) return expect(skipped).toBeTruthy()
    const aliceDir = tmp()
    const bobDir = tmp()
    const alice = FlockStore.Store.open({ directory: aliceDir, name: "alice" })
    const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
    befriend(alice, bob)
    const aliceHandle = alice.identity().handle
    const bobHandle = bob.identity().handle

    const log: string[] = []
    const a = boot(aliceDir, "alice", log, relay.base)
    let b = boot(bobDir, "bob", log, relay.base)
    await connected(a, bobHandle)
    await connected(b, aliceHandle)

    // Bob's engine goes away. Alice stays attached, which is what keeps the
    // rendezvous — and therefore the ring — alive on the relay (`server.ts`
    // drops a rendezvous only when NO socket is left on it).
    b.stop()
    running.splice(running.indexOf(b), 1)

    // Asked into the dark. Nothing is awaited yet: the frame reaches the relay
    // and sits in the ring with nobody to forward it to.
    const before = seqOf(aliceDir, bobHandle).send
    const asking = a.peer!.ask(bobHandle, "still there?", 60_000)
    await until("the question to reach the relay", () => seqOf(aliceDir, bobHandle).send > before)

    b = boot(bobDir, "bob", log, relay.base)
    await connected(b, aliceHandle)

    const answer = await asking
    expect(answer.ok).toBe(true)
    expect(answer.text).toBe("bob says: STILL THERE?")
    // Served once, by the engine that came back — not twice, and not by a
    // resend, because Alice's own socket never dropped.
    expect(log.filter((line) => line.includes("still there?"))).toHaveLength(1)
  }, 90_000)

  test("an engine that restarts is not mistaken for a replay", async () => {
    if (!relay) return expect(skipped).toBeTruthy()
    const aliceDir = tmp()
    const bobDir = tmp()
    const alice = FlockStore.Store.open({ directory: aliceDir, name: "alice" })
    const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
    befriend(alice, bob)
    const aliceHandle = alice.identity().handle
    const bobHandle = bob.identity().handle

    const log: string[] = []
    let a = boot(aliceDir, "alice", log, relay.base)
    const b = boot(bobDir, "bob", log, relay.base)
    await connected(a, bobHandle)
    await connected(b, aliceHandle)
    expect((await a.peer!.ask(bobHandle, "first", 20_000)).ok).toBe(true)
    const reached = seqOf(bobDir, aliceHandle).recv
    expect(reached).toBeGreaterThan(0)

    // ALICE RESTARTS: new service, new transport, new Peer, new Store object,
    // same directory. Before the counters were persisted this is the exact
    // point where every later frame from her was dropped for ever as a replay,
    // and the only symptom was a friend who had gone quiet.
    a.stop()
    running.splice(running.indexOf(a), 1)
    a = boot(aliceDir, "alice", log, relay.base)
    await connected(a, bobHandle)

    const answer = await a.peer!.ask(bobHandle, "second", 20_000)
    expect(answer.ok).toBe(true)
    expect(answer.text).toBe("bob says: SECOND")
    expect(seqOf(bobDir, aliceHandle).recv).toBeGreaterThan(reached)
  }, 90_000)
})

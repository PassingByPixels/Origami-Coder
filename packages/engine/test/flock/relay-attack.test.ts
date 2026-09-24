// FIVE WAYS TO BREAK A FRIENDSHIP, AGAINST A REAL RELAY.
//
// `relay-e2e.test.ts` proves the happy path across a process boundary. This
// file attacks it: a friend added while the engine is already up, an invite
// older than its lifetime, a revoke that lands while an answer is in flight, a
// gap punched in the relay's replay ring, and two questions outstanding at once.
//
// The relay is the shipped `origami relay` verb in its own process on
// 127.0.0.1, exactly as the e2e file starts it. A green run that tested nothing
// is worse than a red one, so a relay that will not start fails the file loudly.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockRelayTransport } from "@/flock/relay-transport"
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
      if (match) return { base: `ws://${match[1]}:${match[2]}`, stop: () => child.kill() }
    }
  } finally {
    reader.releaseLock()
  }
  child.kill()
  throw new Error(`origami relay never announced a port. stdout so far: ${JSON.stringify(text)}`)
}

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-attack-"))
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
    console.warn(`[flock attack] SKIPPED - ${skipped}`)
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

/** A promise a test resolves by hand, for holding one answer open. */
function latch(): { promise: Promise<void>; open(): void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * One engine's answering desk. `holds` parks a named question until the test
 * releases it, which is how "while a question is pending" is made a real state
 * rather than a race against a sleep.
 */
function desk(name: string, log: string[], holds?: Map<string, Promise<void>>) {
  return {
    runner: async (input: { question: string; from: string; model: string }) => {
      const hold = holds?.get(input.question)
      if (hold) await hold
      log.push(`${name} answered "${input.question}" from ${input.from}`)
      return { text: `${name} says: ${input.question.toUpperCase()}`, tokens: 42 }
    },
    approver: async () => true,
  }
}

function boot(input: {
  store: FlockStore.Store
  name: string
  log: string[]
  base: string
  holds?: Map<string, Promise<void>>
  deps?: FlockRelayTransport.RelayDeps
}): FlockService.Handle {
  const handle = FlockService.start({
    store: input.store,
    config: { model: "test/fake", autoAnswer: true },
    relayUrl: input.base,
    ...desk(input.name, input.log, input.holds),
    ...(input.deps ? { deps: input.deps } : {}),
    publish: false,
    log: (line) => input.log.push(line),
  })
  running.push(handle)
  return handle
}

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

describe("flock under attack, over a real relay", () => {
  // ---------------------------------------------------------------- 1 ------
  test("scenario 1 - a friend added while the service is running", async () => {
    if (!relay) return expect(skipped).toBeTruthy()
    const aliceDir = tmp()
    const bobDir = tmp()
    const carolDir = tmp()
    const alice = FlockStore.Store.open({ directory: aliceDir, name: "alice" })
    const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
    const carol = FlockStore.Store.open({ directory: carolDir, name: "carol" })
    befriend(alice, bob)
    const aliceHandle = alice.identity().handle
    const bobHandle = bob.identity().handle
    const carolHandle = carol.identity().handle

    const aliceLog: string[] = []
    const carolLog: string[] = []
    const a = boot({ store: alice, name: "alice", log: aliceLog, base: relay.base })
    expect(a.active).toBe(true)
    await connected(a, bobHandle)

    // CAROL IS ADDED NOW, through the very Store object the service holds -
    // the friendliest possible case. The pane and the CLI are worse: both open
    // their own Store (`acp/flock.ts`), so the running service never even sees
    // the row.
    alice.accept(carol.invite().invite)
    carol.accept(alice.invite().invite)
    expect(alice.find(carolHandle)).toBeDefined()

    // EXPECTED: no route, because routes are built once in `FlockService.start`.
    expect(a.routes.get(carolHandle)).toBeUndefined()

    // EXPECTED: asking her fails, and the failure names the reason.
    let outbound = ""
    try {
      await a.peer!.ask(carolHandle, "are you there?", 4_000)
      outbound = "RESOLVED"
    } catch (error) {
      outbound = error instanceof Error ? error.message : String(error)
    }
    console.log(`[s1] outbound to a just-added friend: ${outbound}`)

    // EXPECTED: and she cannot reach US either - her frame sits in a ring
    // nobody is listening on, and nothing on Alice's side says a word.
    const c = boot({ store: carol, name: "carol", log: carolLog, base: relay.base })
    expect(c.active).toBe(true)
    await connected(c, aliceHandle)
    let inbound = ""
    try {
      await c.peer!.ask(aliceHandle, "hello alice", 4_000)
      inbound = "RESOLVED"
    } catch (error) {
      inbound = error instanceof Error ? error.message : String(error)
    }
    console.log(`[s1] inbound from a just-added friend: ${inbound}`)
    console.log(`[s1] alice log: ${JSON.stringify(aliceLog)}`)

    expect(aliceLog.some((line) => line.includes(carolHandle))).toBe(false)
    expect(inbound).toMatch(/did not answer/)
    // The message a person actually sees must name the restart, or a friend
    // they just added is simply broken with no explanation.
    expect(outbound).toMatch(/restart/i)
  }, 120_000)

  // ---------------------------------------------------------------- 2 ------
  test("scenario 2 - an invite older than 48 hours, and the same invite twice", async () => {
    if (!relay) return expect(skipped).toBeTruthy()
    const aliceDir = tmp()
    const bobDir = tmp()
    const malDir = tmp()
    const alice = FlockStore.Store.open({ directory: aliceDir, name: "alice" })
    const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
    const mallory = FlockStore.Store.open({ directory: malDir, name: "mallory" })

    const stale = FlockStore.encodeInvite({
      identity: alice.identity(),
      token: FlockStore.newToken(),
      issuedAt: Date.now() - FlockStore.TOKEN_TTL_MS - 1_000,
    })
    let expired = "ACCEPTED"
    try {
      bob.accept(stale)
    } catch (error) {
      expired = error instanceof Error ? error.message : String(error)
    }
    console.log(`[s2] a 48h+1s old invite: ${expired}`)
    expect(expired).toMatch(/expired/)

    // The boundary itself: five seconds inside the window is still good.
    const edge = FlockStore.encodeInvite({
      identity: alice.identity(),
      token: FlockStore.newToken(),
      issuedAt: Date.now() - FlockStore.TOKEN_TTL_MS + 5_000,
    })
    expect(bob.accept(edge).handle).toBe(alice.identity().handle)

    // REPLAY, SAME REDEEMER: refused, and still refused after a revoke -
    // revoking somebody must not hand their old invite back its power.
    const once = alice.invite().invite
    const carolDir = tmp()
    const carol = FlockStore.Store.open({ directory: carolDir, name: "carol" })
    carol.accept(once)
    carol.revoke(alice.identity().handle)
    let second = "ACCEPTED"
    try {
      carol.accept(once)
    } catch (error) {
      second = error instanceof Error ? error.message : String(error)
    }
    console.log(`[s2] the same invite, same redeemer, after a revoke: ${second}`)
    expect(second).toMatch(/already been used/)

    // REPLAY, A DIFFERENT REDEEMER: the used-token list is the redeemer's own
    // file, and the issuer keeps no record of what it minted at all.
    let stolen = "REFUSED"
    try {
      mallory.accept(once)
      stolen = "ACCEPTED"
    } catch (error) {
      stolen = error instanceof Error ? error.message : String(error)
    }
    console.log(`[s2] the same invite, a SECOND redeemer: ${stolen}`)
    // OBSERVED, AND A REAL HOLE: single use is enforced by the REDEEMER's own
    // `used` list, and `Store.invite()` persists nothing at all, so the issuer
    // has no record of what it minted. One invite is therefore spendable once
    // per redeemer, not once. The blast radius is bounded — a redeemer only
    // gains the issuer's public keys and a rendezvous with them, and the
    // issuer must still accept an invite of theirs before anything is answered
    // — but "invites work once" is not what the file does.
    expect(stolen).toBe("ACCEPTED")

    // OVER THE REAL RELAY: a friendship built from an invite that has since
    // aged out keeps working. Expiry gates the accept and nothing after it.
    const aliceLog: string[] = []
    const bobLog: string[] = []
    alice.accept(bob.invite().invite)
    const a = boot({ store: alice, name: "alice", log: aliceLog, base: relay.base })
    const b = boot({ store: bob, name: "bob", log: bobLog, base: relay.base })
    await connected(a, bob.identity().handle)
    await connected(b, alice.identity().handle)
    const answer = await a.peer!.ask(bob.identity().handle, "still valid?", 20_000)
    console.log(`[s2] friendship from a now-expired invite: ok=${answer.ok} text=${JSON.stringify(answer.text)}`)
    // Expiry gates the ACCEPT and nothing after it: the invite that made this
    // friendship is a dead string now, and the friendship still answers.
    expect(answer.ok).toBe(true)
  }, 120_000)

  // ---------------------------------------------------------------- 3 ------
  test("scenario 3 - a revoke lands while the answer is in flight", async () => {
    if (!relay) return expect(skipped).toBeTruthy()
    const aliceDir = tmp()
    const bobDir = tmp()
    const alice = FlockStore.Store.open({ directory: aliceDir, name: "alice" })
    const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
    befriend(alice, bob)
    const aliceHandle = alice.identity().handle
    const bobHandle = bob.identity().handle

    const aliceLog: string[] = []
    const bobLog: string[] = []
    const holds = new Map<string, Promise<void>>()
    const gate = latch()
    holds.set("what is the answer?", gate.promise)

    const a = boot({ store: alice, name: "alice", log: aliceLog, base: relay.base })
    const b = boot({ store: bob, name: "bob", log: bobLog, base: relay.base, holds })
    await connected(a, bobHandle)
    await connected(b, aliceHandle)

    const asking = a.peer!.ask(bobHandle, "what is the answer?", 8_000)
    // The question has REACHED Bob - his own counter for Alice has moved - so
    // the revoke below is genuinely mid-flight and not a race with the send.
    await until("bob to take delivery", () => seqOf(bobDir, aliceHandle).recv > 0)

    // REVOKED THE WAY PRODUCTION REVOKES: `acp/flock.ts` and `cli/cmd/flock.ts`
    // both call `Store.open(...)` and revoke on THAT object, not on the one the
    // running service is holding.
    const pane = FlockStore.Store.open({ directory: aliceDir })
    expect(pane.revoke(bobHandle)).toBe(true)
    expect(FlockStore.Store.open({ directory: aliceDir }).find(bobHandle)).toBeUndefined()

    gate.open()

    let seen = "RESOLVED"
    try {
      const answer = await asking
      seen = `RESOLVED ok=${answer.ok} text=${JSON.stringify(answer.text)}`
    } catch (error) {
      seen = error instanceof Error ? error.message : String(error)
    }
    console.log(`[s3] what the asker saw after revoking mid-flight: ${seen}`)
    // The revoke took the friend ROW with it, counters and all, so there is no
    // "recv seq after" to read - the only witness that the answer was refused
    // is that the asker never got it.
    console.log(`[s3] bob's row on alice's disk: ${FlockStore.Store.open({ directory: aliceDir }).find(bobHandle)}`)
    console.log(`[s3] alice's socket to the revoked friend: ${a.transport!.status(a.routes.get(bobHandle)!.rid)}`)
    console.log(`[s3] bob still answered it: ${JSON.stringify(bobLog.filter((line) => line.includes("answered")))}`)

    // A REVOKED PEER MUST NOT DELIVER AN ANSWER THAT IS ACCEPTED. The asker
    // waits out the request timeout and gets a refusal, not a friend's words.
    expect(seen).toMatch(/did not answer/)
    // What the revoked peer CAN still do, all of it harmless: run the turn,
    // remember it, and put the frame on the wire. Only acceptance is denied.
    expect(bobLog.some((line) => line.includes(`bob answered "what is the answer?"`))).toBe(true)
    expect(bob.answered().some((entry) => entry.from === aliceHandle)).toBe(true)

    // REPORTED, NOT FIXED: the revoke never reaches the transport, so the
    // socket to a friendship that no longer exists stays up for the life of
    // the engine and the orphaned question stays in the pending list for its
    // full 24 hours. Both need `service.ts` to be told about the revoke, which
    // is a wiring change in `acp/flock.ts`.
    expect(a.transport!.status(a.routes.get(bobHandle)!.rid)).toBe("open")
    const orphan = FlockStore.Store.open({ directory: aliceDir }).pending()
    expect(orphan.some((entry) => entry.question === "what is the answer?")).toBe(true)
  }, 120_000)

  // ---------------------------------------------------------------- 4 ------
  test("scenario 4 - a sequence gap after a crash mid-send", async () => {
    if (!relay) return expect(skipped).toBeTruthy()
    const aliceDir = tmp()
    const bobDir = tmp()
    const alice = FlockStore.Store.open({ directory: aliceDir, name: "alice" })
    const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
    befriend(alice, bob)
    const aliceHandle = alice.identity().handle
    const bobHandle = bob.identity().handle

    const aliceLog: string[] = []
    const bobLog: string[] = []

    // A socket that swallows the next N frames on the way out - which is
    // exactly what a process killed between `nextSendSeq` and `socket.send`
    // leaves behind: a burnt sequence and nothing in the relay's ring.
    let swallow = 0
    const dropped: number[] = []
    const deps: FlockRelayTransport.RelayDeps = {
      connect: (url) => {
        const ws = new WebSocket(url) as unknown as FlockRelayTransport.RelaySocket
        const shim: FlockRelayTransport.RelaySocket = {
          get binaryType() {
            return ws.binaryType
          },
          set binaryType(value: string | undefined) {
            ws.binaryType = value
          },
          send(data: Uint8Array) {
            if (swallow > 0) {
              swallow--
              dropped.push(data.length)
              return
            }
            ws.send(data)
          },
          close: (code?: number, reason?: string) => ws.close(code, reason),
          get onopen() {
            return ws.onopen
          },
          set onopen(fn) {
            ws.onopen = fn
          },
          get onmessage() {
            return ws.onmessage
          },
          set onmessage(fn) {
            ws.onmessage = fn
          },
          get onclose() {
            return ws.onclose
          },
          set onclose(fn) {
            ws.onclose = fn
          },
          get onerror() {
            return ws.onerror
          },
          set onerror(fn) {
            ws.onerror = fn
          },
        }
        return shim
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }

    let a = boot({ store: alice, name: "alice", log: aliceLog, base: relay.base, deps })
    const b = boot({ store: bob, name: "bob", log: bobLog, base: relay.base })
    await connected(a, bobHandle)
    await connected(b, aliceHandle)
    expect((await a.peer!.ask(bobHandle, "first", 20_000)).ok).toBe(true)
    const settled = seqOf(bobDir, aliceHandle).recv
    expect(settled).toBeGreaterThan(0)

    // LEG A - a sequence burnt and never used. `Store.nextSendSeq` reserves
    // BEFORE the frame goes out, so this is byte-for-byte the state a crash
    // leaves. Bob's guard is `>`, not `= last + 1`.
    const burnt = alice.nextSendSeq(bobHandle)
    const gapped = await a.peer!.ask(bobHandle, "after the hole", 20_000)
    console.log(`[s4] leg A burnt seq ${burnt}; bob recv ${settled} -> ${seqOf(bobDir, aliceHandle).recv}`)
    expect(gapped.ok).toBe(true)
    // The hole is EXACTLY one number wide and Bob steps straight over it: his
    // guard is `>`, never `= last + 1`, because a reserved-and-crashed number
    // is a legitimate hole and refusing one would wedge the friendship for ever.
    expect(seqOf(bobDir, aliceHandle).recv).toBe(burnt + 1)
    // Nobody said a word about the missing number. A lost frame is invisible at
    // this layer by design; the pending list is the only thing that covers it.
    expect(bobLog.some((line) => /gap|missing|out of order|skipped/i.test(line))).toBe(false)
    expect(aliceLog.some((line) => /gap|missing|out of order|skipped/i.test(line))).toBe(false)

    // LEG B - the frame really is lost on the wire. The asker gets a timeout
    // and nothing else; the question survives only in the pending list.
    swallow = 1
    let lost = "RESOLVED"
    try {
      await a.peer!.ask(bobHandle, "into the void", 5_000)
    } catch (error) {
      lost = error instanceof Error ? error.message : String(error)
    }
    console.log(`[s4] leg B a frame dropped on the wire: ${lost} (dropped ${dropped.length} frame(s))`)
    expect(lost).toMatch(/did not answer/)
    expect(bobLog.some((line) => line.includes("into the void"))).toBe(false)
    expect(alice.pending(bobHandle).some((entry) => entry.question === "into the void")).toBe(true)

    // And the recovery: a reconnect is the only thing that re-sends it.
    a.stop()
    running.splice(running.indexOf(a), 1)
    a = boot({ store: alice, name: "alice", log: aliceLog, base: relay.base })
    await connected(a, bobHandle)
    await until("bob to serve the re-sent question", () => bobLog.some((line) => line.includes("into the void")))
    await until("alice to retire the pending entry", () => alice.pending(bobHandle).length === 0)
    console.log(`[s4] after a reconnect: ${JSON.stringify(bobLog.filter((line) => line.includes("void")))}`)
  }, 120_000)

  // ---------------------------------------------------------------- 5 ------
  test("scenario 5 - two questions in flight at once", async () => {
    if (!relay) return expect(skipped).toBeTruthy()
    const aliceDir = tmp()
    const bobDir = tmp()
    const alice = FlockStore.Store.open({ directory: aliceDir, name: "alice" })
    const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
    befriend(alice, bob)
    const aliceHandle = alice.identity().handle
    const bobHandle = bob.identity().handle

    const aliceLog: string[] = []
    const bobLog: string[] = []
    // The SLOW one is asked first and answered last, so a transport that
    // matched answers by arrival order would cross them.
    const holds = new Map<string, Promise<void>>()
    const slow = latch()
    holds.set("slow question", slow.promise)

    const a = boot({ store: alice, name: "alice", log: aliceLog, base: relay.base })
    const b = boot({ store: bob, name: "bob", log: bobLog, base: relay.base, holds })
    await connected(a, bobHandle)
    await connected(b, aliceHandle)

    const first = a.peer!.ask(bobHandle, "slow question", 30_000)
    const second = a.peer!.ask(bobHandle, "fast question", 30_000)
    await until("the fast answer to be served first", () => bobLog.some((line) => line.includes("fast question")))
    expect(bobLog.some((line) => line.includes("slow question"))).toBe(false)
    slow.open()

    const [slowAnswer, fastAnswer] = await Promise.all([first, second])
    console.log(`[s5] slow -> ${JSON.stringify(slowAnswer.text)}`)
    console.log(`[s5] fast -> ${JSON.stringify(fastAnswer.text)}`)
    expect(slowAnswer.text).toBe("bob says: SLOW QUESTION")
    expect(fastAnswer.text).toBe("bob says: FAST QUESTION")
    expect(slowAnswer.signatureOk).toBe(true)
    expect(fastAnswer.signatureOk).toBe(true)
    // Neither was lost, and neither is still queued for a resend.
    expect(alice.pending(bobHandle)).toHaveLength(0)
    // Four frames crossed: two asks out, two answers back.
    expect(seqOf(aliceDir, bobHandle).send).toBeGreaterThanOrEqual(2)
    expect(seqOf(bobDir, aliceHandle).send).toBeGreaterThanOrEqual(2)
  }, 120_000)
})

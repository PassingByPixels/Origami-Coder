// "WHY DOES IT NOT WORK" — one call, and the facts it has to carry.
//
// Every one of these assertions is a question that cost a real session: which
// engine holds the links, is that engine still alive, which relay is this
// contact on, is a socket actually open, and — the one that surprises people —
// whether a Front Desk model is set, which now decides whether you can ANSWER
// and no longer whether you can ask.
//
// Asserted on the object, and on the rendered lines where the wording is the
// thing a person acts on. Never against the owner's real config directory.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ACPFlock } from "@/acp/flock"
import { FlockDiagnose } from "@/flock/diagnose"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-doctor-"))
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

/** Alice with one contact, in her own directory. */
function flock() {
  const directory = tmp()
  const store = FlockStore.Store.open({ directory, name: "alice" })
  const friend = store.accept(FlockStore.Store.open({ directory: tmp(), name: "Macbook" }).invite().invite)
  return { directory, store, friend }
}

describe("with no flock at all", () => {
  test("it says so and does NOT create one", () => {
    const directory = tmp()
    const found = FlockDiagnose.diagnose({ directory })
    expect(found.present).toBe(false)
    expect(found.identity).toBeUndefined()
    expect(found.contacts).toEqual([])
    // THE POINT OF THE TEST. `Store.open()` mints a keypair on first use, and a
    // diagnostic that created the thing it was asked about would orphan every
    // contact the owner has.
    expect(fs.existsSync(path.join(directory, "flock.json"))).toBe(false)
    expect(FlockDiagnose.render(found)[0]).toContain("does not exist")
  })
})

describe("the shape", () => {
  test("identity, contacts, lease, transport, front desk, mailbox and the log", () => {
    const { directory, store, friend } = flock()
    const found = FlockDiagnose.diagnose({ directory, leaseDirectory: tmp() })

    expect(found.present).toBe(true)
    expect(found.file).toBe(FlockStore.file(directory))
    expect(found.identity?.handle).toBe(store.identity().handle)
    expect(found.identity?.handleShort).toContain("@")

    expect(found.contacts).toHaveLength(1)
    const contact = found.contacts[0]!
    expect(contact.handle).toBe(friend.handle)
    expect(contact.name).toBe("Macbook")
    // The relay is the RESOLVED one — the invite's, then the config's, then the
    // built-in default — because "which relay is this contact on" was a
    // question nothing on any surface could answer.
    expect(contact.relay).toBe(FlockService.DEFAULT_RELAY_URL)
    // Not "idle": this process holds no lease, so it holds no socket for
    // anybody, and saying `idle` would read as "the contact is unreachable".
    expect(contact.route).toBe("unrouted")
    expect(contact.canAnswer).toBe(false)

    expect(found.lease.pid).toBeUndefined()
    expect(found.lease.isHolder).toBe(false)
    expect(found.mailbox).toEqual({ threads: 0, waiting: 0, unread: 0 })
    expect(Array.isArray(found.log)).toBe(true)
  })

  test("the mailbox counts are the ones the badge shows", () => {
    const { directory, store, friend } = flock()
    store.openOut({ id: "q-out", contact: friend.handle, question: "?" })
    store.openIn({ id: "q-in", contact: friend.handle, question: "and you?" })
    const found = FlockDiagnose.diagnose({ directory, leaseDirectory: tmp() })
    expect(found.mailbox.threads).toBe(2)
    // One inbound question is waiting on a decision; it is also unread.
    expect(found.mailbox.waiting).toBe(1)
    expect(found.mailbox.unread).toBe(1)
  })

  test("a live lease is reported with its pid, its address and whether it is us", () => {
    const { directory } = flock()
    const leaseDirectory = tmp()
    const owner = new FlockOwnerLease.Owner({ directory: leaseDirectory, httpBase: "http://127.0.0.1:53411" })
    expect(owner.claim()).toBe(true)
    const found = FlockDiagnose.diagnose({ directory, leaseDirectory })
    expect(found.lease.pid).toBe(process.pid)
    expect(found.lease.alive).toBe(true)
    expect(found.lease.isHolder).toBe(true)
    expect(found.lease.httpBase).toBe("http://127.0.0.1:53411")
    owner.release()
  })

  test("a STALE lease — the record is there and the process is not — is named as such", () => {
    const { directory } = flock()
    const leaseDirectory = tmp()
    fs.writeFileSync(
      FlockOwnerLease.file(leaseDirectory),
      JSON.stringify({ pid: 999_999_998, startedAt: "", heartbeatAt: Date.now() }),
    )
    const found = FlockDiagnose.diagnose({ directory, leaseDirectory })
    expect(found.lease.pid).toBe(999_999_998)
    expect(found.lease.alive).toBe(false)
    expect(found.lease.isHolder).toBe(false)
    expect(FlockDiagnose.render(found).join("\n")).toContain("GONE")
  })

  test("a LAN address in the lease is not reported as somewhere to forward to", () => {
    const { directory } = flock()
    const leaseDirectory = tmp()
    fs.writeFileSync(
      FlockOwnerLease.file(leaseDirectory),
      JSON.stringify({ pid: process.pid, startedAt: "", heartbeatAt: Date.now(), httpBase: "http://10.0.0.5:8080" }),
    )
    const found = FlockDiagnose.diagnose({ directory, leaseDirectory })
    expect(found.lease.httpBase).toBeUndefined()
    expect(FlockDiagnose.render(found).join("\n")).toContain("published no address")
  })
})

describe("the front desk line", () => {
  test("NO MODEL is called out, and says asking still works", () => {
    const { directory } = flock()
    const found = FlockDiagnose.diagnose({ directory, leaseDirectory: tmp() })
    expect(found.frontDesk.modelSet).toBe(false)
    const rendered = FlockDiagnose.render(found).join("\n")
    expect(rendered).toContain("NO MODEL SET")
    // The whole reason the gate was split. A person reading this must not go on
    // believing they cannot ask anybody anything.
    expect(rendered).toContain("You can ask")
    // And the fix is a PATH, not a sentence about a pane they may not have open.
    expect(rendered).toContain(found.frontDesk.path)
  })

  test("a per-contact model counts, and the contact is marked answerable", () => {
    const { directory, store, friend } = flock()
    store.setPolicy(friend.handle, { model: "test/fake" })
    const found = FlockDiagnose.diagnose({ directory, leaseDirectory: tmp() })
    expect(found.frontDesk.modelSet).toBe(true)
    expect(found.contacts[0]!.canAnswer).toBe(true)
  })
})

describe("from an engine that HOLDS the flock", () => {
  test("the route is a live socket state and the log carries the last lines", () => {
    const { directory, friend } = flock()
    const leaseDirectory = tmp()
    const handle = FlockService.start({
      store: FlockStore.Store.open({ directory }),
      config: { model: "test/fake" },
      relayUrl: "ws://relay.test",
      runner: async () => ({ text: "", tokens: 0 }),
      leaseDirectory,
      deps: {
        connect: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
        setTimer: () => 0,
        clearTimer: () => {},
      },
      // PUBLISHED, because the diagnosis reads the module slots this writes —
      // which is the whole reason it can answer for a running engine at all.
      log: () => {},
    })
    handles.push(handle)

    const found = FlockDiagnose.diagnose({ directory, leaseDirectory })
    expect(found.transport.kind).toBe("relay")
    expect(found.transport.reason).toBeUndefined()
    expect(found.contacts[0]!.route).toBe("connecting")
    expect(found.contacts[0]!.relay).toBe("ws://relay.test")
    expect(found.lease.isHolder).toBe(true)
    // The lifecycle lines an engine has just printed are the useful ones.
    expect(found.log.some((line) => line.includes("holding 1 friendship"))).toBe(true)
    expect(found.log.length).toBeLessThanOrEqual(3)
    expect(FlockDiagnose.render(found).join("\n")).toContain(friend.handle.slice(0, 6))
  })
})

describe("the ACP surface", () => {
  test("flock_diagnose returns the same object the CLI renders", () => {
    const { directory } = flock()
    const viaAcp = ACPFlock.diagnose({ directory })
    expect(viaAcp.present).toBe(true)
    expect(viaAcp.contacts).toHaveLength(1)
    expect(viaAcp.frontDesk.path).toBe(FlockDiagnose.diagnose({ directory }).frontDesk.path)
  })
})

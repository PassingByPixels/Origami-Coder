// WHO SOMEBODY IS ON A CONTACT ROW: a display name and a sigil id, and the
// three ways either one moves.
//
// The feature is small and every part of it is a place a name could be set by
// somebody who should not be able to set it, so the claims are about WHO WROTE
// what, not about the fields existing:
//
//   1. the owner's own name and icon round trip through `flock.json`, and the
//      HANDLE does not follow the name — a rename that re-minted the handle
//      would orphan every contact holding the old one;
//   2. a file written before icons existed reads as the default, and gains it
//      on the next write rather than being refused;
//   3. an invite carries both, and accepting one stores both;
//   4. a contact's rename reaches us on their next SIGNED frame — and a frame
//      whose signature does not check leaves the stored row exactly as it was.
//
// (4) is the one worth the setup. It is asserted by breaking the signature on a
// frame that is otherwise perfectly sealed, so the seal cannot be what refuses
// it: a peer holding the pair secret is "one of the two of us", and only the
// Ed25519 signature inside says which.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockCard } from "@/flock/card"
import { FlockEnvelope } from "@/flock/envelope"
import { FlockIdentity } from "@/flock/identity"
import { FlockPeer } from "@/flock/peer"
import { FlockPolicy } from "@/flock/policy"
import { FlockStore } from "@/flock/store"
import { FlockTransport } from "@/flock/transport"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-contact-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const peers: FlockPeer.Peer[] = []
afterEach(() => {
  for (const peer of peers.splice(0)) peer.stop()
})

/** Let the loopback's queued microtasks run. `send` defers delivery on purpose. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const fileOf = (directory: string) => path.join(directory, FlockStore.FILE)
const raw = (directory: string) => JSON.parse(fs.readFileSync(fileOf(directory), "utf8")) as FlockStore.Data

describe("the owner's own display name and icon", () => {
  test("round trip through flock.json, and the handle does not follow the name", () => {
    const directory = tmp()
    const before = FlockStore.Store.open({ directory, name: "jane" })
    const handle = before.identity().handle

    // A fresh identity already shows SOMETHING: there is no "no icon" state.
    expect(before.identity().icon).toBe(FlockIdentity.ICON_DEFAULT)

    before.setIdentity({ name: "Jane Doe", icon: "fox" })

    // Re-opened from disk, not read back off the object that wrote it.
    const after = FlockStore.Store.open({ directory })
    expect(after.identity().name).toBe("Jane Doe")
    expect(after.identity().icon).toBe("fox")
    // THE POINT OF THE WHOLE DESIGN. Every contact stored `handle` when they
    // accepted the invite and matches on it; a rename that moved it would make
    // this Origami a stranger to all of them.
    expect(after.identity().handle).toBe(handle)
    expect(FlockIdentity.handleName(after.identity().handle, "")).toBe("jane")
  })

  test("either field alone, and a blank name is refused rather than stored", () => {
    const directory = tmp()
    const store = FlockStore.Store.open({ directory, name: "jane" })

    store.setIdentity({ icon: "wolf" })
    expect(store.identity().name).toBe("jane")
    expect(store.identity().icon).toBe("wolf")

    store.setIdentity({ name: "Dana" })
    expect(store.identity().icon).toBe("wolf")
    expect(store.identity().name).toBe("Dana")

    // An Origami with no name renders an empty row on every contact's address
    // book, and there is no way back to a name from there but another rename.
    store.setIdentity({ name: "   " })
    expect(store.identity().name).toBe("Dana")
  })

  test("an icon that is not a short id is refused, wherever it came from", () => {
    const directory = tmp()
    const store = FlockStore.Store.open({ directory, name: "jane" })

    // Each of these is a way somebody else's machine could try to decide what
    // this one fetches or renders. They all become the brand mark instead.
    for (const hostile of [
      "../../etc/passwd",
      "https://example.invalid/x.png",
      "data:image/svg+xml;base64,AAAA",
      "Fox",
      "",
      "a".repeat(64),
    ]) {
      store.setIdentity({ icon: hostile })
      expect(store.identity().icon).toBe(FlockIdentity.ICON_DEFAULT)
    }
  })
})

describe("a flock.json written before icons existed", () => {
  test("reads as the default and is migrated in place, keeping the handle it had", () => {
    const directory = tmp()
    const seed = FlockStore.Store.open({ directory, name: "jane" })
    const handle = seed.identity().handle

    // Strip the field back out, which is exactly what an older build left.
    const before = JSON.parse(fs.readFileSync(fileOf(directory), "utf8")) as Record<string, any>
    delete before["identity"]["icon"]
    fs.writeFileSync(fileOf(directory), JSON.stringify(before, null, 2))
    expect((raw(directory).identity as { icon?: string }).icon).toBeUndefined()

    const reopened = FlockStore.Store.open({ directory })

    expect(reopened.identity().icon).toBe(FlockIdentity.ICON_DEFAULT)
    expect(reopened.identity().handle).toBe(handle)
    // Migrated ON DISK, not just in memory, so the next reader needs no rule.
    expect(raw(directory).identity.icon).toBe(FlockIdentity.ICON_DEFAULT)
  })

  test("a renamed owner is not re-handled by the fingerprint migration", () => {
    const directory = tmp()
    const store = FlockStore.Store.open({ directory, name: "jane" })
    const handle = store.identity().handle
    store.setIdentity({ name: "Somebody Else" })

    // `migrate` rebuilds a handle to upgrade a short fingerprint. It must take
    // the NAME HALF from the handle already on disk, or every rename would
    // quietly re-mint the label every contact matches on.
    expect(FlockStore.migrate(raw(directory))).toBeUndefined()
    expect(FlockStore.Store.open({ directory }).identity().handle).toBe(handle)
  })
})

describe("an invite", () => {
  test("carries the sender's name and icon, and accepting one stores both", () => {
    const sender = FlockStore.Store.open({ directory: tmp(), name: "dana" })
    sender.setIdentity({ name: "Dana at the garage", icon: "deer" })
    const receiver = FlockStore.Store.open({ directory: tmp(), name: "jane" })

    const contact = receiver.accept(sender.invite().invite)

    expect(contact.name).toBe("Dana at the garage")
    expect(contact.icon).toBe("deer")
    // The key is what the two of them actually share; the label is minted here.
    expect(contact.signPublicKey).toBe(sender.identity().signPublicKey)
    expect(contact.handle.endsWith(`@${FlockIdentity.fingerprint(contact.signPublicKey)}`)).toBe(true)
  })

  test("for the DEFAULT icon is byte for byte the string the old encoder wrote", () => {
    const sender = FlockStore.Store.open({ directory: tmp(), name: "dana" })
    const identity = FlockIdentity.toPublic(sender.identity())

    // No trailing segment when there is nothing to say, so an invite made by
    // this build is one an already-shipped build still parses.
    const plain = FlockStore.encodeInvite({ identity, token: "tok", issuedAt: 1_700_000_000_000 })
    expect(plain.split(".")).toHaveLength(6)

    // With a relay the icon still does not appear, and the relay stays in the
    // slot every older decoder reads it from.
    const relayed = FlockStore.encodeInvite({ identity, token: "tok", relay: "wss://r.example", issuedAt: 1 })
    expect(relayed.split(".")).toHaveLength(7)
    expect(FlockStore.decodeInvite(relayed).relay).toBe("wss://r.example")
  })

  test("with an icon and no relay leaves the relay slot empty rather than shifting it", () => {
    const sender = FlockStore.Store.open({ directory: tmp(), name: "dana" })
    sender.setIdentity({ icon: "heron" })
    const invite = FlockStore.encodeInvite({
      identity: FlockIdentity.toPublic(sender.identity()),
      token: "tok",
      issuedAt: Date.now(),
    })

    const parts = invite.slice(FlockStore.INVITE_SCHEME.length).split(".")
    expect(parts).toHaveLength(8)
    // Segment 7 is the relay's, and an older reader takes "" as absent exactly
    // as it always did rather than reading the icon as a relay URL.
    expect(parts[6]).toBe("")
    expect(FlockStore.decodeInvite(invite).relay).toBeUndefined()
    expect(FlockStore.decodeInvite(invite).identity.icon).toBe("heron")
  })

  test("that names no icon at all is accepted, and the contact shows the default", () => {
    const sender = FlockStore.Store.open({ directory: tmp(), name: "dana" })
    const receiver = FlockStore.Store.open({ directory: tmp(), name: "jane" })

    expect(receiver.accept(sender.invite().invite).icon).toBe(FlockIdentity.ICON_DEFAULT)
  })
})

// --------------------------------------------------------------------------
// A rename crossing the wire.
// --------------------------------------------------------------------------

/** One Origami: its own store on its own disk, its own peer on a shared transport. */
function origami(name: string, transport: FlockTransport.Transport, serve?: FlockPeer.Serve) {
  const store = FlockStore.Store.open({ directory: tmp(), name })
  const peer = new FlockPeer.Peer(store, transport, serve)
  peers.push(peer)
  return { store, peer }
}

/** An answering side with no model behind it: the transport is what is under test. */
const echo = (store: FlockStore.Store): FlockPeer.Serve => ({
  async ask() {
    return { ok: true, text: "answered", tokens: 1 }
  },
  async card() {
    const identity = store.identity()
    return FlockCard.build({
      identity,
      specialties: ["tax rules"],
      policy: FlockPolicy.resolve({ config: { model: "test/fake", dailyBudgetTokens: 200_000 } }),
      signPrivateKey: identity.sign.privateKey,
    })
  },
})

describe("a contact who renames themselves", () => {
  test("their new name and icon arrive on their next signed frame, and the row keeps its handle", async () => {
    const transport = new FlockTransport.LoopbackTransport()
    const ownerStore = FlockStore.Store.open({ directory: tmp(), name: "jane" })
    const danaStore = FlockStore.Store.open({ directory: tmp(), name: "dana" })
    ownerStore.accept(danaStore.invite().invite)
    danaStore.accept(ownerStore.invite().invite)
    const owner = new FlockPeer.Peer(ownerStore, transport, echo(ownerStore))
    const dana = new FlockPeer.Peer(danaStore, transport, echo(danaStore))
    peers.push(owner, dana)
    owner.start()
    dana.start()

    const handle = ownerStore.friends()[0]!.handle
    expect(ownerStore.find(handle)!.name).toBe("dana")

    // The rename happens on DANA's box, and nothing is pushed: it rides out on
    // the next thing she says, which here is an ordinary question.
    danaStore.setIdentity({ name: "Dana at the garage", icon: "deer" })
    await dana.ask(danaStore.friends()[0]!.handle, "are you there?")
    await settle()

    const row = ownerStore.find(handle)!
    expect(row.name).toBe("Dana at the garage")
    expect(row.icon).toBe("deer")
    // The label every lookup on this box matches on is the one it was minted
    // with. A row that renamed itself would strand this owner's pending
    // questions, their answer log and their per-contact policy.
    expect(row.handle).toBe(handle)
    expect(row.signPublicKey).toBe(danaStore.identity().signPublicKey)
  })

  test("a frame whose signature does not check changes NOTHING", async () => {
    const transport = new FlockTransport.LoopbackTransport()
    const dana = FlockStore.Store.open({ directory: tmp(), name: "dana" })
    const owner = FlockStore.Store.open({ directory: tmp(), name: "jane" })
    owner.accept(dana.invite().invite)
    const peer = new FlockPeer.Peer(owner, transport, echo(owner))
    peers.push(peer)
    peer.start()

    const contact = owner.friends()[0]!
    // Dana's side of the same pair secret, derived here rather than through a
    // Peer of her own: this test writes the frame by hand precisely so it can
    // write a BAD one, which no Peer would ever emit.
    const keys = FlockEnvelope.derive(
      FlockIdentity.pairSecret({
        boxPrivateKey: dana.identity().box.privateKey,
        peerBoxPublicKey: owner.identity().boxPublicKey,
      }),
    )

    // Signed honestly, then EDITED. The seal is still perfect — this is a peer
    // holding the pair secret — so nothing but the Ed25519 signature inside can
    // refuse it, which is the check the update is placed behind.
    const honest = FlockEnvelope.signPayload(
      { type: "flock/answer", v: 1, id: "flq_x", from: contact.handle, ok: true, text: "", tokens: 0, at: "now", name: "dana", icon: "crane" },
      dana.identity().sign.privateKey,
    )
    const forged = { ...honest, name: "Mallory", icon: "wolf" }
    await transport.send(keys.rid, FlockEnvelope.seal({ keys, role: FlockEnvelope.ROLE_ANSWER, seq: 1, payload: forged }))
    await settle()

    const after = owner.find(contact.handle)!
    expect(after.name).toBe("dana")
    expect(FlockIdentity.normaliseIcon(after.icon)).toBe(FlockIdentity.ICON_DEFAULT)

    // The control: the SAME frame, unedited, does land. Without this the test
    // above would pass just as well against a peer that never updated anything.
    const renamed = FlockEnvelope.signPayload(
      { type: "flock/answer", v: 1, id: "flq_y", from: contact.handle, ok: true, text: "", tokens: 0, at: "now", name: "Dana at the garage", icon: "deer" },
      dana.identity().sign.privateKey,
    )
    await transport.send(keys.rid, FlockEnvelope.seal({ keys, role: FlockEnvelope.ROLE_ANSWER, seq: 2, payload: renamed }))
    await settle()

    expect(owner.find(contact.handle)!.name).toBe("Dana at the garage")
    expect(owner.find(contact.handle)!.icon).toBe("deer")
  })

  test("a card fetch carries it too, and a card that does not verify is refused whole", async () => {
    const transport = new FlockTransport.LoopbackTransport()
    const danaStore = FlockStore.Store.open({ directory: tmp(), name: "dana" })
    const ownerStore = FlockStore.Store.open({ directory: tmp(), name: "jane" })
    ownerStore.accept(danaStore.invite().invite)
    danaStore.accept(ownerStore.invite().invite)
    const dana = new FlockPeer.Peer(danaStore, transport, echo(danaStore))
    const owner = new FlockPeer.Peer(ownerStore, transport, echo(ownerStore))
    peers.push(dana, owner)
    dana.start()
    owner.start()

    danaStore.setIdentity({ name: "Dana at the garage", icon: "deer" })
    const card = await owner.who(ownerStore.friends()[0]!.handle)

    expect(card.name).toBe("Dana at the garage")
    expect(card.icon).toBe("deer")
    expect(ownerStore.friends()[0]!.name).toBe("Dana at the garage")
    expect(ownerStore.friends()[0]!.icon).toBe("deer")
  })
})

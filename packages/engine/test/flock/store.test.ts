// The FRIENDS LIST is the whole trust model of this feature: there is no
// directory, no search and no server that knows who exists, so "who may ask me"
// is exactly "who is in this file". Everything asserted here is therefore a
// security property, not a convenience: where the file lives, that an invite
// carries no secret, that a handle cannot be claimed twice, and that revoking
// really removes.
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockIdentity } from "@/flock/identity"
import { FlockStore } from "@/flock/store"

// Each store gets its own directory; they are removed together at the end so a
// full run does not leave a few hundred of them behind.
const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-store-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("the flock store", () => {
  test("generates an identity on first open and keeps it on the next", () => {
    const directory = tmp()
    const first = FlockStore.Store.open({ directory, name: "alice" })
    const second = FlockStore.Store.open({ directory, name: "someone-else" })

    expect(first.identity().handle).toStartWith("alice@")
    // The name only seeds a NEW identity. Reopening under a different name must
    // not mint a second keypair — every friend holding the first one's key
    // would be orphaned by it.
    expect(second.identity().handle).toBe(first.identity().handle)
    expect(second.identity().sign.privateKey).toBe(first.identity().sign.privateKey)
  })

  test("writes flock.json in the directory it was given, and nowhere else", () => {
    const directory = tmp()
    FlockStore.Store.open({ directory, name: "alice" })
    expect(fs.existsSync(path.join(directory, "flock.json"))).toBe(true)
    expect(fs.readdirSync(directory)).toEqual(["flock.json"])
  })

  test("an invite carries public keys and no private key", () => {
    const store = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    const { invite } = store.invite()

    expect(invite).toStartWith(FlockStore.INVITE_SCHEME)
    const identity = store.identity()
    // The one assertion that matters most in this file.
    expect(invite).not.toContain(identity.sign.privateKey)
    expect(invite).not.toContain(identity.box.privateKey)

    const decoded = FlockStore.decodeInvite(invite)
    expect(decoded.identity.signPublicKey).toBe(identity.signPublicKey)
    expect(decoded.identity.boxPublicKey).toBe(identity.boxPublicKey)
    expect(decoded.identity.handle).toBe(identity.handle)
    expect(decoded.token).toBeTruthy()
  })

  test("an invite round-trips a relay URL and a name with a dot in it", () => {
    const store = FlockStore.Store.open({ directory: tmp(), name: "j.doe" })
    const { invite } = store.invite("wss://relay.example/r")
    const decoded = FlockStore.decodeInvite(invite)
    // The dot is the segment separator, so a dotted NAME is the case that
    // breaks a naive split. base64url of the name is what stops it.
    expect(decoded.identity.name).toBe("j.doe")
    expect(decoded.relay).toBe("wss://relay.example/r")
  })

  test("rejects a malformed or wrong-version invite instead of half-parsing it", () => {
    const store = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    expect(() => store.accept("https://example.com/nope")).toThrow(/wrong scheme/)
    expect(() => store.accept(FlockStore.INVITE_SCHEME + "v9.a.b.c.d")).toThrow(/unsupported invite version/)
    expect(() => store.accept(FlockStore.INVITE_SCHEME + "v2.a.b")).toThrow(/too few segments/)
    // v1 had no issue time. Decoding one would be a standing way past the
    // expiry rule below, so it is refused by version and not by age.
    expect(() => store.accept(FlockStore.INVITE_SCHEME + "v1.a.b.c.d.e")).toThrow(/older Origami/)
  })

  test("an invite token carries at least 128 bits of randomness", () => {
    const store = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const tokens = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const { token } = store.invite()
      expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(16)
      tokens.add(token)
    }
    // A generator that repeats is a generator with less entropy than its length
    // claims; 200 draws from 2^128 collide with probability around 1e-34.
    expect(tokens.size).toBe(200)
  })

  test("an invite expires after 48 hours, and one dated in the future is refused too", () => {
    const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    const issued = Date.now()
    const { invite } = bob.invite()

    // One minute inside the window: fine.
    expect(alice.accept(invite, undefined, issued + FlockStore.TOKEN_TTL_MS - 60_000).handle).toBe(
      bob.identity().handle,
    )

    const carol = FlockStore.Store.open({ directory: tmp(), name: "carol" })
    const stale = FlockStore.Store.open({ directory: tmp(), name: "dana" }).invite().invite
    expect(() => carol.accept(stale, undefined, issued + FlockStore.TOKEN_TTL_MS + 1000)).toThrow(/expired/)
    // ...and a timestamp far AHEAD of this box would otherwise never expire.
    expect(() => carol.accept(stale, undefined, issued - 2 * FlockStore.TOKEN_FUTURE_SKEW_MS)).toThrow(
      /dated in the future/,
    )
    expect(carol.friends()).toEqual([])
  })

  test("an invite works ONCE — revoking a friend does not revive their old invite", () => {
    const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    const { invite } = bob.invite()

    alice.accept(invite)
    alice.revoke(bob.identity().handle)
    expect(alice.friends()).toEqual([])

    // Without the used-token ledger this succeeds: the handle guard is gone
    // with the friend, so the SAME string would let bob back in for ever.
    expect(() => alice.accept(invite)).toThrow(/already been used/)
    expect(alice.friends()).toEqual([])
  })

  test("invite, accept, list, revoke", () => {
    const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })

    const { invite } = bob.invite()
    const friend = alice.accept(invite)

    expect(friend.handle).toBe(bob.identity().handle)
    expect(alice.friends().map((f) => f.handle)).toEqual([bob.identity().handle])
    expect(alice.find("bob")?.signPublicKey).toBe(bob.identity().signPublicKey)
    expect(alice.findByKey(bob.identity().signPublicKey)?.handle).toBe(bob.identity().handle)

    expect(alice.revoke(bob.identity().handle)).toBe(true)
    expect(alice.friends()).toEqual([])
    expect(alice.findByKey(bob.identity().signPublicKey)).toBeUndefined()
    // Revoking twice is not an error, it is a no-op that says so.
    expect(alice.revoke(bob.identity().handle)).toBe(false)
  })

  test("a revoke survives a reopen, because the friends list is the file", () => {
    const directory = tmp()
    const alice = FlockStore.Store.open({ directory, name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    alice.accept(bob.invite().invite)
    alice.revoke(bob.identity().handle)

    expect(FlockStore.Store.open({ directory }).friends()).toEqual([])
  })

  test("refuses a second friend under a handle it already holds", () => {
    const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    alice.accept(bob.invite().invite)
    // A repeat invite from the same person, and the fingerprint-collision case,
    // land on the same guard: `find` must never have two people to choose from.
    expect(() => alice.accept(bob.invite().invite)).toThrow(/already in this flock/)
  })

  test("refuses its own invite", () => {
    const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    expect(() => alice.accept(alice.invite().invite)).toThrow(/own invite/)
  })

  test("charges a budget per UTC day and forgets yesterday", () => {
    const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    const friend = alice.accept(bob.invite().invite)

    alice.charge(friend.handle, 400, "2026-09-02")
    alice.charge(friend.handle, 350, "2026-09-02")
    expect(alice.spent(friend.handle, "2026-09-02")).toBe(750)
    // The reset is lazy and read-side: nothing runs at midnight, so a box that
    // was asleep at midnight must still start the new day at zero.
    expect(alice.spent(friend.handle, "2026-09-03")).toBe(0)
    alice.charge(friend.handle, 10, "2026-09-03")
    expect(alice.spent(friend.handle, "2026-09-03")).toBe(10)
  })

  test("a mutation re-reads the file, so a second writer's friend is not lost", () => {
    const directory = tmp()
    const alice = FlockStore.Store.open({ directory, name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    const carol = FlockStore.Store.open({ directory: tmp(), name: "carol" })

    // Two handles on the same file, as `origami flock accept` in a terminal and
    // a running engine are two processes on one flock.json.
    const other = FlockStore.Store.open({ directory })
    alice.accept(bob.invite().invite)
    other.accept(carol.invite().invite)

    const handles = FlockStore.Store.open({ directory })
      .friends()
      .map((f) => f.handle)
      .sort()
    expect(handles).toEqual([bob.identity().handle, carol.identity().handle].sort())
  })

  test("a fingerprint is derived from the signing key, so it is stable and key-bound", () => {
    const store = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const identity = store.identity()
    expect(identity.handle).toBe(`alice@${FlockIdentity.fingerprint(identity.signPublicKey)}`)
    expect(FlockIdentity.fingerprint(identity.signPublicKey)).toHaveLength(FlockIdentity.FINGERPRINT_LENGTH)
    expect(FlockIdentity.fingerprint(identity.boxPublicKey)).not.toBe(
      FlockIdentity.fingerprint(identity.signPublicKey),
    )
  })
})

/**
 * THE 32-BIT HANDLES ON DISK.
 *
 * Passing's own box has a `flock.json` written by 0.4.81, so this is a real
 * file and not a hypothetical one. Both halves are asserted separately because
 * they fail differently: an un-upgraded IDENTITY hands friends a handle nobody
 * will recognise, and an un-upgraded FRIEND is a row whose handle no longer
 * matches the key beside it, so every policy write against it misses.
 */
describe("upgrading a flock.json written before the fingerprint grew", () => {
  /** A store file exactly as 0.4.81 left it: same keys, eight-hex handles. */
  function legacyFile(directory: string, self: FlockIdentity.Info, friend: FlockIdentity.Info): void {
    const short = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 8)
    fs.writeFileSync(
      path.join(directory, FlockStore.FILE),
      JSON.stringify({
        version: FlockStore.VERSION,
        identity: { ...self, handle: `${self.name}@${short(self.signPublicKey)}` },
        friends: [
          {
            handle: `${friend.name}@${short(friend.signPublicKey)}`,
            name: friend.name,
            signPublicKey: friend.signPublicKey,
            boxPublicKey: friend.boxPublicKey,
            addedAt: "2026-09-01T10:00:00.000Z",
            policy: { autoAnswer: true },
          },
        ],
      }),
    )
  }

  test("recomputes the OWNER's handle on load and writes it back", () => {
    const directory = tmp()
    const self = FlockIdentity.generate("passing")
    const friend = FlockIdentity.generate("chris")
    legacyFile(directory, self, friend)

    const opened = FlockStore.Store.open({ directory })
    const want = `passing@${FlockIdentity.fingerprint(self.signPublicKey)}`
    expect(opened.identity().handle).toBe(want)
    // The keys are untouched: an upgrade that minted a new identity would
    // orphan every friend holding the old key.
    expect(opened.identity().sign.privateKey).toBe(self.sign.privateKey)

    // Written back, not just fixed in memory — the CLI in another process reads
    // the file, not this object.
    const onDisk = JSON.parse(fs.readFileSync(path.join(directory, FlockStore.FILE), "utf8"))
    expect(onDisk.identity.handle).toBe(want)
  })

  test("upgrades a FRIEND by their public key, keeping their policy", () => {
    const directory = tmp()
    const self = FlockIdentity.generate("passing")
    const friend = FlockIdentity.generate("chris")
    legacyFile(directory, self, friend)

    const opened = FlockStore.Store.open({ directory })
    const want = `chris@${FlockIdentity.fingerprint(friend.signPublicKey)}`
    expect(opened.friends().map((f) => f.handle)).toEqual([want])
    // The match is by KEY, which is the only thing that survived the change.
    expect(opened.findByKey(friend.signPublicKey)?.handle).toBe(want)
    expect(opened.find(want)?.policy).toEqual({ autoAnswer: true })
    // ...and the upgraded handle is the one a policy write now addresses.
    expect(() => opened.setPolicy(want, { autoAnswer: false })).not.toThrow()
  })

  // THREE DANAS. The owner's own label for a friend, which is the only name on
  // this pane they are allowed to change: `name` is self-declared, it rides in
  // the invite and it is half the handle, so editing it would address nobody.
  test("a display name round-trips through the FILE, and the declared name survives it", () => {
    const directory = tmp()
    const alice = FlockStore.Store.open({ directory, name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "dana" })
    const friend = alice.accept(bob.invite().invite)

    alice.setDisplayName(friend.handle, "Dana from the gym")

    // Re-OPENED, not re-read from the same instance: the claim is that it is on
    // disk, not that a setter returned what it was handed.
    const reopened = FlockStore.Store.open({ directory })
    const stored = reopened.find(friend.handle)!
    expect(stored.displayName).toBe("Dana from the gym")
    // The name they signed with is untouched, and so is the handle every write
    // and every envelope check addresses.
    expect(stored.name).toBe("dana")
    expect(stored.handle).toBe(friend.handle)

    // Blank CLEARS the key rather than storing "": a row whose first line is an
    // empty string is worse than one that falls back to the declared name.
    reopened.setDisplayName(friend.handle, "   ")
    const cleared = JSON.parse(fs.readFileSync(path.join(directory, FlockStore.FILE), "utf8"))
    expect(Object.keys(cleared.friends[0])).not.toContain("displayName")

    expect(() => reopened.setDisplayName("ghost@nobody", "x")).toThrow(/not in this flock/)
  })

  test("a display name and a policy write do not overwrite one another", () => {
    const directory = tmp()
    const alice = FlockStore.Store.open({ directory, name: "alice" })
    const friend = alice.accept(FlockStore.Store.open({ directory: tmp(), name: "dana" }).invite().invite)

    alice.setDisplayName(friend.handle, "Dana T")
    alice.setPolicy(friend.handle, { autoAnswer: true, dailyBudgetTokens: 2000 })
    // A policy write REPLACES the overrides block. If the label lived inside it,
    // renaming somebody would be a way to silently drop their budget.
    expect(alice.find(friend.handle)?.displayName).toBe("Dana T")

    alice.setDisplayName(friend.handle, "Dana Two")
    expect(alice.find(friend.handle)?.policy).toEqual({ autoAnswer: true, dailyBudgetTokens: 2000 })
  })

  test("a file that is already current is not rewritten", () => {
    const directory = tmp()
    FlockStore.Store.open({ directory, name: "alice" })
    const file = path.join(directory, FlockStore.FILE)
    const before = fs.readFileSync(file, "utf8")
    FlockStore.Store.open({ directory })
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })
})

// TWO STORE OBJECTS ON ONE FILE. This is not a hypothetical: `FlockService`
// holds one, `tool/flock.ts`'s cached peer holds another, every ACP call opens
// a third, and `origami flock accept` in a terminal is a whole second process.
// They all write the WHOLE file. If a write started from the copy the object
// loaded at open, the last writer would silently delete every contact added
// since — which is what losing a contact looks like from the outside.
describe("several stores, one file", () => {
  test("two objects each add a different contact and BOTH survive", () => {
    const directory = tmp()
    FlockStore.Store.open({ directory, name: "alice" })
    // Both opened BEFORE either writes, so both hold a copy with no contacts.
    const one = FlockStore.Store.open({ directory })
    const two = FlockStore.Store.open({ directory })

    const bob = one.accept(FlockStore.Store.open({ directory: tmp(), name: "bob" }).invite().invite)
    const dana = two.accept(FlockStore.Store.open({ directory: tmp(), name: "dana" }).invite().invite)

    const onDisk = FlockStore.Store.open({ directory })
      .friends()
      .map((friend) => friend.handle)
      .sort()
    expect(onDisk).toEqual([bob.handle, dana.handle].sort())
    // And the object that wrote FIRST picks the other's contact up on its next
    // `reload` — the seam `FlockService.refresh` drives when the file changes,
    // and the reason the revoke guard in peer.ts fires for a revoke made
    // anywhere rather than only through that one object.
    expect(one.find(dana.handle)).toBeUndefined()
    one.reload()
    expect(one.find(dana.handle)?.handle).toBe(dana.handle)
  })

  test("two objects each file a different thread and BOTH survive", () => {
    const directory = tmp()
    FlockStore.Store.open({ directory, name: "alice" })
    const one = FlockStore.Store.open({ directory })
    const two = FlockStore.Store.open({ directory })

    one.openOut({ id: "thr_out", contact: "bob@k", question: "ours" })
    two.openIn({ id: "thr_in", contact: "dana@k", question: "theirs" })

    expect(
      FlockStore.Store.open({ directory })
        .mailbox()
        .map((thread) => thread.id)
        .sort(),
    ).toEqual(["thr_in", "thr_out"])
    // A reader that kept its own copy would return undefined here, and an
    // answer arriving for a thread the peer's store has never seen is dropped.
    expect(one.thread("thr_in")?.direction).toBe("in")
  })

  test("a file that exists but cannot be read THROWS rather than being replaced", () => {
    const directory = tmp()
    const alice = FlockStore.Store.open({ directory, name: "alice" })
    const handle = alice.identity().handle
    const file = path.join(directory, FlockStore.FILE)

    // A directory where the file should be is the portable stand-in for the
    // EPERM/EBUSY a Windows box gives a reader that arrives mid-write: the read
    // fails for a reason that is NOT "there is no flock here".
    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(() => FlockStore.Store.open({ directory })).toThrow()
    // The identity is still whatever it was. A `catch` that read the failure as
    // first use would have minted a new keypair over it and orphaned every
    // contact holding the old one.
    fs.rmdirSync(file)
    fs.writeFileSync(file, JSON.stringify({ version: 1, identity: alice.identity(), friends: [] }))
    expect(FlockStore.Store.open({ directory }).identity().handle).toBe(handle)
  })
})

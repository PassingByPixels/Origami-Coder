// WHO THE OWNER MEANT.
//
// The live failure: a contact shown everywhere as "Macbook" was asked for as
// `macbook` and the flock reported that it did not know anybody by that name.
// Every label a person can read off a pane has to be a label they can type
// back, and nobody re-types case correctly from a sigil-sized column.
//
// The other half is the one that costs money: TWO matches are never a guess.
// Picking whichever sorted first would put the owner's question, and a
// contact's tokens, on the wrong Origami — and the owner would have no way to
// tell, because the answer comes back hours later in a mailbox row.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockPeer } from "@/flock/peer"
import { FlockStore } from "@/flock/store"
import { FlockTransport } from "@/flock/transport"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-resolve-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/** Alice, with the named contacts in her flock. Returns their full handles. */
function flockOf(...names: string[]) {
  const store = FlockStore.Store.open({ directory: tmp(), name: "alice" })
  const handles: Record<string, string> = {}
  for (const name of names) {
    const friend = store.accept(FlockStore.Store.open({ directory: tmp(), name }).invite().invite)
    handles[name] = friend.handle
  }
  return { store, handles }
}

describe("one contact, by whatever the owner calls them", () => {
  test("the full handle, exactly", () => {
    const { store, handles } = flockOf("macbook")
    expect(store.find(handles["macbook"]!)?.handle).toBe(handles["macbook"]!)
  })

  test("the declared name, in ANY case — the reported bug", () => {
    const { store, handles } = flockOf("Macbook")
    for (const typed of ["Macbook", "macbook", "MACBOOK", "  macbook  "]) {
      expect(store.find(typed)?.handle, `"${typed}" should reach Macbook`).toBe(handles["Macbook"]!)
    }
  })

  test("the handle in any case, too", () => {
    const { store, handles } = flockOf("Macbook")
    expect(store.find(handles["Macbook"]!.toUpperCase())?.handle).toBe(handles["Macbook"]!)
  })

  test("the owner's OWN display name for them, which is the label the pane shows", () => {
    const { store, handles } = flockOf("bob")
    store.setDisplayName(handles["bob"]!, "The Garage")
    expect(store.find("the garage")?.handle).toBe(handles["bob"]!)
    // And the declared name still works: renaming somebody on your own side
    // must not take away the name they call themselves.
    expect(store.find("bob")?.handle).toBe(handles["bob"]!)
  })

  test("a PREFIX of the handle — what somebody reads off a narrow column", () => {
    const { store, handles } = flockOf("macbook")
    const full = handles["macbook"]!
    expect(store.find(full.slice(0, full.indexOf("@") + 5))?.handle).toBe(full)
  })

  test("an exact name BEATS a prefix — bob is Bob even with a Bobby in the flock", () => {
    const { store, handles } = flockOf("bob", "bobby")
    // `bob` is a prefix of `bobby@…` as well, so a flat matcher would call this
    // ambiguous and refuse to send anything to a contact named exactly bob.
    expect(store.find("bob")?.handle).toBe(handles["bob"]!)
    expect(store.find("bobby")?.handle).toBe(handles["bobby"]!)
  })

  test("nobody by that name is nobody, not the nearest thing", () => {
    const { store } = flockOf("macbook")
    expect(store.find("mini")).toBeUndefined()
    expect(store.find("")).toBeUndefined()
    expect(store.find("   ")).toBeUndefined()
  })
})

describe("two matches are never a guess", () => {
  test("resolve returns the CANDIDATES, and find returns nothing", () => {
    const { store, handles } = flockOf("mac", "machine")
    const found = store.resolve("mac")
    // `mac` is an exact name for one and a handle prefix of the other, so the
    // tiers keep them apart: tier 3 matches exactly one.
    expect(found.kind).toBe("one")

    const wider = store.resolve("m")
    expect(wider.kind).toBe("many")
    if (wider.kind !== "many") throw new Error("unreachable")
    expect(wider.candidates.map((friend) => friend.handle).sort()).toEqual(
      [handles["mac"]!, handles["machine"]!].sort(),
    )
    expect(store.find("m")).toBeUndefined()
  })

  test("the sentence NAMES them, because a count is nothing the owner can act on", () => {
    const { store, handles } = flockOf("mac", "machine")
    const found = store.resolve("m")
    if (found.kind !== "many") throw new Error("expected an ambiguity")
    const message = FlockStore.ambiguous("m", found.candidates)
    expect(message).toContain(handles["mac"]!)
    expect(message).toContain(handles["machine"]!)
    expect(message).toContain("Ask again using one of those handles")
  })

  test("a display name the owner set on TWO contacts is ambiguous, not first-wins", () => {
    const { store, handles } = flockOf("one", "two")
    store.setDisplayName(handles["one"]!, "Laptop")
    store.setDisplayName(handles["two"]!, "laptop")
    const found = store.resolve("LAPTOP")
    expect(found.kind).toBe("many")
  })
})

describe("what the asking side does with an ambiguity", () => {
  test("a post to an ambiguous name is REFUSED and names the candidates", async () => {
    const { store, handles } = flockOf("mac", "machine")
    const peer = new FlockPeer.Peer(store, new FlockTransport.LoopbackTransport())
    try {
      const sent = await peer.postMany(["m"], "which of you is it?")
      expect(sent).toHaveLength(1)
      // No thread was opened, so nothing is waiting on an answer that will
      // never come — and the sentence carries both handles.
      expect(sent[0]!.thread).toBeUndefined()
      expect(sent[0]!.error).toContain(handles["mac"]!)
      expect(sent[0]!.error).toContain(handles["machine"]!)
      expect(store.mailbox()).toHaveLength(0)
    } finally {
      peer.stop()
    }
  })

  test("a post to a name in the wrong case still goes out", async () => {
    const { store, handles } = flockOf("Macbook")
    const peer = new FlockPeer.Peer(store, new FlockTransport.LoopbackTransport())
    try {
      const sent = await peer.postMany(["macbook"], "the reported case")
      expect(sent[0]!.contact).toBe(handles["Macbook"]!)
      expect(sent[0]!.thread).toBeTruthy()
    } finally {
      peer.stop()
    }
  })

  test("peer.lookup keeps the ambiguity the forwarding path has to report", () => {
    const { store } = flockOf("mac", "machine")
    const peer = new FlockPeer.Peer(store, new FlockTransport.LoopbackTransport())
    try {
      expect(peer.lookup("m").kind).toBe("many")
      expect(peer.resolve("m")).toBeUndefined()
      expect(peer.resolve("mac")).toBeTruthy()
    } finally {
      peer.stop()
    }
  })
})

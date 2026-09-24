// PUSH, NOT POLL — the mailbox announces itself.
//
// The thing under test is not "does fs.watch work"; it is the requirement:
// A WRITE MADE THROUGH ONE `Store` REACHES A LISTENER THAT HOLDS ANOTHER. That
// is the real shape of the bug — three engines per workspace, the lease holder
// writes `flock.json`, the pane is served by a different process — and it is
// asserted with two independent Store objects over one directory, never by
// checking that a watcher callback fired.
//
// Every detector is exercised on its own as well, because a green run on a
// machine where `fs.watch` happens to work would say nothing about the poll,
// which is the half that carries Windows and every network filesystem.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockStore } from "@/flock/store"
import { FlockWatch } from "@/flock/watch"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-watch-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const watchers: FlockWatch.Watcher[] = []
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop()
})

const keep = (watcher: FlockWatch.Watcher) => {
  watchers.push(watcher)
  return watcher
}

/** Poll an observable instead of sleeping for a guessed duration. */
async function until(label: string, check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

/** Alice with Bob in her contacts, plus the path her store lives at. */
function alice() {
  const directory = tmp()
  const store = FlockStore.Store.open({ directory, name: "alice" })
  const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
  const friend = store.accept(bob.invite().invite)
  return { directory, store, friend, file: FlockStore.file(directory) }
}

describe("one engine's write reaches another engine's listener", () => {
  test("a thread written through one Store is announced to a holder of a second one", async () => {
    const { directory, store, friend, file } = alice()
    // The SECOND object, opened before the write, holding the file as it was.
    const reader = FlockStore.Store.open({ directory })
    expect(reader.mailbox()).toHaveLength(0)

    let seen = 0
    // The real deps, and a poll short enough that the test finishes on a box
    // where `fs.watch` reports nothing at all — which is the point of it.
    keep(FlockWatch.start({ file, onChange: () => seen++, pollMs: 200, debounceMs: 50 }))

    store.openOut({ id: "q1", contact: friend.handle, question: "does this reach the pane?" })
    await until("the change to be announced", () => seen > 0)

    // THE ASSERTION THAT MATTERS: the other object can now see the row. A
    // callback count alone would pass for a watcher that fired on the temp
    // file and left the reader looking at the old content.
    reader.reload()
    expect(reader.mailbox().map((thread) => thread.id)).toEqual(["q1"])
  })

  test("one logical write is one announcement, not one per filesystem event", async () => {
    const { store, friend, file } = alice()
    let seen = 0
    keep(FlockWatch.start({ file, onChange: () => seen++, pollMs: 200, debounceMs: 80 }))

    // `store.write` is a temp file plus a rename plus (on some platforms) a
    // directory touch. The owner made one change and must be told once.
    store.openOut({ id: "q1", contact: friend.handle, question: "?" })
    await until("the first announcement", () => seen > 0)
    await Bun.sleep(400)
    expect(seen).toBe(1)
  })

  test("nothing is announced while the file does not move", async () => {
    const { file } = alice()
    let seen = 0
    keep(FlockWatch.start({ file, onChange: () => seen++, pollMs: 50, debounceMs: 20 }))
    await Bun.sleep(400)
    expect(seen).toBe(0)
  })
})

describe("the two detectors, each on its own", () => {
  /** Deps whose watch and clock the test drives by hand. */
  function scripted() {
    const timers: Array<{ fn: () => void; ms: number }> = []
    let fire: ((filename: string | null) => void) | undefined
    let closed = 0
    let print = "a"
    const deps: FlockWatch.Deps = {
      watchDirectory: (_directory, onEvent) => {
        fire = onEvent
        return { close: () => closed++ }
      },
      fingerprint: () => print,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length - 1
      },
      clearTimer: () => {},
    }
    /**
     * Run the timers armed so far, once — the DEBOUNCE ones by default.
     *
     * The two detectors share one settle, so a helper that fired every armed
     * timer would make each of the tests below pass on the poll no matter what
     * the watch did. `ms` picks which detector is being driven.
     */
    const run = (ms = FlockWatch.DEBOUNCE_MS) => {
      const due = timers.filter((timer) => timer.ms === ms)
      for (const timer of due) timers.splice(timers.indexOf(timer), 1)
      for (const timer of due) timer.fn()
    }
    return {
      deps,
      run,
      timers,
      event: (filename: string | null = "flock.json") => fire?.(filename),
      change: (value: string) => {
        print = value
      },
      closed: () => closed,
    }
  }

  test("a watch event announces after the debounce, and only if the content moved", () => {
    const wire = scripted()
    let seen = 0
    keep(FlockWatch.start({ file: "/tmp/x/flock.json", onChange: () => seen++, deps: wire.deps }))

    // An event with an UNCHANGED fingerprint is a rename of the temp file or a
    // touch of the directory — noise the pane must not be woken for.
    wire.event()
    wire.run()
    expect(seen).toBe(0)

    wire.change("b")
    wire.event()
    wire.run()
    expect(seen).toBe(1)
  })

  test("an event for another file in the directory is ignored", () => {
    const wire = scripted()
    let seen = 0
    keep(FlockWatch.start({ file: "/tmp/x/flock.json", onChange: () => seen++, deps: wire.deps }))
    wire.change("b")
    wire.event("origami.json")
    wire.run()
    expect(seen).toBe(0)
  })

  test("an event that names NO file is treated as ours — some platforms say nothing", () => {
    const wire = scripted()
    let seen = 0
    keep(FlockWatch.start({ file: "/tmp/x/flock.json", onChange: () => seen++, deps: wire.deps }))
    wire.change("b")
    wire.event(null)
    wire.run()
    expect(seen).toBe(1)
  })

  test("the POLL announces on its own, with no watch event at all", () => {
    const wire = scripted()
    let seen = 0
    keep(FlockWatch.start({ file: "/tmp/x/flock.json", onChange: () => seen++, deps: wire.deps, pollMs: 5000 }))
    wire.change("b")
    // No `event()` — this is the filesystem that reports nothing.
    wire.run(5000)
    expect(seen).toBe(1)
  })

  test("a directory that cannot be watched degrades to the poll and says so", () => {
    const wire = scripted()
    const throwing: FlockWatch.Deps = {
      ...wire.deps,
      watchDirectory: () => {
        throw new Error("ENOSPC: watchers exhausted")
      },
    }
    let seen = 0
    const watcher = keep(
      FlockWatch.start({ file: "/tmp/x/flock.json", onChange: () => seen++, deps: throwing }),
    )
    expect(watcher.kind).toBe("poll")
    expect(watcher.reason).toContain("ENOSPC")
    wire.change("b")
    wire.run(FlockWatch.POLL_MS)
    expect(seen).toBe(1)
  })

  test("a DELETE is a change: the pane must stop showing a mailbox that is gone", () => {
    const wire = scripted()
    let seen = 0
    keep(FlockWatch.start({ file: "/tmp/x/flock.json", onChange: () => seen++, deps: wire.deps }))
    wire.change(undefined as unknown as string)
    wire.event()
    wire.run()
    expect(seen).toBe(1)
  })

  test("stop closes the watch and fires nothing afterwards", () => {
    const wire = scripted()
    let seen = 0
    const watcher = FlockWatch.start({ file: "/tmp/x/flock.json", onChange: () => seen++, deps: wire.deps })
    watcher.stop()
    expect(wire.closed()).toBe(1)
    wire.change("b")
    wire.event()
    wire.run()
    wire.run(FlockWatch.POLL_MS)
    expect(seen).toBe(0)
  })
})

describe("the process-local channel the ACP shell listens on", () => {
  test("every sink is called, an unsubscribe is honoured, and a thrower does not stop the next", () => {
    const calls: string[] = []
    const offBad = FlockWatch.onChanged(() => {
      calls.push("bad")
      throw new Error("a sink that throws")
    })
    const offGood = FlockWatch.onChanged(() => calls.push("good"))
    FlockWatch.announce()
    expect(calls).toEqual(["bad", "good"])

    offBad()
    offGood()
    expect(FlockWatch.listenerCount()).toBe(0)
    FlockWatch.announce()
    expect(calls).toEqual(["bad", "good"])
  })
})

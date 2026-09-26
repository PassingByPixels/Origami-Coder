import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { SpawnLock } from "../src/spawn-lock"

// t-x0lim2: the process-wide spawn lock (src/spawn-lock.ts). A Worker holds it
// the way a Worker holds it for a process start; the main thread's start must
// wait for it without stopping the main thread, and must not wait forever for
// a holder that never releases (a Worker stopped inside its hold).

const fixture = path.join(import.meta.dir, "fixture", "spawn-lock-worker.ts")
const workers: Worker[] = []

afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate()
})

const holdOnWorker = async (holdMs: number) => {
  const worker = new Worker(fixture)
  workers.push(worker)
  const held = new Promise<void>((resolve) =>
    worker.addEventListener("message", (event: MessageEvent) => event.data === "held" && resolve()),
  )
  worker.postMessage({ buffer: SpawnLock.share(), holdMs })
  await held
}

/** Runs a start through `when`; resolves with the ms it waited and the main-thread timer ticks meanwhile. */
const startOnMain = async () => {
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  const started = performance.now()
  const waited = await new Promise<number>((resolve) => SpawnLock.when(() => resolve(performance.now() - started)))
  clearInterval(timer)
  return { waited, ticks }
}

describe.skipIf(process.platform !== "win32")("spawn lock", () => {
  test("a main-thread start waits while a Worker holds the lock, and the main thread keeps running", async () => {
    await holdOnWorker(400)
    const { waited, ticks } = await startOnMain()
    expect(waited).toBeGreaterThan(250)
    expect(ticks).toBeGreaterThan(5)
  })

  test("a start that finds the lock free runs at once", async () => {
    let ran = false
    SpawnLock.share()
    SpawnLock.when(() => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test("starts that queued up while a Worker held the lock run one per loop turn, in order", async () => {
    await holdOnWorker(300)
    const START_MS = 60
    let last = performance.now()
    let longest = 0
    const timer = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 1)
    const order: number[] = []
    await Promise.all(
      [0, 1, 2, 3, 4].map(
        (i) =>
          new Promise<void>((resolve) =>
            SpawnLock.when(() => {
              order.push(i)
              // A process start that holds the thread for START_MS.
              const end = performance.now() + START_MS
              while (performance.now() < end) {}
              resolve()
            }),
          ),
      ),
    )
    clearInterval(timer)
    // The gap up to now counts too: the last starts may have run with no tick after them.
    longest = Math.max(longest, performance.now() - last)
    expect(order).toEqual([0, 1, 2, 3, 4])
    // All five in one turn would hold the thread for 5 x START_MS.
    expect(longest).toBeLessThan(3 * START_MS)
  })

  test("a hold that is never released is taken over, so starts do not stop for good", async () => {
    await holdOnWorker(15_000)
    const { waited, ticks } = await startOnMain()
    expect(waited).toBeGreaterThan(4_000)
    expect(waited).toBeLessThan(10_000)
    expect(ticks).toBeGreaterThan(100)
  }, 30_000)
})

test("does nothing where the class does not exist (not Windows)", () => {
  if (process.platform === "win32") return
  expect(SpawnLock.share()).toBeUndefined()
})

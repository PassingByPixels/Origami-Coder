import { describe, expect, test } from "bun:test"
import { _concurrencyInternals } from "../../src/provider/provider"

const { AsyncSemaphore, releaseOnBodyEnd, isSelfHostedURL } = _concurrencyInternals

/** Bounded acquire so a leaked permit shows up as a failed expectation instead
 *  of a hung test run. Uses the semaphore's own acquireWithin — a raced plain
 *  acquire() would leave a dead waiter queued that swallows the next release. */
function acquireWithin(sem: InstanceType<typeof AsyncSemaphore>, ms: number): Promise<boolean> {
  return sem.acquireWithin(ms)
}

/** A streaming Response whose producer enqueues one chunk and then closes —
 *  the well-behaved "provider finished generating" case. */
function finishedResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("data: done\n\n"))
        ctrl.close()
      },
    }),
    { status: 200 },
  )
}

/** A streaming Response whose producer never closes — the hung/abandoned
 *  provider stream. */
function hangingResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })
}

describe("provider concurrency permit lifecycle", () => {
  test("permit releases when the body is read to the end", async () => {
    const sem = new AsyncSemaphore(1)
    await sem.acquire()
    const wrapped = releaseOnBodyEnd(finishedResponse(), () => sem.release())
    // Drain the body like the AI SDK normally does.
    const reader = wrapped.body!.getReader()
    while (!(await reader.read()).done) {
      /* drain */
    }
    expect(await acquireWithin(sem, 1000)).toBe(true)
  })

  test("permit releases when the consumer cancels the body", async () => {
    const sem = new AsyncSemaphore(1)
    await sem.acquire()
    const wrapped = releaseOnBodyEnd(hangingResponse(), () => sem.release())
    await wrapped.body!.cancel("client gave up")
    expect(await acquireWithin(sem, 1000)).toBe(true)
  })

  test("a bodyless response releases immediately", async () => {
    const sem = new AsyncSemaphore(1)
    await sem.acquire()
    releaseOnBodyEnd(new Response(null, { status: 500 }), () => sem.release())
    expect(await acquireWithin(sem, 1000)).toBe(true)
  })

  // SEAMS_PLAN Phase 3: the AI SDK can abandon a response it never reads and
  // never cancels (an error thrown between receiving headers and consuming the
  // stream, or a caller that drops the response object). Before the watchdog
  // that permit was held FOREVER — with max_concurrent permits leaked, every
  // later request to that provider blocked in acquire() with no error, the
  // "second chat stuck composing" shape. The abandonment watchdog reclaims it.
  test("permit releases when the response is abandoned unread (watchdog)", async () => {
    const sem = new AsyncSemaphore(1)
    await sem.acquire()
    releaseOnBodyEnd(hangingResponse(), () => sem.release(), 200)
    // Nobody reads, nobody cancels — the response object is simply dropped.
    expect(await acquireWithin(sem, 3000)).toBe(true)
  })

  test("watchdog leaves a live consumer alone, however slow the stream", async () => {
    const sem = new AsyncSemaphore(1)
    await sem.acquire()
    // The invariant under test — a locked body always bails the watchdog,
    // whenever it happens to check — is time-independent (see releaseOnBodyEnd:
    // `if (body.locked) return`), so a short watchdog delay only makes this
    // test faster, never weaker.
    const wrapped = releaseOnBodyEnd(hangingResponse(), () => sem.release(), 20)
    const reader = wrapped.body!.getReader()
    // acquireWithin blocks on the semaphore's own release event for the full
    // window (not a blind sleep followed by a separate short check) — 25x the
    // watchdog delay, so scheduler jitter under CPU contention can't produce a
    // false "still held" pass by finishing before the watchdog even runs. A
    // locked body means the consumer owns the release, so the permit must
    // still be held for the whole window.
    expect(await acquireWithin(sem, 500)).toBe(false)
    await reader.cancel("done waiting")
    expect(await acquireWithin(sem, 2000)).toBe(true)
  })

  test("watchdog reclaim releases exactly once despite the pending upstream read", async () => {
    // The wrapped stream's eager pull is awaiting the hung upstream when the
    // watchdog fires; the watchdog's reader.cancel() resolves that read, which
    // re-enters the release path — the settle guard must dedupe it.
    let releases = 0
    let notifyRelease: (() => void) | undefined
    const firstRelease = new Promise<void>((resolve) => {
      notifyRelease = resolve
    })
    releaseOnBodyEnd(
      hangingResponse(),
      () => {
        releases++
        notifyRelease?.()
      },
      20,
    )
    // Event-driven: wait for the actual release, not a fixed sleep racing the
    // watchdog. The 3s ceiling is only a deadman fallback so a genuinely broken
    // (never-fires) watchdog fails the test with a clear message instead of
    // silently reading releases===0 under load.
    await Promise.race([
      firstRelease,
      new Promise((_, reject) => setTimeout(() => reject(new Error("watchdog never released")), 3000)),
    ])
    // The re-entrant done-branch (from the watchdog's cancel() unblocking the
    // pending upstream read) settles within microtasks of the first release in
    // correct code. A generous fixed window here only strengthens the
    // "exactly once" check against a broken settle guard — under correct code
    // this can never flake, since nothing else increments `releases` no matter
    // how long we wait.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(releases).toBe(1)
  })
})

describe("bounded acquire", () => {
  test("grants immediately while permits are free", async () => {
    const sem = new AsyncSemaphore(1)
    expect(await sem.acquireWithin(1000)).toBe(true)
  })

  test("returns false when no permit frees in time", async () => {
    const sem = new AsyncSemaphore(1)
    await sem.acquire()
    expect(await sem.acquireWithin(100)).toBe(false)
  })

  test("a timed-out waiter does not swallow the next released permit", async () => {
    const sem = new AsyncSemaphore(1)
    await sem.acquire()
    // A times out and must leave the queue; if its dead resolver stayed,
    // release() would hand it the permit and B would starve.
    expect(await sem.acquireWithin(50)).toBe(false)
    sem.release()
    expect(await sem.acquireWithin(1000)).toBe(true)
  })
})

describe("self-hosted URL detection (default chunkTimeout gate)", () => {
  test.each([
    ["http://localhost:1234/v1", true],
    ["http://127.0.0.1:1234/v1", true],
    ["http://100.65.43.21:8000/v1", true], // Tailscale CGNAT example
    ["http://192.168.1.49:8188", true],
    ["http://10.0.0.5/v1", true],
    ["http://172.20.1.1/v1", true],
    ["http://workstation:8000/v1", true], // bare LAN hostname
    ["http://inference.local/v1", true],
    ["http://gpu-box.tailnet.ts.net/v1", true],
    ["https://api.openai.com/v1", false],
    ["https://api.anthropic.com", false],
    ["http://172.32.0.1/v1", false], // outside RFC1918 172.16-31
    ["http://100.128.0.1/v1", false], // outside CGNAT 100.64-127
    ["not a url", false],
    [undefined, false],
  ])("%p -> %p", (url, expected) => {
    expect(isSelfHostedURL(url)).toBe(expected)
  })
})

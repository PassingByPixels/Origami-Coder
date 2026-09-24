// t-52cxcw. The permit queue's ORDER, on its own: a parent step goes ahead of
// every queued child, parents keep their arrival order among themselves, and a
// child can never overtake anyone.
//
// The end-to-end case lives in test/session/llm-native-concurrency.test.ts. This
// is the splice itself — insert-before-the-first-ordinary-waiter is the kind of
// index arithmetic that reads correct and is off by one.
import { describe, expect, test } from "bun:test"
import { AsyncSemaphore } from "@/provider/concurrency"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("provider permit queue order", () => {
  test("serves a priority waiter before every ordinary one already queued", async () => {
    const sem = new AsyncSemaphore(1)
    const served: string[] = []
    expect(await sem.acquireWithin(1000)).toBe(true)

    void sem.acquireWithin(5000).then(() => served.push("child-1"))
    void sem.acquireWithin(5000).then(() => served.push("child-2"))
    await settle()
    void sem.acquireWithin(5000, true).then(() => served.push("parent"))
    await settle()

    expect(served).toEqual([])
    sem.release()
    await settle()
    expect(served).toEqual(["parent"])

    sem.release()
    await settle()
    sem.release()
    await settle()
    expect(served).toEqual(["parent", "child-1", "child-2"])
  })

  test("keeps priority waiters in their own arrival order", async () => {
    const sem = new AsyncSemaphore(1)
    const served: string[] = []
    expect(await sem.acquireWithin(1000)).toBe(true)

    void sem.acquireWithin(5000, true).then(() => served.push("parent-1"))
    void sem.acquireWithin(5000).then(() => served.push("child"))
    void sem.acquireWithin(5000, true).then(() => served.push("parent-2"))
    await settle()

    for (let i = 0; i < 3; i++) {
      sem.release()
      await settle()
    }
    expect(served).toEqual(["parent-1", "parent-2", "child"])
  })

  test("counts only the waiters a new arrival of that priority would wait for", async () => {
    const sem = new AsyncSemaphore(1)
    expect(await sem.acquireWithin(1000)).toBe(true)
    expect(sem.free).toBe(0)
    expect(sem.waitingAhead()).toBe(0)

    void sem.acquireWithin(5000)
    void sem.acquireWithin(5000)
    void sem.acquireWithin(5000, true)
    await settle()

    // An ordinary arrival waits for all three; a parent only for the one parent.
    expect(sem.waitingAhead()).toBe(3)
    expect(sem.waitingAhead(true)).toBe(1)

    for (let i = 0; i < 4; i++) {
      sem.release()
      await settle()
    }
    expect(sem.free).toBe(1)
  })

  test("a timed-out priority waiter leaves the queue without eating a permit", async () => {
    // The same loss the bounded acquire exists to prevent, on the priority path:
    // a dead resolver left in the queue would swallow the next release.
    const sem = new AsyncSemaphore(1)
    expect(await sem.acquireWithin(1000)).toBe(true)
    expect(await sem.acquireWithin(20, true)).toBe(false)
    expect(sem.waitingAhead()).toBe(0)

    sem.release()
    expect(sem.free).toBe(1)
    expect(await sem.acquireWithin(1000)).toBe(true)
  })
})

// t-fijeld. The notice is a drawer line that is never erased, so a wait that
// TIMES OUT must not end on "provider slot granted".
import { limitFetch, providerSemaphore, resetProviderSemaphores } from "@/provider/concurrency"

describe("limitFetch queue notice", () => {
  test("a timed-out wait reports the wait and never the start", async () => {
    resetProviderSemaphores()
    const sem = providerSemaphore("notice-test", 1)
    await sem.acquire()
    const calls: string[] = []
    const send = limitFetch("notice-test", 1, async () => new Response("never"), {
      acquireTimeoutMs: 20,
      notice: { onWait: (ahead) => calls.push(`wait:${ahead}`), onStart: () => calls.push("start") },
    })
    await expect(send("https://example.invalid")).rejects.toThrow()
    expect(calls).toEqual(["wait:0"])
    sem.release()
    expect(sem.free).toBe(1)
  })

  test("a granted wait reports both, in order", async () => {
    resetProviderSemaphores()
    const sem = providerSemaphore("notice-test-2", 1)
    await sem.acquire()
    const calls: string[] = []
    const send = limitFetch("notice-test-2", 1, async () => new Response(null), {
      notice: { onWait: (ahead) => calls.push(`wait:${ahead}`), onStart: () => calls.push("start") },
    })
    const pending = send("https://example.invalid")
    await settle()
    sem.release()
    await pending
    expect(calls).toEqual(["wait:0", "start"])
  })
})

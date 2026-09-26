// t-w2u2ki: the warm-spare hold. acp.ts holds the peer start; the first session call adopts.
import { afterEach, describe, expect, test } from "bun:test"
import { ElasticSpare } from "../../src/elastic/spare"

afterEach(() => {
  ElasticSpare.resetForTest()
  delete process.env[ElasticSpare.SPARE_VAR]
})

describe("ElasticSpare", () => {
  test("an engine that holds nothing adopts as a no-op", async () => {
    await ElasticSpare.adopt()
    expect(ElasticSpare.state()).toEqual({ spare: false, adopted: false })
    expect(ElasticSpare.pendingName()).toBeUndefined()
  })

  test("two session calls at once run the held work once, and both wait for it", async () => {
    process.env[ElasticSpare.SPARE_VAR] = "1"
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    ElasticSpare.hold({ peerName: "work-1234", onAdopt: async () => { runs++; await gate } })
    expect(ElasticSpare.pendingName()).toBe("work-1234")

    let settled = 0
    const first = ElasticSpare.adopt().then(() => settled++)
    const second = ElasticSpare.adopt().then(() => settled++)
    await Promise.resolve()
    expect(settled).toBe(0) // the session call waits for the peer start
    // Children the adopted engine starts (MCP, shell) must not inherit the flag.
    expect(process.env[ElasticSpare.SPARE_VAR]).toBeUndefined()
    release()
    await Promise.all([first, second])
    expect(runs).toBe(1)
    expect(ElasticSpare.state()).toEqual({ spare: false, adopted: true })
    expect(ElasticSpare.pendingName()).toBeUndefined()
    await ElasticSpare.adopt()
    expect(runs).toBe(1)
  })

  test("a failed adoption step still lets the chat open", async () => {
    ElasticSpare.hold({ onAdopt: async () => { throw new Error("disk gone") } })
    // t-xnvp72: it resolves (with the adoption's report) instead of rejecting.
    const report = await ElasticSpare.adopt()
    expect(report?.limitHit).toBeUndefined()
    report?.lag.stop()
    expect(ElasticSpare.state().adopted).toBe(true)
  })

  // t-xnvp72: the report the adopting call logs as `adoption timings`.
  test("the adoption report carries what the held work measured, and says when the limit ended the wait", async () => {
    ElasticSpare.hold({ onAdopt: async (report) => { report.disposeMs = 12; report.peersMs = 3 } })
    const report = await ElasticSpare.adopt()
    expect(report).toMatchObject({ disposeMs: 12, peersMs: 3, limitHit: false })
    // Every later session call gets the same report, so it is logged once.
    expect(await ElasticSpare.adopt()).toBe(report)
    report?.lag.stop()

    ElasticSpare.resetForTest()
    ElasticSpare.hold({ onAdopt: () => new Promise<void>(() => {}), limitMs: 50 })
    const stuck = await ElasticSpare.adopt()
    expect(stuck?.limitHit).toBe(true)
    stuck?.lag.stop()
  })

  test("an engine that was never a spare has no adoption report", async () => {
    expect(await ElasticSpare.adopt()).toBeUndefined()
  })

  // t-wdybz9 (review finding 9): adoption disposes the pre-adoption instances
  // with no time limit; a finalizer that never ends kept the new chat from
  // ever opening.
  test("a held step that never ends does not keep the chat from opening", async () => {
    ElasticSpare.hold({ onAdopt: () => new Promise<void>(() => {}), limitMs: 50 })
    const started = performance.now()
    await ElasticSpare.adopt()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(ElasticSpare.state().adopted).toBe(true)
  })

  test("the disposal step is bounded on its own, so the steps after it (peer + Flock start) still run", async () => {
    let started = false
    const work = ElasticSpare.bounded(new Promise<void>(() => {}), 50, "dispose").then(() => {
      started = true
    })
    await work
    expect(started).toBe(true)
  })

  // t-y4x518: in the 0.4.179 UAT the pane's first call booted an instance 10 ms before
  // `session/new` adopted; the adoption waited for that boot and disposed it. A call that
  // arrives while an adoption runs now waits for it (acp/agent.ts reads inFlight()).
  test("a call that arrives while an adoption runs can wait for it; before and after there is nothing to wait for", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    ElasticSpare.hold({ onAdopt: () => gate })
    expect(ElasticSpare.inFlight()).toBeUndefined() // a waiting spare: the window's probe runs at once
    const adoption = ElasticSpare.adopt()
    const running = ElasticSpare.inFlight()
    expect(running).toBeDefined()
    let waited = false
    const call = running!.then(() => (waited = true))
    await Promise.resolve()
    expect(waited).toBe(false)
    release()
    await call
    ;(await adoption)?.lag.stop()
    expect(ElasticSpare.inFlight()).toBeUndefined()
  })

  test("an ordinary engine never has an adoption in flight", async () => {
    await ElasticSpare.adopt()
    expect(ElasticSpare.inFlight()).toBeUndefined()
  })

  // t-y4x518: a spare waits at the idle class (IDLE + EcoQoS). The adoption lifts it
  // before any of the chat's work runs, in the same synchronous step as the call that adopts.
  test("adopting lifts the spare before the held work runs, synchronously", async () => {
    const order: string[] = []
    ElasticSpare.hold({ lift: () => order.push("lift"), onAdopt: async () => { order.push("held") } })
    const adoption = ElasticSpare.adopt()
    expect(order).toEqual(["lift"])
    ;(await adoption)?.lag.stop()
    expect(order).toEqual(["lift", "held"])
    await ElasticSpare.adopt()
    expect(order).toEqual(["lift", "held"]) // once
  })

  test("a lift that throws does not stop the adoption", async () => {
    let held = false
    ElasticSpare.hold({ lift: () => { throw new Error("no kernel32") }, onAdopt: async () => { held = true } })
    ;(await ElasticSpare.adopt())?.lag.stop()
    expect(held).toBe(true)
    expect(ElasticSpare.state().adopted).toBe(true)
  })

  test("isSpare reads only the exact value 1", () => {
    expect(ElasticSpare.isSpare({ ORIGAMI_SPARE: "1" })).toBe(true)
    expect(ElasticSpare.isSpare({ ORIGAMI_SPARE: "true" })).toBe(false)
    expect(ElasticSpare.isSpare({})).toBe(false)
  })
})

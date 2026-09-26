// t-w2qlop: the three elastic ext methods, over the real ACP dispatch.
//
// The OS is a FAKE that records what it was asked to do, because the claim
// under test is the ENGINE's decision (which class reaches the OS, when a trim
// is refused, what makes an engine unparkable), not the kernel call. The real
// kernel32 call is exercised in os-windows.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ModelMessage } from "ai"
import { Agent } from "@/acp/agent"
import type * as ACPService from "@/acp/service"
import { ElasticActivity } from "@/elastic/activity"
import { ElasticIdle } from "@/elastic/idle"
import { ElasticOs } from "@/elastic/os"
import { ElasticState } from "@/elastic/state"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockRelayTransport } from "@/flock/relay-transport"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"
import type { Provider } from "@/provider/provider"
import { SessionCacheWarm } from "@/session/cache-warm"
import { enqueueResult, forget } from "@/session/task-result"

/** Records every class and trim the engine sent to the OS. */
function fakeOs(over: Partial<ElasticOs.Os> = {}) {
  const applied: string[] = []
  let trims = 0
  const os: ElasticOs.Os = {
    apply: (cls) => {
      applied.push(cls)
      return { priority: cls === "active" ? "normal" : cls === "background" ? "below-normal" : "idle", ecoqos: cls === "idle" }
    },
    trim: () => {
      trims++
      return { trimmed: true, workingSetBefore: 500, workingSetAfter: 5 }
    },
    ...over,
  }
  return { os, applied, trims: () => trims }
}

const agent = () => new Agent({} as unknown as ACPService.Interface)
const cleanups: Array<() => void> = []

beforeEach(() => {
  ElasticOs.setForTest(fakeOs().os)
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  // Back to `active` while the fake is still installed, so no real OS call runs.
  ElasticState.resetForTest()
  ElasticIdle.resetForTest()
  ElasticOs.setForTest(undefined)
  SessionCacheWarm.reset()
})

/** A live source for the length of one test. */
function hold(source: ElasticActivity.Source, ids: string[]) {
  const live = new Set(ids)
  cleanups.push(ElasticActivity.probe(source, () => live))
  return live
}

describe("_elastic_class", () => {
  test("both spellings reach the handler, apply the class to the OS and answer the contract shape", async () => {
    const fake = fakeOs()
    ElasticOs.setForTest(fake.os)
    expect(await agent().extMethod("_elastic_class", { class: "idle" })).toEqual({
      class: "idle",
      priority: "idle",
      ecoqos: true,
    })
    expect(await agent().extMethod("elastic_class", { class: "background" })).toEqual({
      class: "background",
      priority: "below-normal",
      ecoqos: false,
    })
    expect(fake.applied).toEqual(["idle", "background"])
    expect(ElasticState.requestedClass()).toBe("background")
  })

  test("a class that is not one of the three is refused with invalid params, and nothing changes", async () => {
    const fake = fakeOs()
    ElasticOs.setForTest(fake.os)
    for (const params of [{ class: "low" }, {}, { class: 1 }]) {
      let code: number | undefined
      try {
        await agent().extMethod("_elastic_class", params)
      } catch (error) {
        code = (error as { code?: number }).code
      }
      expect(code).toBe(-32602)
    }
    expect(fake.applied).toEqual([])
    expect(ElasticState.requestedClass()).toBe("active")
  })

  test("idle asked while a turn runs is held at background (BELOW_NORMAL, no EcoQoS) until the turn ends", async () => {
    const fake = fakeOs()
    ElasticOs.setForTest(fake.os)
    const busy = hold("session-busy", ["ses_turn"])
    expect(await agent().extMethod("_elastic_class", { class: "idle" })).toEqual({
      class: "idle",
      priority: "below-normal",
      ecoqos: false,
      deferred: true,
    })
    expect(fake.applied).toEqual(["background"])

    // The turn ends: the status write re-checks the class (session/status.ts).
    busy.clear()
    ElasticState.recheck()
    expect(fake.applied).toEqual(["background", "idle"])

    // A turn that starts in the idle engine lifts it to background, never
    // leaves it at IDLE + EcoQoS, and its end lowers it again.
    busy.add("ses_next")
    ElasticState.recheck()
    busy.clear()
    ElasticState.recheck()
    expect(fake.applied).toEqual(["background", "idle", "background", "idle"])
  })

  test("a busy engine keeps active and background exactly as asked", async () => {
    const fake = fakeOs()
    ElasticOs.setForTest(fake.os)
    hold("session-busy", ["ses_turn"])
    expect(await agent().extMethod("_elastic_class", { class: "background" })).toEqual({
      class: "background",
      priority: "below-normal",
      ecoqos: false,
    })
    expect(await agent().extMethod("_elastic_class", { class: "active" })).toEqual({
      class: "active",
      priority: "normal",
      ecoqos: false,
    })
    expect(fake.applied).toEqual(["background", "active"])
  })

  test("an OS call that fails is reported in the result and never throws", async () => {
    ElasticOs.setForTest(
      fakeOs({ apply: () => ({ priority: "normal", ecoqos: false, error: "SetPriorityClass failed" }) }).os,
    )
    expect(await agent().extMethod("_elastic_class", { class: "idle" })).toMatchObject({
      class: "idle",
      error: "SetPriorityClass failed",
    })
    ElasticOs.setForTest(
      fakeOs({
        apply: () => {
          throw new Error("kernel32 gone")
        },
      }).os,
    )
    expect(await agent().extMethod("_elastic_class", { class: "background" })).toMatchObject({
      class: "background",
      error: "kernel32 gone",
    })
  })
})

// Shapes only: `ttlSeconds` reads providerID / api.npm / api.id / id.
const anthropic = {
  id: "claude-sonnet-5",
  providerID: "anthropic",
  api: { npm: "@ai-sdk/anthropic", id: "claude-sonnet-5" },
} as unknown as Provider.Model
const history: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }]

/** Arm a warm on a clock that never fires: the warm stays pending. */
function armWarm(sessionID = "ses_warm") {
  SessionCacheWarm.setClock({ setTimeout: () => ({ id: sessionID }), clearTimeout: () => {} })
  SessionCacheWarm.armed({ sessionID, model: anthropic, options: {}, messages: history, send: async () => {}, env: {} })
}

describe("_elastic_trim", () => {
  test("a quiet engine is trimmed and the working set figures come back", async () => {
    const fake = fakeOs()
    ElasticOs.setForTest(fake.os)
    expect(await agent().extMethod("_elastic_trim", {})).toEqual({
      trimmed: true,
      workingSetBefore: 500,
      workingSetAfter: 5,
    })
    expect(fake.trims()).toBe(1)
  })

  test("refused for two minutes after a turn ends: the turn's deferred GC would pull the pages back", () => {
    const fake = fakeOs()
    ElasticOs.setForTest(fake.os)
    const busy = hold("session-busy", ["ses_turn"])
    ElasticState.recheck()
    busy.clear()
    const ended = Date.now()
    ElasticState.recheck()
    expect(ElasticIdle.trim(ended + 1_000)).toEqual({ trimmed: false, reason: "turn-ended-recently" })
    expect(ElasticIdle.trim(ended + ElasticIdle.TURN_GUARD_MS - 1_000).reason).toBe("turn-ended-recently")
    expect(ElasticIdle.trim(ended + ElasticIdle.TURN_GUARD_MS + 1_000).trimmed).toBe(true)
    expect(fake.trims()).toBe(1)
  })

  test("refused while a turn runs, while a sub-agent runs, and when a cache warm is due within 30 s", () => {
    const fake = fakeOs()
    ElasticOs.setForTest(fake.os)

    const turn = hold("session-busy", ["ses_turn"])
    expect(ElasticIdle.trim()).toEqual({ trimmed: false, reason: "turn-running" })
    turn.clear()

    // A sub-agent's session is busy too; it is reported as the sub-agent.
    hold("session-busy", ["ses_child"])
    const child = hold("subagent-running", ["ses_child"])
    expect(ElasticIdle.trim()).toEqual({ trimmed: false, reason: "subagent-running" })
    child.clear()
    turn.clear()
    cleanups.splice(0).forEach((off) => off())

    armWarm()
    const due = SessionCacheWarm.nextDueAt()!
    expect(ElasticIdle.trim(due - ElasticIdle.WARM_GUARD_MS - 1_000).trimmed).toBe(true)
    expect(ElasticIdle.trim(due - 10_000)).toEqual({ trimmed: false, reason: "warm-due" })
    expect(fake.trims()).toBe(1)
  })

  test("a trim that throws in the OS layer is a refusal, not a crash", async () => {
    ElasticOs.setForTest(
      fakeOs({
        trim: () => {
          throw new Error("psapi gone")
        },
      }).os,
    )
    expect(await agent().extMethod("_elastic_trim", {})).toEqual({ trimmed: false, reason: "psapi gone" })
  })
})

describe("_elastic_idle_report", () => {
  test("a quiet engine is parkable, with no reasons", async () => {
    expect(await agent().extMethod("_elastic_idle_report", {})).toEqual({ parkable: true, reasons: [] })
  })

  test("every probe-fed reason makes it unparkable, in the fixed order, and a sub-agent is not also a turn", () => {
    hold("session-busy", ["ses_turn", "ses_child"])
    hold("subagent-running", ["ses_child"])
    hold("background-job", ["shell-1"])
    hold("permission-pending", ["per_1"])
    hold("question-pending", ["que_1"])
    hold("collab-run", ["col_1"])
    hold("nest-lease", ["123:abc"])
    expect(ElasticIdle.report()).toEqual({
      parkable: false,
      reasons: [
        "turn-running",
        "subagent-running",
        "background-job",
        "permission-pending",
        "question-pending",
        "nest-lease",
        "collab-run",
      ],
    })
  })

  test("a busy session that IS the running sub-agent reports only the sub-agent", () => {
    hold("session-busy", ["ses_child"])
    hold("subagent-running", ["ses_child"])
    expect(ElasticIdle.report().reasons).toEqual(["subagent-running"])
  })

  test("a probe that cannot be read counts against parking", () => {
    cleanups.push(
      ElasticActivity.probe("question-pending", () => {
        throw new Error("disposed map")
      }),
    )
    expect(ElasticIdle.report()).toEqual({ parkable: false, reasons: ["question-pending"] })
  })

  test("a finished sub-agent result still waiting for its parent", () => {
    enqueueResult("ses_parent", { text: "done", entry: { sessionId: "ses_child", state: "completed" } })
    cleanups.push(() => forget("ses_parent"))
    expect(ElasticIdle.report()).toEqual({ parkable: false, reasons: ["task-result-pending"] })
  })

  test("a pending cache warm, with when the last request went out and when the warm is due", () => {
    const before = Date.now()
    armWarm()
    const report = ElasticIdle.report()
    expect(report.parkable).toBe(false)
    expect(report.reasons).toEqual(["warm-pending"])
    expect(report.lastRequestAt).toBeGreaterThanOrEqual(before)
    // Anthropic default TTL 300 s, warmed at 0.8 of it.
    expect(report.warmDueAt! - report.lastRequestAt!).toBeGreaterThanOrEqual(240_000 - 5)
    expect(report.warmDueAt! - report.lastRequestAt!).toBeLessThanOrEqual(240_000 + 50)
  })

  test("the engine that holds the flock lease is never parkable", () => {
    const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    const flockDir = tmp("elastic-flock-")
    const leaseDir = tmp("elastic-lease-")
    cleanups.push(() => {
      fs.rmSync(flockDir, { recursive: true, force: true })
      fs.rmSync(leaseDir, { recursive: true, force: true })
    })
    const mine = FlockStore.Store.open({ directory: flockDir, name: "alice" })
    mine.accept(FlockStore.Store.open({ directory: tmp("elastic-bob-"), name: "bob" }).invite().invite)
    const deps: FlockRelayTransport.RelayDeps = {
      connect: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
      setTimer: () => 0,
      clearTimer: () => {},
    }
    const handle = FlockService.start({
      store: FlockStore.Store.open({ directory: flockDir }),
      config: { model: "test/fake" },
      relayUrl: "ws://relay.test",
      runner: async () => ({ text: "", tokens: 0 }),
      deps,
      owner: new FlockOwnerLease.Owner({ directory: leaseDir, pid: 101, alive: () => true }),
      leaseDirectory: leaseDir,
      log: () => {},
    })
    cleanups.push(() => handle.stop())
    expect(handle.kind).toBe("relay")
    expect(ElasticIdle.report()).toEqual({ parkable: false, reasons: ["flock-lease"] })
    handle.stop()
    expect(ElasticIdle.report()).toEqual({ parkable: true, reasons: [] })
  })
})

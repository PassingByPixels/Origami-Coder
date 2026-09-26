// t-z6ytkw: a cache warm across a park sends the bytes the live engine's warm sends.
//
// Two runs of one script over the restart harness (test/lib/restart-harness.ts), each
// on its own SQLite database and fake provider (no real provider is called):
//
//   live    one process: a turn (a tool step and a text step), then the armed warm
//           fires on a fake clock and goes out.
//   parked  the same turn; at its end the park hands the armed warm over
//           (`ElasticParkWarm.persist`, as `_elastic_park` does), the process stops
//           (runtime closed, every process store emptied); a NEW process takes the
//           handed-over warm and sends it (`take` + `send`, as `_elastic_warm` does).
//
// The warm request body of `parked` must equal the one of `live`, byte for byte (the
// harness normalises only the temporary directory and the date). Nothing is recorded.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { ElasticParkWarm } from "@/elastic/park-warm"
import { SessionCacheWarm } from "@/session/cache-warm"
import { Session } from "@/session/session"
import { reply } from "../lib/llm-server"
import { providerCfg, runProcesses, say, usage, type Ctx, type Segment } from "../lib/restart-harness"

delete process.env.SHELL

const TIMEOUT = 240_000
const ROOTS: string[] = []
afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true })
})

/** A model the engine caches inline (its id names Claude), so a real request arms a warm. */
const CLAUDE = { providerID: "test", modelID: "claude-warm" } as never

function config(url: string) {
  const cfg = providerCfg(url) as { provider: { test: { models: Record<string, Record<string, unknown>> } } }
  const base = cfg.provider.test.models["test-model"]!
  cfg.provider.test.models["claude-warm"] = { ...base, id: "claude-warm", name: "Claude Warm" }
  return cfg
}

/** A fake clock: `fire` runs the armed warms that were not cancelled. */
function fakeClock() {
  const due = new Map<number, () => void>()
  let next = 0
  SessionCacheWarm.setClock({
    setTimeout: (fn) => {
      const id = ++next
      due.set(id, fn)
      return { id }
    },
    clearTimeout: (handle) => void due.delete(handle.id as number),
  })
  return () => {
    const fns = [...due.values()]
    due.clear()
    for (const fn of fns) fn()
    return fns.length
  }
}

const bodyCount = (ctx: Ctx) =>
  Effect.map(ctx.llm.hits, (hits) => hits.filter((h) => !JSON.stringify(h.body).includes("Generate a title")).length)

const untilMore = (ctx: Ctx, than: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 250; i++) {
      if ((yield* bodyCount(ctx)) > than) return
      yield* Effect.sleep("20 millis")
    }
    throw new Error("the warm never reached the provider")
  })

function turn(ctx: Ctx) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(path.join(ctx.dir, "AGENTS.md"), "PROJECT RULE: answer briefly.")
    yield* fs.writeWithDirs(path.join(ctx.dir, "origami.json"), JSON.stringify(config(ctx.llm.url)))
    yield* fs.writeWithDirs(path.join(ctx.dir, "live1.ts"), "export const live1 = 1\n")
    const chat = yield* (yield* Session.Service).create({
      title: "Warm",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    ctx.ids.set("chat", chat.id)
    yield* ctx.llm.push(reply().tool("read", { filePath: path.join(ctx.dir, "live1.ts") }).usage(usage(1000)))
    yield* ctx.llm.text("Turn one done.", { usage: usage(1000) })
    yield* say(chat.id, "Read live1.ts and report.", CLAUDE)
  })
}

function liveScript(): Segment[] {
  let fire: () => number = () => 0
  return [
    (ctx) => Effect.gen(function* () {
      fire = fakeClock()
      yield* turn(ctx)
      expect(SessionCacheWarm.pending(ctx.ids.get("chat")!)).toBe(true)
    }),
    (ctx) => Effect.gen(function* () {
      const before = yield* bodyCount(ctx)
      yield* ctx.llm.text(".", { usage: usage(1000) })
      expect(fire()).toBe(1)
      yield* untilMore(ctx, before)
    }),
  ]
}

function parkedScript(root: string, handed: ElasticParkWarm.Handed[]): Segment[] {
  return [
    (ctx) => Effect.gen(function* () {
      fakeClock()
      yield* turn(ctx)
      handed.push(...(yield* Effect.promise(() => ElasticParkWarm.persist(root))))
    }),
    (ctx) => Effect.gen(function* () {
      const id = ctx.ids.get("chat")!
      expect(SessionCacheWarm.pending(id), "the new process has no warm of its own").toBe(false)
      yield* ctx.llm.text(".", { usage: usage(1000) })
      const taken = ElasticParkWarm.take(id, root)
      if (!("recipe" in taken)) throw new Error(taken.refused)
      const answer = yield* ElasticParkWarm.send(taken.recipe)
      expect(answer.warmed).toBe(true)
      expect(ElasticParkWarm.take(id, root), "a handed-over warm is used once").toEqual({ refused: "no warm was handed over" })
    }),
  ]
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

describe("t-z6ytkw: the warm after a park == the live engine's warm", () => {
  for (const [label, flags] of [
    ["native", {}],
    ["aisdk", { nativeLlmFamilies: "none" }],
  ] as const) {
    test(
      label + " runtime",
      async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "origami-park-warm-"))
        ROOTS.push(root)
        const live = await runProcesses({ flags, segments: liveScript(), restartAfter: () => false })
        const handed: ElasticParkWarm.Handed[] = []
        const parked = await runProcesses({ flags, segments: parkedScript(root, handed), restartAfter: (i) => i === 0 })
        expect(parked.processes).toBe(2)
        expect(handed.length).toBe(1)
        expect(handed[0]!.dueAt).toBeGreaterThan(Date.now() - 60_000)
        expect(readdirSync(path.join(root, ElasticParkWarm.DIR))).toEqual([])
        // Two turn steps and one warm in each run; the turns match, and so does the warm.
        expect(live.bodies.length).toBe(3)
        expect(parked.bodies.length).toBe(3)
        expect(parked.bodies.slice(0, 2)).toEqual(live.bodies.slice(0, 2))
        const warm = live.bodies[2]!
        expect(warm).not.toBe(live.bodies[1])
        expect(JSON.parse(warm).messages.at(-1)).toMatchObject({ role: "user" })
        expect(sha(parked.bodies[2]!)).toBe(sha(warm))
      },
      TIMEOUT,
    )
  }
})

// Session request memory (t-w2qb1x): every store that feeds the request bytes
// is written to SQLite and read back after a restart, and its rows go with the
// session. The restart is the harness one (test/lib/restart-harness.ts): a new
// runtime over the same database, every process store emptied.

import { Database } from "@origami/core/database/database"
import { expect, spyOn, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { EngineProcessMemory } from "@/engine-process-memory"
import { Session } from "@/session/session"
import { SessionDegrade } from "@/session/degrade"
import { SessionImageCap } from "@/session/image-cap"
import { SessionRequestMemory } from "@/session/request-memory"
import { SessionRequestMemoryRows } from "@/session/request-memory-rows"
import { SessionToolAging } from "@/session/tool-aging"
import { SessionWindowFit } from "@/session/window-fit"
import { ToolSearch } from "@/tool/tool-search"
import { pollWithTimeout } from "../lib/effect"
import { runProcesses, say, setup, stepsScript, usage, type Ctx, type Segment } from "../lib/restart-harness"

delete process.env.SHELL

const TIMEOUT = 120_000
const EFFORT = SessionDegrade.KNOBS.find((knob) => knob.label === "reasoning effort")!

const rowsOf = (sessionID: string) =>
  Database.Service.use(({ db }) => SessionRequestMemoryRows.load(db, sessionID)).pipe(Effect.orDie)

test(
  "refused knobs, image cap, window-fit ratio and tool_search loads survive a restart",
  async () => {
    const seen: Record<string, unknown> = {}
    const chat = (ctx: Ctx) => ctx.ids.get("chat")!
    await runProcesses({
      segments: [
        (ctx) =>
          Effect.gen(function* () {
            yield* setup(ctx, "chat")
            const id = chat(ctx)
            SessionDegrade.record(id, EFFORT)
            SessionImageCap.record(id, 4)
            SessionImageCap.record(id, 2)
            SessionWindowFit.sent(id, 1000)
            SessionWindowFit.observe(id, 1500)
            yield* ToolSearch.Service.use((search) => search.load(id, ["weather_current"]))
            yield* Database.Service.use(({ db }) => SessionRequestMemory.flush(db, id))
          }),
        (ctx) =>
          Effect.gen(function* () {
            const id = chat(ctx)
            // The restart emptied every store.
            seen.before = {
              degrade: SessionDegrade.has(id),
              cap: SessionImageCap.limit(id),
              calibrated: SessionWindowFit.calibrate(id, 1000),
            }
            yield* Database.Service.use(({ db }) => SessionRequestMemory.ensure(db, id))
            seen.after = {
              stripped: SessionDegrade.strip(id, { reasoningEffort: "high", temperature: 1 }),
              cap: SessionImageCap.limit(id),
              calibrated: SessionWindowFit.calibrate(id, 1000),
              loaded: [...(yield* ToolSearch.Service.use((search) => search.loaded(id)))],
            }
          }),
      ],
      restartAfter: () => true,
    })
    expect(seen.before).toEqual({ degrade: false, cap: undefined, calibrated: 1000 })
    expect(seen.after).toEqual({
      stripped: { temperature: 1 },
      cap: 2,
      calibrated: 1500,
      loaded: ["weather_current"],
    })
  },
  TIMEOUT,
)

test(
  "a queued decision is on disk when the request that carries it reaches the provider",
  async () => {
    const seen: Record<string, unknown> = {}
    await runProcesses({
      segments: [
        (ctx) =>
          Effect.gen(function* () {
            yield* setup(ctx, "chat")
            const id = ctx.ids.get("chat")!
            SessionDegrade.record(id, EFFORT)
            seen.queued = (yield* rowsOf(id)).length
            const gate = yield* Deferred.make<void>()
            yield* ctx.llm.hold("held", Effect.runPromise(Deferred.await(gate)))
            const turn = yield* say(id, "Hello.").pipe(Effect.forkChild)
            // The provider holds the reply, so the turn's request is on the
            // wire and nothing after it has run.
            yield* pollWithTimeout(
              ctx.llm.hits.pipe(
                Effect.map((hits) =>
                  hits.some((hit) => !JSON.stringify(hit.body).includes("Generate a title")) ? true : undefined,
                ),
              ),
              "the turn's request never arrived",
            )
            seen.onWire = yield* rowsOf(id)
            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(turn)
          }),
      ],
      restartAfter: () => false,
    })
    expect(seen.queued).toBe(0)
    expect(seen.onWire).toEqual([{ kind: "degrade", key: "reasoning effort", data: true }])
  },
  TIMEOUT,
)

test(
  "a session's rows are deleted with the session",
  async () => {
    const seen: Record<string, unknown> = {}
    await runProcesses({
      segments: [
        (ctx) =>
          Effect.gen(function* () {
            yield* setup(ctx, "chat")
            const id = ctx.ids.get("chat")!
            const other = (yield* Session.Service.use((sessions) => sessions.create({ title: "Other" }))).id
            for (const sessionID of [id, other])
              yield* Database.Service.use(({ db }) =>
                SessionRequestMemoryRows.write(db, sessionID, [
                  { kind: "aging.rewrite", key: "prt_1", data: { output: "[aged]" } },
                  { kind: "window_fit", key: "", data: 1.25 },
                ]),
              ).pipe(Effect.orDie)
            seen.written = (yield* rowsOf(id)).length
            yield* Session.Service.use((sessions) => sessions.remove(id))
            seen.removed = (yield* rowsOf(id)).length
            seen.other = (yield* rowsOf(other)).length
          }),
      ],
      restartAfter: () => false,
    })
    expect(seen).toEqual({ written: 2, removed: 0, other: 2 })
  },
  TIMEOUT,
)

// ---------------------------------------------------------------------------
// t-wdyp7r (review of the request bytes). No test below writes the queue by
// hand: what the engine leaves unwritten at a turn end is what a park, a crash
// or a close loses.
// ---------------------------------------------------------------------------

/** Two turns on one chat. Reply 1 reports 1 prompt token (ratio 1), reply 2 a
 *  huge prompt (ratio 2, the cap): the LAST reply of the run moves the ratio. */
const ratioTurns: Segment = (ctx) =>
  Effect.gen(function* () {
    yield* setup(ctx, "chat")
    const id = ctx.ids.get("chat")!
    yield* ctx.llm.text("one", { usage: usage(1) })
    yield* say(id, "first")
    yield* ctx.llm.text("two", { usage: usage(200_000) })
    yield* say(id, "second")
  })

type Stop = "none" | "restart" | "close"
const stops: readonly Stop[] = ["none", "restart", "close"]

/** Run `after` once with no stop, once after a restart, once after a close in
 *  the same process (the chat's memory freed, as `session/close` frees it). */
async function acrossStops(after: (stop: Stop) => Segment) {
  for (const stop of stops)
    await runProcesses({
      segments: [
        ratioTurns,
        (ctx) =>
          Effect.gen(function* () {
            if (stop === "close") EngineProcessMemory.evictSession(ctx.ids.get("chat")!)
            yield* after(stop)(ctx)
          }),
      ],
      restartAfter: (index) => stop === "restart" && index === 0,
    })
}

test(
  "the window-fit ratio from a turn's last reply is on disk at the turn end and survives a restart and a close",
  async () => {
    const seen: Record<string, unknown> = {}
    await acrossStops((stop) => (ctx) =>
      Effect.gen(function* () {
        const id = ctx.ids.get("chat")!
        seen[stop + ".disk"] = (yield* Database.Service.use(({ db }) =>
          SessionRequestMemoryRows.load(db, id, "window_fit"),
        )).map((row) => row.data)
        yield* Database.Service.use(({ db }) => SessionRequestMemory.ensure(db, id))
        seen[stop + ".calibrate"] = SessionWindowFit.calibrate(id, 1000)
      }),
    )
    expect(seen).toEqual({
      "none.disk": [2],
      "none.calibrate": 2000,
      "restart.disk": [2],
      "restart.calibrate": 2000,
      "close.disk": [2],
      "close.calibrate": 2000,
    })
  },
  TIMEOUT,
)

test(
  "near a full window, the next turn puts the same requests on the wire with no stop, after a restart and after a close",
  async () => {
    const wire: Record<string, string[]> = {}
    await acrossStops((stop) => (ctx) =>
      Effect.gen(function* () {
        const id = ctx.ids.get("chat")!
        const before = (yield* ctx.llm.hits).length
        for (let index = 0; index < 4; index++) yield* ctx.llm.text("three " + index, { usage: usage(1) })
        // About 500k estimated tokens in a 1M window: with the ratio 2 it does not fit.
        yield* say(id, "y".repeat(2_000_000)).pipe(Effect.timeout("60 seconds"), Effect.exit)
        wire[stop] = (yield* ctx.llm.hits).slice(before).map((hit) => {
          const body = hit.body as { messages?: unknown[]; max_tokens?: number; max_completion_tokens?: number }
          const last = JSON.stringify(body.messages?.at(-1) ?? "")
          return `max_tokens=${body.max_tokens ?? body.max_completion_tokens} lastChars=${last.length}`
        })
      }),
    )
    expect(wire.restart).toEqual(wire.none)
    expect(wire.close).toEqual(wire.none)
  },
  TIMEOUT * 2,
)

const agingRows = (id: string) =>
  Database.Service.use(({ db }) => SessionRequestMemoryRows.load(db, id)).pipe(
    Effect.orDie,
    Effect.map((rows) => rows.filter((row) => row.kind.startsWith("aging."))),
  )

test(
  "a failed read at restore takes no aging decision: nothing from scratch is stored, and the next call reads again",
  async () => {
    const seen: Record<string, unknown> = {}
    const script = stepsScript()
    await runProcesses({
      segments: [
        script[0]!,
        script[1]!,
        (ctx) =>
          Effect.gen(function* () {
            const id = ctx.ids.get("chat")!
            const stored = yield* agingRows(id)
            seen.stored = stored.length
            const original = SessionRequestMemoryRows.load
            const failing = spyOn(SessionRequestMemoryRows, "load").mockImplementation(((db, sessionID, kind) =>
              kind === undefined
                ? Effect.fail(new Error("read failed"))
                : original(db, sessionID, kind)) as typeof original)
            try {
              yield* ctx.llm.text("Turn three done.", { usage: usage(1000) })
              yield* say(id, "Resume three.")
            } finally {
              failing.mockRestore()
            }
            seen.held = SessionToolAging.has(id)
            seen.unchanged = JSON.stringify(yield* agingRows(id)) === JSON.stringify(stored)
          }),
      ],
      restartAfter: (index) => index === 1,
    })
    expect(seen).toEqual({ stored: 40, held: false, unchanged: true })
  },
  TIMEOUT,
)

test(
  "aging rows of parts that no longer exist are pruned when the rows are read back; the others stay",
  async () => {
    const seen: Record<string, unknown> = {}
    const script = stepsScript()
    await runProcesses({
      segments: [
        script[0]!,
        script[1]!,
        (ctx) =>
          Effect.gen(function* () {
            const id = ctx.ids.get("chat")!
            seen.before = (yield* agingRows(id)).length
            // A part a revert deleted: its decision can never be sent again.
            yield* Database.Service.use(({ db }) =>
              SessionRequestMemoryRows.write(db, id, [
                { kind: "aging.rewrite", key: "prt_gone", data: { output: "[aged]" } },
                { kind: "aging.reprieve", key: "prt_gone", data: true },
              ]),
            ).pipe(Effect.orDie)
          }),
        (ctx) =>
          Effect.gen(function* () {
            const id = ctx.ids.get("chat")!
            yield* Database.Service.use(({ db }) => SessionRequestMemory.ensure(db, id))
            const after = yield* agingRows(id)
            seen.after = after.length
            seen.gone = after.some((row) => row.key === "prt_gone")
          }),
      ],
      restartAfter: (index) => index === 2,
    })
    expect(seen).toEqual({ before: 40, after: 40, gone: false })
  },
  TIMEOUT,
)

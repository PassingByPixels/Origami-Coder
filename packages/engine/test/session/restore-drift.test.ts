// A cache miss on the first request after an engine restart is named for what
// caused it (t-w2txb2, elastic engine E5: park and restore).
//
// A new engine process holds no previous request of a session, so without a
// seed every first request after a restart reads `cold`. That hides the one
// question a restore raises: did the prefix change while the engine was
// stopped? The engine seeds the comparison from the last PERSISTED step-finish
// prefix of the session, so:
//
// D1  a restore with nothing changed reads as a continuation: the same cause as
//     the same script without a restart, never `cold` and never `stopped`.
// D2  a restore after the system prompt changed reads `stopped`, and names the
//     system half.
// D3  a session that never sent a request before the restart stays `cold`.
// D4  a compaction or a model switch before a restart is still the cause of
//     the first miss after it.
// D5  a restore after the tool set changed reads `stopped`, naming the tools.
//
// t-wdyp7r (review of the request bytes, F2 and F3): the label must be honest.
// D6  a restore on the next calendar day with nothing edited reads as the run
//     without a stop reads (the date line moves in both).
// D7  an agent switch made with the message that wakes the chat reads as the
//     same switch without a stop, not as an edit made while stopped.
// D8  a fork's first request reads `cold`, as before: the fork copied the
//     parent's step-finish parts, but it never sent a request.
// D9  a chat continued on another desk reads `cold`: the step-finish parts
//     came over in the journal, the request memory did not (it never travels).

import { describe, expect, setSystemTime, test } from "bun:test"
import { Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import path from "path"
import { Database } from "@origami/core/database/database"
import { SessionV1 } from "@origami/core/v1/session"
import { FSUtil } from "@origami/core/fs-util"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRequestMemoryRows } from "@/session/request-memory-rows"
import type { SessionID } from "@/session/schema"
import {
  A,
  providerCfg,
  runProcesses,
  say,
  setup,
  stepsScript,
  usage,
  type Ctx,
  type Segment,
} from "../lib/restart-harness"

delete process.env.SHELL

const TIMEOUT = 120_000

type Cache = SessionV1.StepFinishPart["cache"]

/** The `cache` block of every persisted step-finish part of `sessionID`, in order. */
const caches = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messages = yield* sessions.messages({ sessionID })
    return messages.flatMap((message) =>
      message.parts
        .filter((part): part is SessionV1.StepFinishPart => part.type === "step-finish")
        .map((part) => part.cache),
    )
  })

/** Two one-request turns on one chat. `edit` runs before the second turn. */
function twoTurns(
  out: { caches: Cache[]; logs?: string[] },
  edit?: (ctx: Ctx) => Effect.Effect<void, unknown, any>,
): Segment[] {
  const chat = (ctx: Ctx) => ctx.ids.get("chat")!
  return [
    (ctx) =>
      Effect.gen(function* () {
        yield* setup(ctx, "chat")
        yield* ctx.llm.text("Turn one done.", { usage: usage(1000) })
        yield* say(chat(ctx), "Turn one.")
      }),
    (ctx) =>
      Effect.gen(function* () {
        if (edit) yield* edit(ctx)
        yield* ctx.llm.text("Turn two done.", { usage: usage(1000) })
        yield* say(chat(ctx), "Turn two.")
        out.caches = yield* caches(chat(ctx))
        out.logs = (yield* TestConsole.logLines).map((line) => JSON.stringify(line))
      }),
  ]
}

describe("the first request after a restart", () => {
  test(
    "D1: an unchanged restore reads as a continuation, never cold or stopped",
    async () => {
      const reference = { caches: [] as Cache[] }
      const restored: { caches: Cache[]; logs?: string[] } = { caches: [] }
      await runProcesses({ segments: twoTurns(reference), restartAfter: () => false })
      const run = await runProcesses({ segments: twoTurns(restored), restartAfter: (index) => index === 0 })
      expect(run.processes).toBe(2)
      expect(restored.caches.length).toBe(2)
      expect(restored.caches[0]?.cause).toBe("cold")
      const after = restored.caches[1]!
      expect(after).toBeDefined()
      expect(after.cause).not.toBe("cold")
      expect(after.cause).not.toBe("stopped")
      // A continuation: the same verdict the engine gives without a restart.
      expect({ cause: after.cause, preserved: after.preserved }).toEqual({
        cause: reference.caches[1]?.cause,
        preserved: reference.caches[1]?.preserved,
      })
      expect(after.stopped).toBeUndefined()
      expect(restored.logs!.some((line) => line.includes("restore-drift"))).toBe(false)
    },
    TIMEOUT,
  )

  test(
    "D2: a system prompt changed while the engine was stopped reads `stopped`, naming the system half",
    async () => {
      const restored: { caches: Cache[]; logs?: string[] } = { caches: [] }
      const run = await runProcesses({
        segments: twoTurns(restored, (ctx) =>
          FSUtil.Service.use((fs) =>
            fs.writeWithDirs(path.join(ctx.dir, "AGENTS.md"), "PROJECT RULE: answer at length."),
          ),
        ),
        restartAfter: (index) => index === 0,
      })
      // The edit really reached the second request's system prompt.
      expect(run.bodies[0]).toContain("answer briefly")
      expect(run.bodies[1]).toContain("answer at length")
      const after = restored.caches[1]!
      // The array opens with the system text on this provider, so the history
      // digest moved with it; that move is the system's, not a second half.
      expect({ cause: after.cause, stopped: after.stopped }).toEqual({ cause: "stopped", stopped: ["system"] })
      // And the engine log says so, once.
      expect(restored.logs!.filter((line) => line.includes("restore-drift")).length).toBe(1)
    },
    TIMEOUT,
  )

  test(
    "D5: a tool set changed while the engine was stopped reads `stopped`, naming the tools half",
    async () => {
      const restored = { caches: [] as Cache[] }
      const run = await runProcesses({
        segments: twoTurns(restored, (ctx) =>
          FSUtil.Service.use((fs) =>
            fs.writeWithDirs(
              path.join(ctx.dir, "origami.json"),
              JSON.stringify({ ...providerCfg(ctx.llm.url), tools: { side_quest: false } }),
            ),
          ),
        ),
        restartAfter: (index) => index === 0,
      })
      // The edit really took the tool out of the second request.
      expect(run.bodies[0]).toContain('"name":"side_quest"')
      expect(run.bodies[1]).not.toContain('"name":"side_quest"')
      const after = restored.caches[1]!
      expect({ cause: after.cause, stopped: after.stopped }).toEqual({ cause: "stopped", stopped: ["tools"] })
    },
    TIMEOUT,
  )

  test(
    "D4: a compaction or a model switch before a restart is still the cause after it",
    async () => {
      // The compaction mark is process memory; the restore re-derives it from
      // the stored compaction part. A restart falls on every turn boundary.
      const withReader = (out: { caches: Cache[] }): Segment[] => [
        ...stepsScript(),
        (ctx) =>
          Effect.gen(function* () {
            out.caches = yield* caches(ctx.ids.get("chat")!)
          }),
      ]
      const reference = { caches: [] as Cache[] }
      const restored = { caches: [] as Cache[] }
      await runProcesses({ segments: withReader(reference), restartAfter: () => false })
      const run = await runProcesses({ segments: withReader(restored), restartAfter: () => true })
      expect(run.processes).toBe(6)
      const causes = (out: { caches: Cache[] }) => out.caches.map((cache) => cache?.cause)
      const compaction = causes(reference).indexOf("compaction")
      const model = causes(reference).indexOf("model")
      expect(compaction).toBeGreaterThan(0)
      expect(model).toBeGreaterThan(compaction)
      expect(causes(restored).length).toBe(causes(reference).length)
      expect([causes(restored)[compaction], causes(restored)[model]]).toEqual(["compaction", "model"])
      // Only the session's first request is cold, with or without restarts.
      expect(causes(restored).lastIndexOf("cold")).toBe(0)
    },
    TIMEOUT,
  )

  test(
    "D3: a session that sent nothing before the restart stays cold",
    async () => {
      const out = { caches: [] as Cache[] }
      await runProcesses({
        segments: [
          (ctx) =>
            Effect.gen(function* () {
              yield* setup(ctx, "chat")
              yield* ctx.llm.text("Turn one done.", { usage: usage(1000) })
              yield* say(ctx.ids.get("chat")!, "Turn one.")
            }),
          (ctx) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const fresh = yield* sessions.create({
                title: "Fresh",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              yield* ctx.llm.text("Fresh done.", { usage: usage(1000) })
              yield* say(fresh.id, "Hello.")
              out.caches = yield* caches(fresh.id)
            }),
        ],
        restartAfter: (index) => index === 0,
      })
      expect(out.caches.length).toBe(1)
      expect(out.caches[0]?.cause).toBe("cold")
      expect(out.caches[0]?.stopped).toBeUndefined()
    },
    TIMEOUT,
  )
})

describe("t-wdyp7r: the label names what really changed", () => {
  const verdict = (cache: Cache) => ({ cause: cache?.cause, stopped: cache?.stopped })

  test(
    "D6: a restore on the next calendar day with nothing edited reads as the same days without a stop",
    async () => {
      const day1 = new Date("2026-09-24T22:00:00")
      const day2 = new Date("2026-09-25T09:00:00")
      const reference = { caches: [] as Cache[] }
      const restored = { caches: [] as Cache[] }
      try {
        setSystemTime(day1)
        await runProcesses({
          segments: twoTurns(reference),
          restartAfter: () => false,
          between: (index) => index === 0 && setSystemTime(day2),
        })
        setSystemTime(day1)
        await runProcesses({
          segments: twoTurns(restored),
          restartAfter: (index) => index === 0,
          between: (index) => index === 0 && setSystemTime(day2),
        })
      } finally {
        setSystemTime()
      }
      // Without a stop the date line moves the system prompt: `system`.
      expect(verdict(reference.caches[1])).toEqual({ cause: "system", stopped: undefined })
      expect(verdict(restored.caches[1])).toEqual(verdict(reference.caches[1]))
    },
    TIMEOUT,
  )

  test(
    "D7: an agent switch made with the waking message reads as the same switch without a stop",
    async () => {
      const switched = (out: { caches: Cache[] }): Segment[] => [
        twoTurns(out)[0]!,
        (ctx) =>
          Effect.gen(function* () {
            const chat = ctx.ids.get("chat")!
            yield* ctx.llm.text("Plan done.", { usage: usage(1000) })
            yield* SessionPrompt.Service.use((prompt) =>
              prompt.prompt({ sessionID: chat, model: A, agent: "plan", parts: [{ type: "text", text: "Plan it." }] }),
            )
            out.caches = yield* caches(chat)
          }),
      ]
      const reference = { caches: [] as Cache[] }
      const restored = { caches: [] as Cache[] }
      await runProcesses({ segments: switched(reference), restartAfter: () => false })
      await runProcesses({ segments: switched(restored), restartAfter: (index) => index === 0 })
      expect(reference.caches.length).toBe(2)
      expect(["system", "tools"]).toContain(String(reference.caches[1]?.cause))
      expect(verdict(restored.caches[1])).toEqual(verdict(reference.caches[1]))
    },
    TIMEOUT,
  )

  test(
    "D8: a fork's first request reads cold, after a restart and without one",
    async () => {
      for (const restart of [false, true]) {
        const out = { caches: [] as Cache[] }
        await runProcesses({
          segments: [
            twoTurns({ caches: [] })[0]!,
            (ctx) =>
              Effect.gen(function* () {
                const fork = yield* Session.Service.use((sessions) => sessions.fork({ sessionID: ctx.ids.get("chat")! }))
                yield* ctx.llm.text("Fork done.", { usage: usage(1000) })
                yield* say(fork.id, "Fork turn.")
                out.caches = yield* caches(fork.id)
              }),
          ],
          restartAfter: (index) => restart && index === 0,
        })
        // The copied parent step-finish plus the fork's own.
        expect({ restart, ...verdict(out.caches.at(-1)) }).toEqual({ restart, cause: "cold", stopped: undefined })
      }
    },
    TIMEOUT,
  )

  test(
    "D9: a chat continued on another desk reads cold, not `stopped`",
    async () => {
      const out = { caches: [] as Cache[] }
      await runProcesses({
        segments: twoTurns(out, (ctx) =>
          // The other desk's store: the step-finish parts came in the journal,
          // the request memory never travels (it is local to a store).
          Database.Service.use(({ db }) => SessionRequestMemoryRows.remove(db, ctx.ids.get("chat")!)).pipe(
            Effect.orDie,
          ),
        ),
        restartAfter: (index) => index === 0,
      })
      expect(verdict(out.caches[1])).toEqual({ cause: "cold", stopped: undefined })
    },
    TIMEOUT,
  )
})

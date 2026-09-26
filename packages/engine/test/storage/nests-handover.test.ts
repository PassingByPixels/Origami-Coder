// Nests L5 (t-sb9tlk), store side: a chat changes desks. The claims under test:
//
// - TAKE-OVER THEN HAND-BACK on two real stores leaves both with the same owner
//   and the same journal, and each desk's new turn reaches the other.
// - "Continue here" on a running owner makes a FORK: a copy under new ids with
//   `forkOf`, the title suffixed, writable here; the original stays read only.
// - RECONCILE on a returning owner: local events past `remoteSeq` are saved as a
//   fork, the original is rebuilt to `remoteSeq` and re-imported from the nest.
//   Every local event is still somewhere afterwards.
// - A session that was RUNNING at its first export is compacted later: the tail
//   past the high-water mark collapses; rows at or below it keep their seq.

import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@origami/core/database/database"
import { SessionV1 } from "@origami/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, PartID } from "@/session/schema"
import { SessionRequestMemoryRows } from "@/session/request-memory-rows"
import { StorageNests } from "../../src/storage/nests"
import { StorageNestsHandover } from "../../src/storage/nests-handover"
import { ElasticIdle } from "@/elastic/idle"
import {
  DESK_A,
  DESK_B,
  SESSION,
  type Store,
  exportAll,
  journal,
  on,
  ownerOf,
  rows,
  state,
  wire,
  withStores,
  write,
} from "./nests-fixture"

/** One turn as an engine writes it: a user message, then an assistant answer
 *  whose text part streams `rewrites` times. `completed: false` leaves the
 *  answer open, as a running turn does; `finishOnly` writes only the closing
 *  update of an answer left open earlier. */
const turn = Effect.fnUntraced(function* (input: {
  readonly tag: string
  readonly at: number
  readonly rewrites?: number
  readonly completed?: boolean
  readonly finishOnly?: boolean
}) {
  const events = yield* EventV2Bridge.Service
  const user = MessageID.make(`msg_${input.at}_user_${input.tag}`)
  const answer = MessageID.make(`msg_${input.at}_answer_${input.tag}`)
  if (!input.finishOnly)
    yield* events.publish(SessionV1.Event.MessageUpdated, {
      sessionID: SESSION,
      info: {
        id: user,
        sessionID: SESSION,
        role: "user",
        agent: "build",
        model: { providerID: "p", modelID: "m" },
        time: { created: input.at },
      } as SessionV1.Info,
    })
  const assistant = (completed: boolean) =>
    ({
      id: answer,
      sessionID: SESSION,
      role: "assistant",
      parentID: user,
      modelID: "m",
      providerID: "p",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/nests", root: "/tmp/nests" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: completed ? { created: input.at + 1, completed: input.at + 9 } : { created: input.at + 1 },
    }) as SessionV1.Assistant
  if (!input.finishOnly)
    yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: SESSION, info: assistant(false) })
  const rewrites = input.finishOnly ? 0 : (input.rewrites ?? 1)
  for (let index = 1; index <= rewrites; index++)
    yield* events.publish(SessionV1.Event.PartUpdated, {
      sessionID: SESSION,
      part: {
        id: PartID.make(`prt_${input.at}_${input.tag}`),
        messageID: answer,
        sessionID: SESSION,
        type: "text",
        text: `${input.tag} answer ${"word ".repeat(index)}`,
        time: { start: input.at + 2 },
      } as SessionV1.Part,
      time: input.at + 2 + index,
    })
  if (input.completed !== false)
    yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: SESSION, info: assistant(true) })
})

/** Pull every chunk `from` holds past what `to` has, the way the host does. */
const pull = Effect.fnUntraced(function* (from: { store: Store; desk: string }, to: { store: Store; desk: string }) {
  const ask = yield* on(
    to.store,
    StorageNests.importChunk({
      deviceId: to.desk,
      chunk: { sessionId: SESSION, owner: "unused", from: 0, to: -1, last: 0, events: [] },
    }),
  )
  const chunks = yield* on(from.store, exportAll(700, from.desk, ask.have))
  for (const chunk of chunks) {
    const result = yield* on(to.store, StorageNests.importChunk({ deviceId: to.desk, chunk: wire(chunk) }))
    expect(result.refused).toBeUndefined()
  }
  return chunks
})

const partTexts = (store: Store, sessionID: string) =>
  on(
    store,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const list = yield* db
        .all<{
          text: string | null
        }>(
          sql`SELECT json_extract(data, '$.text') AS text FROM ${sql.identifier("part")} WHERE session_id = ${sessionID} ORDER BY id`,
        )
        .pipe(Effect.orDie)
      return list.map((row) => row.text)
    }),
  )

describe("take-over and hand-back", () => {
  test("two stores: take over on B, hand back to A; same owner and journal on both", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        const A = { store: a, desk: DESK_A }
        const B = { store: b, desk: DESK_B }
        yield* on(a, write())
        yield* pull(A, B)
        expect(yield* on(b, ownerOf())).toBe(DESK_A)

        // B: "Continue here", A idle. B writes it from now on.
        const taken = yield* on(
          b,
          StorageNestsHandover.continueHere({ deviceId: DESK_B, sessionId: SESSION, ownerRunning: false }),
        )
        const tookAt = (yield* on(a, journal())).at(-1)!.seq
        expect(taken).toEqual({ result: "taken", sessionId: SESSION, seq: tookAt })
        expect(yield* on(b, ownerOf())).toBe(DESK_B)
        expect(yield* on(b, StorageNests.foreignOwner({ deviceId: DESK_B, sessionId: SESSION }))).toBeUndefined()

        // A: the hand-over frame arrives.
        const released = yield* on(
          a,
          StorageNestsHandover.release({ deviceId: DESK_A, sessionId: SESSION, owner: DESK_B }),
        )
        expect(released).toMatchObject({ sessionId: SESSION, owner: DESK_B, directory: "/tmp/nests" })
        expect(yield* on(a, ownerOf())).toBe(DESK_B)
        expect(yield* on(a, StorageNests.foreignOwner({ deviceId: DESK_A, sessionId: SESSION }))).toBe(DESK_B)

        // B's turn reaches A.
        yield* on(b, turn({ tag: "b", at: 20_000, rewrites: 3 }))
        yield* pull(B, A)
        expect(yield* on(a, journal())).toEqual(yield* on(b, journal()))

        // Hand back: A continues (B idle), B releases to A, A's turn reaches B.
        const back = yield* on(
          a,
          StorageNestsHandover.continueHere({ deviceId: DESK_A, sessionId: SESSION, ownerRunning: false }),
        )
        expect(back).toMatchObject({ result: "taken", sessionId: SESSION })
        yield* on(b, StorageNestsHandover.release({ deviceId: DESK_B, sessionId: SESSION, owner: DESK_A }))
        yield* on(a, turn({ tag: "a", at: 30_000, rewrites: 2 }))
        yield* pull(A, B)

        expect(yield* on(a, ownerOf())).toBe(DESK_A)
        expect(yield* on(b, ownerOf())).toBe(DESK_A)
        const onA = yield* on(a, journal())
        expect(onA.length).toBeGreaterThan(tookAt + 1)
        expect(yield* on(b, journal())).toEqual(onA)
        expect(state(yield* on(b, rows()))).toEqual(state(yield* on(a, rows())))
        expect(yield* partTexts(b, SESSION)).toContain("a answer word word ")
        expect(yield* partTexts(a, SESSION)).toContain("b answer word word word ")
      }),
    ))

  test("release: a repeated frame is harmless; with no owner named anywhere it is refused", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        yield* on(a, write())
        yield* pull({ store: a, desk: DESK_A }, { store: b, desk: DESK_B })
        expect(yield* on(a, StorageNestsHandover.release({ deviceId: DESK_A, sessionId: SESSION }))).toEqual({
          refused: "unknown-owner",
          sessionId: SESSION,
        })
        expect(yield* on(a, ownerOf())).toBe(DESK_A)
        // B's index row names B as the writer: that is enough without `owner`.
        yield* on(b, StorageNestsHandover.continueHere({ deviceId: DESK_B, sessionId: SESSION, ownerRunning: false }))
        const rowsOfB = yield* on(
          b,
          StorageNests.index({ deviceId: DESK_B, deskName: "Surface", running: new Set(), open: new Set() }),
        )
        yield* on(a, StorageNests.applyIndex({ deviceId: DESK_A, desk: DESK_B, rows: [...rowsOfB], replace: true }))
        const first = yield* on(a, StorageNestsHandover.release({ deviceId: DESK_A, sessionId: SESSION }))
        const again = yield* on(a, StorageNestsHandover.release({ deviceId: DESK_A, sessionId: SESSION }))
        expect(first).toMatchObject({ owner: DESK_B })
        expect(again).toEqual(first)
        expect(yield* on(a, StorageNestsHandover.release({ deviceId: DESK_A, sessionId: "ses_missing" }))).toEqual({
          refused: "not-found",
          sessionId: "ses_missing",
        })
      }),
    ))
})

describe("continue here on a running owner", () => {
  test("makes a fork: new ids, forkOf, title suffixed, writable here; the original stays read only", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        yield* on(a, write())
        yield* pull({ store: a, desk: DESK_A }, { store: b, desk: DESK_B })
        const before = { journal: yield* on(b, journal()), rows: yield* on(b, rows(SESSION)) }

        const result = yield* on(
          b,
          StorageNestsHandover.continueHere({ deviceId: DESK_B, sessionId: SESSION, ownerRunning: true, now: 77 }),
        )
        if (!("result" in result) || result.result !== "forked")
          throw new Error(`not forked: ${JSON.stringify(result)}`)
        expect(result.sessionId).not.toBe(SESSION)
        expect(result.forkOf).toEqual({ id: SESSION, desk: DESK_A, at: 77 })

        // The original is untouched and still A's.
        expect(yield* on(b, journal())).toEqual(before.journal)
        expect(yield* on(b, rows(SESSION))).toEqual(before.rows)
        expect(yield* on(b, ownerOf())).toBe(DESK_A)

        // The fork: one event per original event, no id shared with the original.
        const fork = yield* on(b, journal(result.sessionId))
        expect(fork.map((row) => row.type)).toEqual(before.journal.map((row) => row.type))
        expect(fork.map((row) => row.seq)).toEqual(before.journal.map((_, seq) => seq))
        // Ids the original DEFINES (a row's own "id"). The fixture's assistant
        // also names a parent message that no event defines; a reference to
        // something outside this journal keeps pointing where it pointed.
        const defined = (data: string) => [...data.matchAll(/"id":"((?:ses|msg|prt)_[^"]+)"/g)].map((m) => m[1]!)
        const originalIds = new Set(before.journal.flatMap((row) => [row.id, ...defined(row.data)]))
        expect(originalIds.size).toBeGreaterThan(before.journal.length)
        for (const row of fork) {
          expect(originalIds.has(row.id)).toBe(false)
          // `forkOf.id` names the original on purpose; it is checked below.
          const data = row.data.replace(`"forkOf":{"id":"${SESSION}"`, "")
          for (const id of data.match(/(?:ses|msg|prt)_[A-Za-z0-9_]+/g) ?? []) {
            if (id === "msg_nests_parent") continue
            expect([id, originalIds.has(id)]).toEqual([id, false])
          }
        }
        // Same content under the new ids, in the same order.
        expect(yield* partTexts(b, result.sessionId)).toEqual(yield* partTexts(b, SESSION))
        const { db } = yield* on(b, Database.Service)
        const cost = (id: string) =>
          on(
            b,
            db
              .get<{ cost: number }>(sql`SELECT cost FROM ${sql.identifier("session")} WHERE id = ${id}`)
              .pipe(Effect.orDie),
          )
        expect((yield* cost(result.sessionId))?.cost).toBe((yield* cost(SESSION))?.cost)

        // Written here, and listed with its parent.
        expect(yield* on(b, ownerOf(result.sessionId))).toBeNull()
        expect(
          yield* on(b, StorageNests.foreignOwner({ deviceId: DESK_B, sessionId: result.sessionId })),
        ).toBeUndefined()
        const index = yield* on(
          b,
          StorageNests.index({ deviceId: DESK_B, deskName: "Surface", running: new Set(), open: new Set() }),
        )
        expect(index.find((row) => row.id === result.sessionId)).toMatchObject({
          title: "Renamed twice (fork #1)",
          owner: DESK_B,
          forkOf: { id: SESSION, desk: DESK_A, at: 77 },
        })
        expect(index.find((row) => row.id === SESSION)).toMatchObject({ owner: DESK_A })
      }),
    ))

  test("a session this desk already writes is `taken` with nothing written; an unknown one is refused", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const held = yield* on(a, journal())
        const result = yield* on(
          a,
          StorageNestsHandover.continueHere({ deviceId: DESK_A, sessionId: SESSION, ownerRunning: true }),
        )
        expect(result).toEqual({ result: "taken", sessionId: SESSION, seq: held.at(-1)!.seq })
        expect(yield* on(a, journal())).toEqual(held)
        expect(yield* on(a, ownerOf())).toBeNull()
        expect(
          yield* on(
            a,
            StorageNestsHandover.continueHere({ deviceId: DESK_A, sessionId: "ses_x", ownerRunning: false }),
          ),
        ).toEqual({ refused: "not-found", sessionId: "ses_x" })
      }),
    ))
})

// t-tc2b6c. The run lease is how every engine on one store sees a turn that
// another engine runs. `withRunLease` is the hook session/run-state.ts wraps
// each turn in; here it wraps a turn that never ends.
describe("the run lease (t-tc2b6c)", () => {
  const leased = (store: Store, stop: Effect.Effect<void> = Effect.void) =>
    Effect.forkChild(on(store, StorageNestsHandover.withRunLease(SESSION, Effect.never, stop)))
  /** The forked turn has written its first row. */
  const held = (store: Store) =>
    Effect.gen(function* () {
      for (let tries = 0; tries < 100; tries++) {
        if (yield* on(store, StorageNestsHandover.runningHere(SESSION))) return
        yield* Effect.sleep("20 millis")
      }
      throw new Error("the lease was never written")
    })

  /** `store` with every statement its client runs written to `log` as text. */
  const counted = (store: Store, log: string[]) => {
    const text = (query: unknown): string => {
      if (typeof query === "string") return query
      if (typeof query !== "object" || query === null) return String(query)
      const chunk = query as { queryChunks?: unknown[]; value?: unknown }
      if (Array.isArray(chunk.queryChunks)) return chunk.queryChunks.map(text).join("")
      if (Array.isArray(chunk.value)) return chunk.value.join("")
      return typeof chunk.value === "string" ? chunk.value : ""
    }
    const { db } = Context.get(store, Database.Service)
    const proxy = new Proxy(db, {
      get: (target, key) => {
        const value = Reflect.get(target, key)
        if (typeof value !== "function") return value
        if (key !== "run" && key !== "get" && key !== "all") return value.bind(target)
        return (query: unknown, ...rest: unknown[]) => {
          log.push(text(query))
          return value.call(target, query, ...rest)
        }
      },
    })
    return Context.add(store, Database.Service, { db: proxy })
  }

  test("with Nests off a turn does no lease work: zero nest_run statements, and nothing after its start", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        // A: Nests never on. B: Nests on once, then off (the mark is stale).
        yield* on(b, StorageNestsHandover.markActive(Date.now() - StorageNestsHandover.ACTIVE_MS - 1))
        for (const store of [a, b]) {
          const log: string[] = []
          const turn = yield* leased(counted(store, log))
          yield* Effect.sleep("100 millis")
          const atStart = log.length
          // Three heartbeat periods.
          yield* Effect.sleep(StorageNestsHandover.RUN_BEAT_MS * 3 + 500)
          const during = log.length
          yield* Fiber.interrupt(turn)
          console.log(
            `nests off, ${store === a ? "never on" : "stale mark"}: ${log.length} statements (start ${atStart}, ` +
              `after 3.5 s ${during}), nest_run statements ${log.filter((q) => q.includes("nest_run")).length}`,
          )
          expect(log.filter((q) => q.includes("nest_run"))).toEqual([])
          // The gate is read once at the start, and nothing runs per second.
          expect(atStart).toBeLessThanOrEqual(2)
          expect(log.length).toBe(atStart)
        }
        const { db } = yield* on(a, Database.Service)
        const table = yield* db
          .get<{ n: number }>(sql`SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'nest_%'`)
          .pipe(Effect.orDie)
        expect(table?.n).toBe(0)
      }),
    ), 20_000)

  test("a leased turn makes continue here fork though the host says idle; after it ends, it takes over", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        yield* on(a, write())
        yield* pull({ store: a, desk: DESK_A }, { store: b, desk: DESK_B })
        // A gated nest call passed: Nests is on for this store.
        yield* on(b, StorageNestsHandover.markActive())

        const turn = yield* leased(b)
        yield* held(b)
        expect(yield* on(b, StorageNestsHandover.runningSessions())).toEqual(new Set([SESSION]))
        const forked = yield* on(
          b,
          StorageNestsHandover.continueHere({ deviceId: DESK_B, sessionId: SESSION, ownerRunning: false }),
        )
        expect("result" in forked && forked.result).toBe("forked")
        expect(yield* on(b, ownerOf())).toBe(DESK_A)

        yield* Fiber.interrupt(turn)
        expect(yield* on(b, StorageNestsHandover.runningSessions())).toEqual(new Set())
        const taken = yield* on(
          b,
          StorageNestsHandover.continueHere({ deviceId: DESK_B, sessionId: SESSION, ownerRunning: false }),
        )
        expect("result" in taken && taken.result).toBe("taken")
      }),
    ))

  // t-w2qlop: a held run lease keeps the engine unparkable - a stop would leave
  // another engine's release waiting out RUN_TTL_MS for a turn nobody runs.
  test("a held run lease is a reason in the elastic idle report, and dropping it clears the reason", () =>
    withStores((_a, b) =>
      Effect.gen(function* () {
        yield* on(b, StorageNestsHandover.markActive())
        const turn = yield* leased(b)
        yield* held(b)
        expect(ElasticIdle.report().reasons).toContain("nest-lease")
        yield* Fiber.interrupt(turn)
        expect(ElasticIdle.report().reasons).not.toContain("nest-lease")
      }),
    ))

  test("Nests turned on mid-turn in this process starts the lease of the running turn", () =>
    withStores((_a, b) =>
      Effect.gen(function* () {
        const turn = yield* leased(b)
        yield* Effect.sleep("300 millis")
        expect(yield* on(b, StorageNestsHandover.runningHere(SESSION))).toBe(false)
        // What a gated nest call does (acp/nests.ts `store`).
        yield* on(b, StorageNestsHandover.markActive())
        StorageNestsHandover.wake()
        yield* held(b)
        yield* Fiber.interrupt(turn)
        expect(yield* on(b, StorageNestsHandover.runningHere(SESSION))).toBe(false)
      }),
    ))

  test("a lease whose engine stopped beating has expired", () =>
    withStores((_a, b) =>
      Effect.gen(function* () {
        yield* on(b, StorageNestsHandover.runningSessions())
        const store = yield* on(b, Database.Service)
        const stale = Date.now() - StorageNestsHandover.RUN_TTL_MS - 1
        yield* store.db
          .run(
            sql`INSERT INTO nest_run (session_id, holder, pid, heartbeat) VALUES (${SESSION}, 'crashed', 1, ${stale})`,
          )
          .pipe(Effect.orDie)
        expect(yield* on(b, StorageNestsHandover.runningHere(SESSION))).toBe(false)
        expect(yield* on(b, StorageNestsHandover.requestStop(SESSION))).toBe(false)
      }),
    ))

  test("a stop request reaches the turn at its next heartbeat, and the lease is gone after it", () =>
    withStores((_a, b) =>
      Effect.gen(function* () {
        yield* on(b, StorageNestsHandover.markActive())
        const stopped = yield* Deferred.make<void>()
        const turn = yield* leased(b, Deferred.succeed(stopped, undefined).pipe(Effect.asVoid))
        yield* held(b)
        expect(yield* on(b, StorageNestsHandover.requestStop(SESSION))).toBe(true)
        yield* Deferred.await(stopped).pipe(Effect.timeout(StorageNestsHandover.RUN_BEAT_MS * 3))
        // The stop is the caller's (run-state cancels the turn); here the turn is
        // interrupted by hand, as the cancel would.
        yield* Fiber.interrupt(turn)
        expect(yield* on(b, StorageNestsHandover.awaitStopped(SESSION, 1_000))).toBe(true)
      }),
    ))
})

describe("reconcile on a returning owner", () => {
  test("events past remoteSeq become a fork; the original is rebuilt and re-imported; nothing is lost", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        const A = { store: a, desk: DESK_A }
        const B = { store: b, desk: DESK_B }
        yield* on(a, write())
        yield* pull(A, B)
        const shared = (yield* on(b, journal())).at(-1)!.seq

        // A goes offline and writes on. B takes over (forced) and writes too.
        yield* on(a, turn({ tag: "offline", at: 40_000, rewrites: 2 }))
        const aAll = yield* on(a, journal())
        yield* on(b, StorageNestsHandover.continueHere({ deviceId: DESK_B, sessionId: SESSION, ownerRunning: false }))
        yield* on(b, turn({ tag: "b", at: 50_000 }))

        // A comes back. Nothing names the new owner yet: refused, nothing written.
        expect(
          yield* on(a, StorageNestsHandover.reconcile({ deviceId: DESK_A, sessionId: SESSION, remoteSeq: shared })),
        ).toEqual({ refused: "unknown-owner", sessionId: SESSION })
        expect(yield* on(a, journal())).toEqual(aAll)

        // The index from B arrives, then the one check.
        const rowsOfB = yield* on(
          b,
          StorageNests.index({ deviceId: DESK_B, deskName: "Surface", running: new Set(), open: new Set() }),
        )
        yield* on(a, StorageNests.applyIndex({ deviceId: DESK_A, desk: DESK_B, rows: [...rowsOfB], replace: true }))
        const at = new Date(2026, 8, 22, 14, 2).getTime()
        const result = yield* on(
          a,
          StorageNestsHandover.reconcile({
            deviceId: DESK_A,
            sessionId: SESSION,
            remoteSeq: shared,
            deskName: "5090",
            now: at,
          }),
        )
        if (!("result" in result) || result.result !== "forked")
          throw new Error(`not forked: ${JSON.stringify(result)}`)
        expect(result).toMatchObject({ have: shared, owner: DESK_B })
        expect(result.fork.title).toBe("Renamed twice (5090, 14:02)")
        expect(result.fork.forkOf).toEqual({ id: SESSION, desk: DESK_A, at })

        // The fork holds every event A had, including the offline turn.
        const fork = yield* on(a, journal(result.fork.sessionId))
        expect(fork.map((row) => row.type)).toEqual(aAll.map((row) => row.type))
        expect(yield* partTexts(a, result.fork.sessionId)).toContain("offline answer word word ")
        expect(yield* on(a, ownerOf(result.fork.sessionId))).toBeNull()

        // The original is back at the shared prefix, owned by B, and pulls cleanly.
        expect(yield* on(a, journal())).toEqual(aAll.slice(0, shared + 1))
        expect(yield* on(a, ownerOf())).toBe(DESK_B)
        expect(yield* partTexts(a, SESSION)).not.toContain("offline answer word word ")
        yield* pull(B, A)
        expect(yield* on(a, journal())).toEqual(yield* on(b, journal()))
        expect(state(yield* on(a, rows(SESSION)))).toEqual(state(yield* on(b, rows(SESSION))))
        expect(yield* partTexts(a, SESSION)).toEqual(yield* partTexts(b, SESSION))

        // A second check finds nothing more to do.
        expect(
          yield* on(
            a,
            StorageNestsHandover.reconcile({
              deviceId: DESK_A,
              sessionId: SESSION,
              remoteSeq: (yield* on(b, journal())).at(-1)!.seq,
            }),
          ),
        ).toMatchObject({ result: "clean" })
      }),
    ))

  // t-wdyp7r (review F4): the rebuild deletes the session row, and the cascade
  // took the request memory with it while the engine that holds the chat kept
  // its copy: disk and memory disagreed, and "always allow" answers were lost.
  test("the rebuild keeps the chat's request memory and always-allow rows", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        const A = { store: a, desk: DESK_A }
        const B = { store: b, desk: DESK_B }
        yield* on(a, write())
        yield* pull(A, B)
        const shared = (yield* on(b, journal())).at(-1)!.seq
        yield* on(a, turn({ tag: "offline", at: 40_000 }))
        yield* on(b, StorageNestsHandover.continueHere({ deviceId: DESK_B, sessionId: SESSION, ownerRunning: false }))
        const rowsOfB = yield* on(
          b,
          StorageNests.index({ deviceId: DESK_B, deskName: "Surface", running: new Set(), open: new Set() }),
        )
        yield* on(a, StorageNests.applyIndex({ deviceId: DESK_A, desk: DESK_B, rows: [...rowsOfB], replace: true }))
        const memory: SessionRequestMemoryRows.Row[] = [
          { kind: "aging.rewrite", key: `prt_${40_000}_offline`, data: { output: "[aged]" } },
          { kind: "window_fit", key: "", data: 1.25 },
          { kind: "permission.always", key: "bash\u0000git *", data: { permission: "bash", pattern: "git *" } },
        ]
        const held = Database.Service.use(({ db }) => SessionRequestMemoryRows.load(db, SESSION)).pipe(Effect.orDie)
        yield* on(a, Database.Service.use(({ db }) => SessionRequestMemoryRows.write(db, SESSION, memory)).pipe(Effect.orDie))
        expect(yield* on(a, held)).toEqual(memory)

        const result = yield* on(a, StorageNestsHandover.reconcile({ deviceId: DESK_A, sessionId: SESSION, remoteSeq: shared }))
        expect(result).toMatchObject({ result: "forked" })
        expect(yield* on(a, held)).toEqual(memory)
      }),
    ))
})

describe("tail compaction past the high-water mark", () => {
  test("a session running at its first export is compacted later, without moving what a receiver holds", () =>
    withStores((a, b) =>
      Effect.gen(function* () {
        const A = { store: a, desk: DESK_A }
        const B = { store: b, desk: DESK_B }
        yield* on(a, write())
        // Mid-turn at the first export: compaction skips it, the claim fixes it.
        yield* on(a, turn({ tag: "long", at: 60_000, rewrites: 5, completed: false }))
        const first = yield* pull(A, B)
        const mark = first.at(-1)!.to
        const held = yield* on(b, journal())
        expect(yield* on(a, StorageNests.highWater(SESSION))).toBe(mark)

        // The turn ends, then another one streams.
        yield* on(a, turn({ tag: "long", at: 60_000, finishOnly: true }))
        yield* on(a, turn({ tag: "next", at: 70_000, rewrites: 6 }))
        const written = (yield* on(a, journal())).length - held.length
        const second = yield* pull(A, B)
        const sent = second.flatMap((chunk) => chunk.events)
        // The six rewrites of the new part travel as one row, and its answer's
        // open and closing updates as one.
        const rewritesOf = (id: string) =>
          sent.filter((event) => (event.data as { part?: { id?: string } }).part?.id === id).length
        expect(rewritesOf("prt_70000_next")).toBe(1)
        expect(sent.length).toBe(written - 6)
        // Rows at or below the mark are exactly what B held.
        expect((yield* on(a, journal())).slice(0, held.length)).toEqual(held)
        expect(yield* on(b, journal())).toEqual(yield* on(a, journal()))
        expect(state(yield* on(b, rows()))).toEqual(state(yield* on(a, rows())))
        expect(yield* on(a, StorageNests.highWater(SESSION))).toBe(second.at(-1)!.to)
      }),
    ))

  // t-tc2193. An export reads its chunk in batches of 256 rows. A second
  // export that compacts the tail (the 30 s tail asks again just as the turn
  // ends) and renumbers the journal between two of those reads moves rows under
  // the first export's cursor: rows skipped, others sent at a seq they no
  // longer have. The store's `db.all` is wrapped so the second export starts,
  // on its own fiber, exactly after the first export's first full batch; the
  // first one then waits up to 300 ms for it before it reads on.
  test("an export overlapped by a tail compaction sends each event at the seq the journal holds it", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const [first] = yield* on(a, exportAll(1 << 20))
        const mark = first!.to
        // Running at the first export below, so that one does not compact;
        // more rows than one read batch.
        yield* on(a, turn({ tag: "long", at: 60_000, rewrites: 400, completed: false }))
        const exportAt = (after: number) =>
          StorageNests.exportChunk({ deviceId: DESK_A, sessionId: SESSION, after, maxBytes: 1 << 24 })
        const { db } = Context.get(a, Database.Service)
        const run = () =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* turn({ tag: "long", at: 60_000, finishOnly: true })
              return yield* exportAt(mark)
            }).pipe(Effect.provide(a)),
          )
        let second: ReturnType<typeof run> | undefined
        const allRows = (query: Parameters<typeof db.all>[0]) =>
          (db.all(query) as Effect.Effect<ReadonlyArray<unknown>, unknown>).pipe(
            Effect.tap((rows) =>
              Effect.promise(async () => {
                const batch = rows as ReadonlyArray<{ n?: number }>
                if (second || batch.length !== 256 || batch[0]?.n === undefined) return
                second = run()
                await Promise.race([second, Bun.sleep(300)])
              }),
            ),
          )
        const all = allRows as unknown as typeof db.all
        const wrapped = Context.add(a, Database.Service, {
          db: new Proxy(db, { get: (target, key) => (key === "all" ? all : Reflect.get(target, key)) }),
        })
        const reader = yield* on(wrapped, exportAt(mark))
        expect(second).toBeDefined()
        const compactor = yield* Effect.promise(() => second!)
        const final = yield* on(a, journal())
        const bySeq = new Map(final.map((row) => [row.seq, row]))
        for (const chunk of [reader, compactor]) {
          if ("refused" in chunk) throw new Error(`export refused: ${chunk.refused}`)
          expect(chunk.events.length).toBeGreaterThan(0)
          expect(chunk.events.map((event) => event.seq)).toEqual(chunk.events.map((_, index) => chunk.from + index))
          expect(new Set(chunk.events.map((event) => event.id)).size).toBe(chunk.events.length)
          // Not lost, not duplicated, not moved: what a receiver stores at seq N
          // is what this desk holds at seq N.
          for (const event of chunk.events) {
            const row = bySeq.get(event.seq)
            expect({ seq: event.seq, id: event.id as string, type: event.type, data: event.data }).toEqual({
              seq: event.seq,
              id: row?.id as string,
              type: row?.type as string,
              data: JSON.parse(row?.data ?? "null"),
            })
          }
        }
      }),
    ))

  test("a session claimed before L5 (no mark) is never compacted again", () =>
    withStores((a) =>
      Effect.gen(function* () {
        yield* on(a, write())
        const events = yield* on(a, EventV2Bridge.Service)
        yield* on(a, events.claim(SESSION, DESK_A))
        yield* on(a, turn({ tag: "late", at: 80_000, rewrites: 4 }))
        const before = yield* on(a, journal())
        yield* on(a, exportAll(1 << 20))
        expect(yield* on(a, journal())).toEqual(before)
      }),
    ))
})

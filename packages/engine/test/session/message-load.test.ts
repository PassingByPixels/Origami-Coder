// t-tc1mhl: the per-step session load. `filterCompactedEffect` (prompt.ts, top
// of every loop step) used to read EVERY page of the session and only then cut
// at the compaction marker. It now stops the page walk at the cut. `turn`
// (summary.ts) reads back only as far as one user message.
//
// "Not read" is made observable with a poison row: a message row whose data
// is not JSON, older than the cut. Reading its page dies; a walk that stops at
// the cut never reads it.
import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionV1 } from "@origami/core/v1/session"
import { SessionProjector } from "@origami/core/session/projector"
import { Database } from "@origami/core/database/database"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node, Database.node])),
)

const withSession = <A, E, R>(fn: (sessionID: SessionID) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    SessionNs.Service.use((session) => session.create({})),
    (created) => fn(created.id),
    (created) => SessionNs.Service.use((session) => session.remove(created.id)).pipe(Effect.ignore),
  )

let clock = Date.now()
const tick = () => ++clock

const user = Effect.fn("Test.user")(function* (sessionID: SessionID, opts?: { compaction?: MessageID | true }) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: tick() },
    agent: "test",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  } satisfies SessionV1.User)
  yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text: `u ${id}` })
  if (opts?.compaction)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "compaction",
      auto: true,
      tail_start_id: opts.compaction === true ? undefined : opts.compaction,
    } as SessionV1.Part)
  return id
})

const assistant = Effect.fn("Test.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  summary?: boolean,
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: tick() },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary,
    finish: "stop",
  } satisfies SessionV1.Assistant)
  return id
})

/** `count` user/assistant pairs. */
const history = Effect.fn("Test.history")(function* (sessionID: SessionID, count: number) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const u = yield* user(sessionID)
    ids.push(u, yield* assistant(sessionID, u))
  }
  return ids
})

/** A row older than everything else whose data is not JSON: reading it dies. */
const poison = Effect.fn("Test.poison")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const id = MessageID.ascending()
  yield* db.run(
    sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${id}, ${sessionID}, 1, 1, '{not json')`,
  )
})

const ids = (msgs: readonly SessionV1.WithParts[]) => msgs.map((m) => m.info.id)

describe("MessageV2.filterCompactedEffect", () => {
  it.instance("gives the same messages as a full walk, over many pages, with no compaction", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        yield* history(sessionID, 70) // 140 messages = 3 pages of 50
        const full = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        const cut = yield* MessageV2.filterCompactedEffect(sessionID)
        expect(full).toHaveLength(140)
        expect(ids(cut)).toEqual(ids(full))
      }),
    ),
  )

  it.instance("stops reading at a compaction with no kept tail", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        yield* poison(sessionID)
        yield* history(sessionID, 60)
        const c = yield* user(sessionID, { compaction: true })
        const s = yield* assistant(sessionID, c, true)
        const after = yield* history(sessionID, 3)

        // A full walk reads the poison row, so the old load died here.
        expect(Exit.isFailure(yield* Effect.exit(MessageV2.stream(sessionID)))).toBe(true)
        expect(ids(yield* MessageV2.filterCompactedEffect(sessionID))).toEqual([c, s, ...after])
      }),
    ),
  )

  it.instance("reads back to a kept tail that starts pages before the compaction, and no further", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        yield* poison(sessionID)
        yield* history(sessionID, 60) // keeps the poison row pages away from the tail
        const tail = yield* history(sessionID, 40) // 80 messages: the tail spans two pages
        const c = yield* user(sessionID, { compaction: tail[0] })
        const s = yield* assistant(sessionID, c, true)
        const after = yield* history(sessionID, 2)

        expect(Exit.isFailure(yield* Effect.exit(MessageV2.stream(sessionID)))).toBe(true)
        expect(ids(yield* MessageV2.filterCompactedEffect(sessionID))).toEqual([c, s, ...tail, ...after])
      }),
    ),
  )
})

// t-u54x6w: the loop pass that ENDS a turn only needs `latest()`. `window`
// reads the newest pages until `latest()` cannot change, and reads the rest of
// the window only when the pass goes on to send a request.
const latestIds = (found: ReturnType<typeof MessageV2.latest>) => ({
  user: found.user?.id,
  assistant: found.assistant?.id,
  finished: found.finished?.id,
  tasks: found.tasks.map((part) => part.id),
})

const sameAsFull = Effect.fn("Test.sameAsFull")(function* (sessionID: SessionID) {
  const full = yield* MessageV2.filterCompactedEffect(sessionID)
  const read = yield* MessageV2.window(sessionID)
  expect(latestIds(read.latest)).toEqual(latestIds(MessageV2.latest(full)))
  const all = yield* read.all
  expect(ids(all)).toEqual(ids(full))
  expect(latestIds(MessageV2.latest(all))).toEqual(latestIds(MessageV2.latest(full)))
  return read
})

describe("MessageV2.window", () => {
  it.instance("the pass that ends a turn reads the newest page and no older one", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        yield* poison(sessionID)
        yield* history(sessionID, 60) // the poison row is pages away
        const u = yield* user(sessionID)
        const a = yield* assistant(sessionID, u)

        // The whole-window read (the old top of every pass) dies on the poison.
        expect(Exit.isFailure(yield* Effect.exit(MessageV2.filterCompactedEffect(sessionID)))).toBe(true)
        const read = yield* MessageV2.window(sessionID)
        expect(read.latest.user?.id).toBe(u)
        expect(read.latest.assistant?.id).toBe(a)
        expect(read.latest.finished?.id).toBe(a)
        expect(read.head.length).toBeLessThanOrEqual(50)
        // ...and a pass that goes on still reads everything, as before.
        expect(Exit.isFailure(yield* Effect.exit(read.all))).toBe(true)
      }),
    ),
  )

  it.instance("gives what the whole-window read gives: turn start, turn end, interjection, compaction tail", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        yield* history(sessionID, 60)
        // Turn end: the newest reply finished.
        yield* sameAsFull(sessionID)
        // Turn start: a new user message after the finished reply.
        const u = yield* user(sessionID)
        yield* sameAsFull(sessionID)
        // A reply in flight, then a user message pushed into the turn.
        yield* assistant(sessionID, u)
        yield* user(sessionID)
        yield* sameAsFull(sessionID)
        // A compaction marker (a task) newer than the finished reply.
        const tail = yield* history(sessionID, 30)
        const c = yield* user(sessionID, { compaction: tail[0] })
        yield* sameAsFull(sessionID)
        // The compaction done, and a turn after it.
        yield* assistant(sessionID, c, true)
        yield* history(sessionID, 2)
        yield* sameAsFull(sessionID)
      }),
    ),
  )

  it.instance("an unread row with a larger id makes it read the whole window", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        yield* history(sessionID, 60)
        const u = yield* user(sessionID)
        yield* assistant(sessionID, u)
        // A user message created LAST (largest id) but stamped oldest, so the
        // newest-first page order puts it at the very end.
        const { db } = yield* Database.Service
        const late = yield* user(sessionID)
        yield* db.run(sql`UPDATE message SET time_created = 2 WHERE id = ${late}`)

        const read = yield* sameAsFull(sessionID)
        expect(read.latest.user?.id).toBe(late)
        expect(read.head.length).toBe(123)
      }),
    ),
  )

  it.instance("lets the event loop run between the pages of a long read", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        yield* history(sessionID, 100) // 200 messages = 4 pages
        let turns = 0
        let on = true
        const spin = () => {
          if (!on) return
          turns++
          setImmediate(spin)
        }
        setImmediate(spin)
        const before = turns
        const all = yield* MessageV2.filterCompactedEffect(sessionID)
        const during = turns - before
        on = false
        expect(all).toHaveLength(200)
        // One event-loop turn at least between each pair of pages. Without the
        // yield the four reads ran as one block and `during` was 0.
        expect(during).toBeGreaterThanOrEqual(3)
      }),
    ),
  )
})

describe("MessageV2.turn", () => {
  it.instance("returns one user message and every message after it, oldest first, without older pages", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        yield* poison(sessionID)
        yield* history(sessionID, 60)
        const u = yield* user(sessionID)
        const a1 = yield* assistant(sessionID, u)
        const a2 = yield* assistant(sessionID, u)

        expect(ids(yield* MessageV2.turn(sessionID, u))).toEqual([u, a1, a2])
      }),
    ),
  )
})

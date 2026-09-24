import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { SessionProjector } from "@origami/core/session/projector"
import { SessionTable } from "@origami/core/session/sql"
import { SessionSteps } from "@origami/core/session/steps"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { RunStats } from "../../src/acp/run-stats"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// t-ucn8zm. The session row's `steps` column replaces reading the whole
// transcript through `RunStats.stat(...).steps`. Every check here compares the
// row with that old reader over the messages that are left, plus a fixed number,
// so a counter that drifts from the old rule, or from the truth, fails.

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionRevert.node,
      Snapshot.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      Database.node,
    ]),
  ),
)

const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
const tokens = (input: number) => ({ input, output: 7, reasoning: 0, cache: { read: 3, write: 0 } })

const user = Effect.fn("test.user")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent: "default",
    model,
    time: { created: Date.now() },
  })
})

const assistant = Effect.fn("test.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  dir: string,
  extra: { source?: string } = {},
) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    // What the processor leaves on the message: the LAST step's tokens.
    tokens: tokens(100),
    modelID: ModelV2.ID.make("gpt-4"),
    providerID: ProviderV2.ID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
    ...extra,
  })
})

const stepFinish = (sessionID: SessionID, messageID: MessageID, id = PartID.ascending(), input = 100) => ({
  id,
  messageID,
  sessionID,
  type: "step-finish" as const,
  reason: "tool-calls",
  cost: 0.01,
  tokens: tokens(input),
})

const text = (sessionID: SessionID, messageID: MessageID, id = PartID.ascending()) => ({
  id,
  messageID,
  sessionID,
  type: "text" as const,
  text: "hello",
})

/** The row's `steps` beside the old reader's count over what is left. */
const compare = Effect.fn("test.compare")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  const row = (yield* session.get(sessionID)).steps
  const messages = yield* session.messages({ sessionID })
  const old = RunStats.stat(sessionID, messages as unknown as Parameters<typeof RunStats.stat>[1]).steps ?? 0
  return { row, old }
})

describe("session steps counter", () => {
  it.live(
    "the projector keeps steps equal to RunStats.stat over add, replace, part remove and revert",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const sid = info.id
          expect(yield* compare(sid)).toEqual({ row: 0, old: 0 })

          // Add: two steps in the first turn.
          const u1 = yield* user(sid)
          const a1 = yield* assistant(sid, u1.id, dir)
          // A message whose first step is still running: the old rule counts
          // its message-level tokens as one step.
          expect(yield* compare(sid)).toEqual({ row: 1, old: 1 })
          const s1 = yield* session.updatePart(stepFinish(sid, a1.id))
          expect(yield* compare(sid)).toEqual({ row: 1, old: 1 })
          yield* session.updatePart(text(sid, a1.id))
          const s2 = yield* session.updatePart(stepFinish(sid, a1.id))
          expect(yield* compare(sid)).toEqual({ row: 2, old: 2 })

          // Replace: the same step-finish written again is still one step.
          yield* session.updatePart(stepFinish(sid, a1.id, s1.id, 250))
          expect(yield* compare(sid)).toEqual({ row: 2, old: 2 })

          // Replace across kinds: a text part that becomes a step-finish adds
          // one; a step-finish that becomes a text part takes one away.
          const t1 = yield* session.updatePart(text(sid, a1.id))
          yield* session.updatePart(stepFinish(sid, a1.id, t1.id))
          expect(yield* compare(sid)).toEqual({ row: 3, old: 3 })
          yield* session.updatePart(text(sid, a1.id, t1.id))
          expect(yield* compare(sid)).toEqual({ row: 2, old: 2 })

          // Part remove.
          yield* session.removePart({ sessionID: sid, messageID: a1.id, partID: s2.id })
          expect(yield* compare(sid)).toEqual({ row: 1, old: 1 })

          // A second turn, then a revert to before it removes its messages.
          const u2 = yield* user(sid)
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* session.updatePart(stepFinish(sid, a2.id))
          yield* session.updatePart(stepFinish(sid, a2.id))
          yield* session.updatePart(stepFinish(sid, a2.id))
          expect(yield* compare(sid)).toEqual({ row: 4, old: 4 })

          // setRevert writes the whole row through session.updated; that must
          // not reset the running count either.
          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u2.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          expect(yield* compare(sid)).toEqual({ row: 4, old: 4 })
          yield* revert.cleanup(yield* session.get(sid))
          expect((yield* session.messages({ sessionID: sid })).map((m) => m.info.id)).toEqual([u1.id, a1.id])
          expect(yield* compare(sid)).toEqual({ row: 1, old: 1 })
        }),
      { git: true },
    ),
  )

  // The messages the old rule treats differently from "one step per step-finish".
  const mixed = Effect.fn("test.mixed")(function* (sid: SessionID, dir: string) {
    const session = yield* Session.Service
    const u1 = yield* user(sid)
    // Two counted steps.
    const a1 = yield* assistant(sid, u1.id, dir)
    yield* session.updatePart(stepFinish(sid, a1.id))
    yield* session.updatePart(stepFinish(sid, a1.id))
    // Aborted before its first step-finish, zero tokens, no parts: counted once.
    const aborted = yield* assistant(sid, u1.id, dir)
    yield* session.updateMessage({ ...aborted, tokens: tokens(0), error: { name: "MessageAbortedError", data: { message: "x" } } })
    // Foreign (mirrored) messages: skipped, step-finish parts or not.
    yield* assistant(sid, u1.id, dir, { source: "claude-code" })
    const f2 = yield* assistant(sid, u1.id, dir, { source: "claude-code" })
    yield* session.updatePart(stepFinish(sid, f2.id))
    // An empty source is not foreign.
    const e1 = yield* assistant(sid, u1.id, dir, { source: "" })
    yield* session.updatePart(stepFinish(sid, e1.id))
    // A step-finish on a USER message: the old rule reads assistant messages only.
    yield* session.updatePart(stepFinish(sid, u1.id))
    return { a1, aborted, e1 }
  })

  it.live(
    "the projector applies the whole old rule: message-level fallback, foreign and user messages",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const sid = (yield* session.create({})).id
          const { a1, aborted, e1 } = yield* mixed(sid, dir)
          expect(yield* compare(sid)).toEqual({ row: 4, old: 4 })
          // Removing the fallback-only message takes its one step away.
          yield* session.removeMessage({ sessionID: sid, messageID: aborted.id })
          expect(yield* compare(sid)).toEqual({ row: 3, old: 3 })
          // Removing the ONLY step-finish of a message that has message tokens
          // leaves the message counted once, by the fallback.
          const only = (yield* session.messages({ sessionID: sid })).find((m) => m.info.id === e1.id)!.parts[0]!
          yield* session.removePart({ sessionID: sid, messageID: e1.id, partID: only.id })
          expect(yield* compare(sid)).toEqual({ row: 3, old: 3 })
          // A message with two step-finish parts, removed whole.
          yield* session.removeMessage({ sessionID: sid, messageID: a1.id })
          expect(yield* compare(sid)).toEqual({ row: 1, old: 1 })
        }),
      { git: true },
    ),
  )

  it.live(
    "a row that is not backfilled stays NULL under increments, and the backfill applies the whole old rule",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const { db } = yield* Database.Service
          const sid = (yield* session.create({})).id
          // As a row made before the column existed.
          yield* db.update(SessionTable).set({ steps: null }).where(eq(SessionTable.id, sid)).run()
          yield* mixed(sid, dir)
          expect((yield* session.get(sid)).steps).toBeUndefined()

          yield* SessionSteps.backfillSession(db, sid)
          expect(yield* compare(sid)).toEqual({ row: 4, old: 4 })

          // A second run changes nothing: the backfill only writes NULL rows.
          yield* db.update(SessionTable).set({ steps: 99 }).where(eq(SessionTable.id, sid)).run()
          yield* SessionSteps.backfillSession(db, sid)
          expect((yield* session.get(sid)).steps).toBe(99)
        }),
      { git: true },
    ),
  )
})

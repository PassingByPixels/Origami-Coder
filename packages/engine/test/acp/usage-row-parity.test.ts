// t-u1j4jm. `sendUpdate` used to read the WHOLE session after every turn to
// find the newest assistant message and to sum every assistant message's cost.
// It now reads the newest messages only and takes the cost from the session
// row. This test runs both against one real store, over the real HTTP server,
// through compaction, a revert and a sub-agent: after each step the frame the
// new code sends must carry the values the old full read computed.

import { afterEach, describe, expect } from "bun:test"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { FSUtil } from "@origami/core/fs-util"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Database } from "@origami/core/database/database"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { createOrigamiClient, type OrigamiClient } from "@origami/sdk/v2"
import { UsageService } from "@/acp/usage"
import { Session as SessionNs } from "@/session/session"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "../server/httpapi-layer"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const appLayer = AppNodeBuilder.build(
  LayerNode.group([FSUtil.node, CrossSpawnSpawner.node, InstanceStore.node, Database.node, SessionNs.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const PROVIDER = ProviderV2.ID.make("test")
const MODEL = ModelV2.ID.make("test")

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
const tokens = (input: number, read: number, write = 0): Tokens => ({
  input,
  output: 5,
  reasoning: 0,
  cache: { read, write },
})

function sdkFor(directory: string) {
  return HttpServer.HttpServer.use((server) =>
    Effect.sync(() => {
      const baseUrl = HttpServer.formatAddress(server.address)
      return createOrigamiClient({ baseUrl, directory })
    }),
  )
}

/** The engine side of a session, written the way the processor writes it: one
 *  assistant message per turn whose `cost` is the sum of its step-finish parts'
 *  costs and whose `tokens` are the LAST step's. */
function seeder(directory: string) {
  const run = <A>(effect: Effect.Effect<A, never, SessionNs.Service>) =>
    InstanceStore.Service.use((store) => store.provide({ directory }, effect))

  const user = (sessionID: SessionID, compaction = false) =>
    run(
      SessionNs.Service.use((svc) =>
        Effect.gen(function* () {
          const message = yield* svc.updateMessage({
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: PROVIDER, modelID: MODEL },
          })
          yield* svc.updatePart(
            compaction
              ? { id: PartID.ascending(), sessionID, messageID: message.id, type: "compaction", auto: false }
              : { id: PartID.ascending(), sessionID, messageID: message.id, type: "text", text: "go" },
          )
          return message.id
        }),
      ),
    )

  const assistant = (
    sessionID: SessionID,
    parentID: MessageID,
    steps: ReadonlyArray<{ cost: number; tokens: Tokens }>,
    summary = false,
  ) =>
    run(
      SessionNs.Service.use((svc) =>
        Effect.gen(function* () {
          const id = MessageID.ascending()
          const last = steps.at(-1)!
          yield* svc.updateMessage({
            id,
            sessionID,
            role: "assistant",
            parentID,
            mode: "build",
            agent: "build",
            path: { cwd: directory, root: directory },
            cost: steps.reduce((sum, step) => sum + step.cost, 0),
            tokens: last.tokens,
            modelID: MODEL,
            providerID: PROVIDER,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
            ...(summary ? { summary: true } : {}),
          })
          for (const step of steps) {
            yield* svc.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "step-start" })
            yield* svc.updatePart({
              id: PartID.ascending(),
              sessionID,
              messageID: id,
              type: "step-finish",
              reason: "stop",
              cost: step.cost,
              tokens: step.tokens,
            })
          }
          return id
        }),
      ),
    )

  const remove = (sessionID: SessionID, messageID: MessageID) =>
    run(SessionNs.Service.use((svc) => svc.removeMessage({ sessionID, messageID })))

  return { user, assistant, remove }
}

/** What the OLD `sendUpdate` put in the frame: a full read, the newest
 *  assistant message, and the sum of every assistant message's cost. */
async function fullRead(sdk: OrigamiClient, sessionID: string, directory: string) {
  const all = ((await sdk.session.messages({ sessionID, directory }, { throwOnError: true })).data ??
    []) as readonly UsageService.SessionMessage[]
  const latest = UsageService.latestAssistantMessage(all)
  if (!latest || (latest as { summary?: boolean }).summary === true) return undefined
  const cache = latest.tokens.cache
  return {
    used: latest.tokens.input + cache.read,
    cost: UsageService.totalSessionCost(all),
    cache: cache.read > 0 || cache.write > 0 ? { read: cache.read, write: cache.write } : undefined,
  }
}

/** What the NEW `sendUpdate` sends, over the same store. Only the provider list
 *  is stubbed, to give the test model a context size. */
async function frame(sdk: OrigamiClient, sessionID: string, directory: string) {
  const updates: SessionNotification[] = []
  const usage = UsageService.makeUsageService(
    {
      session: sdk.session,
      config: {
        providers: () =>
          Promise.resolve({ data: { providers: [{ id: PROVIDER, models: { [MODEL]: { limit: { context: 1_000_000 } } } }] } }),
      },
    } as unknown as OrigamiClient,
    () => null,
  )
  await Effect.runPromise(
    usage.sendUpdate({
      connection: { sessionUpdate: (update) => (updates.push(update), Promise.resolve()) },
      sessionID,
      directory,
    }),
  )
  const update = updates[0]?.update as
    | { used: number; cost: { amount: number }; _meta?: { cache?: { read: number; write: number } } }
    | undefined
  if (!update) return undefined
  return { used: update.used, cost: update.cost.amount, cache: update._meta?.cache }
}

describe("usage_update from a bounded read equals the old full read", () => {
  it.instance(
    "through turns, compaction, a revert and a sub-agent",
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sdk = yield* sdkFor(directory)
      const seed = seeder(directory)
      const created = yield* Effect.promise(() => sdk.session.create({ directory }, { throwOnError: true }))
      const sessionID = SessionID.make(created.data!.id)
      const check = Effect.fn("check")(function* (step: string, expectSent = true) {
        const before = yield* Effect.promise(() => fullRead(sdk, sessionID, directory))
        const after = yield* Effect.promise(() => frame(sdk, sessionID, directory))
        expect(after, step).toEqual(before)
        if (expectSent) expect(after, step).toBeDefined()
      })

      // Two turns; the second is a tool loop of three billed steps.
      const u1 = yield* seed.user(sessionID)
      yield* seed.assistant(sessionID, u1, [{ cost: 0.25, tokens: tokens(1_000, 0, 200) }])
      yield* check("first turn")
      const u2 = yield* seed.user(sessionID)
      yield* seed.assistant(sessionID, u2, [
        { cost: 0.125, tokens: tokens(1_200, 900) },
        { cost: 0.0625, tokens: tokens(1_300, 1_100) },
        { cost: 0.5, tokens: tokens(1_500, 1_250, 40) },
      ])
      yield* check("tool loop")

      // A newer user message with no reply yet: the gauge still reads the last assistant.
      yield* seed.user(sessionID)
      yield* check("queued user message")

      // /compact: the summariser's message is newest, so neither sends a frame.
      const c = yield* seed.user(sessionID, true)
      yield* seed.assistant(sessionID, c, [{ cost: 0.75, tokens: tokens(40_000, 0) }], true)
      yield* check("compaction summary is newest", false)
      const u3 = yield* seed.user(sessionID)
      yield* seed.assistant(sessionID, u3, [{ cost: 0.03125, tokens: tokens(900, 600) }])
      yield* check("first turn after compaction")

      // A sub-agent's spend lands on its own row, not in the parent's cost.
      const child = yield* Effect.promise(() =>
        sdk.session.create({ directory, parentID: sessionID }, { throwOnError: true }),
      )
      const childID = SessionID.make(child.data!.id)
      const cu = yield* seed.user(childID)
      yield* seed.assistant(childID, cu, [{ cost: 2, tokens: tokens(5_000, 0) }])
      yield* check("after a sub-agent ran")

      // Revert the last turn: the revert cleanup removes whole messages.
      const u4 = yield* seed.user(sessionID)
      const a4 = yield* seed.assistant(sessionID, u4, [{ cost: 4, tokens: tokens(2_000, 1_000) }])
      yield* check("turn to be reverted")
      yield* seed.remove(sessionID, a4)
      yield* seed.remove(sessionID, u4)
      yield* check("after the revert")

      // The row really is the running total, not a coincidence of zeros.
      const row = yield* Effect.promise(() => sdk.session.get({ sessionID, directory }, { throwOnError: true }))
      expect(row.data!.cost).toBeCloseTo(0.25 + 0.125 + 0.0625 + 0.5 + 0.75 + 0.03125, 10)
    }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

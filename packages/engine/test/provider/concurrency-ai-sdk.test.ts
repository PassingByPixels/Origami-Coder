import { afterEach, beforeEach, expect } from "bun:test"
import { createServer, type Server, type ServerResponse } from "node:http"
import { streamText } from "ai"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Effect, Fiber } from "effect"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderConcurrency } from "@/provider/concurrency"
import { SessionProviderQueue } from "@/session/provider-queue"

/**
 * t-fijy8a F2. `max_concurrent` on an AI-SDK provider (local vLLM / LM Studio —
 * the case the cap was built for) took its permit with NO options: no parent
 * priority and no queue notice, so t-52cxcw acceptance 2 and 3 held only on the
 * native runtime.
 *
 * These run through the real seam: the provider service builds the SDK client,
 * `streamText` sends the step's headers, a real HTTP server parks the request
 * inside the permit-protected region, and the order requests REACH THE SERVER is
 * the order permits were granted. The identity headers are the ones
 * `session/llm/request.ts` puts on every step.
 */

let parked: ParkedServer | undefined

afterEach(async () => {
  parked?.releaseAll()
  parked?.server.close()
  parked = undefined
  await disposeAllInstances()
})

beforeEach(() => {
  ProviderConcurrency.resetProviderSemaphores()
  SessionProviderQueue.resetProviderQueueListeners()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

it.live("serves a parent step ahead of every queued child on the AI-SDK path", () =>
  Effect.gen(function* () {
    const server = yield* Effect.promise(() => parkedServer())
    parked = server

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)

          const child1 = yield* Effect.forkScoped(run(language, "child-1", "root"))
          yield* settle()
          expect(server.arrivals).toEqual(["child-1"])

          const child2 = yield* Effect.forkScoped(run(language, "child-2", "root"))
          const child3 = yield* Effect.forkScoped(run(language, "child-3", "root"))
          yield* settle()
          // The parent arrives LAST and still goes next.
          const parent = yield* Effect.forkScoped(run(language, "root"))
          yield* settle()
          expect(server.arrivals).toEqual(["child-1"])

          server.releaseOne()
          yield* settle()
          expect(server.arrivals).toEqual(["child-1", "root"])

          server.releaseAll()
          yield* settle()
          server.releaseAll()
          yield* settle()
          server.releaseAll()
          const texts = yield* Effect.forEach([parent, child1, child2, child3], (fiber) => Fiber.join(fiber), {
            concurrency: "unbounded",
          })
          expect(texts).toEqual(["ok", "ok", "ok", "ok"])
        }),
      { config: providerConfig(server.url, { max_concurrent: 1 }) },
    )
  }),
)

it.live("publishes a provider-queue wait for a queued AI-SDK request, and none for one that runs straight away", () =>
  Effect.gen(function* () {
    const server = yield* Effect.promise(() => parkedServer())
    parked = server
    const seen: string[] = []
    SessionProviderQueue.onProviderQueue((event) =>
      seen.push(
        event.state.type === "waiting"
          ? `${event.sessionID}:waiting:${event.state.ahead}`
          : `${event.sessionID}:started`,
      ),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const language = yield* provider.getLanguage(model)

          const first = yield* Effect.forkScoped(run(language, "child-1", "root"))
          yield* settle()
          expect(seen).toEqual([])

          const second = yield* Effect.forkScoped(run(language, "child-2", "root"))
          yield* settle()
          const third = yield* Effect.forkScoped(run(language, "child-3", "root"))
          yield* settle()
          expect(seen).toEqual(["child-2:waiting:0", "child-3:waiting:1"])

          server.releaseAll()
          yield* settle()
          server.releaseAll()
          yield* settle()
          server.releaseAll()
          yield* Effect.forEach([first, second, third], (fiber) => Fiber.join(fiber), { concurrency: "unbounded" })
          expect(seen.filter((line) => line.endsWith(":started")).sort()).toEqual([
            "child-2:started",
            "child-3:started",
          ])
        }),
      { config: providerConfig(server.url, { max_concurrent: 1 }) },
    )
  }),
)

function run(language: Parameters<typeof streamText>[0]["model"], sessionID: string, parentSessionID?: string) {
  return Effect.promise(
    () =>
      streamText({
        model: language,
        onError() {},
        messages: [{ role: "user", content: "hello" }],
        headers: {
          // Exactly what session/llm/request.ts sends for a step.
          "x-session-affinity": sessionID,
          "X-Session-Id": sessionID,
          ...(parentSessionID ? { "x-parent-session-id": parentSessionID } : {}),
        },
      }).text,
  )
}

/** Real-timer settle: the semaphore hands a permit on directly rather than on a
 *  tick, and a request still has to cross a loopback socket. */
const settle = (times = 10) =>
  Effect.promise(async () => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  })

type ParkedServer = {
  readonly server: Server
  readonly url: string
  /** Session ids in the order their requests reached the server. */
  readonly arrivals: string[]
  readonly releaseOne: () => boolean
  readonly releaseAll: () => void
}

/**
 * A server that parks every request until the test lets it go, so the window a
 * permit is held for is under the test's control and "reached the server" is an
 * observation, not an inference.
 */
async function parkedServer(): Promise<ParkedServer> {
  const held: ServerResponse[] = []
  const arrivals: string[] = []
  const finish = (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  }
  const server = createServer((req, res) => {
    const id = req.headers["x-session-id"]
    arrivals.push(typeof id === "string" ? id : "(none)")
    held.push(res)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    arrivals,
    releaseOne: () => {
      const res = held.shift()
      if (!res) return false
      finish(res)
      return true
    },
    releaseAll: () => {
      while (held.length) finish(held.shift()!)
    },
  }
}

function providerConfig(url: string, options: Record<string, unknown> = {}) {
  const config = testProviderConfig(url)
  return {
    ...config,
    provider: {
      test: {
        ...config.provider.test,
        options: { ...config.provider.test.options, ...options },
      },
    },
  }
}

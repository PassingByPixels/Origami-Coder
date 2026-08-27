// origami_change: WHICH credential reaches the wire, and whether a second
// resolution can be served a client built with the first one.
//
// Both defects here were invisible to every existing provider test because they
// only show up in the REQUEST. `provider.options` can look perfectly correct
// while the header is empty, and two `getLanguage` calls can look independent
// while the second is a memo hit. So these tests assert on what a real
// `node:http` server actually received, not on the state that produced it.

import { expect } from "bun:test"
import { createServer, type Server } from "node:http"
import { streamText } from "ai"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Effect } from "effect"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"

// NO root-level `afterEach(disposeAllInstances)` here, deliberately, even though
// the neighbouring header-timeout.test.ts has one. Bun attaches a file's
// top-level hooks to the run's ROOT scope, so a second copy fires a concurrent
// process-wide instance teardown after EVERY test in the run - which interrupted
// the ACP refresh tests' fibers whenever both directories ran together
// ("All fibers interrupted without error", reproducible 3/3 with the hook, 0/3
// without). `provideTmpdirInstance` already scopes each instance to its own
// test, so nothing here needs the global sweep.
const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")

it.live("an empty-string apiKey does not shadow the stored credential", () =>
  Effect.gen(function* () {
    const capture = yield* captureServer()

    yield* withAuthContent(
      // A credential really is on file for this provider — the case a user is in
      // after `origami providers login`, or after the shell's OAuth completion.
      { test: { type: "api", key: "sk-from-auth" } },
      provideTmpdirInstance(() => ask(), { config: keyedConfig(capture.url, "") }),
    )

    // `options.apiKey === undefined` treated `""` as a credential and stopped
    // here, so `provider.key` never got a look in and the request went out with
    // an EMPTY bearer token.
    expect(capture.seen.at(-1)?.authorization).toBe("Bearer sk-from-auth")
  }),
)

it.live("an empty-string apiKey with nothing to fall back to sends no bearer at all", () =>
  Effect.gen(function* () {
    const capture = yield* captureServer()

    yield* provideTmpdirInstance(() => ask(), { config: keyedConfig(capture.url, "") })

    // CHARACTERISATION, not a red-first proof: this holds before and after the
    // falsy check, and it is recorded because the behaviour was ASSUMED to be
    // an empty `Authorization: Bearer ` and measured to be no header at all.
    // It is the guard for the other direction — an "empty key" fix that
    // substituted a placeholder, or an SDK bump that starts emitting a bearer
    // with nothing after it, both land here.
    expect(capture.seen.at(-1)?.authorization).toBeUndefined()
  }),
)

it.live("a real apiKey is still what reaches the wire", () =>
  Effect.gen(function* () {
    const capture = yield* captureServer()

    yield* provideTmpdirInstance(() => ask(), { config: keyedConfig(capture.url, "sk-configured") })

    // The guard on the two tests above: the falsy check must not have made
    // every config key fall through to auth.json.
    expect(capture.seen.at(-1)?.authorization).toBe("Bearer sk-configured")
  }),
)

it.live("two resolutions whose credentials differ get different clients", () =>
  Effect.gen(function* () {
    const capture = yield* captureServer()

    const [first, second] = yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(providerID, modelID)
          // Same providerID and same model id, DIFFERENT credential — which is
          // exactly what the language-model memo was keyed blind to.
          const one = yield* generate({ ...model, headers: { "x-api-key": "key-one" } })
          const two = yield* generate({ ...model, headers: { "x-api-key": "key-two" } })
          return [one, two] as const
        }),
      { config: keyedConfig(capture.url, "sk-configured") },
    )

    // The SDK map below `getLanguage` hashes the resolved options, so it would
    // have built a second client — but nothing ever asked it to. The memo above
    // it answered `providerID/modelID` from the first call and the second
    // credential never left the process.
    expect(first).not.toBe(second)
    expect(capture.seen.at(-2)?.["x-api-key"]).toBe("key-one")
    expect(capture.seen.at(-1)?.["x-api-key"]).toBe("key-two")
  }),
)

/** Resolve the configured test model and make one real request with it. */
const ask = () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(providerID, modelID)
    return yield* generate(model)
  })

/** One real generation, so the assertion is about a request that was SENT. */
const generate = (model: Provider.Model) =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const language = yield* provider.getLanguage(model)
    const result = streamText({ model: language, messages: [{ role: "user", content: "hello" }], onError() {} })
    yield* Effect.promise(() => result.text)
    return language
  })

function keyedConfig(url: string, apiKey: string) {
  const config = testProviderConfig(url)
  return {
    ...config,
    provider: {
      test: {
        ...config.provider.test,
        options: { ...config.provider.test.options, apiKey },
      },
    },
  }
}

type Seen = Record<string, string | undefined>

/** A real endpoint that RECORDS what it was sent, then answers a one-token SSE. */
function captureServer() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const seen: Seen[] = []
      const server = createServer((req, res) => {
        seen.push({
          authorization: req.headers["authorization"] as string | undefined,
          "x-api-key": req.headers["x-api-key"] as string | undefined,
        })
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
      return { server: server as Server, url: `http://127.0.0.1:${address.port}`, seen }
    }),
    (capture) => Effect.sync(() => capture.server.close()),
  )
}

/** Seed auth.json content for the run, exactly as header-timeout.test.ts does. */
function withAuthContent<A, E, R>(value: Record<string, unknown>, self: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.ORIGAMI_AUTH_CONTENT
      process.env.ORIGAMI_AUTH_CONTENT = JSON.stringify(value)
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.ORIGAMI_AUTH_CONTENT
        else process.env.ORIGAMI_AUTH_CONTENT = previous
      }),
  )
}

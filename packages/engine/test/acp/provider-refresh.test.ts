// origami_change (provider_refresh): a credential written while the engine is
// ALREADY RUNNING has to reach the wire without a restart.
//
// The shell writes `provider.<id>.options.apiKey` into origami.json itself and
// the engine has no way to notice: the global file is cached with
// `Duration.infinity`, the merged per-instance config and the provider list are
// `InstanceState` entries with no TTL, and there is no watcher on the config
// directory. "Reload the window" was the only cure, and that is the thing this
// ext method exists to remove.
//
// Both tests here assert on the `Authorization` header a REAL server received,
// because that is the only place the answer is unambiguous - `provider.options`
// can hold the new key while a memoised client still sends the old one. Each
// one also asserts the STALE reading in the middle: without that step the test
// could pass on a build where nothing was ever cached, and would then be
// proving nothing about the mechanism it is named after.

import { afterAll, describe, expect, it } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import { createServer, type Server } from "node:http"
import fs from "fs/promises"
import path from "path"
import { streamText } from "ai"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Global } from "@origami/core/global"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Provider } from "@/provider/provider"
import { tmpdir } from "../fixture/fixture"

const created: InstanceContext[] = []

afterAll(async () => {
  for (const ctx of created) await InstanceRuntime.disposeInstance(ctx).catch(() => undefined)
})

describe("provider_refresh through the real ACP service", () => {
  it("a key rewritten in the instance config goes live on the call, not before it", async () => {
    const capture = await captureServer()
    const dir = await tmpdir({ git: true, config: providerConfig("test", capture.url, "old-key") })
    await using _dir = dir
    try {
      const ctx = await InstanceRuntime.load({ directory: dir.path })
      created.push(ctx)

      await ask(ctx, "test", "test-model")
      expect(capture.seen.at(-1)).toBe("Bearer old-key")

      // The connect flow: the shell rewrites the provider block on disk while
      // this engine keeps running.
      await writeConfig(path.join(dir.path, "origami.json"), providerConfig("test", capture.url, "new-key"))

      // Nothing notices on its own. This assertion is the defect, pinned.
      await ask(ctx, "test", "test-model")
      expect(capture.seen.at(-1)).toBe("Bearer old-key")

      const service = makeService()
      expect(await Effect.runPromise(service.providerRefresh({ cwd: dir.path }))).toEqual({ ok: true })

      await ask(ctx, "test", "test-model")
      expect(capture.seen.at(-1)).toBe("Bearer new-key")
    } finally {
      capture.server.close()
    }
  }, 120_000)

  // The GLOBAL file is the one the extension's connect flow actually writes, and
  // it is cached separately from everything above - `Effect.cachedInvalidateWithTTL`
  // at `Duration.infinity` (config/config.ts). Invalidating the instance alone
  // would leave that cache serving the old file forever, so it gets its own test.
  it("a key rewritten in the GLOBAL config file goes live too", async () => {
    const capture = await captureServer()
    const file = path.join(Global.Path.config, "origami.json")
    const previous = await fs.readFile(file, "utf8").catch(() => undefined)
    const dir = await tmpdir({ git: true })
    await using _dir = dir
    const service = makeService()
    try {
      await writeConfig(file, providerConfig("globalrefresh", capture.url, "global-old"))
      const ctx = await InstanceRuntime.load({ directory: dir.path })
      created.push(ctx)
      // SETUP, not an assertion: an earlier test file in this process may have
      // already filled the process-wide global cache, and this test is about the
      // SECOND write, not the first.
      await Effect.runPromise(service.providerRefresh({ cwd: dir.path }))

      await ask(ctx, "globalrefresh", "test-model")
      expect(capture.seen.at(-1)).toBe("Bearer global-old")

      await writeConfig(file, providerConfig("globalrefresh", capture.url, "global-new"))
      await ask(ctx, "globalrefresh", "test-model")
      expect(capture.seen.at(-1)).toBe("Bearer global-old")

      await Effect.runPromise(service.providerRefresh({ cwd: dir.path }))
      await ask(ctx, "globalrefresh", "test-model")
      expect(capture.seen.at(-1)).toBe("Bearer global-new")
    } finally {
      // Put the file back and BUST THE CACHE, or every later test file in this
      // process inherits a provider pointing at a socket that is about to close.
      if (previous === undefined) await fs.rm(file, { force: true }).catch(() => undefined)
      else await fs.writeFile(file, previous)
      await Effect.runPromise(service.providerRefresh({ cwd: dir.path })).catch(() => undefined)
      capture.server.close()
    }
  }, 120_000)

  // The mid-turn safety property — that this refresh cannot orphan a running
  // turn — is the subject of provider-refresh-live-turn.test.ts. It lives in its
  // own file because loading the session graph here made these two tests
  // fiber-interrupt under a specific three-file combination; that file says which.
})

/**
 * Resolve a model and make one real request with it, in the given instance.
 *
 * KNOWN HARNESS INTERACTION, not a property of this feature. Run with
 * `interject-instance.test.ts` and ONLY that file, this rejects with "All fibers
 * interrupted without error" in roughly two runs out of three: that test forks
 * turns on `Effect.never` and force-interrupts them at teardown, which kills the
 * process-wide `AppRuntime` every later file resolves services through. Bisected
 * to exactly those two files; adding a test/provider module is not required, and
 * neither an immediate retry nor a 5x50ms backoff recovers it (measured), which
 * is why there is no retry here — the runtime is gone, not busy.
 *
 * Green alone, green across `./test/acp`, and green in the full 351-file suite
 * twice. The root cause is in the other file's teardown and is reported rather
 * than patched around here.
 */
function ask(ctx: InstanceContext, providerID: string, modelID: string) {
  const effect: Effect.Effect<void, never, AppServices> = Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))
    const language = yield* provider.getLanguage(model)
    const result = streamText({ model: language, messages: [{ role: "user", content: "hello" }], onError() {} })
    yield* Effect.promise(() => result.text)
  }).pipe(Effect.orDie)
  return AppRuntime.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))
}

/**
 * The ACP service with a stub sdk. `providerRefresh` never touches the sdk - it
 * does its work IN the instance, which is the whole point of the design - so
 * the stub is only what `make` needs to exist.
 */
function makeService() {
  const sdk = {
    config: {
      providers: () => Promise.resolve({ data: { providers: [], default: {} } }),
      get: () => Promise.resolve({ data: {} }),
      refresh: () => Promise.resolve({ data: true }),
    },
    app: { agents: () => Promise.resolve({ data: [] }), skills: () => Promise.resolve({ data: [] }) },
    command: { list: () => Promise.resolve({ data: [] }) },
    session: { list: () => Promise.resolve({ data: [] }) },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: (_update: SessionNotification) => Promise.resolve(),
    extNotification: () => Promise.resolve(),
  } as unknown as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
  return ACPService.make({ sdk, connection })
}

const writeConfig = (file: string, config: object) => fs.writeFile(file, JSON.stringify(config, null, 2))

/** One openai-compatible provider pointed at the capture server. */
function providerConfig(id: string, url: string, apiKey: string) {
  return {
    provider: {
      [id]: {
        name: id,
        id,
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey, baseURL: url },
      },
    },
  }
}

/** A real endpoint that records the Authorization it was sent. */
async function captureServer() {
  const seen: (string | undefined)[] = []
  const server: Server = createServer((req, res) => {
    seen.push(req.headers["authorization"] as string | undefined)
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}`, seen }
}

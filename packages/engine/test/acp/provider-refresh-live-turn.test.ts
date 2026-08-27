// origami_change (provider_refresh): THE HAZARD THE DESIGN EXISTS TO AVOID.
//
// A connect can land while a turn is streaming. The obvious implementation —
// reuse the HTTP `config.refresh` route that the setModel self-heal already
// calls (`acp/service.ts` resolveConfiguredModel) — would DISPOSE the whole
// instance: `markInstanceForDisposal` -> `InstanceStore.dispose` -> every
// registered disposer, which is every `InstanceState` in the process,
// `SessionRunState` included. The running turn would be orphaned by a user
// pasting an API key in another pane.
//
// `SessionRunState` is per-instance state, so "is this session still busy
// afterwards" is a direct read of whether the instance survived. Proved by
// mutation: swapping the ext method's body for `store.disposeDirectory(cwd)`
// turns this red ("Expected: true / Received: false") while the credential
// tests next door stay green — which is exactly the trap, a disposal LOOKS
// like it works.
//
// SEPARATE FILE, not a third case in provider-refresh.test.ts, and not for
// tidiness: importing `@/session/*` into that file made its two credential
// tests fail with "All fibers interrupted without error" whenever
// interject-instance.test.ts and any test/provider module were in the same run
// (reproducible 3/3; bisected to that exact trio). The credential assertions do
// not need the session graph, so they no longer load it.

import { afterAll, expect, it } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import { createServer, type Server } from "node:http"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { tmpdir } from "../fixture/fixture"

const created: InstanceContext[] = []

afterAll(async () => {
  for (const ctx of created) await InstanceRuntime.disposeInstance(ctx).catch(() => undefined)
})

it("provider_refresh does not tear down a session that is mid-turn", async () => {
  const capture = await captureServer()
  const dir = await tmpdir({ git: true, config: providerConfig(capture.url) })
  await using _dir = dir
  try {
    const ctx = await InstanceRuntime.load({ directory: dir.path })
    created.push(ctx)
    const info = await runIn(
      ctx,
      Session.Service.use((sessions) =>
        sessions.create({ model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") } }),
      ),
    )
    const sessionID = SessionID.make(info.id)

    // The same latch a real turn holds, with work that never settles.
    const turn = AppRuntime.runFork(
      SessionRunState.Service.use((state) => state.ensureRunning(sessionID, Effect.never, Effect.never)).pipe(
        Effect.provideService(InstanceRef, ctx),
      ),
    )
    try {
      for (let i = 0; i < 200; i++) {
        if (await busyNow(ctx, sessionID)) break
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(await busyNow(ctx, sessionID)).toBe(true)

      await Effect.runPromise(makeService().providerRefresh({ cwd: dir.path }))

      // Still running. The credential caches were dropped; the turn was not.
      expect(await busyNow(ctx, sessionID)).toBe(true)
    } finally {
      await runIn(ctx, SessionRunState.Service.use((state) => state.cancel(sessionID))).catch(() => undefined)
      turn.interruptUnsafe?.()
    }
  } finally {
    capture.server.close()
  }
}, 120_000)

/** Run engine work in the instance, as `inInstance` does inside the service. */
const runIn = <A, E>(ctx: InstanceContext, effect: Effect.Effect<A, E, AppServices>) =>
  AppRuntime.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))

/** Read busy exactly as `SessionPrompt.interject` reads it. */
const busyNow = (ctx: InstanceContext, sessionID: SessionID) =>
  runIn(
    ctx,
    SessionRunState.Service.use((state) => state.assertNotBusy(sessionID)).pipe(
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    ),
  )

/** The ACP service with a stub sdk — `providerRefresh` never touches it. */
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

function providerConfig(url: string) {
  return {
    provider: {
      test: {
        name: "test",
        id: "test",
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
        options: { apiKey: "turn-key", baseURL: url },
      },
    },
  }
}

/** A quiet endpoint so nothing here depends on a live model. */
async function captureServer() {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

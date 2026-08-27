// origami_change (interject): the ACP seam, not the dispatch seam.
//
// `acp/agent.ts` runs every request on a BARE fiber (`Effect.runPromise`), so
// nothing on it carries `InstanceRef`. Every engine service that keeps
// per-project state reads that reference through `InstanceState`, which DIES
// ("InstanceRef not provided") when it is absent - and `request()` launders the
// defect into `ServiceFailureError("Origami service failure")`, discarding the
// cause. So a handler that runs engine work on the process-wide AppRuntime
// without loading the session's instance first cannot work at all, and cannot
// say why.
//
// These tests drive the REAL service (`ACPService.make`) against a real engine
// instance and assert the interjection LANDS - in both states, because the
// failure sat upstream of the busy/idle split and took both with it.

import { afterAll, describe, expect, it } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Interject } from "@/origami/interject"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { tmpdir } from "../fixture/fixture"

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")

const model = {
  id: modelID,
  providerID,
  api: { id: modelID, url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
  name: "Test Model",
  family: "test",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: { default: {} },
}

/**
 * The ACP session registry is fed by `sdk.session.create`, so pointing it at a
 * REAL engine session id is what makes `interject` address the same session the
 * engine holds - which is the whole point of the path under test.
 */
function makeService(sessionId: string) {
  const sdk = {
    config: {
      providers: () =>
        Promise.resolve({
          data: {
            providers: [
              { id: providerID, name: "Test", source: "config", env: [], options: {}, models: { [modelID]: model } },
            ],
            default: { test: modelID },
          },
        }),
      get: () => Promise.resolve({ data: {} }),
      refresh: () => Promise.resolve({ data: true }),
    },
    app: {
      agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
      skills: () => Promise.resolve({ data: [] }),
    },
    command: { list: () => Promise.resolve({ data: [] }) },
    session: {
      create: () => Promise.resolve({ data: { id: sessionId } }),
      get: () => Promise.resolve({ data: { id: sessionId } }),
      list: () => Promise.resolve({ data: [] }),
      messages: () => Promise.resolve({ data: [] }),
      todo: () => Promise.resolve({ data: [] }),
    },
    mcp: { add: () => Promise.resolve({ data: {} }) },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: (_update: SessionNotification) => Promise.resolve(),
    extNotification: () => Promise.resolve(),
  } as unknown as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
  return ACPService.make({ sdk, connection })
}

/** The instance context the engine services key their per-project state on. */
const inInstance = <A, E>(ctx: InstanceContext, effect: Effect.Effect<A, E, AppServices>) =>
  AppRuntime.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))

const created: InstanceContext[] = []

afterAll(async () => {
  for (const ctx of created) await InstanceRuntime.disposeInstance(ctx).catch(() => undefined)
})

async function makeChat() {
  const dir = await tmpdir({ git: true })
  const ctx = await InstanceRuntime.load({ directory: dir.path })
  created.push(ctx)
  const info = await inInstance(
    ctx,
    Session.Service.use((sessions) => sessions.create({ model: { id: modelID, providerID } })),
  )
  const service = makeService(info.id)
  const opened = await Effect.runPromise(service.newSession({ cwd: dir.path, mcpServers: [] }))
  return { dir, ctx, service, sessionId: opened.sessionId }
}

/** Read exactly as `SessionPrompt.interject` reads it. */
const busyNow = (ctx: InstanceContext, sessionID: SessionID) =>
  inInstance(
    ctx,
    SessionRunState.Service.use((state) => state.assertNotBusy(sessionID)).pipe(
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    ),
  )

const cancel = (ctx: InstanceContext, sessionID: SessionID) =>
  inInstance(ctx, SessionRunState.Service.use((state) => state.cancel(sessionID))).catch(() => undefined)

const textParts = (ctx: InstanceContext, sessionID: SessionID) =>
  inInstance(
    ctx,
    Session.Service.use((sessions) => sessions.messages({ sessionID })).pipe(
      Effect.map((msgs) =>
        msgs.flatMap((msg) => msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))),
      ),
      Effect.orDie,
    ),
  )

describe("interject through the real ACP service", () => {
  it("delivers into a session whose turn has NOT started yet (the first-prompt case)", async () => {
    const chat = await makeChat()
    await using _dir = chat.dir

    const reply = await Effect.runPromise(
      chat.service.interject({ sessionId: chat.sessionId, text: "excluding the vatican city" }),
    )

    expect(reply).toMatchObject({ delivered: true, busy: false })
    // The message itself is the delivery: `runLoop` re-reads the whole window at
    // the top of every step, so a user message on the transcript IS the
    // interjection reaching the turn.
    const parts = await textParts(chat.ctx, SessionID.make(chat.sessionId))
    expect(parts).toContain("excluding the vatican city")
    expect(parts).toContain(Interject.ENVELOPE)

    // The other half of the idle path: with nothing left to re-read the store,
    // `interject` FORKS the turn a plain send would have started
    // (session/prompt.ts). A forked fiber inherits the forking fiber's context,
    // so this also proves the instance reached the fork - if it had not, the
    // loop would die on the same missing reference, silently, and the user's
    // first message would sit in the transcript unanswered.
    let started = false
    for (let i = 0; i < 300 && !started; i++) {
      started = await busyNow(chat.ctx, SessionID.make(chat.sessionId))
      if (!started) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(started).toBe(true)
    await cancel(chat.ctx, SessionID.make(chat.sessionId))
  }, 120_000)

  it("delivers into a session that is BUSY with a turn, and reports it as busy", async () => {
    const chat = await makeChat()
    await using _dir = chat.dir

    // A real turn holds the session through `SessionRunState.ensureRunning`;
    // this is that same latch, with work that never settles.
    const turn = AppRuntime.runFork(
      SessionRunState.Service.use((state) =>
        state.ensureRunning(SessionID.make(chat.sessionId), Effect.never, Effect.never),
      ).pipe(Effect.provideService(InstanceRef, chat.ctx)),
    )
    for (let i = 0; i < 200; i++) {
      if (await busyNow(chat.ctx, SessionID.make(chat.sessionId))) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    try {
      const reply = await Effect.runPromise(
        chat.service.interject({ sessionId: chat.sessionId, text: "excluding the vatican city" }),
      )
      expect(reply).toMatchObject({ delivered: true, busy: true })
      const parts = await textParts(chat.ctx, SessionID.make(chat.sessionId))
      expect(parts).toContain("excluding the vatican city")
    } finally {
      await cancel(chat.ctx, SessionID.make(chat.sessionId))
      turn.interruptUnsafe?.()
    }
  }, 120_000)
})

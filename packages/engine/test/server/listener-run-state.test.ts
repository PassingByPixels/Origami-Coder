// origami_change (interject): the LISTENER seam.
//
// `Server.listen` is the only server path production takes (cli/cmd/acp.ts) and
// it built its service graph with a PRIVATE memo map
// (`Layer.buildWithMemoMap(..., Layer.makeMemoMapUnsafe(), scope)` in
// server/server.ts), while every ACP ext-method runs its engine work on the
// process-wide `AppRuntime`. Two graphs means two of every per-instance
// service for the same directory: two `SessionRunState`s, two `BackgroundJob`
// registries, two `Interject` waiter sets.
//
// What that cost, on 2026-08-20: a turn latched by an HTTP prompt was invisible
// to `SessionPrompt.interject`'s busy read (session/prompt.ts:1590), so an
// interjection sent mid-stream read "idle" and FORKED A SECOND TURN LOOP onto a
// session that was already streaming - two answers, character-interleaved in
// one bubble - and `task_list` in one loop reported "no background tasks" for a
// task the other loop had launched.
//
// Every other server test drives `HttpApiApp.webHandler()`, which already
// passes the module-wide `memoMap`; that is exactly why the split never
// surfaced in the suite. This test drives the listener.

import { afterAll, describe, expect, it } from "bun:test"
import { createServer } from "node:http"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Effect } from "effect"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRuntime } from "@/project/instance-runtime"
import { ServerAuth } from "@/server/auth"
import { Server } from "@/server/server"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { tmpdir } from "../fixture/fixture"

const created: InstanceContext[] = []

afterAll(async () => {
  for (const ctx of created) await InstanceRuntime.disposeInstance(ctx).catch(() => undefined)
})

const inInstance = <A, E>(ctx: InstanceContext, effect: Effect.Effect<A, E, AppServices>) =>
  AppRuntime.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))

/** A session the ACP side owns, in its own instance. */
async function acpSession() {
  const dir = await tmpdir({ git: true })
  const ctx = await InstanceRuntime.load({ directory: dir.path })
  created.push(ctx)
  const info = await inInstance(
    ctx,
    Session.Service.use((sessions) =>
      sessions.create({ model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") } }),
    ),
  )
  return { dir, ctx, sessionID: SessionID.make(info.id) }
}

const headersFor = () => ({ ...(ServerAuth.headers() ?? {}), "content-type": "application/json" })

/** Occupy a port so `startWithPortFallback` has to take its second attempt. */
function occupy(port: number) {
  return new Promise<{ close: () => Promise<void> } | undefined>((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(undefined))
    server.listen(port, "127.0.0.1", () =>
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())) }),
    )
  })
}

describe("Server.listen shares engine instances with the ACP side (AppRuntime)", () => {
  it("sees the ACP side's session, and its run-state latch, as its own", async () => {
    // The ACP side: `AppRuntime` + the session's instance, exactly as
    // `inInstance` (acp/service.ts:2364) resolves it for every ext-method.
    const { dir, ctx, sessionID } = await acpSession()
    await using _dir = dir
    const query = `?directory=${encodeURIComponent(dir.path)}`
    const headers = headersFor()

    // A real turn holds the session through this latch (session/prompt.ts
    // `loop` -> `SessionRunState.ensureRunning`), with work that never settles.
    const turn = AppRuntime.runFork(
      SessionRunState.Service.use((state) => state.ensureRunning(sessionID, Effect.never, Effect.never)).pipe(
        Effect.provideService(InstanceRef, ctx),
      ),
    )
    const busyNow = () =>
      inInstance(
        ctx,
        SessionRunState.Service.use((state) => state.assertNotBusy(sessionID)).pipe(
          Effect.as(false),
          Effect.catch(() => Effect.succeed(true)),
        ),
      )
    for (let i = 0; i < 200; i++) {
      if (await busyNow()) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(await busyNow()).toBe(true)

    const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    try {
      // 1. Same session registry. With two graphs this is a 404 - the listener
      //    has never heard of a session the ACP side created.
      const seen = await fetch(`${listener.url.origin}/session/${sessionID}${query}`, { headers })
      expect(seen.status).toBe(200)

      // 2. Same run-state. `deleteMessage` is the cheapest route that asserts it
      //    (handlers/session.ts:406); the message id need not exist, because the
      //    busy assertion runs first. With two graphs the listener sees an idle
      //    session and deletes - which is the same blindness that let `interject`
      //    start a second turn loop.
      const deleted = await fetch(`${listener.url.origin}/session/${sessionID}/message/msg_probe${query}`, {
        method: "DELETE",
        headers,
      })
      const body = await deleted.text()
      expect({ status: deleted.status, body }).toMatchObject({ status: 409 })
      expect(body).toContain("busy")
    } finally {
      await listener.stop(true)
      await inInstance(ctx, SessionRunState.Service.use((state) => state.cancel(sessionID))).catch(() => undefined)
      turn.interruptUnsafe?.()
    }
  }, 120_000)

  it("still shares when the port fallback has to build a listener twice", async () => {
    // `Server.listen({ port: 0 })` tries 4096 first and falls back
    // (startWithPortFallback). Sharing a memo map across a FAILED build is the
    // obvious way to get stale services, so drive that path on purpose.
    const held = await occupy(4096)
    const { dir, sessionID } = await acpSession()
    await using _dir = dir
    const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    try {
      expect(listener.port).not.toBe(4096)
      const seen = await fetch(
        `${listener.url.origin}/session/${sessionID}?directory=${encodeURIComponent(dir.path)}`,
        { headers: headersFor() },
      )
      expect(seen.status).toBe(200)
    } finally {
      await listener.stop(true)
      await held?.close()
    }
  }, 120_000)

  it("still shares after a listener is stopped and started again", async () => {
    // Effect's memo entries are reference counted, so stopping a listener must
    // not finalize services AppRuntime is still using. A restart that handed out
    // dead services would look exactly like the bug this file exists for.
    const { dir, ctx, sessionID } = await acpSession()
    await using _dir = dir
    const query = `?directory=${encodeURIComponent(dir.path)}`
    const first = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    await first.stop(true)

    const second = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    try {
      const seen = await fetch(`${second.url.origin}/session/${sessionID}${query}`, { headers: headersFor() })
      expect(seen.status).toBe(200)
      // The ACP side is still alive on the same instance after the restart.
      const stillThere = await inInstance(
        ctx,
        Session.Service.use((sessions) => sessions.get(sessionID)).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        ),
      )
      expect(stillThere).toBe(true)
    } finally {
      await second.stop(true)
    }
  }, 120_000)
})

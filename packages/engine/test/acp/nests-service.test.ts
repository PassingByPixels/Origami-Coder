// Nests L4a (t-s9jgzh) through the ACP service and the engine's own AppRuntime
// store (the test process's temp data dir, never the owner's store).
//
// The claim: a chat imported from another desk is READ ONLY here. Its index row
// names that desk as the owner and this desk as the holder, it is `open` (loaded
// in this connection) but never `running`, and a prompt into it is refused
// before the engine is asked to run a turn. A desk that never called a nest
// method pays nothing on the prompt path.
//
// The chunk comes from a separate store (desk A), exported by the real code.

import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { OrigamiClient } from "@origami/sdk/v2"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Database } from "@origami/core/database/database"
import { EventV2 } from "@origami/core/event"
import { SessionProjector } from "@origami/core/session/projector"
import { SessionV1 } from "@origami/core/v1/session"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import * as ACPError from "@/acp/error"
import * as ACPService from "@/acp/service"
import { AppRuntime } from "@/effect/app-runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, SessionID } from "@/session/schema"
import { StorageNests } from "@/storage/nests"

const DESK_A = "deskAAAAAAA"
const DESK_B = "deskBBBBBBB"
const SESSION = SessionID.make("ses_nests_service")

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")
const provider = {
  id: providerID,
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: {
    [modelID]: {
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
    },
  },
}

const makeService = () => {
  const prompts: Array<Record<string, unknown>> = []
  /** Every write the service sent to the engine, by SDK method (L5). */
  const writes: Array<{ method: string; input: Record<string, unknown> }> = []
  const wrote = (method: string) => (input: Record<string, unknown>) => {
    writes.push({ method, input })
    return Promise.resolve({ data: {} })
  }
  const sdk = {
    config: {
      providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
      get: () => Promise.resolve({ data: {} }),
    },
    app: {
      agents: () =>
        Promise.resolve({ data: [{ name: "build", mode: "primary", native: true, permission: [], options: {} }] }),
      skills: () => Promise.resolve({ data: [] }),
    },
    command: { list: () => Promise.resolve({ data: [] }) },
    session: {
      create: () => Promise.resolve({ data: { id: SESSION } }),
      get: () => Promise.resolve({ data: { id: SESSION } }),
      list: () => Promise.resolve({ data: [] }),
      messages: () => Promise.resolve({ data: [] }),
      // What an engine instance reports while a turn runs. The session is
      // imported, so this must NOT make its row `running`.
      status: () => Promise.resolve({ data: { [SESSION]: { type: "busy" } } }),
      prompt: (input: Record<string, unknown>) => {
        prompts.push(input)
        return Promise.resolve({
          data: {
            info: {
              id: "msg_1",
              role: "assistant",
              sessionID: SESSION,
              time: { created: 1, completed: 2 },
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID,
              providerID,
            },
          },
        })
      },
      update: wrote("session.update"),
      revert: wrote("session.revert"),
      unrevert: wrote("session.unrevert"),
      command: wrote("session.command"),
      summarize: wrote("session.summarize"),
      delete: wrote("session.delete"),
      abort: wrote("session.abort"),
    },
    mcp: { add: () => Promise.resolve({ data: {} }) },
  } as unknown as OrigamiClient
  return { service: ACPService.make({ sdk }), prompts, writes }
}

/** Desk A's store: one chat, exported whole. */
const chunkFromDeskA = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dir = mkdtempSync(path.join(process.env["XDG_DATA_HOME"] ?? os.tmpdir(), "nests-service-"))
        const store = yield* Layer.build(
          LayerNode.compile(LayerNode.group([Database.node, EventV2.node, EventV2Bridge.node, SessionProjector.node]), [
            [Database.node, Database.layerFromPath(path.join(dir, "desk-a.db"))],
          ]),
        )
        return yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          const events = yield* EventV2Bridge.Service
          yield* db
            .run(
              sql`INSERT INTO ${sql.identifier("project")} (id, worktree, sandboxes, time_created, time_updated)
                  VALUES ('prj_nests_service', '/tmp/nests', '[]', 1000, 1000)`,
            )
            .pipe(Effect.orDie)
          yield* events.publish(SessionV1.Event.Created, {
            sessionID: SESSION,
            info: {
              id: SESSION,
              slug: "nests",
              projectID: "prj_nests_service",
              directory: "/tmp/nests",
              title: "From the 5090",
              version: "0.0.0",
              cost: 0,
              time: { created: 1_000, updated: 1_000 },
            } as SessionV1.SessionInfo,
          })
          yield* events.publish(SessionV1.Event.MessageUpdated, {
            sessionID: SESSION,
            info: {
              id: MessageID.make("msg_nests_service"),
              sessionID: SESSION,
              role: "user",
              agent: "build",
              model: { providerID: "p", modelID: "m" },
              time: { created: 2_000 },
            } as SessionV1.Info,
          })
          const chunk = yield* StorageNests.exportChunk({
            deviceId: DESK_A,
            sessionId: SESSION,
            after: -1,
            maxBytes: 1 << 20,
          })
          return JSON.parse(JSON.stringify(chunk)) as unknown
        }).pipe(Effect.provide(store))
      }),
    ),
  )

/** Whether the engine's store has the Nests settings table (L5: a desk that
 *  never used Nests must not get it from the guard's restart read). */
const hasNestTables = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const row = yield* db
        .get<{ n: number }>(sql`SELECT count(*) AS n FROM sqlite_master WHERE name = 'nest_setting'`)
        .pipe(Effect.orDie)
      return (row?.n ?? 0) > 0
    }),
  )

const text = (value: string) => ({ sessionId: SESSION, prompt: [{ type: "text", text: value }] }) as never

describe("an imported chat on the ACP service", () => {
  it("is held here, owned by its desk, open but not running, and refuses a prompt", async () => {
    const { service, prompts, writes } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    expect(created.sessionId).toBe(SESSION)

    // No nest call yet: the prompt path reads nothing it creates, and writes go through.
    await Effect.runPromise(service.prompt({ sessionId: SESSION, prompt: [{ type: "text", text: "before" }] } as never))
    expect(prompts).toHaveLength(1)
    await Effect.runPromise(service.setSessionConfigOption({ sessionId: SESSION, configId: "title", value: "Mine" }))
    expect(writes.map((entry) => entry.method)).toEqual(["session.update"])
    expect(await hasNestTables()).toBe(false)

    const imported = await Effect.runPromise(service.nestImport({ deviceId: DESK_B, chunk: await chunkFromDeskA() }))
    expect(imported).toMatchObject({ sessionId: SESSION, done: true })
    expect(imported.refused).toBeUndefined()

    const index = await Effect.runPromise(service.nestIndex({ deviceId: DESK_B, deskName: "Surface", open: [] }))
    expect(index.rows.find((row) => row.id === SESSION)).toMatchObject({
      id: SESSION,
      title: "From the 5090",
      desk: DESK_B,
      deskName: "Surface",
      owner: DESK_A,
      state: "open",
      lastAt: 2_000,
      seq: imported.have,
    })

    const refused = await Effect.runPromise(
      service.prompt({ sessionId: SESSION, prompt: [{ type: "text", text: "after" }] } as never).pipe(Effect.flip),
    )
    expect(refused).toBeInstanceOf(ACPError.RefusalError)
    expect((refused as ACPError.RefusalError).service).toBe("nests")
    expect((refused as ACPError.RefusalError).safeMessage).toContain(DESK_A)
    expect(prompts).toHaveLength(1)
  })

  // L5 (t-sb9tlk). The tests below run on the same engine store, in order: the
  // session is now held here and written by desk A.

  it("refuses every write path into it with the nests RefusalError, and sends nothing to the engine", async () => {
    const { service, prompts, writes } = makeService()
    await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    await Effect.runPromise(service.nestIndex({ deviceId: DESK_B, deskName: "Surface", open: [] }))
    const config = (configId: string, value: string) =>
      service.setSessionConfigOption({ sessionId: SESSION, configId, value })
    // One entry per write path in the ACP method table (acp/agent.ts). A slash
    // command, `/compact`, a todo write and a shell run all enter through
    // `prompt`: none has its own ACP method.
    const paths: Array<[string, Effect.Effect<unknown, unknown>]> = [
      ["prompt", service.prompt(text("hello"))],
      ["prompt: command", service.prompt(text("/review main"))],
      ["prompt: compact", service.prompt(text("/compact"))],
      ["prompt: todo write", service.prompt(text("add a todo: ship L5"))],
      ["title", config("title", "Renamed here")],
      ["revert", config("revert", "msg_nests_service")],
      ["unrevert", config("unrevert", "")],
      ["subagentModel", config("subagentModel", "")],
      ["permission", config("permission", "bypass")],
      ["visionProfile", config("visionProfile", "")],
      ["compactionThreshold", config("compactionThreshold", "")],
      ["delete", service.sessionDelete({ sessionId: SESSION })],
      ["append", service.sessionAppendForeign({ sessionId: SESSION, source: "claude", messages: [] })],
      ["interject", service.interject({ sessionId: SESSION, text: "and also" })],
      ["shell stop", service.shellStop({ sessionId: SESSION, jobId: "job_1" })],
    ]
    for (const [name, effect] of paths) {
      const error = await Effect.runPromise(effect.pipe(Effect.flip))
      expect([name, error instanceof ACPError.RefusalError]).toEqual([name, true])
      expect([name, (error as ACPError.RefusalError).service]).toEqual([name, "nests"])
      expect((error as ACPError.RefusalError).safeMessage).toContain(DESK_A)
    }
    expect(prompts).toEqual([])
    expect(writes).toEqual([])
    // A connection-only option is not a write into the session: still allowed.
    await Effect.runPromise(config("temperature", "0.5"))
  })

  it("after a restart the guard holds before any nest call", async () => {
    // A new service is a new process's memory: no nest call has passed the gate.
    const { service, prompts } = makeService()
    await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const refused = await Effect.runPromise(service.prompt(text("after restart")).pipe(Effect.flip))
    expect(refused).toBeInstanceOf(ACPError.RefusalError)
    expect((refused as ACPError.RefusalError).service).toBe("nests")
    expect(prompts).toEqual([])
  })

  it("continue here takes it over; a release stops the turn and makes it read only again", async () => {
    const { service, prompts, writes } = makeService()
    await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const taken = await Effect.runPromise(
      service.nestContinue({ deviceId: DESK_B, sessionId: SESSION, ownerOnline: false, ownerRunning: false }),
    )
    expect(taken).toMatchObject({ result: "taken", sessionId: SESSION })
    await Effect.runPromise(service.prompt(text("mine now")))
    expect(prompts).toHaveLength(1)

    // The hand-over frame from desk A arrives here.
    const released = await Effect.runPromise(
      service.nestRelease({ deviceId: DESK_B, sessionId: SESSION, owner: DESK_A }),
    )
    expect(released).toMatchObject({ sessionId: SESSION, owner: DESK_A, aborted: true })
    // The existing turn stop: the same SDK call ACP `cancel` makes.
    expect(writes).toEqual([{ method: "session.abort", input: { directory: "/tmp/nests", sessionID: SESSION } }])
    const refused = await Effect.runPromise(service.prompt(text("too late")).pipe(Effect.flip))
    expect(refused).toBeInstanceOf(ACPError.RefusalError)
    expect(prompts).toHaveLength(1)
  })

  it("continue here while the owner runs a turn returns a writable fork", async () => {
    const { service, prompts } = makeService()
    await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const forked = await Effect.runPromise(
      service.nestContinue({ deviceId: DESK_B, sessionId: SESSION, ownerOnline: true, ownerRunning: true }),
    )
    if (!("result" in forked) || forked.result !== "forked") throw new Error(`not forked: ${JSON.stringify(forked)}`)
    expect(forked.sessionId).not.toBe(SESSION)
    expect(forked.forkOf).toMatchObject({ id: SESSION, desk: DESK_A })
    const index = await Effect.runPromise(service.nestIndex({ deviceId: DESK_B, deskName: "Surface", open: [] }))
    expect(index.rows.find((row) => row.id === forked.sessionId)).toMatchObject({
      owner: DESK_B,
      title: "From the 5090 (fork #1)",
      forkOf: forked.forkOf,
    })
    // The original is still desk A's.
    expect(
      (await Effect.runPromise(service.prompt(text("original")).pipe(Effect.flip))) instanceof ACPError.RefusalError,
    ).toBe(true)
    expect(prompts).toEqual([])
  })

  // t-tc2b6c. The guard fails CLOSED: when it cannot read which desk writes the
  // chat, the write is refused, and the failed read is not kept for the rest
  // of the process.
  it("refuses a write when the owner cannot be read, and reads again on the next call", async () => {
    const setDevice = (value: string) =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.run(sql`UPDATE nest_setting SET value = ${value} WHERE key = 'device'`).pipe(Effect.orDie)
        }),
      )
    // A new process's memory: the device id must come from the store, and the
    // stored value is broken.
    const { service, prompts } = makeService()
    await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    await setDevice("{broken")
    try {
      const refused = await Effect.runPromise(service.prompt(text("unreadable")).pipe(Effect.flip))
      expect(refused).toBeInstanceOf(ACPError.RefusalError)
      expect((refused as ACPError.RefusalError).service).toBe("nests")
      expect((refused as ACPError.RefusalError).safeMessage).toContain("could not be read")
      expect(prompts).toEqual([])
    } finally {
      await setDevice(JSON.stringify(DESK_B))
    }
    // Readable again: the same service now names the desk that writes it.
    const again = await Effect.runPromise(service.prompt(text("readable")).pipe(Effect.flip))
    expect((again as ACPError.RefusalError).safeMessage).toContain(DESK_A)
    expect(prompts).toEqual([])
  })
})

// t-wdybz9 (review finding 2): a peer message that reaches an engine WHILE it
// parks must not start a turn. The extension stops the process right after
// `_elastic_park` answers, so a turn admitted in that window was killed, and
// the sender had already been told "delivered".
//
// Tested on the real prompt_async ROUTE, like httpapi-peer-prompt.test.ts: the
// claim is about what the handler does with a POST, not about a helper.
// noReply keeps an LLM out of the test; on base the message is still created
// as a user message in the session, which is what the assertions count.

import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@origami/core/v1/session"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Database } from "@origami/core/database/database"
import { Ripgrep } from "@origami/core/ripgrep"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { peerMessageMetadata, resetPeerMessages } from "../../src/session/peer-message"
import { AgentBroker } from "../../src/origami/agent-broker"
import { ACPElastic } from "../../src/acp/elastic"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

function request(url: string, init?: RequestInit) {
  const parsed = new URL(url, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(parsed, init)).pipe(
    HttpClientRequest.setUrl(parsed.pathname),
    HttpClient.execute,
  )
}

function peerBody(text: string, id: string) {
  return JSON.stringify({
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    noReply: true,
    parts: [{ type: "text", text, metadata: peerMessageMetadata({ from: "peer", replyTo: "peer#ses_sender", id }) }],
  })
}

const userTexts = (sessionID: Session.Info["id"]) =>
  Session.use.messages({ sessionID }).pipe(
    Effect.orDie,
    Effect.map((messages) =>
      messages
        .filter((message) => message.info.role === "user")
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.TextPart => part.type === "text")
        .map((part) => part.text),
    ),
  )

let home: string
const saved: Record<string, string | undefined> = {}
const KEYS = ["ORIGAMI_TEST_HOME", "ORIGAMI_AGENT_NAME", "ORIGAMI_CLIENT", "ORIGAMI_AGENT_KIND"]

beforeEach(async () => {
  resetPeerMessages()
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "park-route-"))
  for (const key of KEYS) saved[key] = process.env[key]
  process.env.ORIGAMI_TEST_HOME = home
  process.env.ORIGAMI_AGENT_NAME = "sleeper"
  process.env.ORIGAMI_CLIENT = "acp"
  delete process.env.ORIGAMI_AGENT_KIND
})

afterEach(async () => {
  await ACPElastic.dispatch("elastic_unpark", {})?.catch(() => {})
  AgentBroker.attachSessions(() => [])
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await disposeAllInstances()
  await resetDatabase()
  await fsp.rm(home, { recursive: true, force: true })
})

const mailbox = (sessionID: string) =>
  fsp.readdir(path.join(home, ".origami", "agents", "mailbox", sessionID)).catch(() => [] as string[])

describe("prompt_async while the engine parks", () => {
  it.instance(
    "a message that lands during and after the park is kept in the mailbox and starts no turn",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-origami-directory": test.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "parking" })
        const other = yield* Session.use.create({ title: "not parked" })
        AgentBroker.attachSessions(() => [session.id])
        const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: test.directory })
        yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))
        const post = (sessionID: string, text: string, id: string) =>
          request(SessionPaths.promptAsync.replace(":sessionID", sessionID), {
            method: "POST",
            headers,
            body: peerBody(text, id),
          })

        // The park is not awaited: the POST races its file writes, which is
        // the window the review measured.
        const parking = ACPElastic.dispatch("elastic_park", { hostPid: process.pid })!
        const during = yield* post(session.id, "during", "id-during")
        const answer = yield* Effect.promise(() => parking)
        const after = yield* post(session.id, "after", "id-after")
        const elsewhere = yield* post(other.id, "elsewhere", "id-elsewhere")

        expect(answer).toEqual({ parked: true, sessionIds: [session.id] })
        // The sender is told it was accepted: it is, into the mailbox.
        expect(during.status).toBe(204)
        expect(after.status).toBe(204)
        // Control: leave parking (no admitter is attached, so nothing is
        // drained), then send one more. prompt_async forks in arrival order, so
        // once "control" is in the session a parked message that had started a
        // turn would be there too.
        yield* Effect.promise(() => ACPElastic.dispatch("elastic_unpark", {}) ?? Promise.resolve({}))
        expect((yield* post(session.id, "control", "id-control")).status).toBe(204)
        yield* pollWithTimeout(
          userTexts(session.id).pipe(Effect.map((texts) => texts.find((t) => t === "control"))),
          "the control message was never injected",
        )
        expect(yield* userTexts(session.id)).toEqual(["control"])
        // A session this engine did not park has no mailbox reader: refused.
        expect(elsewhere.status).toBe(400)
        expect(yield* userTexts(other.id)).toEqual([])
        const kept = yield* Effect.promise(() => mailbox(session.id))
        expect(kept).toHaveLength(2)
        const bodies = yield* Effect.promise(() =>
          Promise.all(
            kept
              .toSorted()
              .map(async (name) =>
                JSON.parse(
                  await fsp.readFile(path.join(home, ".origami", "agents", "mailbox", session.id, name), "utf8"),
                ),
              ),
          ),
        )
        expect(bodies.map((body: { parts: { text: string }[] }) => body.parts[0]!.text).toSorted()).toEqual([
          "after",
          "during",
        ])
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 20000 },
  )

  it.instance(
    "a kept message is admitted once through the route after unpark (the peer ledger did not see it at deposit)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-origami-directory": test.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "parking" })
        AgentBroker.attachSessions(() => [session.id])
        const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: test.directory })
        yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))
        const post = (text: string, id: string) =>
          request(SessionPaths.promptAsync.replace(":sessionID", session.id), {
            method: "POST",
            headers,
            body: peerBody(text, id),
          })
        yield* Effect.promise(() => ACPElastic.dispatch("elastic_park", { hostPid: process.pid })!)
        expect((yield* post("kept", "id-kept")).status).toBe(204)

        // Unparked: the engine's own drain posts the kept body to the route,
        // which admits it now. The same id posted again is the duplicate.
        const { AgentMailbox } = yield* Effect.promise(() => import("../../src/origami/agent-mailbox"))
        const context = yield* Effect.context<HttpClient.HttpClient>()
        AgentMailbox.attachAdmitter(() => async (body) => {
          const response = await Effect.runPromise(
            request(SessionPaths.promptAsync.replace(":sessionID", session.id), {
              method: "POST",
              headers,
              body: JSON.stringify(body),
            }).pipe(Effect.provide(context)),
          )
          if (response.status !== 204) throw new Error(`status ${response.status}`)
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => AgentMailbox.attachAdmitter(undefined)))
        const result = yield* Effect.promise(() => ACPElastic.dispatch("elastic_unpark", {})!)
        expect(result).toEqual({ unparked: true, delivered: 1 })
        expect((yield* post("kept", "id-kept")).status).toBe(204)
        yield* Effect.sleep("300 millis")
        expect(yield* userTexts(session.id)).toEqual(["kept"])
        expect(yield* Effect.promise(() => mailbox(session.id))).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 20000 },
  )
})

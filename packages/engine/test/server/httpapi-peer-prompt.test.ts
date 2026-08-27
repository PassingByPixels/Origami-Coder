// The RECEIVER half of peer messaging (t-kgu05m), tested where it actually
// lives: the prompt_async ROUTE.
//
// test/session/peer-message.test.ts proves the ledger's logic in isolation by
// calling duplicatePeerPrompt() as a pure function. That is a different claim
// from the one the feature makes. The claim that matters is that the HTTP
// handler CALLS it — delete the guard in handlers/session.ts and every pure
// test stays green while a peer's re-send is injected into the chat twice.
// So this file posts the real payload tool/agents.ts posts, over the real
// router, and counts what landed in the session.
//
// noReply is set for one reason, named so the next reader does not mistake it
// for the thing under test: the guard runs BEFORE promptSvc.prompt, so
// stopping after the user message is created removes an LLM from the test
// without moving the line being exercised.

import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@origami/core/v1/session"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Database } from "@origami/core/database/database"
import { Ripgrep } from "@origami/core/ripgrep"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { peerMessageMetadata, resetPeerMessages } from "../../src/session/peer-message"
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

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

/** Exactly the body tool/agents.ts builds, minus the prose wrapper. */
function peerBody(input: { text: string; id?: string }) {
  return JSON.stringify({
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    noReply: true,
    parts: [
      {
        type: "text",
        text: input.text,
        ...(input.id
          ? { metadata: peerMessageMetadata({ from: "peer", replyTo: "peer#ses_sender", id: input.id }) }
          : {}),
      },
    ],
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

beforeEach(() => {
  // Process-wide module state: without this, an id claimed by an earlier test
  // file in the same bun process would make the FIRST delivery here a repeat.
  resetPeerMessages()
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("prompt_async peer de-duplication", () => {
  it.instance(
    "injects a peer message once and drops the re-send of the same id",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-origami-directory": test.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "peer dedupe" })
        const post = (text: string, id?: string) =>
          request(SessionPaths.promptAsync.replace(":sessionID", session.id), {
            method: "POST",
            headers,
            body: peerBody({ text, id }),
          })

        const first = yield* post("alpha", "id-alpha")
        expect(first.status).toBe(204)
        expect(
          yield* pollWithTimeout(
            userTexts(session.id).pipe(Effect.map((texts) => texts.find((t) => t === "alpha"))),
            "peer message was never injected",
          ),
        ).toBe("alpha")

        // The re-send, then a DIFFERENT id behind it. Waiting for "beta" is
        // what makes the negative assertion safe: prompt_async forks with
        // startImmediately, so the duplicate's fiber — forked first — has
        // already run by the time the later message is visible. Asserting on
        // "no alpha yet" without that would only prove the test was quick.
        expect((yield* post("alpha", "id-alpha")).status).toBe(204)
        expect((yield* post("beta", "id-beta")).status).toBe(204)
        yield* pollWithTimeout(
          userTexts(session.id).pipe(Effect.map((texts) => texts.find((t) => t === "beta"))),
          "the following peer message was never injected",
        )

        const texts = yield* userTexts(session.id)
        expect(texts.filter((t) => t === "alpha")).toEqual(["alpha"])
        expect(texts.filter((t) => t === "beta")).toEqual(["beta"])
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 20000 },
  )

  it.instance(
    "injects an ordinary prompt every time — the guard never swallows a human turn",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-origami-directory": test.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "human repeat" })
        const post = () =>
          request(SessionPaths.promptAsync.replace(":sessionID", session.id), {
            method: "POST",
            headers,
            body: peerBody({ text: "ok" }),
          })

        expect((yield* post()).status).toBe(204)
        expect((yield* post()).status).toBe(204)

        // A person typing the same word twice must see it twice. This is also
        // the assertion that fails if the guard's condition is inverted: an
        // inverted guard drops everything that is NOT a duplicate, which is
        // every ordinary prompt.
        const texts = yield* pollWithTimeout(
          userTexts(session.id).pipe(Effect.map((found) => (found.length === 2 ? found : undefined))),
          "an ordinary prompt was dropped by the peer guard",
        )
        expect(texts).toEqual(["ok", "ok"])
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 20000 },
  )
})

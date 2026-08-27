import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@origami/core/effect/app-node"
import { LayerNode } from "@origami/core/effect/layer-node"
import { httpClient } from "@origami/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

// Message the fork's neuter fails with. Kept in one place so a regression that
// changes the wording is caught in exactly one spot, not scattered echoes.
const DISABLED = "upgrade is disabled in this fork"

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

// A test layer whose HTTP + subprocess backends record every call. Before the
// fork neuter, latest()/upgrade() reached the network (GitHub releases, the npm
// registry, the curl install script) and spawned package managers. The neuter
// must fail *before* any of that — so a test proves the kill by asserting the
// error AND that these recorders stayed empty. If someone un-neuters a code
// path, the effect stops failing and/or a call lands in one of these arrays.
function recordingLayer() {
  const httpCalls: string[] = []
  const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = []
  const layer = testLayer(
    (request) => {
      httpCalls.push(request.url)
      // Well-formed answers for every upstream endpoint the pre-neuter code used,
      // so an accidentally-live path would succeed loudly rather than error for an
      // unrelated reason and mask the regression.
      return jsonResponse({
        tag_name: "v9.9.9",
        version: "9.9.9",
        versions: { stable: "9.9.9" },
        d: { results: [{ Version: "9.9.9" }] },
      })
    },
    (cmd, args) => {
      spawnCalls.push({ cmd, args })
      return ""
    },
  )
  return { layer, httpCalls, spawnCalls }
}

describe("installation (fork neuter)", () => {
  // latest() is the upgrade chokepoint. Every install method funnelled through it
  // to a *different* upstream endpoint; the neuter must apply to all of them. One
  // test per distinct pre-neuter network path (GitHub / npm registry / brew /
  // chocolatey) proves the kill is method-independent and reaches no endpoint.
  describe("latest() is disabled for every method", () => {
    for (const method of ["unknown", "npm", "brew", "choco"] as const) {
      const { layer, httpCalls, spawnCalls } = recordingLayer()
      testEffect(layer).effect(`latest("${method}") dies with the disabled message and touches no network/subprocess`, () =>
        Effect.gen(function* () {
          const exit = yield* Installation.use.latest(method).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(DISABLED)
          }
          expect(httpCalls).toEqual([])
          expect(spawnCalls).toEqual([])
        }),
      )
    }
  })

  // upgrade() replaced the running binary. Package-manager methods spawned the
  // manager; curl fetched the install script over HTTP and piped it to a shell.
  // Cover both shapes (npm = spawn, curl = http + shell) and assert the typed
  // failure carries the disabled message and neither backend was invoked.
  describe("upgrade() is disabled for every method", () => {
    for (const method of ["npm", "curl"] as const) {
      const { layer, httpCalls, spawnCalls } = recordingLayer()
      testEffect(layer).effect(
        `upgrade("${method}") fails with UpgradeFailedError("${DISABLED}") and touches no network/subprocess`,
        () =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(Installation.use.upgrade(method, "9.9.9"))
            expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
            expect(error.stderr).toBe(DISABLED)
            expect(error.message).toBe(error.stderr)
            expect(httpCalls).toEqual([])
            expect(spawnCalls).toEqual([])
          }),
      )
    }
  })

  // info() is a real caller: it composes { version, latest() }. Because latest()
  // now dies, info() must die too — proving the strip propagates to the public
  // surface the REST /global route and the CLI both read.
  describe("info() propagates the disabled latest()", () => {
    const { layer, httpCalls, spawnCalls } = recordingLayer()
    testEffect(layer).effect("info() dies with the disabled message and touches no network/subprocess", () =>
      Effect.gen(function* () {
        const exit = yield* Installation.use.info().pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain(DISABLED)
        }
        expect(httpCalls).toEqual([])
        expect(spawnCalls).toEqual([])
      }),
    )
  })
})

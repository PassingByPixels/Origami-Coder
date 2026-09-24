/**
 * t-tc1haz: the git snapshot passes a turn pays per step.
 *
 * A scripted 8-step turn (7 bash steps that each write one file, then a text
 * reply) through the real prompt loop, processor and snapshot service, in the
 * test preload's isolated XDG/HOME and a scratch git repo. The git calls are
 * recorded by a spy AppProcess, and the LLM requests mark the step boundaries.
 *
 * Set ORIGAMI_SNAPSHOT_BENCH=1 to print the per-step wall time of the snapshot
 * git work (the measurement the ticket asks for). The assertions run always.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { AppProcess } from "@origami/core/process"
import fs from "fs/promises"
import path from "path"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { Database } from "@origami/core/database/database"
import { SessionProjector } from "@origami/core/session/projector"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { gitSpy, gitSpyLayer, isAddPass, subcommand, type GitCall } from "../lib/git-spy"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Snapshot } from "@/snapshot"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
// The real snapshot service, with the wall time of every track() and patch()
// call recorded: the passes the processor waits on, lock waits included.
const passes: { op: string; start: number; end: number }[] = []
const timed = <A, E, R>(op: string, fx: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = performance.now()
    const out = yield* fx
    passes.push({ op, start, end: performance.now() })
    return out
  })
const timedSnapshot = {
  ...Snapshot.node,
  implementation: Layer.effect(
    Snapshot.Service,
    Effect.gen(function* () {
      const real = yield* Snapshot.Service
      return Snapshot.Service.of({
        ...real,
        track: () => timed("track", real.track()),
        patch: (hash, to) => timed("patch", real.patch(hash, to)),
      })
    }),
  ).pipe(Layer.provide(Snapshot.node.implementation as Layer.Layer<Snapshot.Service>)),
} as typeof Snapshot.node

const it = testEffect(
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [AppProcess.node, gitSpyLayer],
    [Snapshot.node, timedSnapshot],
  ]),
)

const providerCfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
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
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const STEPS = 8
const BENCH = process.env.ORIGAMI_SNAPSHOT_BENCH === "1"
// A scratch repo with some weight, so each git spawn does real index work.
const SEED_FILES = BENCH ? 2000 : 50

/** Calls of the snapshot store: its own gitdir, or the source-repo ignore check it runs. */
const isSnapshotCall = (call: GitCall) =>
  call.args.some((arg) => arg.includes(`${path.sep}snapshot${path.sep}`) || arg.includes("/snapshot/")) ||
  subcommand(call.args) === "check-ignore"

/** Wall time covered by the calls (overlapping spawns counted once). */
const union = (calls: GitCall[]) => {
  const sorted = [...calls].sort((a, b) => a.start - b.start)
  let total = 0
  let end = -Infinity
  for (const call of sorted) {
    if (call.end <= end) continue
    total += call.end - Math.max(call.start, end)
    end = call.end
  }
  return total
}

const p50 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]!
}

it.live(
  "an 8-step turn runs at most one snapshot add pass per step",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        yield* Effect.promise(async () => {
          await Promise.all(
            Array.from({ length: SEED_FILES }, (_, i) =>
              fs.writeFile(path.join(dir, `seed-${i}.txt`), `seed ${i}\n`.repeat(20)),
            ),
          )
          const git = Bun.spawnSync(["git", "add", "."], { cwd: dir })
          if (git.exitCode !== 0) throw new Error(git.stderr.toString())
          const commit = Bun.spawnSync(["git", "commit", "-q", "-m", "seed"], { cwd: dir })
          if (commit.exitCode !== 0) throw new Error(commit.stderr.toString())
        })

        const session = yield* sessions.create({
          title: "snapshot step pass",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Each request's arrival is a step boundary. The match runs when the
        // request is served, and a hit is stamped once.
        const stamps: number[] = []
        const seen = new WeakSet<object>()
        const stamp = (hit: { body: object }) => {
          if (!seen.has(hit.body)) {
            seen.add(hit.body)
            stamps.push(performance.now())
          }
          return true
        }
        for (let i = 1; i < STEPS; i++) {
          yield* llm.toolMatch(stamp, "bash", {
            explanation: `write step ${i}`,
            command: `echo step${i} > ${path.join(dir, `out-${i}.txt`)}`,
          })
        }
        yield* llm.textMatch(stamp, "done")

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "write the files" }],
        })

        gitSpy.reset()
        passes.length = 0
        const begin = performance.now()
        yield* prompt.loop({ sessionID: session.id })
        const finish = performance.now()
        const calls = gitSpy.calls.filter(isSnapshotCall)
        gitSpy.reset()

        // The shell encodes the text its own way (UTF-16 on Windows PowerShell),
        // so the check is that each step's file exists.
        for (let i = 1; i < STEPS; i++) {
          expect(yield* Effect.promise(() => fs.stat(path.join(dir, `out-${i}.txt`)).then(() => true))).toBe(true)
        }
        expect(stamps.length).toBe(STEPS)

        // Step i owns [request i, request i+1): its step-finish track and patch,
        // and the next step's start snapshot. The last step runs to loop end.
        const bounds = [...stamps, finish]
        const within = <T extends { start: number }>(items: T[], i: number) =>
          items.filter((item) => item.start >= stamps[i]! && item.start < bounds[i + 1]!)
        const steps = stamps.map((_, i) => {
          const own = within(passes, i)
          return {
            // Time the processor spent inside track()/patch(), lock waits included.
            ms: own.reduce((sum, pass) => sum + pass.end - pass.start, 0),
            ops: own.map((pass) => pass.op).join("+"),
            // All snapshot git in the window, the forked turn summary's diffFull too.
            git: union(within(calls, i)),
            passes: within(calls, i).filter((call) => isAddPass(call.args)).length,
          }
        })
        passes.length = 0

        if (BENCH) {
          console.log(
            JSON.stringify({
              seedFiles: SEED_FILES,
              perStepOps: steps.map((step) => step.ops),
              perStepPasses: steps.map((step) => step.passes),
              perStepMs: steps.map((step) => Math.round(step.ms)),
              p50Ms: Math.round(p50(steps.map((step) => step.ms))),
              perStepGitMs: steps.map((step) => Math.round(step.git)),
              p50GitMs: Math.round(p50(steps.map((step) => step.git))),
              turnMs: Math.round(finish - begin),
            }),
          )
        }

        // The pass count per step: one add at step-finish, none for the patch
        // and none for the next step's start (it reuses the step-finish tree).
        for (const step of steps) expect(step.passes).toBeLessThanOrEqual(1)

        // The patch parts still name the file each step wrote.
        const msgs = yield* MessageV2.filterCompactedEffect(session.id)
        const patched = msgs
          .flatMap((msg) => msg.parts)
          .flatMap((part) => (part.type === "patch" ? part.files : []))
          .map((file) => path.basename(file))
        for (let i = 1; i < STEPS; i++) expect(patched).toContain(`out-${i}.txt`)
      }),
      { git: true, config: providerCfg },
    ),
  120_000,
)

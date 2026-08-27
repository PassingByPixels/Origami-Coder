import path from "node:path"
import { afterAll, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { Command } from "../../src/command"
import { pollWithTimeout, testEffect } from "../lib/effect"

/**
 * `session/new` must not wait for MCP servers to connect.
 *
 * Every chat spawns its own engine, so this cost is paid on every chat and
 * never amortised: on the owner's real config one plugin-declared server put
 * 3248ms into a 3295ms `session/new`, all of it inside `command.list`, because
 * building the command list read `mcp.prompts()` and that forces every
 * configured and plugin-declared server to connect.
 */
const it = testEffect(LayerNode.compile(Command.node))

const slowPromptFixture = path.join(import.meta.dir, "../fixture/mcp-slow-prompt-stdio.ts")

/**
 * A server that accepts the connection and then answers NOTHING, ever. The
 * configured timeout is what eventually fails it; the point of the test is that
 * the command list does not wait for that verdict.
 */
const neverAnswers = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
afterAll(() => {
  neverAnswers.stop(true)
})

const names = (commands: readonly Command.Info[]) => commands.map((command) => command.name)

it.instance(
  "a never-answering MCP server does not stall the command list",
  () =>
    Effect.gen(function* () {
      const command = yield* Command.Service

      const commands = yield* command.list().pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail(new Error("Command.list() waited for the MCP connect")),
        }),
      )

      // The builtins are the point: they are what the composer's slash menu
      // shows, and they must be there without an MCP server having answered.
      expect(names(commands)).toContain(Command.Default.INIT)
      expect(names(commands)).toContain(Command.Default.REVIEW)
    }),
  {
    config: () => ({
      mcp: {
        "never-answers": { type: "remote" as const, url: neverAnswers.url.toString(), oauth: false, timeout: 2000 },
      },
    }),
  },
)

it.instance(
  "MCP prompts fold into the command list after discovery, and stay executable",
  () =>
    Effect.gen(function* () {
      const command = yield* Command.Service

      // Before: answered without the slow server, which is the whole change.
      expect(names(yield* command.list())).not.toContain("slow:review")

      // After: the same list carries it, with no restart and no second config
      // read — the fold writes into the map the fast readers already hold.
      const folded = yield* pollWithTimeout(
        Effect.gen(function* () {
          const commands = names(yield* command.list())
          return commands.includes("slow:review") ? commands : undefined
        }),
        "MCP prompt never folded into the command list",
        "15 seconds",
      )
      expect(folded).toContain("slow:review")

      const found = yield* command.get("slow:review")
      expect(found?.source).toBe("mcp")
      expect(yield* Effect.promise(async () => await found!.template)).toBe("review the diff")
    }),
  {
    config: () => ({
      mcp: {
        slow: {
          type: "local" as const,
          command: [process.execPath, slowPromptFixture],
          environment: { MCP_SLOW_PROMPT_DELAY_MS: "600" },
        },
      },
    }),
  },
  20_000,
)

it.instance(
  "a slash command that only MCP knows still resolves while discovery is in flight",
  () =>
    Effect.gen(function* () {
      const command = yield* Command.Service

      // The execution path (`session/prompt` resolves a typed `/name` through
      // `get`), asked in the window where discovery has not answered yet. A miss
      // that did not wait would make an MCP slash command silently do nothing.
      const found = yield* command.get("slow:review")

      expect(found?.name).toBe("slow:review")
      expect(found?.source).toBe("mcp")
    }),
  {
    config: () => ({
      mcp: {
        slow: {
          type: "local" as const,
          command: [process.execPath, slowPromptFixture],
          environment: { MCP_SLOW_PROMPT_DELAY_MS: "600" },
        },
      },
    }),
  },
  20_000,
)

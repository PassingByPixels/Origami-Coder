// A restarted engine sends the bytes the same engine would have sent without
// the restart (t-w2qb1x, epic t-w1r73y option D3).
//
// Each test runs the same script twice over the harness in
// test/lib/restart-harness.ts: once in ONE runtime, once with a restart (a new
// runtime over the same SQLite database, every process store emptied) at the
// turn boundaries. The two runs must send identical request bodies. Nothing is
// recorded: the reference is the run without a restart, so no golden file is
// involved.
//
// R1  restart at every turn boundary of the request-steps-golden script, on
//     the native runtime and on the AI SDK runtime.
// R2  a tool loaded by `tool_search` stays loaded after a restart.
// R3  a restart on the next calendar day.
// L1  a chat's tool-aging decisions survive 16 other sessions in one engine.

import { describe, expect, setSystemTime, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MCP } from "@/mcp"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/client"
import { Session } from "@/session/session"
import { reply } from "../lib/llm-server"
import {
  AGED,
  count,
  runProcesses,
  say,
  seedReads,
  setup,
  stepsScript,
  usage,
  type Ctx,
  type Run,
  type Segment,
} from "../lib/restart-harness"

// The shell tool describes the shell from $SHELL; unset, as in the steps golden.
delete process.env.SHELL

const TIMEOUT = 240_000

/** Equal body for body. On a difference, name the first request that differs
 *  and the text around the first differing byte, so a red run says why. */
function expectSame(restarted: Run, reference: Run) {
  expect(restarted.bodies.length).toBe(reference.bodies.length)
  for (const [index, body] of restarted.bodies.entries()) {
    const expected = reference.bodies[index]!
    if (body === expected) continue
    let at = 0
    while (at < body.length && body[at] === expected[at]) at++
    const around = (text: string) => text.slice(Math.max(0, at - 120), at + 120)
    expect(
      { request: index, aged: count(body, AGED), around: around(body) },
      "request " + index + " differs after a restart",
    ).toEqual({ request: index, aged: count(expected, AGED), around: around(expected) })
  }
}

describe("R1: restart at every turn boundary == no restart", () => {
  for (const [label, flags] of [
    ["native", {}],
    ["aisdk", { nativeLlmFamilies: "none" }],
  ] as const) {
    test(
      label + " runtime",
      async () => {
        const reference = await runProcesses({ flags, segments: stepsScript(), restartAfter: () => false })
        const restarted = await runProcesses({ flags, segments: stepsScript(), restartAfter: () => true })
        // The script is the steps golden: 9 requests, the aging batches where
        // that test pins them, and five runtimes in the restarted run.
        expect(reference.processes).toBe(1)
        expect(restarted.processes).toBe(5)
        expect(reference.bodies.length).toBe(9)
        expect(count(reference.bodies[0]!, AGED)).toBe(22)
        expect(count(reference.bodies[3]!, AGED)).toBe(22)
        expect(count(reference.bodies[4]!, AGED)).toBe(40)
        expectSame(restarted, reference)
      },
      TIMEOUT,
    )
  }
})

// Two MCP tools, both deferred by default (tool/tool-search.ts), so the first
// request offers `tool_search` and neither tool.
const deferredMcp = Layer.mock(MCP.Service, {
  status: () => Effect.succeed({}),
  instructions: () => Effect.succeed([]),
  prompts: () => Effect.succeed({}),
  resources: () => Effect.succeed({}),
  resourceTemplates: () => Effect.succeed({}),
  // A real MCP client answers this; session/tools.ts asks every client whether
  // it serves resources before it offers the resource tools.
  clients: () => Effect.succeed({ weather: { getServerCapabilities: () => ({}) } as never }),
  tools: () =>
    Effect.succeed({
      weather_current: {
        def: {
          name: "current",
          description: "Current weather for a city",
          inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        } as MCPToolDef,
        client: {} as MCP.McpTool["client"],
      },
      weather_forecast: {
        def: {
          name: "forecast",
          description: "Five day forecast for a city",
          inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        } as MCPToolDef,
        client: {} as MCP.McpTool["client"],
      },
    }),
})

const toolSearchScript = (): Segment[] => {
  const chat = (ctx: Ctx) => ctx.ids.get("chat")!
  return [
    (ctx) =>
      Effect.gen(function* () {
        yield* setup(ctx, "chat")
        yield* ctx.llm.push(reply().tool("tool_search", { query: "current weather", limit: 1 }).usage(usage(1000)))
        yield* ctx.llm.text("Loaded.", { usage: usage(1000) })
        yield* say(chat(ctx), "Find me a weather tool.")
      }),
    (ctx) =>
      Effect.gen(function* () {
        yield* ctx.llm.text("Still here.", { usage: usage(1000) })
        yield* say(chat(ctx), "And now?")
      }),
  ]
}

test(
  "R2: a tool loaded by tool_search is still loaded after a restart",
  async () => {
    const reference = await runProcesses({
      mcp: deferredMcp,
      segments: toolSearchScript(),
      restartAfter: () => false,
    })
    const restarted = await runProcesses({ mcp: deferredMcp, segments: toolSearchScript(), restartAfter: () => true })
    expect(reference.bodies.length).toBe(3)
    // The script does what it says: the first request declares neither tool,
    // the turn after the search declares the loaded one and not the other.
    expect(reference.bodies[0]).not.toContain('"name":"weather_current"')
    expect(reference.bodies[2]).toContain('"name":"weather_current"')
    expect(reference.bodies[2]).not.toContain('"name":"weather_forecast"')
    expectSame(restarted, reference)
  },
  TIMEOUT,
)

test(
  "R3: a restart on the next calendar day == the same day change without a restart",
  async () => {
    const tomorrow = new Date(Date.now() + 86_400_000)
    const run = async (restart: boolean) => {
      try {
        return await runProcesses({
          segments: stepsScript(),
          restartAfter: () => restart,
          between: (index) => {
            if (index === 0) setSystemTime(tomorrow)
          },
        })
      } finally {
        setSystemTime()
      }
    }
    const reference = await run(false)
    const restarted = await run(true)
    // Known and independent of the restart: the date line moves at midnight in
    // both runs, so turn 1 carries today and turn 2 carries tomorrow. The
    // bodies were normalised while the clock said tomorrow, so tomorrow is the
    // date masked as <DATE>.
    const today = new Date().toDateString()
    expect(reference.bodies[0]).toContain(today)
    expect(reference.bodies[3]).toContain("<DATE>")
    expect(reference.bodies[3]).not.toContain(today)
    expectSame(restarted, reference)
  },
  TIMEOUT,
)

test(
  "L1: a chat keeps its tool-aging decisions while 16 other sessions run in the same engine",
  async () => {
    const chat = (ctx: Ctx) => ctx.ids.get("chat")!
    const script = (others: number): Segment[] => {
      const steps = stepsScript()
      return [
        steps[0]!,
        (ctx) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            for (let index = 0; index < others; index++) {
              const other = yield* sessions.create({
                title: "Other " + index,
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              yield* ctx.llm.text("Other " + index + " done.", { usage: usage(1000) })
              yield* say(other.id, "Hello " + index + ".")
            }
          }),
        (ctx) =>
          Effect.gen(function* () {
            yield* seedReads(chat(ctx), ctx.dir, 1)
            yield* ctx.llm.text("Turn two done.", { usage: usage(1000) })
            yield* say(chat(ctx), "Resume two.")
          }),
      ]
    }
    const alone = await runProcesses({ segments: script(0), restartAfter: () => false })
    const crowded = await runProcesses({ segments: script(16), restartAfter: () => false })
    const last = (run: Run) => run.bodies.at(-1)!
    expect(alone.bodies.length).toBe(4)
    expect(crowded.bodies.length).toBe(4 + 16)
    expect(count(last(alone), AGED)).toBe(22)
    expect(count(last(crowded), AGED)).toBe(count(last(alone), AGED))
    expect(last(crowded)).toBe(last(alone))
  },
  TIMEOUT,
)


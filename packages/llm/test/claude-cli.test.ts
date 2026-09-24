import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Exit, Layer, Queue, Stream } from "effect"
import { LLM, LLMError, Message, ToolCallPart, type LLMEvent } from "../src"
import { LLMClient, ProcessExecutor } from "../src/route"
import { ClaudeCli } from "../src/route/transport/claude-cli"
import * as ClaudeSubscription from "../src/providers/claude-subscription"
import { dynamicResponse } from "./lib/http"

// Every test here runs a FAKE claude (fixtures/claude-cli/fake-claude.ts) with
// its command injected. Nothing contacts Anthropic.
const FIXTURES = path.join(import.meta.dir, "fixtures", "claude-cli")
const FAKE = path.join(FIXTURES, "fake-claude.ts")
const SSE = JSON.parse(readFileSync(path.join(FIXTURES, "anthropic-sse.json"), "utf8")) as Record<
  "toolCall" | "toolAnswer" | "reasoning",
  Record<string, any>[]
>

/** What the CLI prints for one answer: its native SSE events wrapped, tool names as the CLI sees them. */
const wrap = (events: Record<string, any>[]) =>
  events.map((event) => {
    const block = event.content_block
    const renamed =
      event.type === "content_block_start" && block?.type === "tool_use"
        ? { ...event, content_block: { ...block, name: ClaudeCli.TOOL_PREFIX + block.name } }
        : event
    return { type: "stream_event", event: renamed }
  })

const INIT = {
  type: "system",
  subtype: "init",
  session_id: "fake",
  tools: [],
  mcp_servers: [{ name: "origami", status: "connected" }],
}

const baseEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ClaudeCli.envConflicts({ [key]: process.env[key] }).length === 0),
  )

const HTTP_NEVER = dynamicResponse(() => Effect.die("the claude-cli route must not use HTTP"))

interface Run {
  readonly log: string
  readonly events: ReadonlyArray<LLMEvent>
  readonly exit: Exit.Exit<ReadonlyArray<LLMEvent>, unknown>
}

const step = async (
  scenario: Record<string, unknown>,
  request: (
    model: ReturnType<ReturnType<typeof ClaudeSubscription.configure>["model"]>,
  ) => Parameters<typeof LLM.request>[0],
  options: { env?: Record<string, string | undefined>; take?: number } = {},
): Promise<Run> => {
  const log = mkdtempSync(path.join(tmpdir(), "fake-claude-log-"))
  const file = path.join(log, "scenario.json")
  writeFileSync(file, JSON.stringify(scenario))
  const model = ClaudeSubscription.configure({
    command: [process.execPath, FAKE],
    env: { ...baseEnv(), FAKE_SCENARIO: file, FAKE_LOG: log, ...options.env },
    idleTimeoutMs: 20_000,
  }).model("claude-haiku-4-5")
  const stream = LLMClient.stream(LLM.request(request(model)))
  const limited = options.take === undefined ? stream : stream.pipe(Stream.take(options.take))
  const exit = await Effect.runPromise(
    Stream.runCollect(limited).pipe(
      Effect.map((chunk) => [...chunk]),
      Effect.exit,
      Effect.provide(HTTP_NEVER),
    ),
  )
  return { log, exit, events: Exit.isSuccess(exit) ? exit.value : [] }
}

const read = (log: string, name: string) => JSON.parse(readFileSync(path.join(log, name), "utf8"))
const lines = (log: string, name: string) =>
  existsSync(path.join(log, name)) ? readFileSync(path.join(log, name), "utf8").trim().split("\n").filter(Boolean) : []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitGone = async (pid: number) => {
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50)
  return !alive(pid)
}

const weatherTool = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
}

const failureOf = (run: Run) => {
  expect(Exit.isFailure(run.exit)).toBe(true)
  const text = String(Exit.isFailure(run.exit) ? run.exit.cause : "")
  return text
}

describe("claude-cli transport: request lowering", () => {
  test("splits the Messages body into system file, history frames and the extra body", async () => {
    const model = ClaudeSubscription.configure({ command: ["claude"] }).model("claude-sonnet-5")
    const prepared = await Effect.runPromise(
      LLMClient.prepare(
        LLM.request({
          model,
          system: "You are Origami.",
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([
              { type: "reasoning", text: "signed", providerMetadata: { anthropic: { signature: "sig" } } },
              { type: "reasoning", text: "stale, no signature" },
              { type: "text", text: "" },
              ToolCallPart.make({ id: "toolu_1", name: "get_weather", input: { city: "Paris" } }),
            ]),
            Message.tool({ id: "toolu_1", name: "get_weather", result: "sunny" }),
            Message.user("Thanks."),
          ],
          tools: [weatherTool],
          generation: { maxTokens: 900, temperature: 0.3, topP: 0.9 },
          providerOptions: { [ClaudeCli.OPTIONS_KEY]: { effort: "high" } },
        }),
      ).pipe(Effect.provide(HTTP_NEVER)),
    )
    const body = prepared.body as any
    const lowered = await Effect.runPromise(
      ClaudeCli.prepareRequest(
        body,
        LLM.request({
          model,
          prompt: "x",
          providerOptions: { [ClaudeCli.OPTIONS_KEY]: { effort: "high" } },
        }),
      ),
    )
    expect(lowered.system).toBe("You are Origami.")
    expect(lowered.frames).toEqual([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "What is the weather?" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "signed", signature: "sig" },
            { type: "tool_use", id: "toolu_1", name: "mcp__origami__get_weather", input: { city: "Paris" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            // A plain result is JSON on the Anthropic wire (`toolResultText`).
            { type: "tool_result", tool_use_id: "toolu_1", content: JSON.stringify("sunny") },
            { type: "text", text: "Thanks." },
          ],
        },
      },
    ])
    expect(lowered.extraBody).toEqual({
      tools: [
        {
          name: "mcp__origami__get_weather",
          description: weatherTool.description,
          input_schema: weatherTool.inputSchema,
        },
      ],
      max_tokens: 900,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    })
    expect(lowered.manifest).toEqual([
      { name: "get_weather", description: weatherTool.description, inputSchema: weatherTool.inputSchema },
    ])
  })

  test("effort none disables thinking; Haiku gets the effort but no adaptive block", async () => {
    const body = {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stream: true,
      max_tokens: 10,
    } as any
    const model = ClaudeSubscription.configure({ command: ["claude"] }).model("claude-haiku-4-5")
    const lower = (effort: string) =>
      Effect.runPromise(
        ClaudeCli.prepareRequest(
          body,
          LLM.request({ model, prompt: "x", providerOptions: { [ClaudeCli.OPTIONS_KEY]: { effort } } }),
        ),
      )
    expect((await lower("none")).extraBody).toMatchObject({
      thinking: { type: "disabled" },
      context_management: { edits: [] },
    })
    const haiku = (await lower("low")).extraBody
    expect(haiku.thinking).toBeUndefined()
    expect(haiku.output_config).toEqual({ effort: "low" })
  })

  test("refuses assistant prefill, bad tool names and unknown effort", async () => {
    const model = ClaudeSubscription.configure({ command: ["claude"] }).model("claude-sonnet-5")
    const request = LLM.request({ model, prompt: "x" })
    const user = { role: "user", content: [{ type: "text", text: "hi" }] }
    const prefill = {
      model: "m",
      messages: [user, { role: "assistant", content: [{ type: "text", text: "Sure" }] }],
      stream: true,
      max_tokens: 1,
    } as any
    const badTool = {
      model: "m",
      messages: [user],
      tools: [{ name: "has space", description: "", input_schema: {} }],
      stream: true,
      max_tokens: 1,
    } as any
    const fail = (body: any, req = request) => Effect.runPromise(Effect.flip(ClaudeCli.prepareRequest(body, req)))
    expect((await fail(prefill)).reason.message).toContain("assistant prefill is not supported")
    expect((await fail(badTool)).reason.message).toContain('"has space" is not')
    const effort = LLM.request({
      model,
      prompt: "x",
      providerOptions: { [ClaudeCli.OPTIONS_KEY]: { effort: "turbo" } },
    })
    expect(
      (await fail({ model: "m", messages: [user], stream: true, max_tokens: 1 }, effort)).reason.message,
    ).toContain("effort must be one of")
  })
})

describe("claude-cli transport: environment", () => {
  test("refuses API-key, base-URL and cloud-backend overrides by name, never by value", () => {
    const conflicts = ClaudeCli.envConflicts({
      ANTHROPIC_API_KEY: "sk-secret",
      anthropic_base_url: "http://relay",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "false",
      PATH: "x",
    })
    expect(conflicts).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"])
    expect(ClaudeCli.conflictMessage(conflicts)).not.toContain("sk-secret")
  })

  test("child env drops Origami flags and inherited Claude Code session state, keeps the config dir", () => {
    const env = ClaudeCli.childEnv(
      { PATH: "p", ORIGAMI_EXPERIMENTAL: "1", CLAUDECODE: "1", CLAUDE_CODE_EXTRA_BODY: "{}", CLAUDE_CONFIG_DIR: "c" },
      1234,
    )
    expect(env).toEqual({
      PATH: "p",
      CLAUDE_CONFIG_DIR: "c",
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1234",
    })
  })

  test("a step with ANTHROPIC_API_KEY set fails before any process starts", async () => {
    const run = await step({ lines: wrap(SSE.toolAnswer) }, (model) => ({ model, prompt: "hi" }), {
      env: { ANTHROPIC_API_KEY: "sk-test-value" },
    })
    const text = failureOf(run)
    expect(text).toContain("ANTHROPIC_API_KEY")
    expect(text).not.toContain("sk-test-value")
    expect(lines(run.log, "pids.log")).toEqual([])
  })
})

describe("claude-cli transport: one step against the fake CLI", () => {
  test("tool call: Hermes argv, inert MCP inventory, prefix stripped, one upstream request, process gone", async () => {
    const run = await step(
      {
        lines: [
          INIT,
          ...wrap(SSE.toolCall),
          { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2 },
        ],
        exitCode: 1,
      },
      (model) => ({
        model,
        system: "Use tools.",
        prompt: "What is the weather in Paris?",
        tools: [weatherTool],
      }),
    )
    expect(Exit.isSuccess(run.exit)).toBe(true)
    const call = run.events.find((event) => event.type === "tool-call")
    expect(call).toMatchObject({ type: "tool-call", name: "get_weather", input: { city: "Paris" } })
    expect(run.events.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" })

    const argv = read(run.log, "argv.json") as string[]
    const at = (flag: string) => argv[argv.indexOf(flag) + 1]
    expect(argv[0]).toBe("-p")
    expect(at("--model")).toBe("claude-haiku-4-5")
    expect(at("--tools")).toBe("")
    expect(at("--setting-sources")).toBe("")
    expect(at("--max-turns")).toBe("1")
    expect(at("--permission-mode")).toBe("dontAsk")
    for (const flag of [
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--include-partial-messages",
      "--verbose",
    ])
      expect(argv).toContain(flag)
    expect(readFileSync(path.join(run.log, "system.md"), "utf8")).toBe("Use tools.")
    const extra = JSON.parse(read(run.log, "settings.json").env.CLAUDE_CODE_EXTRA_BODY)
    expect(extra.tools.map((tool: { name: string }) => tool.name)).toEqual(["mcp__origami__get_weather"])

    // The inert server lists exactly Origami's tools and refuses to run one.
    const [init, list, called] = read(run.log, "mcp-answers.json")
    expect(init.result.serverInfo.name).toBe("origami-inert-inventory")
    expect(list.result.tools).toEqual([
      { name: "get_weather", description: weatherTool.description, inputSchema: weatherTool.inputSchema },
    ])
    expect(called.result.isError).toBe(true)

    expect(lines(run.log, "requests.log")).toHaveLength(1)
    const [pid] = lines(run.log, "pids.log").map(Number)
    expect(await waitGone(pid!)).toBe(true)
  })

  test("history replay: earlier user frames go without a query and each is acknowledged", async () => {
    const run = await step({ lines: wrap(SSE.toolAnswer) }, (model) => ({
      model,
      messages: [
        Message.user("What is the weather in Paris?"),
        Message.assistant([ToolCallPart.make({ id: "toolu_1", name: "get_weather", input: { city: "Paris" } })]),
        Message.tool({ id: "toolu_1", name: "get_weather", result: "sunny" }),
      ],
      tools: [weatherTool],
    }))
    expect(Exit.isSuccess(run.exit)).toBe(true)
    const frames = read(run.log, "frames.json")
    expect(frames.map((frame: { type: string; shouldQuery?: boolean }) => [frame.type, frame.shouldQuery])).toEqual([
      ["user", false],
      ["assistant", undefined],
      ["user", undefined],
    ])
    expect(frames[1].message.content[0].name).toBe("mcp__origami__get_weather")
    expect(
      run.events
        .filter((event) => event.type === "text-delta")
        .map((event: any) => event.text)
        .join(""),
    ).toContain("Paris")
    expect(lines(run.log, "requests.log")).toHaveLength(1)
  })

  test("a CLI that answers a replayed frame with a turn is refused as unsupported", async () => {
    const run = await step({ lines: wrap(SSE.toolAnswer), replayBad: true }, (model) => ({
      model,
      messages: [Message.user("one"), Message.assistant("two"), Message.user("three")],
    }))
    expect(failureOf(run)).toContain("history replay is not supported by this version")
    expect(lines(run.log, "requests.log")).toHaveLength(0)
  })

  test("a tool the model names outside Origami's inventory fails the step", async () => {
    const rogue = wrap(SSE.toolCall).map((line) =>
      line.event.type === "content_block_start"
        ? { ...line, event: { ...line.event, content_block: { ...line.event.content_block, name: "mcp__other__rm" } } }
        : line,
    )
    const run = await step({ lines: rogue }, (model) => ({ model, prompt: "go", tools: [weatherTool] }))
    expect(failureOf(run)).toContain("outside Origami's tool list: mcp__other__rm")
  })

  test("thinking tokens from message_delta reach usage as reasoningTokens", async () => {
    const run = await step({ lines: wrap(SSE.reasoning) }, (model) => ({ model, prompt: "Think." }))
    expect(Exit.isSuccess(run.exit)).toBe(true)
    const finish = run.events.find((event) => event.type === "finish") as any
    expect(finish.usage).toMatchObject({ outputTokens: 135, reasoningTokens: 128 })
    expect(finish.usage.visibleOutputTokens).toBe(7)
  })

  test("plan refusal: rate_limit_event + 429 result become a usage-limit error carrying the upstream text", async () => {
    const upstream =
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}'
    const resetsAt = Math.round(Date.now() / 1000) + 3600
    const run = await step(
      {
        lines: [
          INIT,
          {
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt, utilization: 1 },
          },
          {
            type: "assistant",
            error: "rate_limit",
            message: { role: "assistant", content: [{ type: "text", text: upstream }] },
          },
          { type: "result", subtype: "success", is_error: true, api_error_status: 429, num_turns: 1, result: upstream },
        ],
        exitCode: 1,
      },
      (model) => ({ model, prompt: "hi" }),
    )
    expect(Exit.isFailure(run.exit)).toBe(true)
    const error = Exit.isFailure(run.exit) ? (run.exit.cause as any).reasons?.[0]?.error : undefined
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason._tag).toBe("QuotaExceeded")
    expect(error.reason.http.response.status).toBe(429)
    const body = JSON.parse(error.reason.http.body)
    expect(body.error.type).toBe("usage_limit_reached")
    expect(body.error.plan_type).toBe("five_hour")
    expect(body.error.resets_in_seconds).toBeGreaterThan(3500)
    expect(body.error.upstream_message).toContain("exceed your account's rate limit")
  })

  test("a CLI that exits without an answer fails with its exit code and stderr, not a silent empty turn", async () => {
    const run = await step({ lines: [INIT], exitCode: 3 }, (model) => ({ model, prompt: "hi" }))
    expect(failureOf(run)).toContain("exit code 3")
  })
})

describe("claude-cli transport: cancel and admission", () => {
  test("cancel mid-stream kills the CLI and its MCP child", async () => {
    const started = wrap(SSE.toolAnswer).slice(0, 4)
    const run = await step(
      { lines: started, hang: true, keepMcp: true },
      (model) => ({ model, prompt: "hi", tools: [weatherTool] }),
      {
        take: 1,
      },
    )
    expect(Exit.isSuccess(run.exit)).toBe(true)
    const [pid] = lines(run.log, "pids.log").map(Number)
    const [mcp] = lines(run.log, "mcp-pid.log").map(Number)
    expect(await waitGone(pid!)).toBe(true)
    expect(await waitGone(mcp!)).toBe(true)
  })

  test("the kill at message_stop admits exactly one upstream request (race measured)", async () => {
    // The fake starts a SECOND generation `afterMs` after it wrote message_stop,
    // as the CLI may despite --max-turns 1. Each delay runs 5 times.
    const second = { lines: wrap(SSE.toolAnswer) }
    const results: { afterMs: number; admitted: number[]; killMs: number[] }[] = []
    for (const afterMs of [0, 2, 5, 10, 25, 50]) {
      const admitted: number[] = []
      const killMs: number[] = []
      for (let i = 0; i < 5; i++) {
        const run = await step({ lines: wrap(SSE.toolAnswer), second: { ...second, afterMs } }, (model) => ({
          model,
          prompt: "hi",
        }))
        expect(Exit.isSuccess(run.exit)).toBe(true)
        admitted.push(lines(run.log, "requests.log").length)
        const stopped = read(run.log, "stopped.json") as number
        // The last heartbeat that landed whole; none at all = killed within the first 1 ms tick.
        const beats = lines(run.log, "alive.log").map(Number).filter(Number.isFinite)
        const last = beats.length ? Math.max(...beats) : stopped
        killMs.push(Math.round((last - stopped) * 10) / 10)
        const [pid] = lines(run.log, "pids.log").map(Number)
        await waitGone(pid!)
      }
      results.push({ afterMs, admitted, killMs })
    }
    console.log("ADMISSION RACE", JSON.stringify(results))
    // A second generation that starts 5 ms or more after message_stop must
    // never get out. (At 0 ms the fake has already started it before the line
    // reaches the engine; that residual window is what the log above reports.)
    for (const row of results.filter((row) => row.afterMs >= 5)) expect(row.admitted).toEqual([1, 1, 1, 1, 1])
  }, 120_000)

  test("local overhead per step: spawn + MCP start + replay of N frames (fake CLI, no upstream)", async () => {
    const history = (turns: number) => [
      ...Array.from({ length: turns }, (_, i) => [Message.user(`q${i}`), Message.assistant(`a${i}`)]).flat(),
      Message.user("last"),
    ]
    const timings: Record<number, number[]> = {}
    for (const turns of [0, 10, 50]) {
      timings[turns] = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        const run = await step({ lines: wrap(SSE.toolAnswer) }, (model) => ({
          model,
          messages: history(turns),
          tools: [weatherTool],
        }))
        expect(Exit.isSuccess(run.exit)).toBe(true)
        timings[turns]!.push(Math.round(performance.now() - t0))
      }
    }
    console.log("STEP OVERHEAD ms (turns -> runs)", JSON.stringify(timings))
  }, 120_000)
})

describe("claude-cli transport: injected process executor", () => {
  test("runtime.process replaces node spawning; the same decode path runs on its lines", async () => {
    const spawned: string[][] = []
    const executor = ProcessExecutor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          spawned.push([input.command, ...input.args])
          const queue = yield* Queue.unbounded<string, any>()
          let killed = 0
          return {
            pid: undefined,
            lines: queue,
            write: () => Effect.void,
            closeInput: Effect.sync(() => {
              for (const line of wrap(SSE.toolAnswer)) Queue.offerUnsafe(queue, JSON.stringify(line))
              Queue.endUnsafe(queue)
            }),
            kill: Effect.sync(() => void killed++),
            exited: Effect.succeed(0),
            stderr: () => [],
          }
        }),
    })
    const model = ClaudeSubscription.configure({ command: ["C:/not/run/claude.exe"], env: baseEnv() }).model(
      "claude-sonnet-5",
    )
    const events = await Effect.runPromise(
      Stream.runCollect(LLMClient.stream(LLM.request({ model, prompt: "hi" }))).pipe(
        // Outer provide first in the pipe order: the client layer is built where the executor is already present.
        Effect.provide(HTTP_NEVER),
        Effect.provide(Layer.succeed(ProcessExecutor.Service, executor)),
      ),
    )
    expect(spawned[0]?.[0]).toBe("C:/not/run/claude.exe")
    expect([...events].at(-1)).toMatchObject({ type: "finish", reason: "stop" })
  })
})

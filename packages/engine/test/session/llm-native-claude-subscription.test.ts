import { beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { jsonSchema, type Tool } from "ai"
import { Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ClaudeCli, LLMClient, ProcessExecutor, RequestExecutor } from "@origami/llm/route"
import { ProviderV2 } from "@origami/core/provider"
import { Global } from "@origami/core/global"
import { SessionV1 } from "@origami/core/v1/session"
import { LLMNativeRoute } from "@/session/llm/native-route"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { SessionUsageLimit } from "@/session/usage-limit"
import { ProviderConcurrency } from "@/provider/concurrency"
import { ProviderError } from "@/provider/error"
import { ClaudeSubscription } from "@/provider/claude-subscription"
import type { Provider } from "@/provider/provider"

// t-tija5f. Every CLI here is the FAKE from packages/llm (it never contacts
// anything); no test runs the real `claude`.
const FIXTURES = path.resolve(import.meta.dir, "../../../llm/test/fixtures/claude-cli")
const FAKE = [process.execPath, path.join(FIXTURES, "fake-claude.ts")]
const SSE = JSON.parse(readFileSync(path.join(FIXTURES, "anthropic-sse.json"), "utf8")) as Record<string, any[]>

const wrap = (events: any[]) =>
  events.map((event) => {
    const block = event.content_block
    return {
      type: "stream_event",
      event:
        event.type === "content_block_start" && block?.type === "tool_use"
          ? { ...event, content_block: { ...block, name: ClaudeCli.TOOL_PREFIX + block.name } }
          : event,
    }
  })

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ClaudeCli.envConflicts({ [key]: process.env[key] }).length === 0),
  )

/** Point the fake CLI at one scenario for this process (the transport builds the child env from process.env). */
const useScenario = (scenario: Record<string, unknown>) => {
  const log = mkdtempSync(path.join(tmpdir(), "fake-claude-engine-"))
  const file = path.join(log, "scenario.json")
  writeFileSync(file, JSON.stringify(scenario))
  process.env.FAKE_SCENARIO = file
  process.env.FAKE_LOG = log
  return log
}

const model = ClaudeSubscription.modelRow({ id: "haiku", name: "Haiku", context: 200_000 })
const provider: Provider.Info = {
  id: ProviderV2.ID.make(ClaudeSubscription.PROVIDER_ID),
  name: "Claude (subscription, experimental)",
  source: "custom",
  env: [],
  options: {},
  models: { haiku: model },
}

const clientLayer = LLMClient.layer.pipe(
  Layer.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))),
)
const client = Effect.runSync(
  Effect.gen(function* () {
    return yield* LLMClient.Service
  }).pipe(Effect.provide(clientLayer)),
)

describe("claude-subscription: Gate A (family flag)", () => {
  const row = { api: { id: "haiku", url: "", npm: ClaudeSubscription.NPM } }
  test("its own family, never anthropic, and only its own flag turns it on", () => {
    expect(LLMNativeRoute.family(ClaudeSubscription.NPM)).toBe("claude-subscription")
    expect(LLMNativeRoute.DEFAULTS["claude-subscription"]).toBe(false)
    const off = { experimentalNativeLlm: false, nativeLlmFamilies: "" }
    expect(LLMNativeRoute.enabled(row, off)).toBe(false)
    expect(LLMNativeRoute.enabled(row, { experimentalNativeLlm: true, nativeLlmFamilies: "all" })).toBe(false)
    expect(LLMNativeRoute.enabled(row, { ...off, nativeLlmFamilies: "claude-subscription" })).toBe(false)
    expect(LLMNativeRoute.enabled(row, { ...off, experimentalClaudeSubscription: true })).toBe(true)
    // The flag does not leak onto the API-key anthropic family.
    expect(
      LLMNativeRoute.enabled(
        { api: { id: "m", url: "", npm: "@ai-sdk/anthropic" } },
        { ...off, nativeLlmFamilies: "none", experimentalClaudeSubscription: true },
      ),
    ).toBe(false)
  })
})

describe("claude-subscription: Gate B (readiness) and the false-green guard", () => {
  beforeEach(() => ClaudeSubscription.resetMemo())

  test("below the version floor: refused with the floor and the fix named", async () => {
    useScenario({ version: "2.1.198 (Claude Code)" })
    const ready = await ClaudeSubscription.probe({ command: FAKE, env: { ...cleanEnv(), ...pick() } })
    expect(ready).toMatchObject({ type: "unready" })
    expect(ready.type === "unready" && ready.reason).toContain(
      `Claude CLI 2.1.198 is below the qualified floor ${ClaudeSubscription.VERSION_FLOOR}`,
    )
    expect(ready.type === "unready" && ready.reason).toContain("claude update")
    // t-tjt9wd: `kind`/`found`/`floor` are what the picker's host call reads —
    // without them the wire status would have to re-parse this English text.
    expect(ready).toMatchObject({ kind: "version-too-old", found: "2.1.198", floor: ClaudeSubscription.VERSION_FLOOR })
    expect(ClaudeSubscription.readinessWireState(ready)).toEqual({
      state: "version-too-old",
      found: "2.1.198",
      floor: ClaudeSubscription.VERSION_FLOOR,
      path: FAKE[0],
    })
    expect(ready.type === "unready" && ready.reason).toContain(`It is at ${FAKE[0]}.`)
  })

  test("logged out: refused, and the fix is Anthropic's own login", async () => {
    useScenario({ auth: { loggedIn: false } })
    const ready = await ClaudeSubscription.probe({ command: FAKE, env: { ...cleanEnv(), ...pick() } })
    expect(ready.type === "unready" && ready.reason).toContain("claude auth login")
    expect(ready).toMatchObject({ kind: "not-logged-in" })
    expect(ClaudeSubscription.readinessWireState(ready)).toEqual({ state: "not-logged-in" })
  })

  test("readinessWireState: ready maps straight through, and an unmapped reason keeps its own text", () => {
    expect(ClaudeSubscription.readinessWireState({ type: "ready", command: FAKE, version: "2.1.263" })).toEqual({
      state: "ready",
      version: "2.1.263",
      path: FAKE[0],
    })
    // Env conflicts carry no `kind` (see the type's own comment) — the wire
    // status must not guess a state for a reason none of the four name.
    expect(
      ClaudeSubscription.readinessWireState({ type: "unready", reason: "ANTHROPIC_API_KEY is set" }),
    ).toEqual({ state: "unready", reason: "ANTHROPIC_API_KEY is set" })
  })

  test("CLI not found: refused with the install hint and kind cli-missing", () => {
    const ready = ClaudeSubscription.resolveCommand({ PATH: "" })
    expect(ready).toMatchObject({ type: "unready", kind: "cli-missing" })
    expect(ClaudeSubscription.readinessWireState(ready as ClaudeSubscription.Readiness)).toEqual({
      state: "cli-missing",
    })
  })

  // t-vd9s7z: the extension discovers the newest binary (its passthrough uses
  // it too) and writes it to a hand-off file; the engine reads the file each
  // time it needs a binary. An old CLI on PATH must not win.
  const handoff = (doc: unknown) => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-handoff-"))
    const chosen = path.join(dir, "claude.exe")
    writeFileSync(chosen, "")
    const file = path.join(dir, ClaudeSubscription.CLI_FILE)
    writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc ?? { path: chosen, version: "2.1.281" }))
    return { dir, chosen, file }
  }

  test("reads the hand-off file at use time: written after the engine started, the next lookup uses it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-handoff-"))
    const file = path.join(dir, ClaudeSubscription.CLI_FILE)
    expect(ClaudeSubscription.resolveCommand({ PATH: "" }, file)).toMatchObject({ kind: "cli-missing" })
    const chosen = path.join(dir, "claude.exe")
    writeFileSync(chosen, "")
    writeFileSync(file, JSON.stringify({ path: chosen, version: "2.1.281", source: "vscode-extension", at: 1 }))
    expect(ClaudeSubscription.resolveCommand({ PATH: "" }, file)).toEqual([chosen])
  })

  test("a missing, corrupt, empty or stale hand-off falls back to PATH", () => {
    const { dir, file } = handoff({ path: path.join(tmpdir(), "no-such-dir-t-vd9s7z", "claude.exe") })
    expect(ClaudeSubscription.resolveCommand({ PATH: "" }, file)).toMatchObject({ kind: "cli-missing" })
    expect(ClaudeSubscription.resolveCommand({ PATH: "" }, path.join(dir, "absent.json"))).toMatchObject({ kind: "cli-missing" })
    expect(ClaudeSubscription.resolveCommand({ PATH: "" }, handoff("{not json").file)).toMatchObject({ kind: "cli-missing" })
    expect(ClaudeSubscription.resolveCommand({ PATH: "" }, handoff({ path: "" }).file)).toMatchObject({ kind: "cli-missing" })
  })

  test("the default hand-off file is ~/.origami/claude-cli.json (the extension writes the same name)", () => {
    expect(ClaudeSubscription.CLI_FILE).toBe("claude-cli.json")
    expect(ClaudeSubscription.handoffFile()).toBe(path.join(Global.Path.origami, "claude-cli.json"))
  })

  test("a running engine re-checks when the hand-off names a different binary than its last answer", async () => {
    const file = ClaudeSubscription.handoffFile()
    const chosen = path.join(mkdtempSync(path.join(tmpdir(), "claude-handoff-")), "claude.exe")
    writeFileSync(chosen, "") // runs as nothing: no version, so the answer is unready, never a real claude
    ClaudeSubscription.setReadiness({ type: "ready", command: ["C:\\old\\claude.exe"], version: "2.1.263" })
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ path: chosen, version: "2.1.281" }))
    try {
      const answer = await ClaudeSubscription.ensureChecked({ env: cleanEnv() })
      expect(answer).toMatchObject({ type: "unready", command: [chosen] })
    } finally {
      rmSync(file, { force: true })
    }
  })

  test("the wire status names the binary; the update step fits how it was installed", () => {
    const bundled = "C:\\Users\\u\\.vscode\\extensions\\anthropic.claude-code-2.1.281-win32-x64\\resources\\native-binary\\claude.exe"
    expect(
      ClaudeSubscription.readinessWireState({ type: "ready", command: [bundled], version: "2.1.281" }),
    ).toEqual({ state: "ready", version: "2.1.281", path: bundled })
    expect(ClaudeSubscription.updateHint(bundled)).toContain("Claude Code extension")
    expect(ClaudeSubscription.updateHint("C:\\Users\\u\\.local\\bin\\claude.exe")).toContain("claude update")
  })

  test("an API key in the environment is refused by name before the CLI is asked anything", async () => {
    const log = useScenario({})
    const ready = await ClaudeSubscription.probe({ command: FAKE, env: { ...cleanEnv(), ANTHROPIC_API_KEY: "sk-x" } })
    expect(ready.type === "unready" && ready.reason).toContain("ANTHROPIC_API_KEY")
    expect(() => readFileSync(path.join(log, "pids.log"))).toThrow()
  })

  test("status() says supported only when the probe said ready, and says why not otherwise", async () => {
    useScenario({})
    const ready = await ClaudeSubscription.probe({ command: FAKE, env: { ...cleanEnv(), ...pick() } })
    expect(ready).toMatchObject({ type: "ready", version: "2.1.263", plan: "max" })
    ClaudeSubscription.setReadiness(ready)
    expect(LLMNativeRuntime.status({ model, provider, auth: undefined })).toEqual({
      type: "supported",
      apiKey: undefined,
    })
    ClaudeSubscription.setReadiness({ type: "unready", reason: "not signed in" })
    expect(LLMNativeRuntime.status({ model, provider, auth: undefined })).toEqual({
      type: "unsupported",
      reason: "not signed in",
    })
  })

  test("the AI SDK stub refuses with the Gate B reason instead of running anything", async () => {
    ClaudeSubscription.setReadiness({ type: "unready", reason: "Claude CLI 2.1.198 is below the qualified floor" })
    const refused = await Promise.resolve(
      ClaudeSubscription.languageModel("haiku").doStream({ prompt: [] } as any),
    ).catch((error: unknown) => error)
    expect(String(refused)).toContain("below the qualified floor")
  })
})

describe("claude-subscription: catalog from the initialize handshake", () => {
  beforeEach(() => ClaudeSubscription.resetMemo())

  test("the account's picker becomes model rows: aliases, 1M only on [1m], credits on non-Max Fable, zero cost, effort ladder", async () => {
    const log = useScenario({
      models: [
        { value: "default", description: "Default (recommended)" },
        { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5 · Best for everyday tasks" },
        { value: "opus[1m]", description: "Opus 5.5 (1M context) · Most capable" },
        { value: "fable", description: "Fable 5.1 · Deep work" },
        { value: "opusplan", description: "Opus in plan mode" },
      ],
      account: { subscriptionType: "pro" },
    })
    const info = await ClaudeSubscription.providerInfo({ command: FAKE, env: { ...cleanEnv(), ...pick() } })
    expect(Object.keys(info.models)).toEqual(["sonnet", "opus[1m]", "fable"])
    expect(info.models["opus[1m]"]!.limit.context).toBe(1_000_000)
    expect(info.models.sonnet!.limit.context).toBe(200_000)
    expect(info.models.fable!.name).toBe("Fable 5.1 (usage credits)")
    expect(info.models.sonnet!.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    expect(Object.keys(info.models.sonnet!.variants!)).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
    expect(info.options.max_concurrent).toBe(2)
    // The handshake asked for the picker and wrote no user message.
    const frames = JSON.parse(readFileSync(path.join(log, "frames.json"), "utf8"))
    expect(frames.map((frame: any) => frame.type)).toEqual(["control_request"])
    expect(ClaudeSubscription.readiness().type).toBe("ready")
  })

  test("an unready CLI still lists the pinned rows so the refusal is visible at use", async () => {
    useScenario({ version: "2.1.100" })
    const info = await ClaudeSubscription.providerInfo({ command: FAKE, env: { ...cleanEnv(), ...pick() } })
    expect(Object.keys(info.models)).toEqual(["sonnet", "opus", "haiku", "fable"])
    expect(ClaudeSubscription.readiness().type).toBe("unready")
  })
})

/** The fake's control variables, for the probe's explicit env. */
const pick = () => ({ FAKE_SCENARIO: process.env.FAKE_SCENARIO, FAKE_LOG: process.env.FAKE_LOG })

describe("claude-subscription: one engine step through the fake CLI", () => {
  test("Origami runs the tool Claude asked for; usage has cache and thinking fields; no money", async () => {
    const log = useScenario({ lines: wrap(SSE.toolCall!) })
    ClaudeSubscription.setReadiness({ type: "ready", command: FAKE, version: "2.1.263" })
    const calls: unknown[] = []
    const tools: Record<string, Tool> = {
      get_weather: {
        description: "Get the current weather for a city.",
        inputSchema: jsonSchema({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
        execute: async (args: unknown) => {
          calls.push(args)
          return "sunny"
        },
      },
    }
    const native = LLMNativeRuntime.stream({
      model,
      provider,
      auth: undefined,
      llmClient: client,
      messages: [{ role: "user", content: "What is the weather in Paris?" }],
      tools,
      headers: {},
      abort: new AbortController().signal,
      providerOptions: { effort: "low" },
    })
    expect(native.type).toBe("supported")
    if (native.type !== "supported") return
    const events = [...(await Effect.runPromise(Stream.runCollect(native.stream) as Effect.Effect<any>))]
    expect(calls).toEqual([{ city: "Paris" }])
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({ name: "get_weather" })
    const finish = events.find((event) => event.type === "finish")
    expect(finish.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) })
    expect(finish.usage.cacheReadInputTokens).toBeDefined()
    // The effort variant reached the CLI as output_config.effort (Haiku: no adaptive block).
    const extra = JSON.parse(
      JSON.parse(readFileSync(path.join(log, "settings.json"), "utf8")).env.CLAUDE_CODE_EXTRA_BODY,
    )
    expect(extra.output_config).toEqual({ effort: "low" })
    expect(extra.thinking).toBeUndefined()
    expect(extra.tools.map((tool: any) => tool.name)).toEqual(["mcp__origami__get_weather"])
    expect(readFileSync(path.join(log, "requests.log"), "utf8").trim().split("\n")).toHaveLength(1)
  })
})

describe("claude-subscription: limits", () => {
  test("a plan refusal reaches the usage-limit notice with Claude's own words, and is not retryable", () => {
    const error = ClaudeCli.usageLimitError(
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
      { window: "five_hour", resetsAt: 1_000_000 + 5400 },
      1_000_000 * 1000,
    )
    const parsed = ProviderError.parseLLMError({ providerID: ProviderV2.ID.make("claude-subscription"), error })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.statusCode).toBe(429)
    expect(parsed.isRetryable).toBe(false)
    const apiError = new SessionV1.APIError({
      message: parsed.message,
      statusCode: parsed.statusCode,
      isRetryable: parsed.isRetryable,
      responseBody: parsed.responseBody,
    }).toObject()
    const limit = SessionUsageLimit.detect(apiError as any)
    expect(limit).toMatchObject({ plan: "five_hour", resetsInSeconds: 5400 })
    const notice = SessionUsageLimit.notice(limit!, "claude-subscription")
    expect(notice).toContain(
      "Claude subscription usage limit reached on the five_hour plan. It resets in about 90 minutes.",
    )
    expect(notice).toContain("exceed your account's rate limit")
  })

  test("the per-window cap holds four sub-agent steps to two CLI processes", async () => {
    ProviderConcurrency.resetProviderSemaphores()
    ClaudeSubscription.setReadiness({ type: "ready", command: ["C:/never/run/claude.exe"], version: "2.1.263" })
    const gates: Array<() => void> = []
    const state = { active: 0, peak: 0, spawned: 0 }
    const executor = ProcessExecutor.Service.of({
      spawn: () =>
        Effect.gen(function* () {
          state.spawned++
          state.active++
          state.peak = Math.max(state.peak, state.active)
          const lines = yield* Queue.unbounded<string, any>()
          return {
            pid: undefined,
            lines,
            write: () => Effect.void,
            closeInput: Effect.sync(() =>
              gates.push(() => {
                for (const line of wrap(SSE.toolAnswer!)) Queue.offerUnsafe(lines, JSON.stringify(line))
                Queue.endUnsafe(lines)
              }),
            ),
            kill: Effect.sync(() => {
              state.active = Math.max(0, state.active - 1)
            }),
            exited: Effect.succeed(0),
            stderr: () => [],
          }
        }),
    })
    const parked = Effect.runSync(
      Effect.gen(function* () {
        return yield* LLMClient.Service
      }).pipe(Effect.provide(clientLayer), Effect.provide(Layer.succeed(ProcessExecutor.Service, executor))),
    )
    const start = (id: string) => {
      const native = LLMNativeRuntime.stream({
        model,
        provider,
        auth: undefined,
        llmClient: parked,
        messages: [{ role: "user", content: "hi" }],
        tools: {},
        headers: {},
        abort: new AbortController().signal,
        sessionID: `child-${id}`,
        parentSessionID: "root",
      })
      if (native.type !== "supported") throw new Error(native.reason)
      return Effect.runFork(Stream.runCollect(native.stream))
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
    const fibers = ["a", "b", "c", "d"].map(start)
    await settle()
    expect(state.spawned).toBe(2)
    gates.shift()!()
    await settle()
    expect(state.spawned).toBe(3)
    while (state.spawned < 4 || gates.length) {
      gates.shift()?.()
      await settle()
    }
    const exits = await Promise.all(fibers.map((fiber) => Effect.runPromise(Fiber.await(fiber))))
    expect(exits.every(Exit.isSuccess)).toBe(true)
    expect(state.peak).toBe(2)
  })
})

describe("claude-subscription: grep gate", () => {
  // The route's own files. They may NAME these things in comments and in the
  // refusal list; they must never open a credential file, set a base URL for the
  // child (a relay), or touch an Authorization header in code.
  const FILES = [
    "../../src/provider/claude-subscription.ts",
    "../../../llm/src/route/transport/claude-cli.ts",
    "../../../llm/src/route/transport/process.ts",
    "../../../llm/src/providers/claude-subscription.ts",
  ].map((file) => path.resolve(import.meta.dir, file))

  test("no credential file, no base-URL relay, no Authorization header in code", () => {
    for (const file of FILES) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n")
      expect({ file, hit: /\.credentials|credentials\.json/.test(code) }).toEqual({ file, hit: false })
      expect({ file, hit: /ANTHROPIC_BASE_URL\s*[:=]|\[\s*["']ANTHROPIC_BASE_URL["']\s*\]\s*=/.test(code) }).toEqual({
        file,
        hit: false,
      })
      expect({ file, hit: /authorization/i.test(code) }).toEqual({ file, hit: false })
    }
  })
})

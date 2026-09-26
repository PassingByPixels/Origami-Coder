import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Effect, Option, Queue, Stream } from "effect"
import type { AnthropicMessagesBody } from "../../protocols/anthropic-messages"
import * as ProviderShared from "../../protocols/shared"
import {
  AuthenticationReason,
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  LLMError,
  ProviderInternalReason,
  QuotaExceededReason,
  TransportReason,
  UnknownProviderReason,
  type LLMRequest,
} from "../../schema"
import type { Transport, TransportRuntime } from "./index"
import { spawnNode, type Handle, type Interface as ProcessInterface } from "./process"

/**
 * The installed `claude` CLI used as a MODEL CLIENT, one process per model step.
 *
 * Origami keeps the agent loop: its own tools, approvals, compaction and
 * history. The CLI gets the history as stream-json frames, answers ONE
 * Messages request with its own credentials, and is killed at the first
 * complete message. The shape is the Hermes `claude-subscription-directsdk`
 * plugin (v0.3.0, `directsdk.py`), with one change: there is no loopback relay
 * on ANTHROPIC_BASE_URL, so Origami never holds the Authorization header.
 * Admission is the kill at `message_stop` instead (see `ADMISSION` below).
 *
 * The CLI's own tools, settings, hooks, skills and MCP servers are all off.
 * Origami's tools reach the model as `mcp__origami__<name>` through an inert
 * stdio MCP server that lists them and refuses every call; the tool calls come
 * back on the stream and the engine runs them.
 *
 * This module never opens a Claude credential file and never reads a header.
 */

export const TOOL_PREFIX = "mcp__origami__"
const MCP_SERVER_NAME = "origami"

/** `mcp__origami__` + name must fit the 64-character tool-name limit. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,50}$/

/** Auth and backend overrides that would move the CLI off the subscription. */
export const REFUSED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
]
export const REFUSED_BACKEND_FLAGS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]
const FALSE_WORDS = new Set(["", "0", "false", "no", "off"])
/** `CLAUDE*` keys the child keeps: where the login lives, and the Windows bash path. */
const KEPT_CLAUDE_KEYS = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"])

export type SourceEnv = Readonly<Record<string, string | undefined>>

/** The names (never the values) of variables that make this route refuse to start. */
export const envConflicts = (env: SourceEnv): ReadonlyArray<string> =>
  Object.entries(env).flatMap(([key, value]) => {
    const name = key.toUpperCase()
    if (value === undefined || value === "") return []
    if (REFUSED_ENV.includes(name)) return [name]
    if (REFUSED_BACKEND_FLAGS.includes(name) && !FALSE_WORDS.has(value.trim().toLowerCase())) return [name]
    return []
  })

export const conflictMessage = (names: ReadonlyArray<string>) =>
  `Claude (subscription) refuses to start while ${names.join(", ")} ${names.length === 1 ? "is" : "are"} set: ` +
  `the CLI would use that key or backend instead of your subscription. Unset ${names.length === 1 ? "it" : "them"} for the engine, or use the Anthropic API-key connection.`

/**
 * The child's environment: the parent's, without Origami's own flags or any
 * inherited Claude Code session state, plus the switches that make the CLI a
 * stateless one-request client (Hermes `directsdk.py:466-476`).
 */
export const childEnv = (source: SourceEnv, maxTokens: number | undefined): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const name = key.toUpperCase()
    if (name.startsWith("ORIGAMI_")) continue
    if (name.startsWith("CLAUDE") && !KEPT_CLAUDE_KEYS.has(name)) continue
    env[key] = value
  }
  return {
    ...env,
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    // The replayed token-budget reminder changes the prefix and cost Hermes its
    // cache reads (3.66 % before, ~98 % after, README.md:88-92).
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    ...(maxTokens === undefined ? {} : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) }),
  }
}

/** The stdio MCP server the CLI starts: lists Origami's tools, runs none of them. */
export const INERT_MCP_SCRIPT = `import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
const tools = JSON.parse(readFileSync(process.argv[2], "utf8"))
const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  let row
  try { row = JSON.parse(line) } catch { return }
  let result = {}
  if (row.method === "initialize")
    result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "origami-inert-inventory", version: "1" } }
  else if (row.method === "tools/list") result = { tools }
  else if (row.method === "tools/call")
    result = { isError: true, content: [{ type: "text", text: "Denied: this tool list is inert; only Origami runs tools." }] }
  if (row.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: row.id, result }) + "\\n")
})
rl.on("close", () => process.exit(0))
`

export interface Options {
  /** The CLI: an absolute executable path plus any fixed leading arguments. */
  readonly command: ReadonlyArray<string>
  /** What runs the inert MCP script. Default: this runtime (`BUN_BE_BUN=1` for a compiled engine). */
  readonly mcpCommand?: ReadonlyArray<string>
  /** Silence on stdout longer than this fails the step. Default 180 s, as Hermes. */
  readonly idleTimeoutMs?: number
  /** The environment the child is built from. Default `process.env`. */
  readonly env?: SourceEnv
}

type Block = Record<string, unknown>

export interface Frame {
  readonly type: "user" | "assistant"
  readonly message: { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> }
}

export interface ManifestTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export interface Prepared {
  readonly model: string
  readonly system: string
  readonly frames: ReadonlyArray<Frame>
  /** The Messages-body fragment the CLI merges into its request (`CLAUDE_CODE_EXTRA_BODY`). */
  readonly extraBody: Record<string, unknown>
  readonly manifest: ReadonlyArray<ManifestTool>
  readonly names: ReadonlySet<string>
  readonly maxTokens: number | undefined
}

const invalid = ProviderShared.invalidRequest

const withoutCacheControl = (block: Block): Block => {
  const { cache_control: _cache, eager_input_streaming: _eager, ...rest } = block
  return rest
}

/** The CLI owns cache breakpoints; an empty text block is a 400 upstream. */
const cleanBlock = (block: Block): Block | undefined => {
  if (block.type === "text" && (typeof block.text !== "string" || block.text === "")) return undefined
  // A thinking block without its signature cannot be replayed (Hermes drops them too).
  if (block.type === "thinking" && typeof block.signature !== "string") return undefined
  if (block.type === "tool_use") return { ...withoutCacheControl(block), name: TOOL_PREFIX + String(block.name) }
  return withoutCacheControl(block)
}

const SERVER_BLOCKS = new Set([
  "server_tool_use",
  "web_search_tool_result",
  "code_execution_tool_result",
  "web_fetch_tool_result",
])

/** History as stream-json frames. Adjacent user frames merge; the last frame must ask. */
export const historyFrames = Effect.fn("ClaudeCli.historyFrames")(function* (body: AnthropicMessagesBody) {
  const frames: { type: "user" | "assistant"; message: { role: "user" | "assistant"; content: Block[] } }[] = []
  for (const message of body.messages) {
    const blocks: Block[] = []
    for (const raw of message.content as ReadonlyArray<Block>) {
      if (SERVER_BLOCKS.has(String(raw.type)))
        return yield* invalid("Claude (subscription) does not run provider-side tools; this history has one")
      const block = cleanBlock(raw)
      if (block) blocks.push(block)
    }
    if (blocks.length === 0) continue
    // A mid-conversation system update (Opus 4.8 only) cannot be a stream-json
    // frame; it rides in the user turn it follows, as the wrapped fallback does.
    const role = message.role === "assistant" ? "assistant" : "user"
    const last = frames.at(-1)
    if (last && last.type === role && role === "user") last.message.content.push(...blocks)
    else frames.push({ type: role, message: { role, content: blocks } })
  }
  const last = frames.at(-1)
  if (!last || last.type !== "user")
    return yield* invalid(
      "Claude (subscription) needs the history to end with a user or tool-result message; assistant prefill is not supported",
    )
  return frames as ReadonlyArray<Frame>
})

const BANNED_TOP_LEVEL = ["oneOf", "allOf", "anyOf"]

/** Top-level combinators are a hard 400 on Anthropic's validator (Hermes `normalize_input_schema`). */
const toolSchema = (schema: Record<string, unknown>) => {
  const kept = Object.fromEntries(Object.entries(schema).filter(([key]) => !BANNED_TOP_LEVEL.includes(key)))
  const typed = kept.type === undefined ? { ...kept, type: "object" } : kept
  return typed.type === "object" && !ProviderShared.isRecord(typed.properties) ? { ...typed, properties: {} } : typed
}

/** Effort ladder the CLI's models take on `output_config.effort`. */
export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const
export type Effort = (typeof EFFORTS)[number]

/** Haiku 4.5 answers `thinking: {type: "adaptive"}` with a 400 (Hermes `model_catalog.py`). */
export const supportsAdaptiveThinking = (model: string) => !/haiku-4-5|^haiku$/.test(model.replace(/\[1m\]$/, ""))

/** Where the engine puts this route's options: keyed by provider id, as `ProviderTransform.providerOptions` does. */
export const OPTIONS_KEY = "claude-subscription"

const effortOf = Effect.fn("ClaudeCli.effortOf")(function* (request: LLMRequest) {
  const options = request.providerOptions?.[OPTIONS_KEY]
  const value = ProviderShared.isRecord(options) ? options.effort : undefined
  if (value === undefined) return undefined
  if (typeof value !== "string" || !(EFFORTS as ReadonlyArray<string>).includes(value))
    return yield* invalid(`Claude (subscription) effort must be one of ${EFFORTS.join(", ")}`)
  return value as Effort
})

export const prepareRequest = Effect.fn("ClaudeCli.prepare")(function* (
  body: AnthropicMessagesBody,
  request: LLMRequest,
) {
  const frames = yield* historyFrames(body)
  const effort = yield* effortOf(request)
  const names = new Set<string>()
  const manifest: ManifestTool[] = []
  const tools: Record<string, unknown>[] = []
  for (const tool of body.tools ?? []) {
    if (!TOOL_NAME.test(tool.name) || names.has(tool.name))
      return yield* invalid(
        `Claude (subscription) needs unique tool names of at most 50 ASCII letters, digits, _ or -; "${tool.name}" is not`,
      )
    names.add(tool.name)
    const schema = toolSchema(tool.input_schema)
    manifest.push({ name: tool.name, description: tool.description, inputSchema: schema })
    tools.push({ name: TOOL_PREFIX + tool.name, description: tool.description, input_schema: schema })
  }
  // A forced tool choice is refused with thinking on, and adaptive-thinking models
  // refuse thinking disabled (t-ytsf8q). Those models keep the choice unforced
  // (auto) and their thinking; only models without adaptive thinking are forced.
  const forced =
    body.tool_choice !== undefined && body.tool_choice.type !== "auto" && !supportsAdaptiveThinking(body.model)
  const extraBody: Record<string, unknown> = {
    tools,
    max_tokens: body.max_tokens,
    ...(body.stop_sequences?.length ? { stop_sequences: body.stop_sequences } : {}),
    ...(forced
      ? {
          tool_choice: body.tool_choice,
          thinking: { type: "disabled" },
          context_management: { edits: [] },
        }
      : effort === "none"
        ? { thinking: { type: "disabled" }, context_management: { edits: [] } }
        : effort
          ? {
              ...(supportsAdaptiveThinking(body.model) ? { thinking: { type: "adaptive" } } : {}),
              output_config: { effort },
            }
          : {}),
  }
  // temperature / top_p / top_k are dropped: subscription models reject sampling
  // controls (Hermes `directsdk.py:216-221`).
  return {
    model: body.model,
    system: (body.system ?? []).map((part) => part.text).join("\n\n"),
    frames,
    extraBody,
    manifest,
    names,
    maxTokens: body.max_tokens,
  } satisfies Prepared
})

export interface Paths {
  readonly dir: string
  readonly system: string
  readonly settings: string
  readonly mcp: string
}

/** The Hermes argv (`directsdk.py:478`), with the MCP config in a file. */
export const argv = (prepared: Pick<Prepared, "model">, paths: Paths): ReadonlyArray<string> => [
  "-p",
  "--model",
  prepared.model,
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--tools",
  "",
  "--system-prompt-file",
  paths.system,
  "--settings",
  paths.settings,
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--max-turns",
  "1",
  "--permission-mode",
  "dontAsk",
  "--no-session-persistence",
  "--mcp-config",
  paths.mcp,
]

// ---------------------------------------------------------------------------
// Errors

const PROCESS_URL = "claude-cli://messages"
const LIMIT_TEXT = /rate[_ -]?limit|\b429\b|usage limit|usage credits|out of (?:usage|credits)|quota exceeded/i

const httpContext = (status: number, body: string) =>
  new HttpContext({
    request: new HttpRequestDetails({ method: "POST", url: PROCESS_URL, headers: {} }),
    response: new HttpResponseDetails({ status, headers: {} }),
    body,
  })

export interface PlanLimit {
  readonly window?: string
  readonly resetsAt?: number
}

/**
 * A plan or rate refusal, shaped as the usage-limit body the engine already
 * reads (`session/usage-limit.ts`): the retry ladder lets it out on the first
 * attempt, because a retry on a subscription spends the same window again.
 */
export const usageLimitError = (upstream: string, limit: PlanLimit | undefined, now = Date.now()) => {
  const seconds =
    limit?.resetsAt !== undefined && limit.resetsAt > 0
      ? Math.max(0, Math.round(limit.resetsAt - now / 1000))
      : undefined
  const body = JSON.stringify({
    error: {
      type: "usage_limit_reached",
      ...(limit?.window ? { plan_type: limit.window } : {}),
      ...(seconds === undefined ? {} : { resets_in_seconds: seconds }),
      // Read by the engine's session/usage-limit.ts into the notice.
      upstream_message: upstream,
    },
  })
  return new LLMError({
    module: "ClaudeCli",
    method: "stream",
    reason: new QuotaExceededReason({
      message: upstream || "Claude usage limit reached",
      http: httpContext(429, body),
    }),
  })
}

const failure = (message: string, status: number | undefined) => {
  if (status === 401 || status === 403)
    return new LLMError({
      module: "ClaudeCli",
      method: "stream",
      reason: new AuthenticationReason({
        message: `${message} (run \`claude auth login\` in a terminal, then try again)`,
        kind: "invalid",
      }),
    })
  if (status !== undefined && status >= 500)
    return new LLMError({
      module: "ClaudeCli",
      method: "stream",
      reason: new ProviderInternalReason({ message, status }),
    })
  return new LLMError({ module: "ClaudeCli", method: "stream", reason: new UnknownProviderReason({ message, status }) })
}

const transportFailure = (message: string, kind: string) =>
  new LLMError({
    module: "ClaudeCli",
    method: "stream",
    reason: new TransportReason({ message, kind, url: PROCESS_URL }),
  })

// ---------------------------------------------------------------------------
// The step

type Line = Record<string, unknown>

const texts = (message: unknown) =>
  ProviderShared.isRecord(message) && Array.isArray(message.content)
    ? message.content
        .filter((block): block is Block => ProviderShared.isRecord(block) && block.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("\n")
    : ""

interface StepState {
  stopped: boolean
  planLimit: PlanLimit | undefined
  apiError: { kind: string; text: string } | undefined
}

/** The classified failure for a step that ended without a complete message. */
const endedWithout = (state: StepState, result: Line | undefined, exit: string) => {
  const errors = Array.isArray(result?.errors) ? result.errors.filter((item) => typeof item === "string") : []
  const said = [state.apiError?.text, ...errors, typeof result?.result === "string" ? result.result : undefined]
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .join(" · ")
  const status = typeof result?.api_error_status === "number" ? result.api_error_status : undefined
  if (status === 429 || state.planLimit || state.apiError?.kind === "rate_limit" || LIMIT_TEXT.test(said))
    return usageLimitError(said, state.planLimit)
  if (said) return failure(`Claude CLI request failed: ${said}`, status)
  return failure(`Claude CLI ended without a complete message (${exit})`, status)
}

const parseLine = (line: string) =>
  Effect.try({
    try: () => JSON.parse(line) as unknown,
    catch: () =>
      ProviderShared.eventError(PROCESS_URL, "Invalid stream-json line from the Claude CLI", line.slice(0, 300)),
  }).pipe(
    Effect.flatMap((value) =>
      ProviderShared.isRecord(value)
        ? Effect.succeed(value as Line)
        : Effect.fail(
            ProviderShared.eventError(PROCESS_URL, "Invalid stream-json line from the Claude CLI", line.slice(0, 300)),
          ),
    ),
  )

const nextLine = (handle: Handle, idleMs: number) =>
  Queue.take(handle.lines).pipe(
    Effect.map(Option.some),
    Effect.catchIf(Cause.isDone, () => Effect.succeed(Option.none<string>())),
    Effect.timeoutOption(idleMs),
    Effect.flatMap((value) =>
      Option.isNone(value)
        ? Effect.fail(transportFailure(`The Claude CLI wrote nothing for ${Math.round(idleMs / 1000)} s`, "timeout"))
        : Effect.succeed(value.value),
    ),
  )

/** Write the history; every user frame but the last is replayed without a query and must be acknowledged with zero turns. */
const replay = Effect.fn("ClaudeCli.replay")(function* (handle: Handle, frames: ReadonlyArray<Frame>, idleMs: number) {
  for (const [index, frame] of frames.entries()) {
    const silent = frame.type === "user" && index < frames.length - 1
    yield* handle.write(JSON.stringify(silent ? { ...frame, shouldQuery: false } : frame))
    if (!silent) continue
    while (true) {
      const line = yield* nextLine(handle, idleMs)
      if (Option.isNone(line))
        return yield* transportFailure("The Claude CLI exited before acknowledging the history", "replay")
      const row = yield* parseLine(line.value)
      if (row.type === "stream_event")
        return yield* failure(
          "This Claude CLI answered a replayed history frame with a request; history replay is not supported by this version",
          undefined,
        )
      if (row.type !== "result") continue
      if (row.num_turns !== 0 || row.is_error === true)
        return yield* failure(
          "This Claude CLI did not acknowledge a replayed history frame with zero turns; history replay is not supported by this version",
          undefined,
        )
      break
    }
  }
  yield* handle.closeInput
})

/** Rewrite one stream event for the Anthropic decoder: tool names lose the MCP prefix and must be Origami's. */
const rewriteEvent = (event: Record<string, unknown>, names: ReadonlySet<string>) => {
  const block = event.content_block
  if (event.type !== "content_block_start" || !ProviderShared.isRecord(block) || block.type !== "tool_use") return event
  const name = String(block.name ?? "")
  const bare = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : undefined
  if (bare === undefined || !names.has(bare)) return undefined
  return { ...event, content_block: { ...block, name: bare } }
}

/**
 * ADMISSION. The CLI can start a second generation after the first answer even
 * with `--max-turns 1` (Hermes README.md:42). Hermes blocks it with a loopback
 * relay that holds the bearer token; Origami kills the process tree the moment
 * the first `message_stop` arrives, so the token never leaves the CLI. The
 * residual window is the time from the CLI writing that line to the process
 * dying; `test/claude-cli.test.ts` measures it on a fake CLI.
 */
const readStep = Effect.fn("ClaudeCli.readStep")(function* (
  handle: Handle,
  prepared: Prepared,
  idleMs: number,
  emit: (frame: string) => Effect.Effect<void>,
) {
  const state: StepState = { stopped: false, planLimit: undefined, apiError: undefined }
  while (true) {
    const next = yield* nextLine(handle, idleMs)
    if (Option.isNone(next)) {
      const code = yield* handle.exited.pipe(Effect.timeoutOption(2000))
      const stderr = handle.stderr().join(" | ")
      const exit = `exit code ${Option.getOrElse(code, () => null) ?? "unknown"}${stderr ? `; stderr: ${stderr}` : ""}`
      return yield* endedWithout(state, undefined, exit)
    }
    const row = yield* parseLine(next.value)
    if (row.type === "stream_event" && ProviderShared.isRecord(row.event)) {
      const event = rewriteEvent(row.event, prepared.names)
      if (!event) {
        yield* handle.kill
        return yield* failure(
          `Claude asked for a tool outside Origami's tool list: ${String((row.event.content_block as Block).name)}`,
          undefined,
        )
      }
      if (event.type === "error") {
        const error = ProviderShared.isRecord(event.error) ? event.error : {}
        const message = String(error.message ?? error.type ?? "stream error")
        if (error.type === "rate_limit_error" || LIMIT_TEXT.test(message))
          return yield* usageLimitError(message, state.planLimit)
      }
      if (event.type === "message_stop") {
        state.stopped = true
        // Kill first, then hand the last frame on: the kill is the admission gate.
        yield* handle.kill
        yield* emit(JSON.stringify(event))
        return
      }
      yield* emit(JSON.stringify(event))
      continue
    }
    if (row.type === "rate_limit_event" && ProviderShared.isRecord(row.rate_limit_info)) {
      const info = row.rate_limit_info
      if (info.status === "rejected")
        state.planLimit = {
          window: typeof info.rateLimitType === "string" ? info.rateLimitType : undefined,
          resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : undefined,
        }
      continue
    }
    if (row.type === "assistant") {
      const message = ProviderShared.isRecord(row.message) ? row.message : {}
      const kind = row.error ?? message.error
      if (kind !== undefined) state.apiError = { kind: String(kind), text: texts(message) }
      continue
    }
    if (row.type === "result") return yield* endedWithout(state, row, "the CLI reported a result before message_stop")
  }
})

const makeDir = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => mkdtemp(path.join(tmpdir(), "origami-claude-")),
    catch: (error) =>
      transportFailure(`Could not create a private temp dir: ${ProviderShared.errorText(error)}`, "prepare"),
  }),
  // Windows refuses to delete a cwd a dying child still holds; a leftover dir must not fail the step.
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)),
)

const writeFiles = (dir: string, prepared: Prepared, mcpCommand: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const paths: Paths = {
        dir,
        system: path.join(dir, "system.md"),
        settings: path.join(dir, "settings.json"),
        mcp: path.join(dir, "mcp.json"),
      }
      const tools = path.join(dir, "tools.json")
      const script = path.join(dir, "inert-mcp.mjs")
      const [command, ...args] = mcpCommand
      await Promise.all([
        writeFile(paths.system, prepared.system, "utf8"),
        // Settings carry the body fragment: no per-argument or env-string length limit.
        writeFile(
          paths.settings,
          JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(prepared.extraBody) } }),
          "utf8",
        ),
        writeFile(tools, JSON.stringify(prepared.manifest), "utf8"),
        writeFile(script, INERT_MCP_SCRIPT, "utf8"),
        writeFile(
          paths.mcp,
          JSON.stringify({
            mcpServers: {
              [MCP_SERVER_NAME]: { command, args: [...args, script, tools], env: { BUN_BE_BUN: "1" } },
            },
          }),
          "utf8",
        ),
      ])
      return paths
    },
    catch: (error) => transportFailure(`Could not write the step files: ${ProviderShared.errorText(error)}`, "prepare"),
  })

export interface ClaudeCliTransport extends Transport<AnthropicMessagesBody, Prepared, string> {}

export const transport = (options: Options): ClaudeCliTransport => ({
  id: "claude-cli",
  prepare: (input) => prepareRequest(input.body, input.request),
  frames: (prepared, _request, runtime: TransportRuntime) =>
    Stream.callback<string, LLMError>((queue) =>
      Effect.gen(function* () {
        const source = options.env ?? process.env
        const conflicts = envConflicts(source)
        if (conflicts.length > 0) return yield* failure(conflictMessage(conflicts), undefined)
        const [command, ...fixed] = options.command
        if (!command) return yield* failure("Claude (subscription) has no CLI path configured", undefined)
        const idleMs = options.idleTimeoutMs ?? 180_000
        const dir = yield* makeDir
        const paths = yield* writeFiles(dir, prepared, options.mcpCommand ?? [process.execPath])
        const executor: ProcessInterface = runtime.process ?? { spawn: spawnNode }
        const handle = yield* Effect.acquireRelease(
          executor.spawn({
            command,
            args: [...fixed, ...argv(prepared, paths)],
            cwd: dir,
            env: childEnv(source, prepared.maxTokens),
          }),
          (handle) => handle.kill.pipe(Effect.andThen(handle.exited.pipe(Effect.timeoutOption(5000)))),
        )
        yield* replay(handle, prepared.frames, idleMs)
        yield* readStep(handle, prepared, idleMs, (frame) => Queue.offer(queue, frame).pipe(Effect.asVoid))
        yield* Queue.end(queue)
      }).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
    ),
})

export const ClaudeCli = {
  transport,
  prepareRequest,
  historyFrames,
  argv,
  childEnv,
  envConflicts,
  conflictMessage,
  usageLimitError,
  supportsAdaptiveThinking,
  TOOL_PREFIX,
  OPTIONS_KEY,
  EFFORTS,
  INERT_MCP_SCRIPT,
} as const

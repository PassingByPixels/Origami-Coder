/**
 * LIVE gate for tool-result aging (token-burn plan item 2.1).
 *
 * The offline replay (`script/tool-aging-replay.ts`) answers "how many bytes
 * does aging save". This one answers the question that decides whether the
 * feature ships: DOES THE MODEL BEHAVE DIFFERENTLY WHEN THE OLD RESULTS ARE
 * STUBS? It replays real recorded turns twice against a local model — once
 * with the full history, once with the aged history, everything else
 * byte-identical — and compares the tool call the model makes next.
 *
 * The gate, from the plan: "if the aged run re-reads a file the full run did
 * not, K goes up, not the feature off".
 *
 *   bun script/tool-aging-live.ts <copy-of-origami.db> --turns 30 \
 *     [--k 6] [--base-url http://host:8000/v1] [--model NAME] [--out FILE]
 *
 * IT NEVER WRITES A DATABASE. The copy is opened readonly with
 * `PRAGMA query_only = ON` and any path under the live instance directory is
 * refused, exactly as the offline replay does.
 *
 * WHAT IT APPROXIMATES, stated plainly:
 *
 * - The system prompt the turn really carried is not stored. A fixed short
 *   prompt is used for both runs, so it cancels out of the comparison.
 * - Tool DECLARATIONS are rebuilt from this engine's own tool modules (the
 *   real `Parameters` schema through `ToolJsonSchema.fromSchema`, the real
 *   description text file). A tool the recorded session used that this engine
 *   does not define — an MCP or foreign-harness tool — is declared with a
 *   permissive object schema and a one-line description, because the name has
 *   to be callable for the model's next call to be comparable at all. Both
 *   runs get the identical block either way.
 * - `--k` above the engine's `K` is SIMULATED: the plan is taken at the real
 *   K and then rewrites are dropped for the last `--k` completed results that
 *   were not superseded. That is what `plan()` itself would keep, because its
 *   tail test is `!superseder && tail.has(id)`.
 */

import { Database as Sqlite } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { Schema } from "effect"
import { MessageV2 } from "../src/session/message-v2"
import { SessionToolAging } from "../src/session/tool-aging"
import { ToolJsonSchema } from "../src/tool/json-schema"
import { ShellPrompt } from "../src/tool/shell/prompt"
import { Parameters as ReadParameters } from "../src/tool/read"
import { Parameters as EditParameters } from "../src/tool/edit"
import { Parameters as GrepParameters } from "../src/tool/grep"
import { Parameters as GlobParameters } from "../src/tool/glob"
import { Parameters as WriteParameters } from "../src/tool/write"
import { Parameters as TodoParameters } from "../src/tool/todo"
import { Parameters as ApplyPatchParameters } from "../src/tool/apply_patch"
import { Parameters as GitDiffParameters } from "../src/tool/git-diff"
import { Parameters as FileParameters } from "../src/tool/file"
import { Parameters as SkillParameters } from "../src/tool/skill"
import { Parameters as QuestionParameters } from "../src/tool/question"
import READ_DESCRIPTION from "../src/tool/read.txt"
import EDIT_DESCRIPTION from "../src/tool/edit.txt"
import GREP_DESCRIPTION from "../src/tool/grep.txt"
import GLOB_DESCRIPTION from "../src/tool/glob.txt"
import WRITE_DESCRIPTION from "../src/tool/write.txt"
import TODOWRITE_DESCRIPTION from "../src/tool/todowrite.txt"
import APPLY_PATCH_DESCRIPTION from "../src/tool/apply_patch.txt"
import GIT_DIFF_DESCRIPTION from "../src/tool/git-diff.txt"
import FILE_DESCRIPTION from "../src/tool/file.txt"
import SKILL_DESCRIPTION from "../src/tool/skill.txt"
import QUESTION_DESCRIPTION from "../src/tool/question.txt"
import type { Provider } from "../src/provider/provider"
import type { SessionV1 } from "@origami/core/v1/session"

const DEFAULT_TURNS = 30
const DEFAULT_CONTEXT = 200_000
const DEFAULT_BASE_URL = "http://192.0.2.10:8000/v1"
const DEFAULT_MODEL = "deepseek-v4-flash-vision-exp-ablit"
/**
 * Completion cap. 512 was the plan's number and it is TOO SMALL for a
 * reasoning model on a long prompt: at 512 this box truncated 19 of 30 OFF
 * completions against 9 of 30 ON, and a truncated reply carries no tool call
 * at all. That asymmetry is not neutral - the OFF prompt is the bigger one, so
 * the cap silently manufactures "the aged run acted and the full run did not".
 * Raise it with --max-tokens whenever a run shows empty text replies.
 */
const DEFAULT_MAX_TOKENS = 512
/** Sessions carrying more attachment bytes than this are skipped. */
const MAX_ATTACHMENT_BYTES = 200 * 1024
/** Characters of a `bash` command that must match for a call to count as "same". */
const COMMAND_MATCH_CHARS = 40
const FALLBACK_SYSTEM =
  "You are a coding agent. Use the tools when you need information; answer directly when you already have it."

const RERUN_K = [10, 14] as const

function isLivePath(target: string): boolean {
  const normalized = target.replaceAll("\\", "/").toLowerCase()
  return normalized.includes("/.local/share/origami/")
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase()
}

/** Only the shape `toModelMessagesEffect` reads off a model. */
const model = {
  id: "replay",
  providerID: "replay",
  api: { id: "replay", url: "https://example.invalid", npm: "@ai-sdk/openai" },
  name: "Replay",
  limit: { context: 0, input: 0, output: 0 },
} as unknown as Provider.Model

type Row = { id: string; data: string }
type Message = { info: SessionV1.Info; parts: SessionV1.Part[] }

function loadSession(db: Sqlite, sessionID: string): Message[] {
  const messageRows = db
    .query<Row & { session_id: string }, [string]>(
      "select id, session_id, data from message where session_id = ? order by time_created asc, id asc",
    )
    .all(sessionID)
  const partRows = db
    .query<Row & { message_id: string; session_id: string }, [string]>(
      "select id, message_id, session_id, data from part where session_id = ? order by message_id asc, id asc",
    )
    .all(sessionID)

  const byMessage = new Map<string, SessionV1.Part[]>()
  for (const row of partRows) {
    const part = { ...JSON.parse(row.data), id: row.id, sessionID: row.session_id, messageID: row.message_id }
    const list = byMessage.get(row.message_id)
    if (list) list.push(part)
    else byMessage.set(row.message_id, [part])
  }
  return messageRows.map((row) => ({
    info: { ...(JSON.parse(row.data) as object), id: row.id, sessionID: row.session_id } as SessionV1.Info,
    parts: byMessage.get(row.id) ?? [],
  }))
}

// ---------------------------------------------------------------- tool block

type Declaration = { readonly name: string; readonly description: string; readonly parameters: JSONSchema7 }

const PERMISSIVE: JSONSchema7 = { type: "object", properties: {}, additionalProperties: true }

function schema(value: unknown): JSONSchema7 {
  return ToolJsonSchema.fromSchema(value as Schema.Top)
}

/**
 * The engine's own tools, by the id the registry gives them. `bash` is built
 * from the same renderer `tool/shell.ts` uses, for this box's platform.
 */
function builtinDeclarations(): Map<string, Declaration> {
  const shell = ShellPrompt.render("bash", os.platform(), { maxLines: 1000, maxBytes: 30_000 }, 120_000)
  const table: [string, string, unknown][] = [
    ["read", READ_DESCRIPTION, ReadParameters],
    ["edit", EDIT_DESCRIPTION, EditParameters],
    ["grep", GREP_DESCRIPTION, GrepParameters],
    ["glob", GLOB_DESCRIPTION, GlobParameters],
    ["write", WRITE_DESCRIPTION, WriteParameters],
    ["todowrite", TODOWRITE_DESCRIPTION, TodoParameters],
    ["apply_patch", APPLY_PATCH_DESCRIPTION, ApplyPatchParameters],
    ["git_diff", GIT_DIFF_DESCRIPTION, GitDiffParameters],
    ["file", FILE_DESCRIPTION, FileParameters],
    ["skill", SKILL_DESCRIPTION, SkillParameters],
    ["question", QUESTION_DESCRIPTION, QuestionParameters],
    ["bash", shell.description, shell.parameters],
  ]
  const result = new Map<string, Declaration>()
  for (const [name, description, parameters] of table) {
    result.set(name, { name, description, parameters: schema(parameters) })
  }
  return result
}

const BUILTINS = builtinDeclarations()

/** OpenAI tool names allow `[A-Za-z0-9_-]` only; every recorded id already does. */
function declare(names: Iterable<string>): Declaration[] {
  const seen = new Set<string>()
  const out: Declaration[] = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const builtin = BUILTINS.get(name)
    if (builtin) {
      out.push(builtin)
      continue
    }
    out.push({
      name,
      description: `The \`${name}\` tool, as used earlier in this session. Call it with the same argument shape you used before.`,
      parameters: PERMISSIVE,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ------------------------------------------------------------- wire messages

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

type ToolResultOutput =
  | { type: "text" | "error-text"; value: string }
  | { type: "json" | "error-json"; value: unknown }
  | { type: "content"; value: { type: string; text?: string; data?: string }[] }

function outputText(output: unknown): string {
  const value = output as ToolResultOutput
  if (!value || typeof value !== "object") return String(output ?? "")
  if (value.type === "text" || value.type === "error-text") return String(value.value ?? "")
  if (value.type === "content") {
    return (value.value ?? [])
      .map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type} attachment omitted]`))
      .join("\n")
  }
  return JSON.stringify(value.value ?? null)
}

type ModelPart = {
  type: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
}

/**
 * `ModelMessage[]` from `toModelMessagesEffect` to the OpenAI chat shape.
 *
 * Media is dropped: this gate measures whether the model re-reads a FILE, and
 * a screenshot on the wire only buys prefill time. Both runs get the same
 * treatment, so the comparison is unaffected.
 */
function toChat(messages: readonly unknown[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const raw of messages) {
    const message = raw as { role: string; content: unknown }
    const parts: ModelPart[] = Array.isArray(message.content)
      ? (message.content as ModelPart[])
      : [{ type: "text", text: String(message.content ?? "") }]

    if (message.role === "tool") {
      for (const part of parts) {
        if (part.type !== "tool-result" || !part.toolCallId) continue
        out.push({ role: "tool", tool_call_id: part.toolCallId, content: outputText(part.output) })
      }
      continue
    }

    const text = parts
      .filter((part) => part.type === "text" || part.type === "reasoning")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim()

    if (message.role === "assistant") {
      const calls = parts
        .filter((part) => part.type === "tool-call" && part.toolCallId && part.toolName)
        .map((part) => ({
          id: part.toolCallId as string,
          type: "function" as const,
          function: { name: part.toolName as string, arguments: JSON.stringify(part.input ?? {}) },
        }))
      if (calls.length === 0 && text.length === 0) continue
      out.push({ role: "assistant", content: text.length > 0 ? text : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) })
      continue
    }

    if (text.length === 0) continue
    out.push({ role: message.role === "system" ? "system" : "user", content: text })
  }
  return out
}

/**
 * A chat array a strict server will accept: every `tool_calls` entry has its
 * result, every tool message has its call, and no assistant message is empty.
 * An aborted turn in the record leaves exactly those dangling pairs.
 */
function sanitize(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) answered.add(message.tool_call_id)
  }
  const kept: ChatMessage[] = []
  const emitted = new Set<string>()
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls) {
      const calls = message.tool_calls.filter((call) => answered.has(call.id))
      for (const call of calls) emitted.add(call.id)
      if (calls.length === 0) {
        if (message.content) kept.push({ role: "assistant", content: message.content })
        continue
      }
      kept.push({ ...message, tool_calls: calls })
      continue
    }
    if (message.role === "tool" && message.tool_call_id && !emitted.has(message.tool_call_id)) continue
    kept.push(message)
  }
  return kept
}

// ----------------------------------------------------------------- the model

type Action =
  | { kind: "calls"; calls: { name: string; args: Record<string, unknown> }[] }
  | { kind: "text"; text: string }

type Reply = {
  readonly action: Action
  readonly promptTokens: number
  readonly completionTokens: number
  readonly ms: number
}

const hosts = new Set<string>()

async function ask(input: {
  baseUrl: string
  model: string
  messages: ChatMessage[]
  tools: Declaration[]
  maxTokens: number
}): Promise<Reply> {
  const url = `${input.baseUrl.replace(/\/$/, "")}/chat/completions`
  hosts.add(new URL(url).host)
  const started = Date.now()
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      tools: input.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: "auto",
      temperature: 0,
      max_tokens: input.maxTokens,
      stream: false,
    }),
  })
  const ms = Date.now() - started
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 400)}`)
  const body = (await response.json()) as {
    choices: { message: { content?: string | null; tool_calls?: { function: { name: string; arguments: string } }[] } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const message = body.choices[0]?.message ?? {}
  const usage = body.usage ?? {}
  const calls = (message.tool_calls ?? []).map((call) => {
    let args: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || "{}")
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>
    } catch {
      args = { _raw: call.function.arguments }
    }
    return { name: call.function.name, args }
  })
  const action: Action =
    calls.length > 0 ? { kind: "calls", calls } : { kind: "text", text: (message.content ?? "").trim() }
  return { action, promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, ms }
}

// -------------------------------------------------------------- turn picking

type Candidate = {
  readonly sessionID: string
  /** 1-based index of the user turn inside its session. */
  readonly turn: number
  /** History as it stood at the turn's FIRST step. */
  readonly history: Message[]
  /** The aging map at that step, at the engine's own K. Widen it for a sweep. */
  readonly rewrites: ReadonlyMap<string, SessionToolAging.Rewrite>
  /** What the recorded assistant really did next — the ground truth. */
  readonly recorded: Action
  readonly codeSession: boolean
  readonly toolNames: string[]
}

function firstStepParts(message: Message): SessionV1.Part[] {
  const finish = message.parts.findIndex((part) => part.type === "step-finish")
  return finish === -1 ? message.parts : message.parts.slice(0, finish)
}

function recordedAction(message: Message): Action {
  const parts = firstStepParts(message)
  const calls = parts
    .filter((part): part is SessionV1.ToolPart => part.type === "tool")
    .map((part) => ({
      name: part.tool,
      args: (part.state.status === "completed" ? (part.state.input as Record<string, unknown>) : {}) ?? {},
    }))
  if (calls.length > 0) return { kind: "calls", calls }
  const text = parts
    .filter((part): part is Extract<SessionV1.Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  return { kind: "text", text }
}

function attachmentBytes(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file") total += (part as { url?: string }).url?.length ?? 0
      if (part.type !== "tool") continue
      const state = part.state
      if (state.status !== "completed") continue
      for (const item of state.attachments ?? []) total += (item as { url?: string }).url?.length ?? 0
    }
  }
  return total
}

/**
 * Every boundary of the session up to (and including) `stopAt`, fed to `plan`
 * in order, so the map at the target step is the one the real engine would
 * hold there — the module is monotonic, so replaying from the middle would
 * take decisions the engine had already taken differently.
 */
function planAt(sessionID: string, messages: readonly Message[], stopAt: number, context: number) {
  SessionToolAging.reset()
  const closed: Message[] = []
  let step = 0
  let previous: { input: number; cacheRead: number } | undefined
  let latest = SessionToolAging.plan({ sessionID, messages: [], boundary: true })

  for (let index = 0; index <= stopAt && index < messages.length; index++) {
    const message = messages[index]
    if (message.info.role === "user") {
      step = 0
      previous = undefined
    }
    if (message.info.role === "assistant") {
      for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
        const part = message.parts[partIndex]
        if (part.type === "step-start") {
          step++
          const boundary = step === 1 || (previous ? previous.input + previous.cacheRead > context / 2 : false)
          const history = [...closed, { info: message.info, parts: message.parts.slice(0, partIndex) }]
          latest = SessionToolAging.plan({
            sessionID,
            messages: history as SessionV1.WithParts[],
            boundary,
          })
          // The TARGET call is the first step of the message at `stopAt`.
          if (index === stopAt && step === 1) return { plan: latest, history }
        }
        if (part.type === "step-finish") {
          previous = { input: part.tokens.input, cacheRead: part.tokens.cache.read }
        }
      }
    }
    closed.push(message)
  }
  return { plan: latest, history: [...closed] }
}

/** Completed tool parts of a history, oldest first — `plan`'s own ordering. */
function completedTools(messages: readonly Message[]): SessionV1.ToolPart[] {
  const out: SessionV1.ToolPart[] = []
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type === "tool" && part.state.status === "completed") out.push(part)
    }
  }
  return out
}

/**
 * `plan`'s map with the tail widened to `k`. Superseded stubs stay: `plan`
 * ages those whatever the tail says, because the stored text is stale.
 */
function widen(rewrites: ReadonlyMap<string, SessionToolAging.Rewrite>, history: readonly Message[], k: number) {
  if (k <= SessionToolAging.K) return rewrites
  const tail = new Set<string>(completedTools(history).slice(-k).map((part) => part.id))
  const out = new Map<string, SessionToolAging.Rewrite>()
  for (const [id, rewrite] of rewrites) {
    const superseded = rewrite.output?.includes("· superseded:") ?? false
    if (tail.has(id) && !superseded) continue
    out.set(id, rewrite)
  }
  return out
}

/** Files whose `read` result the ON history replaced with a stub. */
function stubbedReads(rewrites: ReadonlyMap<string, SessionToolAging.Rewrite>, history: readonly Message[]) {
  const out = new Map<string, { superseded: boolean }>()
  for (const part of completedTools(history)) {
    if (part.tool !== "read") continue
    const rewrite = rewrites.get(part.id)
    if (!rewrite?.output) continue
    const input = part.state.status === "completed" ? (part.state.input as { filePath?: unknown }) : {}
    if (typeof input.filePath !== "string") continue
    const key = normalizePath(input.filePath)
    const superseded = rewrite.output.includes("· superseded:")
    const held = out.get(key)
    // A file read twice and stubbed twice counts as superseded only if every
    // stub said so — one plain "aged out" is still a plain aged-out re-read.
    out.set(key, { superseded: held ? held.superseded && superseded : superseded })
  }
  return out
}

// -------------------------------------------------------------- comparison

const PATH_TOOLS = new Set(["read", "edit", "write", "apply_patch"])

function callKey(call: { name: string; args: Record<string, unknown> }): string {
  const args = call.args
  if (PATH_TOOLS.has(call.name)) {
    const file = args.filePath ?? args.path
    return `${call.name}:${typeof file === "string" ? normalizePath(file) : ""}`
  }
  if (call.name === "grep" || call.name === "glob") {
    return `${call.name}:${String(args.pattern ?? "")}`
  }
  if (call.name === "bash" || call.name === "shell") {
    const command = typeof args.command === "string" ? args.command : ""
    return `${call.name}:${command.replaceAll(/\s+/g, " ").trim().slice(0, COMMAND_MATCH_CHARS)}`
  }
  return call.name
}

function firstCall(action: Action) {
  return action.kind === "calls" ? action.calls[0] : undefined
}

function describe(action: Action): string {
  if (action.kind === "text") {
    const text = action.text.replaceAll(/\s+/g, " ").slice(0, 60)
    return `text: ${text || "(empty)"}`
  }
  return action.calls
    .map((call) => {
      const args = call.args
      const detail =
        (typeof args.filePath === "string" && path.basename(args.filePath)) ||
        (typeof args.path === "string" && path.basename(args.path)) ||
        (typeof args.pattern === "string" && args.pattern) ||
        (typeof args.command === "string" && args.command.replaceAll(/\s+/g, " ").slice(0, 40)) ||
        ""
      return detail ? `${call.name}(${detail})` : call.name
    })
    .slice(0, 3)
    .join(" + ")
}

/** The path a call would look at, for the re-read test. */
function targetPath(call: { name: string; args: Record<string, unknown> } | undefined): string | undefined {
  if (!call) return undefined
  const args = call.args
  if (call.name === "read") {
    return typeof args.filePath === "string" ? normalizePath(args.filePath) : undefined
  }
  if (call.name === "grep" || call.name === "glob") {
    const raw = args.path ?? args.pattern
    return typeof raw === "string" ? normalizePath(raw) : undefined
  }
  return undefined
}

// ------------------------------------------------------------------- report

type Result = {
  readonly sessionID: string
  readonly turn: number
  readonly off: Reply
  readonly on: Reply
  readonly verdict: "same" | "different" | "text"
  readonly reread: "none" | "aged" | "superseded"
  readonly rereadPath?: string
  readonly matchedRecordedOff: boolean
  readonly matchedRecordedOn: boolean
  readonly recorded: Action
  readonly stubbed: number
}

function escape(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ")
}

function markdown(input: {
  db: string
  baseUrl: string
  modelName: string
  k: number
  context: number
  requested: number
  maxTokens: number
  candidates: number
  codeCandidates: number
  sessionsScanned: number
  sessionsSkipped: number
  results: Result[]
  reruns: string[]
  failures: string[]
  elapsedMs: number
}): string {
  const results = input.results
  const same = results.filter((row) => row.verdict === "same").length
  const different = results.filter((row) => row.verdict === "different").length
  const text = results.filter((row) => row.verdict === "text").length
  const aged = results.filter((row) => row.reread === "aged")
  const superseded = results.filter((row) => row.reread === "superseded").length
  const hitOff = results.filter((row) => row.matchedRecordedOff).length
  const hitOn = results.filter((row) => row.matchedRecordedOn).length
  const meanOff = results.length ? results.reduce((sum, row) => sum + row.off.promptTokens, 0) / results.length : 0
  const meanOn = results.length ? results.reduce((sum, row) => sum + row.on.promptTokens, 0) / results.length : 0
  const totalTokens = results.reduce(
    (sum, row) => sum + row.off.promptTokens + row.on.promptTokens + row.off.completionTokens + row.on.completionTokens,
    0,
  )

  const lines: string[] = []
  lines.push("# tool-result aging — LIVE gate (token-burn plan item 2.1)")
  lines.push("")
  lines.push(`- database (copy, readonly): \`${input.db}\``)
  lines.push(`- endpoint: \`${input.baseUrl}\` · model \`${input.modelName}\``)
  lines.push(`- K=${input.k} (engine K=${SessionToolAging.K}) · boundary context window ${input.context} · temperature 0 · max_tokens ${input.maxTokens}`)
  lines.push(`- turns requested ${input.requested}, replayed ${results.length} · 2 requests each = ${results.length * 2}`)
  lines.push(`- hosts contacted THIS invocation: ${[...hosts].join(", ") || "(none — every turn came from the cache)"}`)
  lines.push(`- elapsed ${(input.elapsedMs / 1000).toFixed(1)} s · tokens billed to the local box ${totalTokens.toLocaleString("en-US")}`)
  lines.push("")
  lines.push("## selection")
  lines.push("")
  lines.push(`- sessions scanned ${input.sessionsScanned}, skipped for attachments > ${MAX_ATTACHMENT_BYTES / 1024} KB: ${input.sessionsSkipped}`)
  lines.push(`- candidate turns found ${input.candidates} (of which code turns — history holds a read/edit/grep result — ${input.codeCandidates})`)
  lines.push("- a candidate is a user turn whose recorded reply opened with >= 1 tool call AND where the aging plan stubs >= 1 result at that turn's first step")
  lines.push("- at most ONE turn is taken per session, so 30 rows are 30 conversations rather than 30 steps of one")
  if (input.failures.length > 0) {
    lines.push("")
    lines.push(`- ${input.failures.length} turn(s) failed at the endpoint and are not in the table:`)
    for (const failure of input.failures) lines.push(`  - \`${escape(failure)}\``)
  }
  lines.push("")
  lines.push("## per turn")
  lines.push("")
  lines.push("| session | turn | stubs | prompt tok OFF | prompt tok ON | first action OFF | first action ON | verdict | re-read? |")
  lines.push("|---|---|---|---|---|---|---|---|---|")
  for (const row of results) {
    lines.push(
      `| ${row.sessionID.slice(0, 20)} | ${row.turn} | ${row.stubbed} | ${row.off.promptTokens.toLocaleString("en-US")} | ${row.on.promptTokens.toLocaleString("en-US")} | ${escape(describe(row.off.action))} | ${escape(describe(row.on.action))} | ${row.verdict} | ${row.reread === "none" ? "-" : `${row.reread}: ${escape(path.basename(row.rereadPath ?? ""))}`} |`,
    )
  }
  lines.push("")
  lines.push("## totals")
  lines.push("")
  lines.push("| metric | value |")
  lines.push("|---|---|")
  lines.push(`| turns | ${results.length} |`)
  lines.push(`| same first call | ${same} |`)
  lines.push(`| different first call | ${different} |`)
  lines.push(`| text on one or both sides | ${text} |`)
  lines.push(`| **re-reads of a stubbed, NOT superseded file** | **${aged.length}** |`)
  lines.push(`| re-reads of a superseded file (aging working as designed) | ${superseded} |`)
  lines.push(`| matches the recorded next call — OFF | ${hitOff}/${results.length} (${results.length ? ((hitOff / results.length) * 100).toFixed(0) : 0}%) |`)
  lines.push(`| matches the recorded next call — ON | ${hitOn}/${results.length} (${results.length ? ((hitOn / results.length) * 100).toFixed(0) : 0}%) |`)
  lines.push(`| mean prompt tokens OFF | ${Math.round(meanOff).toLocaleString("en-US")} |`)
  lines.push(`| mean prompt tokens ON | ${Math.round(meanOn).toLocaleString("en-US")} |`)
  lines.push(`| prompt-token delta | ${meanOff ? (((meanOn - meanOff) / meanOff) * 100).toFixed(1) : "0.0"}% |`)
  lines.push("")
  lines.push("## K recommendation")
  lines.push("")
  if (aged.length > 1) {
    lines.push(`**K should rise.** ${aged.length} of ${results.length} turns re-read a file the aged run had stubbed and the full run did not touch — over the plan's threshold of 1.`)
    lines.push("")
    lines.push("Offending turns, re-run at a wider tail:")
    lines.push("")
    for (const line of input.reruns) lines.push(line)
  } else {
    lines.push(`**K=${SessionToolAging.K} holds.** ${aged.length} of ${results.length} turns re-read a stubbed non-superseded file (threshold: more than 1 of 30).`)
    if (superseded > 0) {
      lines.push("")
      lines.push(`${superseded} turn(s) re-read a file the stub marked superseded. That is the feature working: the stored text was stale, and the model went and got the current one.`)
    }
  }
  return lines.join("\n")
}

// --------------------------------------------------------------------- main

const main = Effect.gen(function* () {
  const started = Date.now()
  const argv = process.argv.slice(2)
  const flags = new Map<string, string>()
  const positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const equals = arg.indexOf("=")
    if (equals !== -1) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1))
      continue
    }
    flags.set(arg.slice(2), argv[index + 1] ?? "")
    index++
  }
  const flag = (name: string): string | undefined => flags.get(name)
  const target = positional[0]
  if (!target) {
    console.error("usage: bun script/tool-aging-live.ts <copy-of-origami.db> [--turns 30] [--k 6] [--base-url URL] [--model NAME] [--out FILE]")
    process.exit(2)
  }
  const resolved = path.resolve(target)
  if (isLivePath(resolved)) {
    console.error(`refusing to open the live instance database: ${resolved}`)
    process.exit(2)
  }

  const requested = Number(flag("turns") ?? DEFAULT_TURNS)
  const maxTokens = Number(flag("max-tokens") ?? DEFAULT_MAX_TOKENS)
  // `--only ses_abc#2,ses_def#5` re-measures named turns and nothing else.
  // Selection still runs whole, so a named turn keeps the identical history.
  const only = new Set((flag("only") ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0))
  const k = Number(flag("k") ?? SessionToolAging.K)
  const context = Number(flag("context") ?? DEFAULT_CONTEXT)
  const baseUrl = flag("base-url") ?? DEFAULT_BASE_URL
  const modelName = flag("model") ?? DEFAULT_MODEL
  const out = flag("out")

  const systemPrompt = (() => {
    const file = path.join(os.homedir(), ".config", "origami", "base-prompt.md")
    try {
      const text = fs.readFileSync(file, "utf8").trim()
      if (text.length > 0) return text
    } catch {
      /* fall through */
    }
    return FALLBACK_SYSTEM
  })()

  const db = new Sqlite(resolved, { readonly: true })
  db.run("PRAGMA query_only = ON")

  const sessions = db
    .query<{ session_id: string; tools: number }, []>(
      `select p.session_id as session_id,
              sum(case when json_extract(p.data,'$.type') = 'tool' then 1 else 0 end) as tools,
              max(s.time_created) as created
         from part p join session s on s.id = p.session_id
        where p.session_id not in (
                select session_id from part where json_extract(data,'$.type') = 'compaction'
              )
        group by p.session_id
       having tools >= 8
        order by created desc
        limit 200`,
    )
    .all()

  const codeCandidates: Candidate[] = []
  const otherCandidates: Candidate[] = []
  let sessionsScanned = 0
  let sessionsSkipped = 0

  for (const session of sessions) {
    if (codeCandidates.length >= requested) break
    const messages = loadSession(db, session.session_id)
    sessionsScanned++
    if (attachmentBytes(messages) > MAX_ATTACHMENT_BYTES) {
      sessionsSkipped++
      continue
    }
    let turn = 0
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (message.info.role === "user") turn++
      if (message.info.role !== "assistant") continue
      if (index === 0 || messages[index - 1].info.role !== "user") continue

      const recorded = recordedAction(message)
      if (recorded.kind !== "calls") continue

      const { plan, history } = planAt(session.session_id, messages, index, context)
      // Snapshot: `plan` hands back the store's own live map.
      const snapshot = new Map(plan.rewrites)
      const stubbed = [...widen(snapshot, history, k).values()].filter(
        (rewrite) => rewrite.output !== undefined,
      ).length
      if (stubbed === 0) continue

      const tools = completedTools(history)
      const names = new Set(tools.map((part) => part.tool))
      for (const call of recorded.calls) names.add(call.name)
      const codeSession = tools.some((part) => ["read", "edit", "grep"].includes(part.tool))
      const candidate: Candidate = {
        sessionID: session.session_id,
        turn,
        history,
        rewrites: snapshot,
        recorded,
        codeSession,
        toolNames: [...names],
      }
      if (codeSession) codeCandidates.push(candidate)
      else otherCandidates.push(candidate)
      // One turn per session keeps the sample from being 30 turns of one
      // conversation, where every row shares the same files and the same bug.
      break
    }
  }

  const candidates = [...codeCandidates, ...otherCandidates]
  const selected = (only.size > 0
    ? candidates.filter((item) => only.has(`${item.sessionID}#${item.turn}`))
    : candidates
  ).slice(0, requested)
  console.error(
    `candidates: ${candidates.length} (code ${codeCandidates.length}, other ${otherCandidates.length}) from ${sessionsScanned} sessions; running ${selected.length}`,
  )
  if (only.size === 0 && candidates.length < 10) {
    console.error("FEWER THAN 10 CANDIDATE TURNS — stopping, per the gate's failure protocol.")
    db.close()
    process.exit(3)
  }

  // A 30-turn run is over an hour of local prefill. Every finished turn is
  // appended to a JSONL cache as it lands, and a re-run replays the cache
  // instead of the model — so a killed run costs the turns it had not reached,
  // not all of them.
  const cachePath = flag("cache") ?? (out ? `${path.resolve(out)}.cache.jsonl` : undefined)
  const cached = new Map<string, Result>()
  if (cachePath && fs.existsSync(cachePath)) {
    for (const line of fs.readFileSync(cachePath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue
      const entry = JSON.parse(line) as Result & { key?: string }
      cached.set(entry.key ?? `${entry.sessionID}#${entry.turn}`, entry)
    }
    console.error(`cache: ${cached.size} turn(s) replayed from ${cachePath}`)
  }
  const remember = (key: string, value: unknown) => {
    if (!cachePath) return
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.appendFileSync(cachePath, `${JSON.stringify({ key, ...(value as object) })}\n`, "utf8")
  }

  const results: Result[] = []
  const failures: string[] = []
  for (const [index, candidate] of selected.entries()) {
    const key = `${candidate.sessionID}#${candidate.turn}`
    const hit = cached.get(key)
    if (hit) {
      results.push(hit)
      console.error(`[${index + 1}/${selected.length}] ${key.slice(0, 26)} · cached · ${hit.verdict}`)
      continue
    }

    const rewrites = widen(candidate.rewrites, candidate.history, k)
    const stubbedCount = [...rewrites.values()].filter((rewrite) => rewrite.output !== undefined).length
    const stubbedFiles = stubbedReads(rewrites, candidate.history)

    const offModel = yield* MessageV2.toModelMessagesEffect(candidate.history as SessionV1.WithParts[], model)
    const onModel = yield* MessageV2.toModelMessagesEffect(candidate.history as SessionV1.WithParts[], model, {
      toolRewrites: rewrites,
    })
    const tools = declare(candidate.toolNames)
    const system: ChatMessage = { role: "system", content: systemPrompt }
    const offMessages = [system, ...sanitize(toChat(offModel))]
    const onMessages = [system, ...sanitize(toChat(onModel))]

    if (flags.has("dry-run")) {
      console.error(
        `[dry] ${candidate.sessionID.slice(0, 20)} turn ${candidate.turn} · ${offMessages.length}/${onMessages.length} msgs · ` +
          `${JSON.stringify(offMessages).length}/${JSON.stringify(onMessages).length} chars · ${tools.length} tools · ${stubbedCount} stubs · ` +
          `recorded ${describe(candidate.recorded)}`,
      )
      continue
    }
    // One bad turn must not throw away the 29 good ones: a 30-turn run is
    // twenty-odd minutes of local prefill, and a single 400 from a malformed
    // recorded history is not a reason to lose it.
    const pair = yield* Effect.tryPromise(async () => {
      const first = await ask({ baseUrl, model: modelName, messages: offMessages, tools, maxTokens })
      const second = await ask({ baseUrl, model: modelName, messages: onMessages, tools, maxTokens })
      return { off: first, on: second }
    }).pipe(Effect.catch((error: unknown) => Effect.succeed({ failed: String(error) } as const)))
    if ("failed" in pair) {
      failures.push(`${candidate.sessionID.slice(0, 20)} turn ${candidate.turn}: ${pair.failed.slice(0, 300)}`)
      console.error(`[${index + 1}/${selected.length}] FAILED ${pair.failed.slice(0, 200)}`)
      continue
    }
    const { off, on } = pair

    const offCall = firstCall(off.action)
    const onCall = firstCall(on.action)
    const verdict: Result["verdict"] =
      !offCall || !onCall ? "text" : callKey(offCall) === callKey(onCall) ? "same" : "different"

    let reread: Result["reread"] = "none"
    let rereadPath: string | undefined
    const onTarget = targetPath(onCall)
    if (onTarget && onCall && stubbedFiles.has(onTarget)) {
      const sameAsOff = offCall ? callKey(offCall) === callKey(onCall) : false
      if (!sameAsOff) {
        reread = stubbedFiles.get(onTarget)!.superseded ? "superseded" : "aged"
        rereadPath = onTarget
      }
    }

    const recordedFirst = firstCall(candidate.recorded)
    const recordedKey = recordedFirst ? callKey(recordedFirst) : undefined
    const result: Result = {
      sessionID: candidate.sessionID,
      turn: candidate.turn,
      off,
      on,
      verdict,
      reread,
      rereadPath,
      matchedRecordedOff: !!offCall && !!recordedKey && callKey(offCall) === recordedKey,
      matchedRecordedOn: !!onCall && !!recordedKey && callKey(onCall) === recordedKey,
      recorded: candidate.recorded,
      stubbed: stubbedCount,
    }
    results.push(result)
    remember(key, result)
    console.error(
      `[${index + 1}/${selected.length}] ${candidate.sessionID.slice(0, 20)} turn ${candidate.turn} · ${verdict}${reread === "none" ? "" : ` · re-read ${reread}`} · ${off.promptTokens}->${on.promptTokens} tok · ${off.ms + on.ms} ms`,
    )
  }

  // The K sweep only runs when the gate tripped, and only on the turns that
  // tripped it: it is the evidence for "raise K by this much", nothing else.
  const offenders = results.filter((row) => row.reread === "aged")
  const reruns: string[] = []
  if (offenders.length > 1) {
    reruns.push("| session | turn | K | first action ON | still re-reads? |")
    reruns.push("|---|---|---|---|---|")
    for (const offender of offenders) {
      const candidate = selected.find((item) => item.sessionID === offender.sessionID && item.turn === offender.turn)!
      for (const wider of RERUN_K) {
        const sweepKey = `${offender.sessionID}#${offender.turn}#k${wider}`
        const sweepHit = cached.get(sweepKey) as unknown as { row?: string } | undefined
        if (sweepHit?.row) {
          reruns.push(sweepHit.row)
          continue
        }
        const rewrites = widen(candidate.rewrites, candidate.history, wider)
        const stubbedFiles = stubbedReads(rewrites, candidate.history)
        const onModel = yield* MessageV2.toModelMessagesEffect(candidate.history as SessionV1.WithParts[], model, {
          toolRewrites: rewrites,
        })
        const messages = [{ role: "system" as const, content: systemPrompt }, ...sanitize(toChat(onModel))]
        const reply = yield* Effect.tryPromise(() =>
          ask({ baseUrl, model: modelName, messages, tools: declare(candidate.toolNames), maxTokens }),
        ).pipe(
          // Same reason as the main loop: the sweep is evidence, not the run.
          Effect.catch((error: unknown) =>
            Effect.succeed({ action: { kind: "text", text: `FAILED ${error}` }, promptTokens: 0, completionTokens: 0, ms: 0 } as Reply),
          ),
        )
        const call = firstCall(reply.action)
        const target = targetPath(call)
        const still = !!target && stubbedFiles.has(target) && target === offender.rereadPath
        const row = `| ${offender.sessionID.slice(0, 20)} | ${offender.turn} | ${wider} | ${escape(describe(reply.action))} | ${still ? "yes" : "no"} |`
        reruns.push(row)
        remember(sweepKey, { row })
        console.error(`  sweep ${offender.sessionID.slice(0, 20)} turn ${offender.turn} K=${wider} · still=${still}`)
      }
    }
  }

  db.close()

  const report = markdown({
    db: resolved,
    baseUrl,
    modelName,
    k,
    context,
    requested,
    maxTokens,
    candidates: candidates.length,
    codeCandidates: codeCandidates.length,
    sessionsScanned,
    sessionsSkipped,
    results,
    reruns,
    failures,
    elapsedMs: Date.now() - started,
  })
  console.log(report)
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
    fs.writeFileSync(path.resolve(out), `${report}\n`, "utf8")
    console.error(`wrote ${path.resolve(out)}`)
  }
})

await Effect.runPromise(main)

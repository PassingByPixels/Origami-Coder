import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect, Option, Queue } from "effect"
import { ClaudeCli, ProcessExecutor } from "@origami/llm/route"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { which } from "@origami/core/util/which"
import { Global } from "@origami/core/global"
import type { Info, Model } from "./provider"

/**
 * Claude through the owner's Claude subscription (experimental, OFF by default).
 *
 * The engine drives the turn; the installed `claude` CLI is only the model
 * client (`@origami/llm` `claude-cli` transport). This module owns the parts
 * that need the engine: finding the CLI, Gate B readiness, and the catalog.
 *
 * Readiness uses exactly two probes: `claude --version` and `claude auth
 * status` (its JSON `loggedIn` / `subscriptionType`). Nothing here opens a
 * credential file, runs a login, or reads a header.
 */

export const PROVIDER_ID = "claude-subscription"
/** The package id the provider registry keys this family on. Not an npm package: nothing is downloaded. */
export const NPM = "origami-claude-subscription"
/**
 * The lowest CLI version this route accepts.
 *
 * 2.1.263 is the version the Hermes plugin qualified live (README.md:48): the
 * `shouldQuery:false` replay acks, `CLAUDE_CODE_EXTRA_BODY` merge and the
 * token-reminder switch are undocumented CLI internals, and a fake CLI can only
 * prove Origami's side of that contract. The CLI on the owner's PC was 2.1.198
 * on 2026-09-23, whose `--help` lists neither `--system-prompt-file` nor
 * `--max-turns`. Lower this only after an owner-run live check (L5) passes on
 * the lower version.
 */
export const VERSION_FLOOR = "2.1.263"
/** Per-window cap on CLI processes, so a sub-agent fan-out cannot start N at once. */
export const DEFAULT_CONCURRENCY = 2

export type Readiness =
  | {
      readonly type: "ready"
      readonly command: ReadonlyArray<string>
      readonly version: string
      readonly plan?: string
    }
  | {
      readonly type: "unready"
      readonly reason: string
      readonly command?: ReadonlyArray<string>
      /** Which of the picker's four states this unready answer maps to. Absent
       *  for a reason none of the four names (e.g. env conflicts) — the wire
       *  status (below) falls back to a generic unready state carrying `reason`
       *  verbatim rather than guessing from the text. */
      readonly kind?: "cli-missing" | "not-logged-in" | "version-too-old"
      readonly found?: string
      readonly floor?: string
    }

/**
 * The JSON-safe shape the picker's readiness.ts union reads directly (t-tjt9wd):
 * one host call (the `claude_subscription_status` ext method) returns this
 * instead of the extension re-deriving readiness from its own CLI discovery.
 */
export type WireStatus =
  | { readonly state: "ready"; readonly version: string; readonly path: string }
  | { readonly state: "cli-missing" }
  | { readonly state: "not-logged-in" }
  | { readonly state: "version-too-old"; readonly found: string; readonly floor: string; readonly path: string }
  | { readonly state: "unready"; readonly reason: string }

/** Maps a Gate B answer onto the wire shape above. Pure and synchronous: reads
 *  the `kind` set at each `probe()` return site rather than re-parsing `reason`. */
export const readinessWireState = (r: Readiness): WireStatus => {
  const path = r.command?.[0] ?? ""
  if (r.type === "ready") return { state: "ready", version: r.version, path }
  if (r.kind === "cli-missing") return { state: "cli-missing" }
  if (r.kind === "not-logged-in") return { state: "not-logged-in" }
  if (r.kind === "version-too-old") return { state: "version-too-old", found: r.found ?? "", floor: r.floor ?? "", path }
  return { state: "unready", reason: r.reason }
}

const INSTALL_HINT =
  "Claude (subscription) needs the Claude Code CLI on PATH. Install it from https://claude.com/claude-code, then reload the window."

export const parseVersion = (text: string) => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export const atLeast = (version: ReadonlyArray<number>, floor: ReadonlyArray<number>) => {
  for (let i = 0; i < 3; i++) {
    if ((version[i] ?? 0) > (floor[i] ?? 0)) return true
    if ((version[i] ?? 0) < (floor[i] ?? 0)) return false
  }
  return true
}

/**
 * The binary the VS Code extension chose (t-vd9s7z), in `~/.origami/claude-cli.json`. Its discovery
 * picks the user setting, else the NEWEST claude that runs, and its passthrough spawns the same file.
 * Written whenever that discovery runs, so it is read at use time, never at engine start. The name
 * MUST match the extension's `CLAUDE_CLI_FILE` (claudeCode/handoff.ts).
 */
export const CLI_FILE = "claude-cli.json"
export const handoffFile = () => path.join(Global.Path.origami, CLI_FILE)

/** The binary the hand-off names, or undefined when the file is missing, unreadable, empty, or names a file that is gone. */
export const handedOver = (file: string = handoffFile()): string | undefined => {
  try {
    const doc: unknown = JSON.parse(readFileSync(file, "utf8"))
    const chosen = doc && typeof doc === "object" ? (doc as Record<string, unknown>).path : undefined
    return typeof chosen === "string" && chosen && existsSync(chosen) ? chosen : undefined
  } catch {
    return undefined
  }
}

/** How to update the binary at `file`. The VS Code extension bundles its own copy, which `claude update` does not change. */
export const updateHint = (file: string) =>
  /anthropic\.claude-code-/i.test(file)
    ? "Update the Claude Code extension in VS Code, then reload the window."
    : "Run `claude update` in a terminal, then reload the window."

/** The CLI the extension chose, else the one on PATH. A Windows `.cmd`/`.bat` shim is refused: argv through cmd.exe breaks and the tree kill loses its root. */
export const resolveCommand = (
  env: NodeJS.ProcessEnv = process.env,
  file: string = handoffFile(),
): Readiness | ReadonlyArray<string> => {
  const found = handedOver(file) ?? which("claude", env)
  if (!found) return { type: "unready", reason: INSTALL_HINT, kind: "cli-missing" }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(found))
    return {
      type: "unready",
      reason: `Claude (subscription) needs the native Claude Code binary, not the npm shim at ${found}. Run \`claude install\` to get claude.exe, then reload the window.`,
      kind: "cli-missing",
    }
  return [found]
}

const run = (command: ReadonlyArray<string>, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv, timeout: number) =>
  new Promise<string>((resolve) => {
    const [file, ...fixed] = command
    try {
      execFile(
        file!,
        [...fixed, ...args],
        { env: ClaudeCli.childEnv(env, undefined), timeout, windowsHide: true, encoding: "utf8" },
        (_error, stdout) => resolve(typeof stdout === "string" ? stdout : ""),
      )
    } catch {
      // A file that cannot start at all (EFTYPE) throws here instead of calling back: no output.
      resolve("")
    }
  })

/** Gate B, from the CLI's own answers. `command` overrides PATH lookup (tests pass a fake CLI). */
export async function probe(
  input: { readonly command?: ReadonlyArray<string>; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<Readiness> {
  const env = input.env ?? process.env
  const conflicts = ClaudeCli.envConflicts(env)
  if (conflicts.length > 0) return { type: "unready", reason: ClaudeCli.conflictMessage(conflicts) }
  const resolved = input.command ?? resolveCommand(env)
  if (!Array.isArray(resolved)) return resolved as Readiness
  const command = resolved as ReadonlyArray<string>
  const versionText = (await run(command, ["--version"], env, 20_000)).trim()
  const version = parseVersion(versionText)
  if (!version)
    return {
      type: "unready",
      command,
      reason: `The claude CLI did not report a version (${versionText || "no output"}).`,
      kind: "cli-missing",
    }
  const shown = version.join(".")
  if (!atLeast(version, parseVersion(VERSION_FLOOR)!))
    return {
      type: "unready",
      command,
      reason: `Claude CLI ${shown} is below the qualified floor ${VERSION_FLOOR} for Claude (subscription). It is at ${command[0]}. ${updateHint(command[0]!)}`,
      kind: "version-too-old",
      found: shown,
      floor: VERSION_FLOOR,
    }
  const authText = (await run(command, ["auth", "status"], env, 20_000)).trim()
  const auth = (() => {
    try {
      const value: unknown = JSON.parse(authText)
      return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  })()
  if (auth.loggedIn !== true)
    return {
      type: "unready",
      command,
      reason:
        "The claude CLI is not signed in. Run `claude auth login` in a terminal (Anthropic's own sign-in), then reload the window.",
      kind: "not-logged-in",
    }
  return {
    type: "ready",
    command,
    version: shown,
    ...(typeof auth.subscriptionType === "string" ? { plan: auth.subscriptionType } : {}),
  }
}

const UNCHECKED: Readiness = {
  type: "unready",
  reason: "Claude (subscription) has not been checked yet; reload the provider list.",
}
let current: Readiness = UNCHECKED
let checking: Promise<Readiness> | undefined

/**
 * True when the hand-off file now names a binary other than the one the last answer was about
 * (t-vd9s7z: the user updated Claude Code, or the pill re-probed). One small file read.
 */
const moved = () => {
  if (current === UNCHECKED) return false
  const chosen = handedOver()
  return chosen !== undefined && current.command?.[0] !== chosen
}

/**
 * The last Gate B answer. Synchronous: `LLMNativeRuntime.status` reads it on every request. When the
 * hand-off names a new binary, a re-check starts in the background and the next request uses it.
 */
export const readiness = (): Readiness => {
  if (!checking && moved()) check().catch(() => undefined)
  return current
}

/** Test seam. `check` is the path the engine uses. */
export const setReadiness = (value: Readiness) => {
  current = value
}

/** Run Gate B now and keep the answer. Callers that arrive while a probe runs share it. */
export const check = (input: { readonly command?: ReadonlyArray<string>; readonly env?: NodeJS.ProcessEnv } = {}) =>
  (checking ??= probe(input)
    .then((value) => (current = value))
    .finally(() => {
      checking = undefined
    }))

/**
 * The answer for a reader that has no provider list (t-ty02bb): the host
 * engine serves the Connections card with no chat open and never builds one,
 * so its first read runs Gate B instead of returning "not been checked yet".
 */
export const ensureChecked = (input: { readonly env?: NodeJS.ProcessEnv } = {}) =>
  current === UNCHECKED || moved() ? check(input) : Promise.resolve(current)

/**
 * The Connections Refresh press: forget the memoised row, so the next
 * provider-list build asks the CLI again, and re-run Gate B now if anything
 * has asked before. An engine that never asked spawns nothing.
 */
export const recheck = () => {
  memo = undefined
  return current === UNCHECKED ? Promise.resolve(current) : check()
}

// ---------------------------------------------------------------------------
// Catalog

export interface CatalogRow {
  readonly id: string
  readonly name: string
  readonly context: number
  readonly note?: string
}

/** The four families the CLI's picker offers; `default` and CLI modes (`opusplan`) are not models. */
const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const

/** Shown when the handshake cannot run (logged out, below the floor). Aliases the CLI resolves itself. */
export const PINNED: ReadonlyArray<CatalogRow> = [
  { id: "sonnet", name: "Sonnet", context: 200_000 },
  { id: "opus", name: "Opus", context: 200_000 },
  { id: "haiku", name: "Haiku", context: 200_000 },
  { id: "fable", name: "Fable", context: 200_000 },
]

/**
 * The account's own picker, from the CLI's `initialize` control request: no
 * user message is written, and the process is killed as soon as the answer
 * arrives. Rows carry the CLI's alias (`sonnet`, `opus[1m]`) as the model id.
 * A `[1m]` alias gets a 1M window; everything else 200K, the safe side for
 * compaction.
 */
export const catalogFromHandshake = (models: ReadonlyArray<unknown>, plan: string | undefined): CatalogRow[] => {
  const rows = new Map<string, CatalogRow>()
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue
    const row = raw as Record<string, unknown>
    const value = typeof row.value === "string" ? row.value : ""
    const base = value.replace(/\[1m\]$/, "")
    if (!(FAMILIES as ReadonlyArray<string>).includes(base)) continue
    const description = typeof row.description === "string" ? row.description : ""
    const label = (typeof row.displayName === "string" ? row.displayName : description.split("·")[0]?.trim()) || value
    // Fable on a non-Max plan bills usage credits from the first request (Hermes directsdk_setup.py:300).
    const credits = /usage credit/i.test(description) || (base === "fable" && plan !== undefined && !/max/i.test(plan))
    rows.set(value, {
      id: value,
      name: label,
      context: value.endsWith("[1m]") ? 1_000_000 : 200_000,
      ...(credits ? { note: "usage credits" } : {}),
    })
  }
  return [...rows.values()]
}

const parseRow = (line: string): Record<string, any> => {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === "object" ? (value as Record<string, any>) : {}
  } catch {
    return {}
  }
}

const handshake = (command: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "origami-claude-picker-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)),
    )
    const mcp = path.join(dir, "mcp.json")
    yield* Effect.promise(() => writeFile(mcp, JSON.stringify({ mcpServers: {} }), "utf8"))
    const [file, ...fixed] = command
    const handle = yield* Effect.acquireRelease(
      ProcessExecutor.spawnNode({
        command: file!,
        args: [
          ...fixed,
          ...["-p", "--model", "sonnet", "--input-format", "stream-json", "--output-format", "stream-json"],
          ...["--verbose", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", mcp],
          ...["--disable-slash-commands", "--no-session-persistence"],
        ],
        cwd: dir,
        env: ClaudeCli.childEnv(env, undefined),
      }),
      (handle) => handle.kill,
    )
    yield* handle.write(
      JSON.stringify({ type: "control_request", request_id: "origami-picker", request: { subtype: "initialize" } }),
    )
    while (true) {
      const line = yield* Queue.take(handle.lines)
      const row = parseRow(line)
      if (row.type !== "control_response") continue
      yield* handle.kill
      const response = row.response?.response ?? {}
      return {
        models: Array.isArray(response.models) ? (response.models as unknown[]) : [],
        plan:
          typeof response.account?.subscriptionType === "string"
            ? (response.account.subscriptionType as string)
            : undefined,
      }
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(40_000),
    Effect.map(Option.getOrUndefined),
    // A picker that cannot be read falls back to the pinned rows; it never fails the provider list.
    Effect.catchCause(() => Effect.succeed(undefined)),
  )

const EFFORT_VARIANTS = Object.fromEntries(ClaudeCli.EFFORTS.map((effort) => [effort, { effort }]))

export const modelRow = (row: CatalogRow): Model => ({
  id: ModelV2.ID.make(row.id),
  providerID: ProviderV2.ID.make(PROVIDER_ID),
  api: { id: row.id, npm: NPM, url: "" },
  name: row.note ? `${row.name} (${row.note})` : row.name,
  family: "claude",
  capabilities: {
    // Sampling knobs are dropped on the way out: subscription models reject them.
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  // Zero on purpose: a plan connection never shows money.
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: row.context, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "",
  variants: { ...EFFORT_VARIANTS },
})

const MEMO_MS = 10 * 60_000
let memo: { at: number; info: Info } | undefined

/**
 * The provider row, built on every provider-list build while the flag is on,
 * memoised ten minutes like every other discovery loader. Unready still lists
 * the pinned rows, so the picker shows the connection and a request is refused
 * with the Gate B reason instead of the connection silently not existing.
 */
export async function providerInfo(
  input: { readonly command?: ReadonlyArray<string>; readonly env?: NodeJS.ProcessEnv } = {},
) {
  if (memo && Date.now() - memo.at < MEMO_MS && input.command === undefined && !moved()) return memo.info
  const env = input.env ?? process.env
  const ready = await check({ ...input, env })
  const live = ready.type === "ready" ? await Effect.runPromise(handshake(ready.command, env)) : undefined
  const rows =
    live && live.models.length
      ? catalogFromHandshake(live.models, live.plan ?? (ready.type === "ready" ? ready.plan : undefined))
      : []
  const info = infoOf(rows.length ? rows : PINNED)
  memo = { at: Date.now(), info }
  return info
}

const infoOf = (rows: ReadonlyArray<CatalogRow>): Info => ({
  id: ProviderV2.ID.make(PROVIDER_ID),
  name: "Claude (subscription, experimental)",
  source: "custom",
  env: [],
  options: { max_concurrent: DEFAULT_CONCURRENCY },
  models: Object.fromEntries(rows.map((row) => [row.id, modelRow(row)])),
})

/**
 * The family's rows for an engine whose flag is OFF while its config still
 * names the family: the extension persists every pick, so a chat started
 * after Disconnect still asks for `claude-subscription/<alias>` (t-ty02bb).
 * Nothing is probed. Every request is refused with this reason, instead of
 * the block's rows reaching the OpenAI-compatible default.
 */
export const offInfo = (): Info => {
  current = {
    type: "unready",
    reason:
      "Claude (subscription) is off for this chat. Add it in Connections (+ Add connection, Labs), then start a new chat, or pick another model.",
  }
  return infoOf(PINNED)
}

/** Test seam: the memo and the last answer are process-wide. */
export const resetMemo = () => {
  memo = undefined
  current = UNCHECKED
}

// ---------------------------------------------------------------------------
// The AI SDK side

const NATIVE_ONLY = "Claude (subscription) runs only on Origami's native model runtime."

/**
 * What `Provider.getLanguage` returns for this family. The session always asks
 * for a language model before it picks a runtime, so one must exist; this one
 * refuses every call, with the Gate B reason when that is why native declined.
 */
export const languageModel = (modelId: string): LanguageModelV3 => {
  const refuse = () => {
    const ready = readiness()
    return Promise.reject(
      new Error(ready.type === "unready" ? `${NATIVE_ONLY} It is not ready: ${ready.reason}` : NATIVE_ONLY),
    )
  }
  return {
    specificationVersion: "v3",
    provider: PROVIDER_ID,
    modelId,
    supportedUrls: {},
    doGenerate: refuse,
    doStream: refuse,
  }
}

export const createSDK = () => ({ languageModel })

export * as ClaudeSubscription from "./claude-subscription"

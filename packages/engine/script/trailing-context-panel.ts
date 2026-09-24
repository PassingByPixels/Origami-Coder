/**
 * LIVE gate for the trailing `<engine-context>` block (ticket t-53wb6v).
 *
 * Since 0.4.127 the engine no longer re-sends an UNCHANGED trailing block as a
 * user-role message after every tool batch; a CHANGED block is folded into the
 * last tool result instead. The offline tests prove the bytes. This script
 * answers the question that decides whether the shape ships: DOES THE MODEL
 * STILL FINISH THE JOB, AND STILL OBEY THE MEMORY RULE, WHEN THE BLOCK STOPS
 * ARRIVING AS ITS OWN TURN?
 *
 * It runs the engine headless from source N times per arm against one model,
 * scores every run FROM THE FILESYSTEM, and summarises the arms:
 *
 *   bun script/trailing-context-panel.ts run --model vllm/Qwen3.8-Flash-Next-NVFP4 \
 *     --arm on-change --nudge off --n 3 --out C:\tmp\panel\out
 *   bun script/trailing-context-panel.ts summary --in C:\tmp\panel\out
 *   bun script/trailing-context-panel.ts usage
 *
 * Arms are the sibling ticket's env switches: `ORIGAMI_TRAILING_CONTEXT` in
 * {on-change, every-step, every-step-continue} x `ORIGAMI_CONTINUE_NUDGE` in
 * {off, default}. They are PASSED THROUGH to the engine process; a build that
 * does not read them yet simply ignores them, which is why the log-action
 * counter degrades to `absent` rather than failing.
 *
 * WHAT IT APPROXIMATES, stated plainly:
 *
 * - COMPLETION IS FILESYSTEM TRUTH, NEVER THE MODEL'S WORDS. The 12 modules,
 *   the 12 tests and SUMMARY.md are counted on disk and `python -m pytest -q`
 *   is run BY THIS SCRIPT in the workspace. A run that says "all done" and
 *   wrote nothing scores zero.
 * - PYTEST'S PASS BAR IS 12, NOT 24. The scenario asks for 12 test files with
 *   ONE test each, so a green suite is 12 passed. (The ticket text says "24
 *   passed"; 24 is the FILE count — 12 modules + 12 tests — which is what
 *   SUMMARY.md must list. Requiring 24 passing tests would make `complete`
 *   unreachable for the scenario as written.) `pytest_passed` is recorded raw
 *   so the bar can be re-derived from the rows without re-running anything.
 * - RULE ADHERENCE IS MEASURED ON FILES THAT EXIST. `rule_early`/`rule_late`
 *   are ok/present, because a file the model never wrote cannot disobey a rule.
 *   `expected` is carried on every row so ok/expected can be computed instead.
 * - TOKENS ARE THE SUM OF `step-finish` PARTS, not `message.info.tokens`, for
 *   the reason `acp/run-stats.ts` states: the message-level field is ASSIGNED
 *   per step, so reading it as a turn total under-reports every tool loop.
 * - RUNS SHARE THE OWNER'S LIVE ENGINE DATABASE. That is accepted, not fixed:
 *   every session is titled `panel:<arm>:<nudge>:<model>:<run>` so the rows are
 *   recognisable. Nothing here writes auth.json or any config file.
 * - THE LOG SLICE IS BYTE-OFFSET BASED. The offset of `origami.log` is taken
 *   before turn 1 and only the tail written after it is parsed, because the
 *   live log is ~100 MB. Concurrent engine activity from another session lands
 *   in the same slice; lines are filtered by sessionID, so a foreign session's
 *   lines are ignored rather than mixed in.
 * - A KILLED TURN LEAVES ORPHANS. `--fake-stop-after-steps` (TEST-ONLY, see
 *   below) and the timeout kill the engine process; a shell tool child it had
 *   spawned (python, say) is not reaped by this script.
 *
 * `--fake-stop-after-steps <k>` IS TEST-ONLY. It kills the engine after k
 * `step_finish` events so the continue path can be exercised without waiting
 * for a model to genuinely give up. Never use it for a measured arm: the row it
 * produces has a manufactured stop.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Auth } from "@/auth"
import { ACPProviderUsage } from "@/acp/provider-usage"

// ------------------------------------------------------------------ scenario

const MODULE_COUNT = 12
/** Files the scenario asks for: 12 modules + 12 tests. SUMMARY.md must list all of them. */
const EXPECTED_FILE_COUNT = MODULE_COUNT * 2
/** A green suite for THIS scenario: one test per module. See the header. */
const REQUIRED_PASSED = MODULE_COUNT
/** Modules 1..EARLY_SPLIT and their tests are "early"; the rest are "late". */
const EARLY_SPLIT = 6
const RULE_MARKER = "panel-rule-7"
const RULE_PY = `# ${RULE_MARKER}`
const RULE_MD = `<!-- ${RULE_MARKER} -->`

const RULE_SENTENCE =
  "HOUSE RULE for every file you write in this project: the FIRST line of every .py file you create must be exactly" +
  " `# panel-rule-7` and the FIRST line of every .md file must be exactly `<!-- panel-rule-7 -->`."

const MEMORY_INDEX = `# Memory Index\n\n- [panel_rule.md](panel_rule.md) - ${RULE_SENTENCE}\n`
const MEMORY_TOPIC = `# House rule\n\n${RULE_SENTENCE}\n`

/** The one task string. THE SAME BYTES MUST REACH EVERY ARM - do not paraphrase. */
const TASK =
  "Build a small Python package in this directory. Create modules mod_01.py through mod_12.py; module N defines" +
  " def f(x): return x + N. For each module create test_mod_NN.py with one pytest test asserting f(1) == N + 1." +
  " Create every file with the write tool, one file per call (review requirement). After every 4 modules run" +
  " python -m pytest -q and fix any failure. When all 12 modules and 12 tests pass, write SUMMARY.md listing all 24" +
  " files, one line each. Do all of it."

/**
 * `--scenario modules-notodo`: the same task with the todo tool ruled out by the
 * user. A model that never writes a list keeps the engine's "no todo list yet"
 * reminder ACTIVE from the fourth tool call to the end of the turn, which is
 * the condition under which the arms differ at all: on-change delivers that
 * reminder once (folded), every-step re-sends it as a user message on every
 * later step. With a list written early (what `modules` produces on most
 * models) the reminders stay empty and both arms send identical requests.
 */
const TASK_NOTODO = TASK + " Do not use the todo tool for this task."

/** The re-prompt. One word, so the arm and not the wording is what differs. */
const CONTINUE = "continue"

/** The probe scenario (`--scenario probe`): proves the memory index reaches the model at all. */
const PROBE_TASK = "Quote the house rule from your memory index word for word, then stop."

// -------------------------------------------------------------------- config

const ARMS = ["on-change", "every-step", "every-step-continue"] as const
type Arm = (typeof ARMS)[number]
const NUDGES = ["off", "default"] as const
type Nudge = (typeof NUDGES)[number]

const DEFAULT_MAX_CONTINUES = 4
const DEFAULT_RUN_TIMEOUT_MIN = 25
const DEFAULT_PARALLEL = 1
const TEXT_TAIL_CHARS = 300
const STDERR_TAIL_CHARS = 2000

const ENGINE_DIR = path.resolve(import.meta.dir, "..")
const PANEL_ROOT =
  process.env.ORIGAMI_PANEL_ROOT ?? (process.platform === "win32" ? "C:\\tmp\\panel" : path.join(os.tmpdir(), "panel"))
const LOG_FILE = path.join(os.homedir(), ".local", "share", "origami", "log", "origami.log")

// --------------------------------------------------------------------- types

type ToolCall = { readonly id: string; readonly tool: string; readonly status: string }

type LogActions = "absent" | Record<string, number>

type Score = {
  readonly modules: number
  readonly tests: number
  readonly pytest_exit: number | null
  readonly pytest_passed: number | null
  readonly pytest_tail: string
  readonly summary_present: boolean
  readonly summary_lists_all: boolean
  readonly missing_from_summary: readonly string[]
  readonly complete: boolean
  readonly rule_early: { ok: number; present: number; expected: number }
  readonly rule_late: { ok: number; present: number; expected: number }
}

type Row = Score & {
  readonly arm: Arm
  readonly nudge: Nudge
  readonly model: string
  readonly variant: string | null
  readonly scenario: string
  readonly run: number
  readonly workspace: string
  readonly sessionID: string | null
  readonly turns: number
  readonly stops: number
  readonly abandoned: boolean
  readonly timeout: boolean
  readonly steps: number
  readonly tool_calls: number
  readonly tools_by_name: Record<string, number>
  readonly todowrite_first_call_index: number | null
  readonly nudge_events: number
  readonly tokens: Record<string, number>
  readonly wall_ms: number
  readonly final_text_tail: readonly string[]
  readonly log_actions: LogActions
  readonly exit_code: number | null
  readonly stderr_tail: string
  readonly fake_stop_after_steps: number | null
  readonly started_at: string
}

// ------------------------------------------------------------------ workspace

function slug(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function moduleName(index: number): string {
  return `mod_${pad(index)}.py`
}

function testName(index: number): string {
  return `test_mod_${pad(index)}.py`
}

function scenarioFiles(): string[] {
  const files: string[] = []
  for (let index = 1; index <= MODULE_COUNT; index++) files.push(moduleName(index))
  for (let index = 1; index <= MODULE_COUNT; index++) files.push(testName(index))
  return files
}

/**
 * Fresh every run: an inherited file would score as the model's work.
 *
 * `git init` IS LOAD-BEARING, not tidiness. `project/project.ts` resolves a
 * directory with no VCS to the `global` project, whose worktree is the string
 * "/" - and `session/instruction.ts` then looks for the project memory index at
 * `/.origami/memory/MEMORY.md` and finds nothing. A workspace that is not a
 * repository therefore gets the OWNER'S global memory and none of the panel
 * rule, which is exactly the delivery this panel exists to measure. Verified by
 * probe: without the repo the model quoted the global index and never saw
 * `panel-rule-7`.
 */
function prepareWorkspace(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true })
  const memory = path.join(dir, ".origami", "memory")
  fs.mkdirSync(memory, { recursive: true })
  fs.writeFileSync(path.join(memory, "MEMORY.md"), MEMORY_INDEX)
  fs.writeFileSync(path.join(memory, "panel_rule.md"), MEMORY_TOPIC)
  const init = Bun.spawnSync({
    cmd: ["git", "init", "-q"],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  })
  if (init.exitCode !== 0) {
    throw new Error(`git init failed in ${dir}: ${new TextDecoder().decode(init.stderr)}`)
  }
}

function firstLine(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]
  } catch {
    return undefined
  }
}

/** Line 1 of a model-written file against the memory rule. `undefined` = the file is not there. */
function obeys(file: string): boolean | undefined {
  const line = firstLine(file)
  if (line === undefined) return undefined
  const expected = file.endsWith(".md") ? RULE_MD : RULE_PY
  return line.trim() === expected
}

function tally(dir: string, files: readonly string[]) {
  let ok = 0
  let present = 0
  for (const name of files) {
    const verdict = obeys(path.join(dir, name))
    if (verdict === undefined) continue
    present++
    if (verdict) ok++
  }
  return { ok, present, expected: files.length }
}

// ---------------------------------------------------------------------- score

/** `pytest -q` tail line, e.g. "12 passed in 0.31s". Returns null when nothing parses. */
function parsePassed(output: string): number | null {
  const match = output.match(/(\d+)\s+passed/)
  return match ? Number(match[1]) : null
}

function runPytest(dir: string): { exit: number | null; passed: number | null; tail: string } {
  const result = Bun.spawnSync({
    cmd: ["python", "-m", "pytest", "-q"],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  })
  const text = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
  return { exit: result.exitCode, passed: parsePassed(text), tail: text.slice(-800) }
}

function score(dir: string): Score {
  const files = scenarioFiles()
  let modules = 0
  let tests = 0
  for (let index = 1; index <= MODULE_COUNT; index++) {
    if (fs.existsSync(path.join(dir, moduleName(index)))) modules++
    if (fs.existsSync(path.join(dir, testName(index)))) tests++
  }

  const summaryPath = path.join(dir, "SUMMARY.md")
  const summaryPresent = fs.existsSync(summaryPath)
  const summaryText = summaryPresent ? fs.readFileSync(summaryPath, "utf8") : ""
  const missing = files.filter((name) => !summaryText.includes(name))
  const summaryListsAll = summaryPresent && missing.length === 0

  // pytest only when there is something to collect; an empty dir exits 5 and
  // would read as "the suite failed" rather than "there is no suite".
  const pytest =
    modules + tests > 0 ? runPytest(dir) : { exit: null, passed: null, tail: "not run: no python files present" }

  const early = [...Array(EARLY_SPLIT)].flatMap((_, i) => [moduleName(i + 1), testName(i + 1)])
  const lateIndexes = [...Array(MODULE_COUNT - EARLY_SPLIT)].map((_, i) => i + EARLY_SPLIT + 1)
  const late = [...lateIndexes.flatMap((i) => [moduleName(i), testName(i)]), "SUMMARY.md"]

  return {
    modules,
    tests,
    pytest_exit: pytest.exit,
    pytest_passed: pytest.passed,
    pytest_tail: pytest.tail,
    summary_present: summaryPresent,
    summary_lists_all: summaryListsAll,
    missing_from_summary: missing,
    complete:
      modules === MODULE_COUNT &&
      tests === MODULE_COUNT &&
      pytest.exit === 0 &&
      (pytest.passed ?? 0) >= REQUIRED_PASSED &&
      summaryListsAll,
    rule_early: tally(dir, early),
    rule_late: tally(dir, late),
  }
}

// ------------------------------------------------------------------ engine log

/**
 * `trailing context` INFO lines the sibling ticket adds, counted by `action`.
 *
 * "absent" means THIS SESSION produced no such line: the build under test
 * predates the sibling lane, or the run never reached a step. It is NOT a
 * failure. The verdict is per-session on purpose — another worktree's engine
 * writes into the same log, and an empty count must not depend on whether a
 * foreign session happened to log during this run's slice.
 */
function logActions(fromOffset: number, sessionID: string | null): LogActions {
  if (!sessionID) return "absent"
  let text: string
  try {
    const size = fs.statSync(LOG_FILE).size
    // A rotated log resets the offset rather than reading a negative slice.
    const start = size < fromOffset ? 0 : fromOffset
    const handle = fs.openSync(LOG_FILE, "r")
    try {
      const buffer = Buffer.alloc(Math.max(0, size - start))
      fs.readSync(handle, buffer, 0, buffer.length, start)
      text = buffer.toString("utf8")
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return "absent"
  }

  // Matched on the session id rather than on the field name: the sibling ticket
  // logs `sessionID=`, every other line in this log logs `session.id=`, and only
  // the value has to be right.
  const lines = text
    .split(/\r?\n/)
    .filter((line) => /message="?trailing context"?/.test(line) && line.includes(sessionID))
  if (lines.length === 0) return "absent"
  const counts: Record<string, number> = {}
  for (const line of lines) {
    const action = line.match(/\baction=("([^"]*)"|\S+)/)
    const value = action ? (action[2] ?? action[1]) : "unknown"
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function logOffset(): number {
  try {
    return fs.statSync(LOG_FILE).size
  } catch {
    return 0
  }
}

// ------------------------------------------------------------------- one turn

type TurnResult = {
  readonly sessionID: string | null
  readonly steps: number
  readonly toolCalls: readonly ToolCall[]
  readonly tokens: Record<string, number>
  readonly nudgeEvents: number
  readonly textTail: string
  readonly exit: number | null
  readonly stderr: string
  readonly timedOut: boolean
  readonly fakeStopped: boolean
}

/** `for await` over a `ReadableStream` is not typed in this project's lib set; read it explicitly. */
async function drain(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void) {
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) onChunk(value)
  }
}

/** Flatten `{input, output, reasoning, cache:{read,write}}` onto one bag of numbers. */
function addTokens(into: Record<string, number>, tokens: unknown) {
  if (typeof tokens !== "object" || tokens === null) return
  for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      into[key] = (into[key] ?? 0) + value
      continue
    }
    if (typeof value === "object" && value !== null) {
      for (const [inner, nested] of Object.entries(value as Record<string, unknown>)) {
        if (typeof nested === "number" && Number.isFinite(nested)) {
          const name = `${key}_${inner}`
          into[name] = (into[name] ?? 0) + nested
        }
      }
    }
  }
}

async function runTurn(input: {
  readonly message: string
  readonly workspace: string
  readonly model: string
  readonly variant: string | undefined
  readonly title: string
  readonly session: string | null
  readonly turn: number
  readonly arm: Arm
  readonly nudge: Nudge
  readonly deadline: number
  readonly eventsFile: string
  readonly stderrFile: string
  readonly fakeStopAfterSteps: number | null
}): Promise<TurnResult> {
  const cmd = [
    "bun",
    "run",
    "--conditions=browser",
    "./src/index.ts",
    "run",
    "--format",
    "json",
    "--auto",
    "--dir",
    input.workspace,
    "--model",
    input.model,
    "--title",
    input.title,
  ]
  if (input.variant) cmd.push("--variant", input.variant)
  if (input.session) cmd.push("--session", input.session)
  cmd.push(input.message)

  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env.ORIGAMI_TRAILING_CONTEXT = input.arm
  // `default` is the absence of the switch, not the string "default": setting it
  // would test a value the sibling ticket does not define.
  if (input.nudge === "off") env.ORIGAMI_CONTINUE_NUDGE = "off"
  else delete env.ORIGAMI_CONTINUE_NUDGE

  const proc = Bun.spawn({ cmd, cwd: ENGINE_DIR, env, stdout: "pipe", stderr: "pipe" })

  let sessionID: string | null = null
  let steps = 0
  const toolCalls: ToolCall[] = []
  const seenTools = new Set<string>()
  const tokens: Record<string, number> = {}
  let nudgeEvents = 0
  let textTail = ""
  let timedOut = false
  let fakeStopped = false

  const events = fs.createWriteStream(input.eventsFile, { flags: "a" })
  // The engine's events are written through verbatim. This ONE line is the
  // harness's own, so a reader can tell which turn any event below belongs to.
  events.write(
    JSON.stringify({
      type: "panel_turn_start",
      turn: input.turn,
      message: input.message,
      session: input.session,
      fake_stop_after_steps: input.fakeStopAfterSteps,
      timestamp: Date.now(),
    }) + "\n",
  )

  const timer = setTimeout(
    () => {
      timedOut = true
      proc.kill()
    },
    Math.max(1000, input.deadline - Date.now()),
  )

  const stderrChunks: string[] = []
  const drainStderr = drain(proc.stderr as ReadableStream<Uint8Array>, (chunk) => {
    stderrChunks.push(new TextDecoder().decode(chunk))
  })

  const decoder = new TextDecoder()
  let buffer = ""
  const handle = (line: string) => {
    if (!line.trim()) return
    events.write(line + "\n")
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof event.sessionID === "string" && !sessionID) sessionID = event.sessionID
    // Nudge detection is on the RAW line: the marker can ride the part text, the
    // part metadata or an `<engine-note>` wrapper, and all three matter equally.
    if (line.includes("origami_continue_nudge") || line.includes("<engine-note>")) nudgeEvents++

    const part = event.part as Record<string, unknown> | undefined
    if (event.type === "tool_use" && part) {
      const id = String(part.id ?? "")
      if (!seenTools.has(id)) {
        seenTools.add(id)
        const state = part.state as Record<string, unknown> | undefined
        toolCalls.push({ id, tool: String(part.tool ?? "?"), status: String(state?.status ?? "?") })
      }
      return
    }
    if (event.type === "step_finish" && part) {
      steps++
      addTokens(tokens, part.tokens)
      if (input.fakeStopAfterSteps !== null && steps >= input.fakeStopAfterSteps && !fakeStopped) {
        fakeStopped = true
        proc.kill()
      }
      return
    }
    if (event.type === "text" && part && typeof part.text === "string") {
      const text = part.text.trim()
      if (text) textTail = text.slice(-TEXT_TAIL_CHARS)
    }
  }

  await drain(proc.stdout as ReadableStream<Uint8Array>, (chunk) => {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      handle(buffer.slice(0, newline).replace(/\r$/, ""))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
  })
  handle(buffer.replace(/\r$/, ""))

  const exit = await proc.exited
  clearTimeout(timer)
  await drainStderr
  events.end()

  const stderr = stderrChunks.join("")
  if (stderr) fs.appendFileSync(input.stderrFile, stderr)

  return { sessionID, steps, toolCalls, tokens, nudgeEvents, textTail, exit, stderr, timedOut, fakeStopped }
}

// -------------------------------------------------------------------- one run

async function runOnce(input: {
  readonly arm: Arm
  readonly nudge: Nudge
  readonly model: string
  readonly variant: string | undefined
  readonly scenario: string
  readonly run: number
  readonly out: string
  readonly maxContinues: number
  readonly timeoutMin: number
  readonly fakeStopAfterSteps: number | null
}): Promise<Row> {
  const modelSlug = slug(input.model)
  const workspace = path.join(PANEL_ROOT, `${input.arm}-${input.nudge}`, modelSlug, `run-${pad(input.run)}`)
  prepareWorkspace(workspace)

  const eventsFile = path.join(input.out, `run-${pad(input.run)}.events.jsonl`)
  const stderrFile = path.join(input.out, `run-${pad(input.run)}.stderr.log`)
  fs.rmSync(eventsFile, { force: true })
  fs.rmSync(stderrFile, { force: true })

  const offset = logOffset()
  const started = Date.now()
  const deadline = started + input.timeoutMin * 60_000
  const task = input.scenario === "probe" ? PROBE_TASK : input.scenario === "modules-notodo" ? TASK_NOTODO : TASK

  let sessionID: string | null = null
  let steps = 0
  const tools: ToolCall[] = []
  const tokens: Record<string, number> = {}
  let nudgeEvents = 0
  const tails: string[] = []
  let stops = 0
  let turns = 0
  let timeout = false
  let exit: number | null = null
  let stderr = ""
  let current = score(workspace)

  for (;;) {
    const turn = await runTurn({
      message: turns === 0 ? task : CONTINUE,
      workspace,
      model: input.model,
      variant: input.variant,
      title: `panel:${input.arm}:${input.nudge}:${input.model}:${pad(input.run)}`,
      session: turns === 0 ? null : sessionID,
      turn: turns + 1,
      arm: input.arm,
      nudge: input.nudge,
      deadline,
      eventsFile,
      stderrFile,
      // The stop is manufactured on turn 1 only; the continue turn must be real.
      fakeStopAfterSteps: turns === 0 ? input.fakeStopAfterSteps : null,
    })
    turns++
    sessionID = turn.sessionID ?? sessionID
    steps += turn.steps
    tools.push(...turn.toolCalls)
    addTokens(tokens, turn.tokens)
    nudgeEvents += turn.nudgeEvents
    tails.push(turn.textTail)
    exit = turn.exit
    stderr += turn.stderr
    if (turn.timedOut) timeout = true

    current = score(workspace)
    // The probe has nothing to complete; one turn is the whole run.
    if (input.scenario === "probe") break
    if (current.complete || timeout) break
    if (!sessionID) break
    if (stops >= input.maxContinues) break
    stops++
  }

  const toolsByName: Record<string, number> = {}
  for (const call of tools) toolsByName[call.tool] = (toolsByName[call.tool] ?? 0) + 1
  const todoIndex = tools.findIndex((call) => call.tool === "todowrite")

  return {
    ...current,
    arm: input.arm,
    nudge: input.nudge,
    model: input.model,
    variant: input.variant ?? null,
    scenario: input.scenario,
    run: input.run,
    workspace,
    sessionID,
    turns,
    stops,
    abandoned: !current.complete && !timeout && stops >= input.maxContinues,
    timeout,
    steps,
    tool_calls: tools.length,
    tools_by_name: toolsByName,
    todowrite_first_call_index: todoIndex === -1 ? null : todoIndex,
    nudge_events: nudgeEvents,
    tokens,
    wall_ms: Date.now() - started,
    final_text_tail: tails,
    log_actions: logActions(offset, sessionID),
    exit_code: exit,
    stderr_tail: stderr.slice(-STDERR_TAIL_CHARS),
    fake_stop_after_steps: input.fakeStopAfterSteps,
    started_at: new Date(started).toISOString(),
  }
}

// ------------------------------------------------------------------- summary

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function fixed(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "-"
}

/**
 * One number for a run's spend.
 *
 * `tokens.total` is the engine's own per-step total and ALREADY contains
 * input + output + reasoning + cache, so summing every key would count the
 * same tokens twice. The component sum is the fallback for a row whose steps
 * carried no `total`.
 */
function totalTokens(tokens: Record<string, number>): number {
  if (typeof tokens.total === "number") return tokens.total
  return Object.entries(tokens)
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + value, 0)
}

function ratio(entry: { ok: number; present: number }): number {
  return entry.present === 0 ? 0 : entry.ok / entry.present
}

function readRows(dir: string): Row[] {
  const file = path.join(dir, "runs.jsonl")
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Row)
}

function renderSummary(rows: readonly Row[]): string {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = `${row.arm}|${row.nudge}|${row.model}|${row.variant ?? "-"}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }

  const header =
    "| arm | nudge | model | N | complete | stops mean/min/max | abandoned | timeouts | steps | tools | tokens | rule early | rule late | todo % | wall min |"
  const divider = "|" + " --- |".repeat(15)
  const lines = [header, divider]

  for (const [key, list] of [...groups.entries()].sort()) {
    const [arm, nudge, model, variant] = key.split("|")
    const stops = list.map((row) => row.stops)
    const spend = list.map((row) => totalTokens(row.tokens))
    lines.push(
      "| " +
        [
          arm,
          nudge,
          variant === "-" ? model : `${model} (${variant})`,
          String(list.length),
          `${fixed((list.filter((row) => row.complete).length / list.length) * 100, 0)}%`,
          `${fixed(mean(stops))}/${Math.min(...stops)}/${Math.max(...stops)}`,
          String(list.filter((row) => row.abandoned).length),
          String(list.filter((row) => row.timeout).length),
          fixed(mean(list.map((row) => row.steps))),
          fixed(mean(list.map((row) => row.tool_calls))),
          fixed(mean(spend), 0),
          fixed(mean(list.map((row) => ratio(row.rule_early))) * 100, 0) + "%",
          fixed(mean(list.map((row) => ratio(row.rule_late))) * 100, 0) + "%",
          fixed((list.filter((row) => row.todowrite_first_call_index !== null).length / list.length) * 100, 0) + "%",
          fixed(mean(list.map((row) => row.wall_ms)) / 60_000),
        ].join(" | ") +
        " |",
    )
  }

  const absent = rows.filter((row) => row.log_actions === "absent").length
  const notes = [
    "",
    `rows: ${rows.length}; \`trailing context\` log line absent for ${absent} of them` +
      (absent === rows.length ? " (this build does not emit it yet)" : ""),
    "rule early/late = obeying files / files present (a file never written cannot disobey).",
    `complete = ${MODULE_COUNT} modules + ${MODULE_COUNT} tests + pytest exit 0 with >= ${REQUIRED_PASSED} passed + SUMMARY.md listing all ${EXPECTED_FILE_COUNT} files.`,
  ]
  return [...lines, ...notes].join("\n") + "\n"
}

// --------------------------------------------------------------------- usage

/**
 * The ChatGPT plan windows.
 *
 * The credential is read through `Auth.Service` — the same store the codex
 * plugin writes — and handed straight to `fetchChatgptUsage`, which puts it on
 * ONE outbound header and drops it. Nothing here prints or writes it: only the
 * label, the percentage and the reset time cross back out.
 */
const usageMain = Effect.gen(function* () {
  const auth = yield* Auth.Service
  const stored = yield* auth.get("openai").pipe(Effect.orElseSucceed(() => undefined))
  if (!stored || stored.type !== "oauth") {
    console.error("no openai oauth credential stored; sign in first")
    process.exit(2)
  }
  const result = yield* Effect.promise(() =>
    ACPProviderUsage.fetchChatgptUsage(stored, Date.now(), globalThis.fetch as never),
  )
  if (!result.ok) {
    console.error(`unavailable: ${result.unavailable}`)
    process.exit(1)
  }
  console.log(`openai${result.plan ? ` (${result.plan})` : ""}`)
  for (const window of result.windows) {
    const resets = window.resetsAt ? new Date(window.resetsAt).toISOString() : "unknown"
    console.log(`  ${window.label}: ${window.usedPercent.toFixed(1)}% used, resets ${resets}`)
  }
}).pipe(Effect.provide(LayerNode.compile(Auth.node)))

// ----------------------------------------------------------------------- main

const USAGE = `usage:
  bun script/trailing-context-panel.ts run --model <provider/model> [--variant <v>]
      --arm <${ARMS.join("|")}> --nudge <${NUDGES.join("|")}> --n <N> --out <dir>
      [--scenario modules|modules-notodo|probe] [--max-continues ${DEFAULT_MAX_CONTINUES}]
      [--run-timeout-min ${DEFAULT_RUN_TIMEOUT_MIN}] [--parallel ${DEFAULT_PARALLEL}]
      [--fake-stop-after-steps <k>   TEST-ONLY: manufactures a stop, never use for a measured arm]
  bun script/trailing-context-panel.ts summary --in <dir>
  bun script/trailing-context-panel.ts usage`

function die(message: string): never {
  console.error(message)
  console.error(USAGE)
  process.exit(2)
}

async function main() {
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
  const flag = (name: string) => flags.get(name)
  const command = positional[0]

  if (command === "usage") {
    await Effect.runPromise(usageMain)
    return
  }

  if (command === "summary") {
    const dir = flag("in")
    if (!dir) die("summary needs --in <dir>")
    const rows = readRows(path.resolve(dir))
    if (rows.length === 0) die(`no rows in ${path.join(path.resolve(dir), "runs.jsonl")}`)
    const table = renderSummary(rows)
    process.stdout.write(table)
    fs.writeFileSync(path.join(path.resolve(dir), "summary.md"), table)
    return
  }

  if (command !== "run") die(command ? `unknown command: ${command}` : "no command given")

  const model = flag("model")
  if (!model) die("run needs --model <provider/model>")
  const arm = (flag("arm") ?? "on-change") as Arm
  if (!ARMS.includes(arm)) die(`--arm must be one of ${ARMS.join(", ")}`)
  const nudge = (flag("nudge") ?? "default") as Nudge
  if (!NUDGES.includes(nudge)) die(`--nudge must be one of ${NUDGES.join(", ")}`)
  const out = flag("out")
  if (!out) die("run needs --out <dir>")
  const outDir = path.resolve(out)
  fs.mkdirSync(outDir, { recursive: true })

  const n = Number(flag("n") ?? 1)
  if (!Number.isInteger(n) || n < 1) die("--n must be a positive integer")
  const scenario = flag("scenario") ?? "modules"
  if (scenario !== "modules" && scenario !== "modules-notodo" && scenario !== "probe")
    die("--scenario must be modules, modules-notodo or probe")
  const maxContinues = Number(flag("max-continues") ?? DEFAULT_MAX_CONTINUES)
  const timeoutMin = Number(flag("run-timeout-min") ?? DEFAULT_RUN_TIMEOUT_MIN)
  const parallel = Math.max(1, Number(flag("parallel") ?? DEFAULT_PARALLEL))
  const fakeStopRaw = flag("fake-stop-after-steps")
  const fakeStop = fakeStopRaw === undefined || fakeStopRaw === "" ? null : Number(fakeStopRaw)
  if (fakeStop !== null && (!Number.isInteger(fakeStop) || fakeStop < 1)) die("--fake-stop-after-steps needs an integer >= 1")
  if (fakeStop !== null) console.error("! --fake-stop-after-steps is TEST-ONLY: this row carries a manufactured stop")

  const rowsFile = path.join(outDir, "runs.jsonl")
  const queue = [...Array(n)].map((_, index) => index + 1)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= queue.length) return
      const run = queue[index]
      const started = Date.now()
      console.error(`> run ${pad(run)}/${n} ${arm}/${nudge} ${model}`)
      const row = await runOnce({
        arm,
        nudge,
        model,
        variant: flag("variant") || undefined,
        scenario,
        run,
        out: outDir,
        maxContinues,
        timeoutMin,
        fakeStopAfterSteps: fakeStop,
      })
      fs.appendFileSync(rowsFile, JSON.stringify(row) + "\n")
      console.error(
        `< run ${pad(run)} complete=${row.complete} stops=${row.stops} steps=${row.steps}` +
          ` tools=${row.tool_calls} ${((Date.now() - started) / 60_000).toFixed(1)}min`,
      )
    }
  }
  await Promise.all([...Array(Math.min(parallel, n))].map(() => worker()))
  console.error(`rows appended to ${rowsFile}`)
}

await main()

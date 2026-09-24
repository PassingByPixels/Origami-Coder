/**
 * The synthetic turn a finished background shell job injects into the session
 * that started it, and the stamp that lets a client recognise it. Without it a
 * `bash` call with `background: true` tells the model nothing, on any outcome,
 * while the prompts it reads promise that results arrive by themselves.
 *
 * It mirrors `tool/task.ts` rather than inventing a shape: the model already
 * reads one settled-background-work format, `<task ...><task_result>`, so this
 * is the same skeleton with the nouns changed and one field a task cannot have,
 * the process exit code.
 *
 * The tail, not the whole log: a background job can write megabytes, which is
 * why its output goes to a file. The last `TAIL_LINES` lines are where a failure
 * states itself, and the path to the rest is on the block's last line.
 */

import type { Info } from "@/background/job"

/** Key on the injected text part's `metadata`; the client's machine-readable
 *  "that background command is done" signal, so nothing parses the prose. */
export const SHELL_RESULT_KEY = "origami_shell_result"

/** How much of the output travels with the notification. */
export const TAIL_LINES = 40

export type ShellResultState = "completed" | "error"

export type ShellResultEntry = {
  /** The background job id, `shell-<callID>` - the same id the launch result
   *  handed the model and the one `task_stop` takes. */
  jobId: string
  state: ShellResultState
  /** Absent when the job never reached a process (cancelled before start, or a
   *  defect in the job itself). */
  exit?: number
}

export function shellResultMetadata(entry: ShellResultEntry) {
  return {
    [SHELL_RESULT_KEY]: {
      jobId: entry.jobId,
      state: entry.state,
      ...(entry.exit === undefined ? {} : { exit: entry.exit }),
    },
  }
}

/** The entry a part's metadata carries, or undefined. Fail-closed: a shape that
 *  is not what `shellResultMetadata` writes is dropped, never guessed at. */
export function shellResult(metadata: unknown): ShellResultEntry | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const raw = (metadata as Record<string, unknown>)[SHELL_RESULT_KEY]
  if (!raw || typeof raw !== "object") return undefined
  const { jobId, state, exit } = raw as { jobId?: unknown; state?: unknown; exit?: unknown }
  if (typeof jobId !== "string" || !jobId) return undefined
  if (state !== "completed" && state !== "error") return undefined
  return { jobId, state, ...(typeof exit === "number" ? { exit } : {}) }
}

/** The last `TAIL_LINES` lines. Trailing blank lines go first so the budget is
 *  spent on output rather than on the newline a shell always adds. */
export function lastLines(text: string, limit = TAIL_LINES) {
  const lines = text.replace(/\s+$/, "").split("\n")
  return lines.length <= limit ? lines.join("\n") : lines.slice(-limit).join("\n")
}

/**
 * One decision, in one place: what a settled job means. `status` alone is not
 * enough — "the command failed", "it ran too long" and "the engine broke" call
 * for three different next moves, so the prose has to tell them apart.
 */
export function describe(info: Info | undefined, command: string) {
  const exit = typeof info?.exit === "number" ? info.exit : undefined
  if (info?.status === "cancelled") {
    return { state: "error" as const, summary: `Background command was stopped: ${command}`, exit }
  }
  if (info?.status === "error") {
    if (exit !== undefined) {
      return { state: "error" as const, summary: `Background command failed with exit ${exit}: ${command}`, exit }
    }
    if (info.metadata?.["expired"] === true) {
      return { state: "error" as const, summary: `Background command hit its time limit: ${command}`, exit }
    }
    return { state: "error" as const, summary: `Background command could not be run: ${command}`, exit }
  }
  return { state: "completed" as const, summary: `Background command finished: ${command}`, exit }
}

/** The block the model reads: the same skeleton as `tool/task.ts`'s
 *  `renderOutput`, with `exit` added and the log path in place of its resume
 *  line. */
export function render(input: {
  jobId: string
  state: ShellResultState
  summary: string
  exit?: number
  text: string
  logPath?: string
}) {
  const tag = input.state === "error" ? "shell_error" : "shell_result"
  return [
    `<shell id="${input.jobId}" state="${input.state}"${input.exit === undefined ? "" : ` exit="${input.exit}"`}>`,
    `<summary>${input.summary}</summary>`,
    `<${tag}>`,
    input.text || "(no output)",
    `</${tag}>`,
    ...(input.logPath ? [`Full output: ${input.logPath}`] : []),
    "</shell>",
  ].join("\n")
}

export * as ShellResult from "./result"

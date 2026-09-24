import { Clock, Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"
import { ShellResult } from "./shell/result" // origami_change (t-41dz9f)

export const Parameters = Schema.Struct({})

type Metadata = {
  count: number
  running: number
}

const DESCRIPTION = [
  "List the background tasks you have launched this session and their status",
  "(running / completed / error / cancelled), newest last.",
  "This is a one-shot, NON-BLOCKING snapshot for situational awareness — e.g. to",
  "see what is still running before launching more work or deciding what to stop.",
  "It does NOT wait or poll; a finished task's result is delivered to you",
  "automatically — background sub-agents and background shell commands alike —",
  "so do not call this repeatedly to watch a task complete.",
  "A settled command shows its exit code, and non-zero is a FAILURE however",
  "ordinary the last lines look.",
].join(" ")

/** The tool id, shared with session/reminders.ts so the poll-loop detector
 *  cannot go blind on a rename. */
export const TaskListID = "task_list"

/** origami_change (t-41dz9f): output lines per settled job in the snapshot. */
const TAIL_LINES = 5

export const TaskListTool = Tool.define<typeof Parameters, Metadata, BackgroundJob.Service>(
  TaskListID,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      deferrable: true,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const jobs = yield* background.list()
          const running = jobs.filter((j) => j.status === "running").length
          if (jobs.length === 0) {
            return {
              title: "No background tasks",
              output: "No background tasks have been launched this session.",
              metadata: { count: 0, running: 0 },
            }
          }
          const now = yield* Clock.currentTimeMillis
          const lines = jobs.flatMap((j) => {
            const end = j.completed_at ?? now
            const secs = Math.max(0, Math.round((end - j.started_at) / 1000))
            const age = j.status === "running" ? `${secs}s running` : `${secs}s`
            // origami_change-start (t-41dz9f)
            // The exit code, and enough output to act on; the status word alone
            // renders a command that exited 1 as `[completed]`. The tail is
            // deliberately short - the settled job already pushed its 40 lines
            // into the conversation, so this stays a snapshot.
            const code = typeof j.exit === "number" ? ` exit=${j.exit}` : ""
            const body = j.status === "running" ? "" : ShellResult.lastLines(j.output ?? j.error ?? "", TAIL_LINES)
            return [
              `- ${j.id} [${j.status}]${code} ${j.title ?? j.type} (${age})`,
              ...(body ? body.split("\n").map((line) => `    ${line}`) : []),
            ]
            // origami_change-end
          })
          return {
            title: `${jobs.length} background task${jobs.length > 1 ? "s" : ""}${running ? ` (${running} running)` : ""}`,
            output: lines.join("\n"),
            metadata: { count: jobs.length, running },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

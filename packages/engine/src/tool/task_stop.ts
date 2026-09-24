import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { BackgroundJob } from "@/background/job"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({
    description:
      'The id of the background task to stop — the id from the <task id="..."> tag returned when you launched it, or from task_list.',
  }),
})

type Metadata = {
  status: string
}

const DESCRIPTION = [
  "Stop (cancel) a running background task you launched, addressed by its task id.",
  "Use this when a background task is no longer needed or is going wrong — do not",
  "wait for it to finish on its own. Cancelling a task that has already finished is",
  "a safe no-op; it reports the task's current status either way.",
].join(" ")

export const TaskStopTool = Tool.define<typeof Parameters, Metadata, BackgroundJob.Service>(
  "task_stop",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      deferrable: true,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const info = yield* background.cancel(params.task_id, "task_stop")
          // t-fijy8a F12. The DESCENDANTS too: a sub-agent job is keyed by the
          // child's own session id, so a grandchild names it as its parent and
          // cancelling the one job left the generations below it running with
          // nobody to report to. The same walk run-state.ts and the expiry
          // watchdog use; `includeRoot: false` because the root is settled
          // above, and detached work is NOT spared - task_stop is the
          // deliberate way to end it (core/background-job.ts cancelTree).
          if (info)
            yield* BackgroundJob.cancelTree(background, params.task_id, { includeRoot: false, reason: "task_stop" })
          if (!info) {
            return {
              title: "Task not found",
              output: `No background task with id ${params.task_id}. Use task_list to see what is running.`,
              metadata: { status: "not_found" },
            }
          }
          const label = info.title ?? info.type
          if (info.status === "cancelled") {
            return {
              title: `Stopped ${params.task_id}`,
              output: `Background task ${params.task_id} (${label}) has been cancelled.`,
              metadata: { status: info.status },
            }
          }
          return {
            title: `Task ${params.task_id} already ${info.status}`,
            output: `Background task ${params.task_id} (${label}) was already ${info.status}; nothing to stop.`,
            metadata: { status: info.status },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

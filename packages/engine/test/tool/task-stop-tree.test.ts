import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { TaskStopTool } from "@/tool/task_stop"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

/**
 * t-fijy8a F12. `task_stop` cancelled ONE job while every other stop path in
 * the engine (session/run-state.ts, the expiry watchdog) cancels the TREE, so
 * stopping an orchestrator left its own sub-agents' sub-agents running with
 * nobody left to report to.
 *
 * Three levels, because two would pass on a one-generation fix: the grandchild
 * names the CHILD as its parent, never the root, so only a transitive walk
 * reaches it.
 */
const it = testEffect(LayerNode.compile(LayerNode.group([Agent.node, BackgroundJob.node, Truncate.node])))

const job = (jobs: BackgroundJob.Interface, id: string, parentSessionId: string) =>
  jobs.start({
    id,
    type: "task",
    title: id,
    metadata: { background: true, parentSessionId, sessionId: id },
    run: Effect.never,
  })

const stop = (taskID: string) =>
  Effect.gen(function* () {
    const tool = yield* (yield* TaskStopTool).init()
    return yield* tool.execute({ task_id: taskID }, {
      sessionID: "ses_parent",
      messageID: "msg_1",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    } as never)
  })

describe("task_stop cascades", () => {
  it.instance("cancels the stopped task's running descendants, not just the task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* job(jobs, "ses_root", "ses_parent")
      yield* job(jobs, "ses_child", "ses_root")
      yield* job(jobs, "ses_grandchild", "ses_child")

      const result = yield* stop("ses_root")
      expect(result.metadata.status).toBe("cancelled")

      for (const id of ["ses_root", "ses_child", "ses_grandchild"]) {
        const info = yield* jobs.get(id)
        expect(`${id}:${info?.status}`).toBe(`${id}:cancelled`)
        expect(info?.metadata?.[BackgroundJob.CANCEL_REASON_KEY]).toBe("task_stop")
      }
    }),
  )

  it.instance("leaves another task's tree alone", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* job(jobs, "ses_root", "ses_parent")
      yield* job(jobs, "ses_child", "ses_root")
      yield* job(jobs, "ses_other", "ses_parent")

      yield* stop("ses_root")

      expect((yield* jobs.get("ses_other"))?.status).toBe("running")
      yield* jobs.cancel("ses_other")
    }),
  )

  it.instance("still reports not_found for an id nothing is running under", () =>
    Effect.gen(function* () {
      const result = yield* stop("ses_missing")
      expect(result.metadata.status).toBe("not_found")
    }),
  )
})

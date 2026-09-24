import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { BackgroundJob } from "@/background/job"
import { stopped } from "@/tool/task"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(BackgroundJob.node))

/**
 * t-di2u7z. The UAT export (origami-session-Tsuru-2026-09-14-21-20-18.md) ended a
 * FOREGROUND `orchestrator` task with `Task stopped by the parent`. The engine log
 * for that run says what really happened - the parent's turn was cancelled first
 * and the child followed 4 ms later:
 *
 *   21:20:16.772 cancel session.id=ses_f5e409cecffec8fvph13B13edn   <- the parent
 *   21:20:16.776 cancel session.id=ses_f5e363414ffeAJH4XfJ9NbQU7d   <- the child
 *
 * i.e. `session/prompt.ts:522` (SessionPrompt.cancel, reached from ACP
 * `session/cancel` - the client's stop) -> `session/run-state.ts:84`
 * `BackgroundJob.cancelTree` -> every job whose `metadata.parentSessionId` is the
 * parent. `tool/task.ts` then read the bare status `cancelled` as "the parent did
 * this". The shape below is that cascade, and the assertion is the sentence.
 */
describe("a child cancelled by the parent's turn stop", () => {
  const child = (jobs: BackgroundJob.Interface, parentSessionId: string) =>
    jobs.start({
      id: "ses_child",
      type: "task",
      title: "Orchestrator builds own todo",
      metadata: { parentSessionId, sessionId: "ses_child" },
      run: Effect.never,
    })

  it.instance("names the turn stop, not the parent, when the cascade took it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* child(jobs, "ses_parent")
      // Exactly what SessionRunState.cancel runs when the user presses stop.
      yield* BackgroundJob.cancelTree(jobs, "ses_parent", { spareDetached: true, reason: "parent_turn_stopped" })

      const info = yield* jobs.get("ses_child")
      expect(info?.status).toBe("cancelled")
      expect(info?.metadata?.[BackgroundJob.CANCEL_REASON_KEY]).toBe("parent_turn_stopped")
      expect(stopped(info!)).toBe("stopped because the parent's turn was stopped")
    }),
  )

  it.instance("still says 'stopped by the parent' when the parent really stopped it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* child(jobs, "ses_parent")
      // What tool/task_stop.ts does when the MODEL calls task_stop.
      yield* jobs.cancel("ses_child", "task_stop")

      expect(stopped((yield* jobs.get("ses_child"))!)).toBe("stopped by the parent")
    }),
  )

  it.instance("falls back to the old sentence when nothing named a reason", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* child(jobs, "ses_parent")
      yield* jobs.cancel("ses_child")

      const info = yield* jobs.get("ses_child")
      expect(info?.metadata?.[BackgroundJob.CANCEL_REASON_KEY]).toBeUndefined()
      expect(stopped(info!)).toBe("stopped by the parent")
    }),
  )
})

// t-fijeld. `cancel_reason` is looked up with `Object.hasOwn`, not `in`: a
// prototype key like "toString" is not a reason and must read as the bare
// "stopped by the parent".
describe("an unknown cancel reason", () => {
  it.effect("falls back to the bare sentence, prototype keys included", () =>
    Effect.gen(function* () {
      const info = (reason: string) =>
        ({ status: "cancelled", metadata: { [BackgroundJob.CANCEL_REASON_KEY]: reason } }) as unknown as BackgroundJob.Info
      expect(stopped(info("toString"))).toBe("stopped by the parent")
      expect(stopped(info("constructor"))).toBe("stopped by the parent")
      expect(stopped(info("task_stop"))).toBe("stopped by the parent")
      expect(stopped(info("session_removed"))).toBe("stopped because the parent session was deleted")
    }),
  )
})

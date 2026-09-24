// t-q910fo. THE PER-ROW STOP ABORTS ONE CHILD AND NOTHING ELSE.
//
// The behaviour worth protecting is not "cancel was called": it is the SHAPE of
// what the cancel reaches. A sub-agent job is registered under the CHILD's own
// session id (tool/task.ts `background.start`) and a grandchild names that id as
// its `parentSessionId`, so:
//
//   - the named child stops, and everything under it stops with it (otherwise a
//     grandchild runs on with nobody left to report to);
//   - a SIBLING child is a different root and must keep running;
//   - the reason is recorded as `user_stop`, which `tool/task.ts` `stopped`
//     renders to the parent's model as "stopped by the user" — the parent
//     decided nothing and the sentence must not say it did;
//   - a detached background SHELL shares this registry and is NOT a sub-agent,
//     so this wire refuses it (`shell_stop` is the shell's own).
//
// Driven against the REAL BackgroundJob registry, not a mock of it: the walk
// being tested is the registry's own.

import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { BackgroundJob } from "@/background/job"
import { NOT_FOUND, stopSubagentJob } from "@/acp/subagent-stop"
import { stopped } from "@/tool/task"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(BackgroundJob.node))

const PARENT = "ses_parent"
const CHILD = "ses_child"
const SIBLING = "ses_sibling"
const GRANDCHILD = "ses_grandchild"

/** A sub-agent job exactly as `tool/task.ts` registers one: keyed by the child's
 *  session id, carrying the parent's. `Effect.never` stands in for the turn. */
const spawn = (jobs: BackgroundJob.Interface, id: string, parentSessionId: string) =>
  jobs.start({
    id,
    type: "task",
    title: id,
    metadata: { parentSessionId, sessionId: id },
    run: Effect.never,
  })

describe("subagent_stop", () => {
  it.instance("stops the named child and its descendants, and leaves a sibling running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* spawn(jobs, CHILD, PARENT)
      yield* spawn(jobs, SIBLING, PARENT)
      yield* spawn(jobs, GRANDCHILD, CHILD)

      const result = yield* stopSubagentJob(jobs, CHILD)

      expect(result.status).toBe("cancelled")
      expect((yield* jobs.get(CHILD))?.status).toBe("cancelled")
      expect((yield* jobs.get(GRANDCHILD))?.status).toBe("cancelled")
      expect((yield* jobs.get(SIBLING))?.status).toBe("running")
    }),
  )

  it.instance("records the stop as the USER's, which the parent's model reads back", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      yield* spawn(jobs, CHILD, PARENT)

      yield* stopSubagentJob(jobs, CHILD)
      const info = yield* jobs.get(CHILD)

      expect(info?.metadata?.[BackgroundJob.CANCEL_REASON_KEY]).toBe("user_stop")
      // The launcher's own sentence — what the parent turn receives as the
      // child's result through the existing task result path.
      expect(stopped(info!)).toBe("stopped by the user")
    }),
  )

  it.instance("refuses a job that is not a sub-agent, and an id nobody registered", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      // A detached background shell: `sessionId`, never `parentSessionId` (tool/shell.ts).
      const shell = yield* jobs.start({
        id: "job_shell",
        type: "shell",
        metadata: { sessionId: PARENT, background: true },
        run: Effect.never,
      })

      expect((yield* stopSubagentJob(jobs, shell.id)).status).toBe(NOT_FOUND)
      expect((yield* jobs.get(shell.id))?.status).toBe("running")
      expect((yield* stopSubagentJob(jobs, "ses_never_existed")).status).toBe(NOT_FOUND)
    }),
  )
})

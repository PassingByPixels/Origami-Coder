// subagent-stop.ts — origami_change (t-q910fo): abort ONE sub-agent child, the
// USER's own stop from the drawer row.
//
// Its own leaf rather than four more lines inside `ACP.subagentStop`, for the
// reason Part 6 of the guide gives: the thing worth protecting here is a
// BEHAVIOUR ("only that child, and everything under it"), and inside the
// service closure it could only be reached through the whole ACP stack. Here a
// test drives it against a real BackgroundJob registry.
//
// It is `task_stop`'s abort path (tool/task_stop.ts), reused deliberately: a
// sub-agent job is keyed by the CHILD's session id, so a grandchild names it as
// its parent, and cancelling the one job leaves the generations below it running
// with nobody to report to. `includeRoot: false` because the root is settled by
// the `cancel` above it.

import { Effect } from "effect"
import { BackgroundJob } from "@/background/job"

/** No sub-agent job is registered under that id — already settled, removed, or
 *  never a child at all. A stop nobody could act on is not an error: the row the
 *  user pressed may simply have finished a moment earlier. */
export const NOT_FOUND = "not_found"

/**
 * Is this job a SUB-AGENT, rather than the detached background SHELL that shares
 * the registry? `parentSessionId` is the key only `tool/task.ts` stamps. This
 * wire is addressed by a child SESSION id and `shell_stop` is the shell's own, so
 * a shell job reached by this method is refused instead of being killed by it.
 */
export function isSubagentJob(info: BackgroundJob.Info): boolean {
  return typeof info.metadata?.["parentSessionId"] === "string"
}

/**
 * Cancel the child registered under `sessionId`, and its descendants. Returns the
 * job's resulting status, or {@link NOT_FOUND}.
 *
 * NOTHING ELSE IS TOUCHED. The parent's turn keeps running and learns of the stop
 * through the launcher's existing result path (`tool/task.ts` `stopped`, which
 * renders the `user_stop` reason as "stopped by the user"); a sibling child is a
 * different root and the walk never reaches it.
 */
export const stopSubagentJob = (jobs: BackgroundJob.Interface, sessionId: string) =>
  Effect.gen(function* () {
    const found = yield* jobs.get(sessionId)
    if (!found || !isSubagentJob(found)) return { status: NOT_FOUND }
    const info = yield* jobs.cancel(sessionId, "user_stop")
    if (info) yield* BackgroundJob.cancelTree(jobs, sessionId, { includeRoot: false, reason: "user_stop" })
    return { status: info?.status ?? found.status }
  })

/**
 * The ROOM STATE a collab agent is given, fresh, on every turn.
 *
 * Facts only - who you are, who is in the room, who leads it, the objective,
 * the hop budget, the open tasks. It is never overridable and there is no file
 * behind it, because it is not prose: an agent that is wrong about the roster
 * @mentions handles that do not exist.
 *
 * The prose that used to sit above this block (the "room manual") is gone. One
 * base prompt states the room's rules once - see `collab-agent-base.txt` - and
 * a second document restating them half-accurately is the failure that layer
 * was creating rather than fixing.
 */

export type RosterEntry = {
  readonly agentSlug: string
  readonly displayName: string
}

/** One row of the task board, as the state block shows it. Never the full record. */
export type TaskSummary = {
  /**
   * The board id, and the reason this row is not just prose.
   *
   * Every board tool takes a `taskId` and NOTHING else identifies a task, so a
   * row printed without one is a task the agent can see and cannot touch. That
   * was the W8 bug: a human-added task (the one case where the agent never
   * receives an id through `ask`, `handoff` or its own `task_add` result) was
   * unclaimable, `task_claim` refused with "there is no task X on this board",
   * and the agent read the refusal as the work having already been taken.
   */
  readonly id: string
  readonly title: string
  readonly state: "open" | "claimed" | "done" | "accepted"
  readonly owner: string | null
}

/** How many open task rows the state block shows before it stops listing them. */
export const TASK_LINES_MAX = 8

/**
 * Built fresh per turn so an add or a remove between two turns shows up in the
 * next one without touching any agent definition.
 *
 * `hops.remaining` is the LIVE hop budget, not the collab's configured cap: a
 * number here that never moved would tell an agent the room's rhythm when it
 * is really reporting a constant. `null` means the budget is off (overnight
 * mode), which has no countdown to announce.
 */
export function roomState(input: {
  agentSlug: string
  displayName: string
  title: string
  roster: readonly RosterEntry[]
  /** @slug of the room's lead, or null when none is set. */
  lead: string | null
  /** The room's standing objective, or null when none is set. */
  objective: string | null
  hops: { remaining: number | null }
  /** Open tasks, oldest first. The block shows only the first few. */
  tasks: readonly TaskSummary[]
}): string {
  const lines = [
    `You are @${input.agentSlug} ("${input.displayName}"). Collab: "${input.title}". Roster:`,
    ...input.roster.map(
      (entry) => `- @${entry.agentSlug}: ${entry.displayName}${entry.agentSlug === input.agentSlug ? " (you)" : ""}`,
    ),
    input.lead
      ? `@${input.lead} leads this room - unaddressed human messages go to them.`
      : "No lead is set for this room.",
  ]
  if (input.objective) lines.push(`Objective: ${input.objective}`)
  lines.push(
    input.hops.remaining === null
      ? "The hop budget is off - it runs until stopped."
      : `This room has ${input.hops.remaining} wake${input.hops.remaining === 1 ? "" : "s"} left on the current human request.`,
  )
  // "Open tasks" was a second lie on the same block: a `done` task is not open,
  // it is waiting on whoever raised it. The heading names the board, and the id
  // leads each row because it is the only argument the board tools take.
  const live = input.tasks.filter((task) => task.state !== "accepted").slice(0, TASK_LINES_MAX)
  if (live.length > 0) {
    lines.push("Task board - name a task by the id below in task_claim / task_done / task_accept / task_reopen:")
    for (const task of live) {
      lines.push(`- ${task.id} [${task.state}] ${task.title}${task.owner ? ` (@${task.owner})` : ""}`)
    }
  }
  return lines.join("\n")
}

export * as CollabState from "./collab-state"

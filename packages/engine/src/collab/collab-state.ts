/**
 * The ROOM STATE a collab agent is given, fresh, on every turn.
 *
 * Facts only - who you are, who is in the room, who leads it, the objective,
 * the hop budget, the open tasks. Never overridable and no file behind it: an
 * agent that is wrong about the roster @mentions handles that do not exist.
 */

export type RosterEntry = {
  readonly agentSlug: string
  readonly displayName: string
}

/** One row of the task board, as the state block shows it. Never the full record. */
export type TaskSummary = {
  /**
   * The board id, and the reason this row is not just prose. Every board tool
   * takes a `taskId` and NOTHING else identifies a task, so a row printed
   * without one is a task the agent can see and cannot touch.
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
 * next one. `hops.remaining` is the LIVE hop budget, not the configured cap;
 * `null` means the budget is off (overnight mode), with no countdown to show.
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
  // A `done` task is not open, it is waiting on whoever raised it. The id leads
  // each row because it is the only argument the board tools take.
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

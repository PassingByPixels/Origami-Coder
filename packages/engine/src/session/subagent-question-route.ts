import { Effect } from "effect"
import type { Session } from "./session"
import type { SessionID } from "./schema"
import { SubagentQuestion } from "./subagent-question"

/**
 * THE SESSION-TREE HALF of the sub-agent question route (t-po041k).
 *
 * `session/subagent-question.ts` is pure and knows nothing about sessions;
 * `tool/question.ts` must stay a tool. This is the join: who the child is, and
 * which ancestors might have a chat open.
 *
 * The suffix strip is the one piece of guesswork here and it is deliberate.
 * `tool/task.ts` titles a child either `<description>` or
 * `<description> (@<type> subagent)` depending on which branch created it, and
 * the description is what the drawer row prints. Reading it back off the title
 * is ugly; the alternative is a new column for a string that already exists.
 */

/** `Some description (@Explore subagent)` -> `Some description`. */
export function descriptionOf(title: string): string {
  return title.replace(/\s*\(@[^)]*subagent\)\s*$/, "").trim()
}

export interface Routing {
  readonly label: string
  /** Nearest first. Empty when the session has no parent at all. */
  readonly ancestors: ReadonlyArray<SessionID>
}

/**
 * How to name this child and where its question may land, or `undefined` when
 * it is not a child at all — which is the signal to ask the user as before.
 *
 * The ancestor chain is walked WHOLE rather than stopping at the parent: a
 * grandchild's parent is itself a sub-agent with no window, and the question
 * has to keep climbing until it reaches a chat somebody is looking at.
 */
export const routingFor = Effect.fn("SubagentQuestion.routingFor")(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
) {
  const self = yield* sessions.get(sessionID)
  if (!self.parentID) return undefined

  const siblings = yield* sessions.children(self.parentID)
  const ordered = [...siblings].sort((a, b) => a.time.created - b.time.created)
  const ordinal = ordered.findIndex((row) => row.id === sessionID) + 1

  const ancestors: SessionID[] = []
  const seen = new Set<string>([sessionID])
  let cursor: SessionID | undefined = self.parentID
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    ancestors.push(cursor)
    const next: Session.Info = yield* sessions.get(cursor)
    cursor = next.parentID
  }

  return {
    label: SubagentQuestion.subagentLabel({
      agentType: self.agent,
      ordinal,
      description: descriptionOf(self.title) || undefined,
    }),
    ancestors,
  } satisfies Routing
})

/**
 * Is `sessionID` somewhere under `ancestorID`?
 *
 * THE BOUNDARY ON `question_reply`. `Question.list()` is engine-wide, so
 * without this a sub-agent in one chat could answer a question asked in
 * another — the same reach across the delegation tree that `send_message` and
 * `list_agents` are denied to children for. A seen-set guards the walk: a
 * malformed pair must not hang a tool call.
 */
export const descendsFrom = Effect.fn("SubagentQuestion.descendsFrom")(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
  ancestorID: SessionID,
) {
  const seen = new Set<string>([sessionID])
  let cursor: SessionID | undefined = (yield* sessions.get(sessionID)).parentID
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestorID) return true
    seen.add(cursor)
    cursor = (yield* sessions.get(cursor)).parentID
  }
  return false
})

export * as SubagentQuestionRoute from "./subagent-question-route"

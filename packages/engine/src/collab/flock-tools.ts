import { Effect, Schema } from "effect"
import { Tool } from "@/tool/tool"
import { EffectBridge } from "@/effect/bridge"
import { SessionID } from "@/session/schema"
import type { TaskPromptOps } from "@/tool/task"
import { CollabStore } from "./store"
import { CollabSystem } from "./collab-system"

/**
 * The flock tools: the protocol a collab agent speaks to the rest of the room.
 *
 * They exist ONLY inside a collab turn. `session/prompt.ts` injects them when
 * `CollabSystem.Turn` is present on the fiber and never otherwise, so an
 * ordinary chat sees no new tool, no registry entry and no schema lookup.
 * Everything they need - the room, the board, the child sessions, the hop
 * budget - arrives on that same turn context as plain closures, which is why
 * this file imports neither the runner nor the prompt loop that injects it.
 *
 * A refusal is a plain-text tool RESULT, never a room message. The room is the
 * record of what the agents said to each other; "you cannot ask yourself" is a
 * note to one model, and posting it would make every mis-step a message the
 * whole roster then reads and reacts to.
 */

/** How deep a chain of asks may go before an agent must answer with what it has. */
export const MAX_ASK_DEPTH = 3

type Result = Tool.ExecuteResult

const result = (title: string, output: string, metadata: Record<string, unknown> = {}): Result => ({
  title,
  metadata,
  output,
})

/** A refusal the model can act on, and that the room never sees. */
const refuse = (title: string, output: string): Result => result(title, output, { refused: true })

const NO_TURN = "The flock tools only work inside a collab turn."

/** A board row is a LABEL, not the brief — the full task text lives on the
 *  ask/handoff message. Unbounded, a paragraph-long `task` arg becomes the
 *  title of every auto-task and the board reads like a second stream. */
const boundTitle = (text: string) => (text.length > 80 ? text.slice(0, 79).trimEnd() + "…" : text)

const opsOf = (ctx: Tool.Context) => ctx.extra?.["promptOps"] as TaskPromptOps | undefined

/**
 * Resolve `to` against the ACTIVE roster. Slug first, then display name: the
 * roster block gives agents both, and a model that copies the label out of it
 * has addressed a real participant.
 */
export function resolveTarget(
  roster: readonly CollabSystem.RosterEntry[],
  to: string,
): CollabSystem.RosterEntry | undefined {
  const wanted = to.trim().replace(/^@/, "").toLowerCase()
  if (wanted.length === 0) return undefined
  return (
    roster.find((entry) => entry.agentSlug.toLowerCase() === wanted) ??
    roster.find((entry) => entry.displayName.toLowerCase() === wanted)
  )
}

const rosterHint = (roster: readonly CollabSystem.RosterEntry[]) =>
  roster.length === 0 ? "nobody else is in this collab" : `on the roster: ${roster.map((e) => e.agentSlug).join(", ")}`

/** True when the budget for this human message is spent. */
const spent = (hops: CollabSystem.Hops) => hops.remaining !== null && hops.remaining <= 0

/** The room message an ask or a hand-off leaves behind. */
export function directedText(input: { task: string; context?: string; expect?: string }): string {
  return [
    input.task.trim(),
    ...(input.context?.trim() ? [`Context: ${input.context.trim()}`] : []),
    ...(input.expect?.trim() ? [`Expected back: ${input.expect.trim()}`] : []),
  ].join("\n")
}

/** Said on `task` and `context` of both directed tools, because both were
 *  arriving one line long: a target sees the brief and the room, never the
 *  sender's head, and there is no length limit on either field. */
const SELF_CONTAINED =
  "This is not truncated - write as much as the work needs, pages if that is what it takes. The target sees this brief and recent room messages, NEVER your head or your session: a spec you did not write down does not exist. If it runs longer than a page, write it to a file in the workspace and give the path here."

const AskParameters = Schema.Struct({
  to: Schema.String.annotate({ description: "The @slug of the agent you are asking. It must be on the roster." }),
  task: Schema.String.annotate({
    description: `What you need from them, stated so they can act on it alone. ${SELF_CONTAINED}`,
  }),
  context: Schema.optional(Schema.String).annotate({
    description: `Anything they need that is not already in the room: paths, constraints, what you already tried. ${SELF_CONTAINED}`,
  }),
  expect: Schema.optional(Schema.String).annotate({
    description: "What you want back, and in what shape. Be specific: this is the only thing you will receive.",
  }),
})

const HandoffParameters = Schema.Struct({
  to: Schema.String.annotate({ description: "The @slug of the agent taking over. It must be on the roster." }),
  task: Schema.String.annotate({
    description: `What they are taking on, complete enough to act on without you. ${SELF_CONTAINED}`,
  }),
  context: Schema.optional(Schema.String).annotate({
    description: `Anything they need that is not already in the room. ${SELF_CONTAINED}`,
  }),
})

const DoneParameters = Schema.Struct({
  summary: Schema.optional(Schema.String).annotate({
    description:
      "One closing message for the room. Leave it out to end your turn in silence, which is the right choice when you have nothing to add.",
  }),
})

const TaskAddParameters = Schema.Struct({
  title: Schema.String.annotate({ description: "What the task is, in one line." }),
})

const TaskIdParameters = Schema.Struct({
  taskId: Schema.String.annotate({ description: "The id of the task on the board." }),
})

const TaskDoneParameters = Schema.Struct({
  taskId: Schema.String.annotate({ description: "The id of the task you are completing. You must own it." }),
  result: Schema.String.annotate({ description: "What you actually did, and how you know it worked." }),
})

const TaskReopenParameters = Schema.Struct({
  taskId: Schema.String.annotate({ description: "The id of the completed task you are sending back." }),
  note: Schema.String.annotate({ description: "Why it is going back, and what has to change." }),
})

const ASK_DESCRIPTION = [
  "Ask another agent in this collab a question and WAIT for their answer.",
  "Their reply comes back to you as this tool's result, and the exchange is recorded in the room.",
  "This blocks your turn while they work, so ask only when you need their answer to carry on.",
  "Anything you need REPORTED BACK - verify this, validate that, review it, check it, tell me what you found - is an ask, because only an ask returns.",
  "If the work leaves your hands for good, use handoff instead - it does not block and it does not come back.",
].join(" ")

const HANDOFF_DESCRIPTION = [
  "Hand the work to another agent and END your turn.",
  "They get the baton and take the next turn; you get nothing back.",
  "Use it when the next step is theirs, not yours.",
  "Do NOT use it to have something verified or reported back to you - that is ask; a handoff never returns, so the answer would reach the room and not you.",
].join(" ")

const DONE_DESCRIPTION = [
  "End your turn now.",
  "Pass a summary to post one last message to the room, or leave it out to end in silence.",
  "Silence is a real choice: if the room already has your answer, adding to it costs a turn and says nothing.",
].join(" ")

/**
 * `ask`. The one BLOCKING tool, and the only one that runs another agent's turn
 * inside this one.
 *
 * The order of the checks is the contract's and is load-bearing. Cycle before
 * depth and busy, because an ancestor in the chain is ALWAYS busy - it is
 * sitting in this very tool call - and reporting that as "they are busy" would
 * tell the model to retry the one thing that can never succeed.
 */
const askTool = (memo: Map<string, Result>) =>
  Tool.define(
    "ask",
    Effect.succeed({
      description: ASK_DESCRIPTION,
      parameters: AskParameters,
      execute: (args: Schema.Schema.Type<typeof AskParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // A provider retry can re-drive a finished stream and re-execute a
          // tool call that already ran. Without this the target would take a
          // second turn, and the room would carry two asks for one question.
          const memoized = ctx.callID ? memo.get(ctx.callID) : undefined
          if (memoized) return memoized

          const turn = yield* CollabSystem.Turn
          if (!turn) return refuse("ask", NO_TURN)
          const ops = opsOf(ctx)
          if (!ops) return refuse("ask", "ask needs the prompt ops it is normally given.")

          const answer = yield* run(turn, ops, args, ctx)
          if (ctx.callID) memo.set(ctx.callID, answer)
          return answer
        }),
    }),
  )

const run = Effect.fnUntraced(function* (
  turn: CollabSystem.TurnContext,
  ops: TaskPromptOps,
  args: Schema.Schema.Type<typeof AskParameters>,
  ctx: Tool.Context,
) {
  // (1) the roster.
  const target = resolveTarget(turn.roster, args.to)
  if (!target) return refuse("ask", `There is no "${args.to}" in this collab - ${rosterHint(turn.roster)}.`)

  // (2) the cycle. Before depth and busy: an agent already waiting on this
  // chain is busy BECAUSE it is waiting, and "busy, try later" is the one
  // answer that can never come true.
  if (target.sessionId !== null && turn.askChain.includes(target.sessionId)) {
    return refuse(
      "ask",
      `@${target.agentSlug} is waiting on you further up this chain - answer them instead of asking back.`,
    )
  }

  // (3) the depth.
  if (turn.askChain.length >= MAX_ASK_DEPTH) {
    return refuse(
      "ask",
      `This ask chain is already ${MAX_ASK_DEPTH} deep. Answer with what you have rather than passing the question on again.`,
    )
  }

  // (4) the hop budget. Shared with every turn in the chain, so going deeper
  // cannot buy more room.
  if (spent(turn.hops)) {
    return refuse("ask", "The room is out of hops for this message. Answer with what you have and wait for the human.")
  }

  // (5) busy. LOAD-BEARING: a prompt to a session that is already running joins
  // the run in flight and DISCARDS this work, so the answer would be whatever
  // the other caller asked for.
  if (target.sessionId !== null && (yield* ops.busy(SessionID.make(target.sessionId)))) {
    return refuse("ask", `@${target.agentSlug} is busy with another turn right now. Carry on without them.`)
  }

  const sessionId = yield* turn.ops.session(target.agentSlug).pipe(Effect.orDie)
  const task = yield* turn.ops.store.addTask({
    collabId: turn.collabId,
    title: boundTitle(args.task.trim()),
    createdBy: turn.agentSlug,
    owner: target.agentSlug,
    state: "claimed",
  })
  const asked = yield* turn.ops
    .append({
      collabId: turn.collabId,
      authorId: turn.agentSlug,
      authorKind: "agent",
      kind: "ask",
      text: directedText(args),
      mentions: [target.agentSlug],
      taskId: task.id,
    })
    .pipe(Effect.orDie)
  yield* turn.ops.store.setTaskOrigin(turn.collabId, task.id, asked.seq)
  // The target is about to be shown this ask as its brief, so it must not be
  // handed the same message again as an unread room message afterwards.
  yield* turn.ops.store.setLastSeen(turn.collabId, target.agentSlug, asked.seq)

  const cancel = yield* EffectBridge.make()
  const stopTarget = ops.cancel(SessionID.make(sessionId))
  const onAbort = () => {
    cancel.fork(stopTarget)
  }
  const outcome = yield* Effect.acquireUseRelease(
    Effect.sync(() => ctx.abort.addEventListener("abort", onAbort)),
    () =>
      turn.ops
        .ask({
          target: target.agentSlug,
          sessionId,
          from: turn.agentSlug,
          task: args.task,
          ...(args.context !== undefined ? { context: args.context } : {}),
          ...(args.expect !== undefined ? { expect: args.expect } : {}),
          // Named in the brief so the target has the board id in hand rather
          // than matching titles against the board to find it.
          taskId: task.id,
          askChain: [...turn.askChain, turn.sessionId],
          hops: turn.hops,
        })
        .pipe(Effect.orDie),
    () => Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort)),
  )

  // A truncated reply must NEVER read as a normal answer: the model would build
  // on half an answer and never know it.
  if (outcome.stepCapped) {
    return result("ask", `@${target.agentSlug} ran out of steps mid-answer.`, { taskId: task.id, incomplete: true })
  }
  if (outcome.error) {
    return result("ask", `@${target.agentSlug} could not answer: ${outcome.error}`, {
      taskId: task.id,
      failed: true,
    })
  }
  const text = outcome.text.trim()
  if (text.length === 0) {
    // Silence is a choice the rules give them. Nothing is appended, and the
    // task stays claimed, because nothing was delivered.
    return result("ask", `@${target.agentSlug} chose not to answer.`, { taskId: task.id, silent: true })
  }

  yield* turn.ops
    .append({
      collabId: turn.collabId,
      authorId: target.agentSlug,
      authorKind: "agent",
      kind: "answer",
      text,
      replyToSeq: asked.seq,
      taskId: task.id,
      trace: outcome.trace,
    })
    .pipe(Effect.orDie)
  yield* turn.ops.store.updateTask({
    collabId: turn.collabId,
    taskId: task.id,
    action: "done",
    result: text,
  })
  return result("ask", text, { taskId: task.id, from: target.agentSlug })
})

const handoffTool = Tool.define(
  "handoff",
  Effect.succeed({
    description: HANDOFF_DESCRIPTION,
    parameters: HandoffParameters,
    execute: (args: Schema.Schema.Type<typeof HandoffParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        void ctx
        const turn = yield* CollabSystem.Turn
        if (!turn) return refuse("handoff", NO_TURN)

        const target = resolveTarget(turn.roster, args.to)
        if (!target) return refuse("handoff", `There is no "${args.to}" in this collab - ${rosterHint(turn.roster)}.`)
        if (target.agentSlug === turn.agentSlug) {
          return refuse("handoff", "You cannot hand the work to yourself. Carry on, or end your turn with done.")
        }
        if (spent(turn.hops)) {
          return refuse(
            "handoff",
            "The room is out of hops for this message, so nobody can take the baton. Say where you got to and stop.",
          )
        }

        const task = yield* turn.ops.store.addTask({
          collabId: turn.collabId,
          title: boundTitle(args.task.trim()),
          createdBy: turn.agentSlug,
          owner: target.agentSlug,
          state: "claimed",
        })
        const handed = yield* turn.ops
          .append({
            collabId: turn.collabId,
            authorId: turn.agentSlug,
            authorKind: "agent",
            kind: "handoff",
            text: directedText(args),
            mentions: [target.agentSlug],
            taskId: task.id,
          })
          .pipe(Effect.orDie)
        yield* turn.ops.store.setTaskOrigin(turn.collabId, task.id, handed.seq)
        yield* turn.ops.handoff(target.agentSlug)

        // The baton is gone, so this turn has nothing left to do. The loop
        // reads this after the step that ran the tool.
        turn.stop.requested = true
        turn.stop.kind = "handoff"
        turn.stop.summary = ""
        return result("handoff", `Handed to @${target.agentSlug} - your turn ends here.`, { taskId: task.id })
      }),
  }),
)

const doneTool = Tool.define(
  "done",
  Effect.succeed({
    description: DONE_DESCRIPTION,
    parameters: DoneParameters,
    execute: (args: Schema.Schema.Type<typeof DoneParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        void ctx
        const turn = yield* CollabSystem.Turn
        if (!turn) return refuse("done", NO_TURN)
        const summary = args.summary?.trim() ?? ""
        turn.stop.requested = true
        turn.stop.kind = "done"
        turn.stop.summary = summary
        return result("done", summary.length > 0 ? "Turn ended - your summary goes to the room." : "Turn ended.", {
          silent: summary.length === 0,
        })
      }),
  }),
)

const CouncilAskParameters = Schema.Struct({
  question: Schema.String.annotate({
    description:
      "ONE question to put back to the whole council. Every member answers it independently, without seeing the others, and you get their answers to reconcile in the next round. Ask it only when the council's answers left something genuinely undecided, and make it self-contained: they see the room, never your reasoning.",
  }),
})

const COUNCIL_ASK_DESCRIPTION = [
  "Put ONE follow-up question to the whole council after reconciling a round.",
  "Every active member answers it independently and blind, then you reconcile again.",
  "It costs the room one round of its budget, so use it when the answers disagreed on something the question turns on - not to tidy up wording.",
].join(" ")

/**
 * The synthesizer's follow-up: a NEW blind round, opened mechanically.
 *
 * A tool rather than a phrase the runner looks for in the synthesis text,
 * because routing in this room reads a message's KIND and never its prose - a
 * synthesis that happened to end in a question mark must not summon the council.
 *
 * Refused outside a SYNTHESIS turn, which is narrower than "in a council": a
 * question asked from inside a blind opinion would open a round nested in the
 * round still being answered, and the member asking it would be the only one
 * who had seen anything.
 */
const councilAskTool = Tool.define(
  "council_ask",
  Effect.succeed({
    description: COUNCIL_ASK_DESCRIPTION,
    parameters: CouncilAskParameters,
    execute: (args: Schema.Schema.Type<typeof CouncilAskParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        void ctx
        const turn = yield* CollabSystem.Turn
        if (!turn) return refuse("council_ask", NO_TURN)
        if (turn.council?.phase !== "synthesis") {
          return refuse(
            "council_ask",
            turn.council === undefined
              ? "This room is not deliberating as a council. Use `ask` to put a question to one agent."
              : "Only the turn that reconciles a round may put a follow-up to the council. Answer the question you were asked; the synthesis decides whether another round is needed.",
          )
        }
        const question = args.question.trim()
        if (question.length === 0) return refuse("council_ask", "A follow-up needs a question.")
        if (spent(turn.hops)) {
          return refuse(
            "council_ask",
            "This room's turn budget is spent, so another round cannot be opened. State what the council has decided so far and stop.",
          )
        }
        // Addressed to nobody in particular ON PURPOSE: the wake rules send a
        // `council_question` to every active member except its author, so
        // naming them here would be a second, quieter roster to keep in step.
        yield* turn.ops
          .append({
            collabId: turn.collabId,
            authorId: turn.agentSlug,
            authorKind: "agent",
            kind: "council_question",
            text: question,
          })
          .pipe(Effect.orDie)
        return result("council_ask", "Put to the council. Their answers arrive as the next round.", {
          question,
        })
      }),
  }),
)

/** The board move each tool makes, and the room row it leaves behind. */
const BOARD: Record<"add" | CollabStore.TaskAction, { kind: CollabStore.MessageKind; verb: string }> = {
  add: { kind: "task_open", verb: "opened" },
  claim: { kind: "task_claim", verb: "claimed" },
  done: { kind: "task_done", verb: "completed" },
  accept: { kind: "task_accept", verb: "accepted" },
  reopen: { kind: "task_reopen", verb: "reopened" },
}

/**
 * The row one board move leaves in the room.
 *
 * The row carries the NOTE when the move has one - the same text
 * `ACPCollab.applyTaskMove` writes for the human's own reject, and for the same
 * reason: the agent this wakes otherwise reads "reopened task: X" and learns
 * only that somebody was unhappy, not what has to change. Only `reopen` carries
 * one today, and a move without one is byte-identical to before.
 */
const record = Effect.fnUntraced(function* (
  turn: CollabSystem.TurnContext,
  move: "add" | CollabStore.TaskAction,
  task: CollabStore.Task,
  note?: string,
) {
  const entry = BOARD[move]
  yield* turn.ops
    .append({
      collabId: turn.collabId,
      authorId: turn.agentSlug,
      authorKind: "agent",
      kind: entry.kind,
      text: `${entry.verb} task: ${task.title}${note ? ` — ${note}` : ""}`,
      taskId: task.id,
    })
    .pipe(Effect.orDie)
})

/** The task a board tool named, or the refusal to hand back instead. */
const load = Effect.fnUntraced(function* (turn: CollabSystem.TurnContext, tool: string, taskId: string) {
  const task = yield* turn.ops.store.getTask(turn.collabId, taskId)
  if (!task) return { refusal: refuse(tool, `There is no task ${taskId} on this board.`) }
  return { task }
})

const taskAddTool = Tool.define(
  "task_add",
  Effect.succeed({
    description: "Put one open task on the collab's board. It stays yours to track until someone claims it.",
    parameters: TaskAddParameters,
    execute: (args: Schema.Schema.Type<typeof TaskAddParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        void ctx
        const turn = yield* CollabSystem.Turn
        if (!turn) return refuse("task_add", NO_TURN)
        const title = args.title.trim()
        if (title.length === 0) return refuse("task_add", "A task needs a title.")
        const task = yield* turn.ops.store.addTask({
          collabId: turn.collabId,
          title,
          createdBy: turn.agentSlug,
        })
        yield* record(turn, "add", task)
        return result("task_add", `Task ${task.id} opened: ${title}`, { taskId: task.id })
      }),
  }),
)

const taskClaimTool = Tool.define(
  "task_claim",
  Effect.succeed({
    description: "Take an open task off the board. Claim it before you start, so nobody does it twice.",
    parameters: TaskIdParameters,
    execute: (args: Schema.Schema.Type<typeof TaskIdParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        void ctx
        const turn = yield* CollabSystem.Turn
        if (!turn) return refuse("task_claim", NO_TURN)
        const found = yield* load(turn, "task_claim", args.taskId)
        if (found.refusal) return found.refusal
        const input = { collabId: turn.collabId, taskId: args.taskId, action: "claim" as const, owner: turn.agentSlug }
        const refusal = CollabStore.taskRefusal(found.task, input)
        if (refusal) return refuse("task_claim", refusal)
        const task = yield* turn.ops.store.updateTask(input)
        yield* record(turn, "claim", task)
        return result("task_claim", `Task ${task.id} is yours: ${task.title}`, { taskId: task.id })
      }),
  }),
)

const taskDoneTool = Tool.define(
  "task_done",
  Effect.succeed({
    description:
      "Mark a task you own as complete, with what you actually did. Whoever opened it is woken to check your work.",
    parameters: TaskDoneParameters,
    execute: (args: Schema.Schema.Type<typeof TaskDoneParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        void ctx
        const turn = yield* CollabSystem.Turn
        if (!turn) return refuse("task_done", NO_TURN)
        const found = yield* load(turn, "task_done", args.taskId)
        if (found.refusal) return found.refusal
        const input = {
          collabId: turn.collabId,
          taskId: args.taskId,
          action: "done" as const,
          result: args.result.trim(),
        }
        // The state first: an OPEN task has no owner to compare against, and
        // "it belongs to nobody" is a worse answer than "claim it first".
        const refusal = CollabStore.taskRefusal(found.task, input)
        if (refusal) return refuse("task_done", refusal)
        if (found.task.owner !== turn.agentSlug) {
          return refuse(
            "task_done",
            `Task ${args.taskId} belongs to ${found.task.owner ?? "nobody"}, not to you. Only its owner can complete it.`,
          )
        }
        const task = yield* turn.ops.store.updateTask(input)
        // The wake for whoever opened it rides the appended row: the rules read
        // the task off the message, so there is exactly one place it happens.
        yield* record(turn, "done", task)
        return result("task_done", `Task ${task.id} is done: ${task.title}`, { taskId: task.id })
      }),
  }),
)

const taskAcceptTool = Tool.define(
  "task_accept",
  Effect.succeed({
    description:
      "Accept a completed task. Only the agent that opened it may accept it; the lead may also accept the human's tasks.",
    parameters: TaskIdParameters,
    execute: (args: Schema.Schema.Type<typeof TaskIdParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        void ctx
        const turn = yield* CollabSystem.Turn
        if (!turn) return refuse("task_accept", NO_TURN)
        const found = yield* load(turn, "task_accept", args.taskId)
        if (found.refusal) return found.refusal
        const mine = found.task.createdBy === turn.agentSlug
        const humans = found.task.createdBy === "user" && turn.lead === turn.agentSlug
        if (!mine && !humans) {
          return refuse(
            "task_accept",
            `Task ${args.taskId} was opened by ${found.task.createdBy}. Accepting someone else's task is theirs to do.`,
          )
        }
        const input = { collabId: turn.collabId, taskId: args.taskId, action: "accept" as const }
        const refusal = CollabStore.taskRefusal(found.task, input)
        if (refusal) return refuse("task_accept", refusal)
        const task = yield* turn.ops.store.updateTask(input)
        yield* record(turn, "accept", task)
        return result("task_accept", `Task ${task.id} accepted: ${task.title}`, { taskId: task.id })
      }),
  }),
)

const taskReopenTool = Tool.define(
  "task_reopen",
  Effect.succeed({
    description: "Send a completed task back to the same owner, with a note saying what has to change.",
    parameters: TaskReopenParameters,
    execute: (args: Schema.Schema.Type<typeof TaskReopenParameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        void ctx
        const turn = yield* CollabSystem.Turn
        if (!turn) return refuse("task_reopen", NO_TURN)
        const found = yield* load(turn, "task_reopen", args.taskId)
        if (found.refusal) return found.refusal
        const input = {
          collabId: turn.collabId,
          taskId: args.taskId,
          action: "reopen" as const,
          note: args.note.trim(),
        }
        const refusal = CollabStore.taskRefusal(found.task, input)
        if (refusal) return refuse("task_reopen", refusal)
        const task = yield* turn.ops.store.updateTask(input)
        yield* record(turn, "reopen", task, input.note)
        return result("task_reopen", `Task ${task.id} is back with @${task.owner}: ${task.title}`, { taskId: task.id })
      }),
  }),
)

/**
 * The nine tools, built fresh for the step that will run them.
 *
 * Fresh matters for one reason: the `ask` memo is keyed by tool call id and is
 * only there to survive a PROVIDER RETRY of the step it belongs to. Held any
 * longer it would be a cache of answers across turns.
 */
export const defs = Effect.gen(function* () {
  const memo = new Map<string, Result>()
  const built: Tool.Def[] = [
    yield* Tool.init(yield* askTool(memo)),
    yield* Tool.init(yield* handoffTool),
    yield* Tool.init(yield* doneTool),
    yield* Tool.init(yield* taskAddTool),
    yield* Tool.init(yield* taskClaimTool),
    yield* Tool.init(yield* taskDoneTool),
    yield* Tool.init(yield* taskAcceptTool),
    yield* Tool.init(yield* taskReopenTool),
    yield* Tool.init(yield* councilAskTool),
  ]
  return built
})

export * as FlockTools from "./flock-tools"

import path from "path"
import { SessionV1 } from "@origami/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { FSUtil } from "@origami/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionPromptCapture } from "./prompt-capture"
import { renderTodoList } from "./command-todos"
import type { Todo } from "./todo"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import DEEP_PLAN_MODE from "./prompt/deep-plan-mode.txt"
import DEEP_PLAN_SWITCH from "./prompt/deep-plan-switch.txt"
import { ShellID } from "@/tool/shell/id"
import { TaskListID } from "@/tool/task_list"

/**
 * The planning agents, and what each is told on the way out to build. Being in
 * this table is what makes an agent a planning agent: `planningAgent` below is
 * the type guard over its keys.
 *
 * The switch prompts are deliberately opposites - plan mode's says "you may
 * edit now, execute the plan", deep plan's says do not begin, because approving
 * a deep plan delivers the folder rather than commissioning the work. Sharing
 * one text here would silently turn the second product into the first.
 */
const PLANNING_REGIME = {
  plan: { switchPrompt: BUILD_SWITCH },
  "deep-plan": { switchPrompt: DEEP_PLAN_SWITCH },
} as const

type PlanningAgent = keyof typeof PLANNING_REGIME

function planningAgent(name: string | undefined): name is PlanningAgent {
  return name !== undefined && name in PLANNING_REGIME
}

/** Written into the shell tool's output when it had to kill a command on timeout. */
const SHELL_TIMEOUT_MARKER = "shell tool terminated command after exceeding timeout"
/** A command whose only purpose is to wait: `sleep 5`, `Start-Sleep`, `timeout /t 5`, `ping -n 5`, `watch ...`. */
const WAIT_COMMAND = /(?:^|[;&|]\s*|\(\s*)(?:sleep\b|start-sleep\b|timeout\s+\/t\b|ping\s+-n\b|watch\b)/i
/** Consecutive waiting calls before the reminder fires, and the interval it repeats on. */
const WAIT_LOOP_STREAK = 3

type ToolCall = {
  tool: string
  completed: boolean
  command?: string
  output: string
}

function normalizeCommand(value: unknown) {
  if (typeof value !== "string") return undefined
  const text = value.trim().replace(/\s+/g, " ").toLowerCase()
  return text.length > 0 ? text : undefined
}

/** Every tool call in the run, oldest first. Non-tool parts are transparent. */
function toolCalls(messages: readonly SessionV1.WithParts[]) {
  const out: ToolCall[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") {
        out.push({ tool: part.tool, completed: false, output: "" })
        continue
      }
      out.push({
        tool: part.tool,
        completed: true,
        command: normalizeCommand(part.state.input.command),
        output: part.state.output,
      })
    }
  }
  return out
}

/**
 * Length of the trailing run of completed shell calls that only wait: an
 * explicit sleep/poll, a repeat of the shell call before it, or a command the
 * shell tool had to kill on timeout. Any other tool call ends the run, so real
 * work between two waits is not counted as a loop.
 */
function waitStreak(calls: readonly ToolCall[]) {
  let streak = 0
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]!
    if (call.tool !== ShellID.ToolID || !call.completed) break
    const previous = calls[index - 1]
    const repeated =
      previous?.tool === ShellID.ToolID && previous.command !== undefined && previous.command === call.command
    const waiting =
      repeated ||
      call.output.includes(SHELL_TIMEOUT_MARKER) ||
      (call.command !== undefined && WAIT_COMMAND.test(call.command))
    if (!waiting) break
    streak++
  }
  return streak
}

/**
 * Length of the trailing run of completed `task_list` calls. Kept apart from
 * `waitStreak`: a shell wait needs evidence that it was a wait, `task_list` is
 * a poll by shape, and the two have different ways out.
 */
function taskPollStreak(calls: readonly ToolCall[]) {
  let streak = 0
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]!
    if (call.tool !== TaskListID || !call.completed) break
    streak++
  }
  return streak
}

/** The tool every reminder in this file is about. */
const TODO_TOOL = "todowrite"

/**
 * May this session call `todowrite` at all?
 *
 * t-di2u7z. Every todo text below tells the model to use the tool, and a
 * SUB-AGENT usually cannot: `agent/subagent-permissions.ts` denies `todowrite`
 * to any child whose own definition does not name it, and the native `general`
 * agent denies it outright. A `general` child several tool calls into its work
 * was therefore told "Write one now with todowrite" about a tool that is not in
 * its tool list - it spent a turn searching the deferred catalog for it and
 * reported the engine as broken (UAT export 2026-09-14).
 *
 * The cage is read exactly as `session/tools.ts` builds it - the agent's rules
 * first, the session row last, `Permission.disabled` for the verdict - so "the
 * reminder fires" and "the tool is offered" cannot disagree. Tolerant of a
 * missing ruleset: an agent or session with none denies nothing.
 */
function canTodo(agent: Agent.Info, session: Session.Info) {
  const cage = Permission.merge(agent.permission ?? [], session.permission ?? [])
  return !Permission.disabled([TODO_TOOL], cage).has(TODO_TOOL)
}

export const TODO_REMINDER_HEAD = "Your todo list for this session (kept with the session, not in this transcript):"

/**
 * One sentence, because this text rides every todo reminder. The list above is
 * rendered with indentation and nothing else, so a model that rebuilds it from
 * this block copies the words and drops the `depth` field that produced the
 * indent - flattening the tree with its own next write.
 */
const TODO_REMINDER_NESTING =
  "Indented items are nested sub-tasks: when you rewrite this list, send each item's `depth` again (0 = top level)."

/**
 * The todo list the model can still see, or `undefined` when the window has
 * none. The tool input is the right source, not the output: pruning clears an
 * old output while leaving the input intact, so a pruned-but-present call still
 * shows the model its list.
 */
function visibleTodos(messages: readonly SessionV1.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const parts = messages[index]!.parts
    for (let part = parts.length - 1; part >= 0; part--) {
      const item = parts[part]!
      if (item.type !== "tool" || item.tool !== TODO_TOOL) continue
      const todos = (item.state as { input?: { todos?: unknown } }).input?.todos
      return Array.isArray(todos) ? (todos as Todo.Info[]) : []
    }
  }
  return undefined
}

/**
 * The stored list, handed back to a model that can no longer see it. Compaction
 * drops every `todowrite` call in the head and the summary has no todo section,
 * so survival would otherwise be left to a paraphrase. Injected only when the
 * model's view is missing or stale, so an ordinary turn pays nothing.
 */
function todoReminder(input: { messages: readonly SessionV1.WithParts[]; todos: readonly Todo.Info[] }) {
  if (input.todos.length === 0) return undefined
  const stored = renderTodoList(input.todos)
  const visible = visibleTodos(input.messages)
  if (visible && renderTodoList(visible) === stored) return undefined
  return `<system-reminder>\n${TODO_REMINDER_HEAD}\n${stored}\nKeep it current with todowrite.\n${TODO_REMINDER_NESTING}\n</system-reminder>`
}

/**
 * What counts as the user speaking, deliberately the coarse `info.role ===
 * "user"`. A finished background sub-agent persists a real user message whose
 * one part is synthetic, and that counts: it is a new instruction arriving
 * mid-session. Returns -1 for a window with no user message.
 */
function newestUserIndex(messages: readonly SessionV1.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.info.role === "user") return index
  }
  return -1
}

/**
 * The current user turn: every message after the newest user message. Empty on
 * the first step of a turn, and that is the signal both nudges below read -
 * `apply` runs before that step's assistant message is created.
 */
function currentTurn(messages: readonly SessionV1.WithParts[]) {
  const index = newestUserIndex(messages)
  return index === -1 ? [] : messages.slice(index + 1)
}

/**
 * The previous assistant turn. `undefined` when the newest user message is the
 * first of the session - there is no write the model can have skipped, so the
 * reconcile nudge below has nothing true to say.
 */
function previousTurn(messages: readonly SessionV1.WithParts[]) {
  const newest = newestUserIndex(messages)
  if (newest <= 0) return undefined
  const previous = newestUserIndex(messages.slice(0, newest))
  if (previous === -1) return undefined
  return messages.slice(previous + 1, newest)
}

/**
 * Said once, at the top of a turn, to a model that left its list where it was.
 * The opposite failure to the todo reminder above: the list is in the window,
 * with work still open in it, and the whole last turn went by without a write.
 */
export const TODO_RECONCILE_NUDGE =
  "Before you continue: your todo list still has open items and you did not update it in your previous turn. " +
  "Check whether any are done, stale, or need new sub-steps, update the list with todowrite, then resume with the user's request."

/**
 * Said to a model several tool calls into a task with no list at all - every
 * other todo reminder is gated on the stored list existing, so a session that
 * never wrote one would get nothing, forever. Depth of work is the only
 * evidence that this was not a single-step request, hence the escape hatch.
 */
export const TODO_CREATION_NUDGE =
  "No todo list exists for this session and you are several tool calls into this task. " +
  "Write one now with todowrite (waves at the top level, steps beneath), or continue only if this work is genuinely single-step."

/** Completed non-`todowrite` calls in one turn before the creation nudge fires. */
const TODO_CREATION_CALLS = 4

/** Statuses that mean the item will not be worked again, so it is not open work
 *  and cannot earn the nudge below. Deliberately the same three `TERMINAL`
 *  names as packages/core/src/session/todo-reconcile.ts: a `failed` item that
 *  held its parent closed there must not count as open here. */
const TODO_CLOSED = new Set(["completed", "cancelled", "failed"])

/**
 * Fires when all three hold: the stored list has open work; this is the first
 * step of the current turn; and the previous turn wrote no list. The previous
 * turn is the span to read, not the current one - on step 1 the current turn is
 * empty by definition, so the claim and the check would not name the same span.
 * A completed call, because a `todowrite` that never returned wrote nothing.
 */
function reconcileNudge(input: { messages: readonly SessionV1.WithParts[]; todos: readonly Todo.Info[] }) {
  if (!input.todos.some((todo) => !TODO_CLOSED.has(todo.status))) return undefined
  const turn = currentTurn(input.messages)
  if (turn.some((message) => message.info.role === "assistant" && message.parts.length > 0)) return undefined
  const previous = previousTurn(input.messages)
  if (!previous) return undefined
  if (toolCalls(previous).some((call) => call.tool === TODO_TOOL && call.completed)) return undefined
  return TODO_RECONCILE_NUDGE
}

/**
 * Fires when the session has NO stored list and the turn is already several
 * completed tool calls deep. Stops the moment a `todowrite` call appears in the
 * turn, finished or not: the model is answering, and repeating the ask while it
 * writes would only be noise.
 */
function creationNudge(input: { messages: readonly SessionV1.WithParts[]; todos: readonly Todo.Info[] }) {
  if (input.todos.length > 0) return undefined
  const calls = toolCalls(currentTurn(input.messages))
  if (calls.some((call) => call.tool === TODO_TOOL)) return undefined
  const worked = calls.filter((call) => call.completed).length
  if (worked < TODO_CREATION_CALLS) return undefined
  return TODO_CREATION_NUDGE
}

function waitLoopReminder(count: number) {
  return [
    `You have made ${count} blocking shell calls in a row that only wait: a sleep, a poll, a repeat of the call before it, or a command the shell tool had to kill on timeout.`,
    `This burns context and finishes nothing.`,
    `Do one of these now instead of waiting again: run the command ONCE with a timeout sized to how long it really takes;`,
    `or start it as a background task with the task tool and carry on with other work;`,
    `or tell the user what you are waiting for and hand back to them.`,
  ].join(" ")
}

/**
 * Said to a model watching a background task by re-listing it. Deliberately not
 * the tool description again: what this can add is the mechanism - results are
 * pushed, so the next snapshot can only repeat this one.
 */
function taskPollReminder(count: number) {
  return [
    `You have called task_list ${count} times in a row with no other work between the calls.`,
    `Looking does not move a running task along, and the next snapshot will say what this one said.`,
    // origami_change (t-41dz9f): true of background SHELL jobs too now, and
    // said out loud - this sentence was written for sub-agents and a model
    // reading it about a background command was being misinformed.
    `You do not have to watch for the result: when a background task or command settles the engine writes its output into this conversation by itself -`,
    `mid-turn it reaches you at your next tool call, and if your turn has ended it starts a new one.`,
    `Do one of these now instead of listing again: carry on with work that does not touch the running task's files or topic;`,
    `or hand back to the user now and answer the result when it arrives;`,
    `or, if you no longer want the task, cancel it with task_stop.`,
  ].join(" ")
}

/**
 * What one model step's reminders come to. The split into two channels is
 * load-bearing.
 *
 * `messages` is the window: the plan-mode briefs below reach it through
 * `sessions.updatePart`, which persists them, so they hold still.
 *
 * `reminders` is text computed fresh on every step from live state and never
 * written to any stored message. It must NOT be pushed onto the last user
 * message: a prefix cache is an exact match from byte 0, and the last user
 * message is the head of a sub-agent's conversation, so a reminder whose text
 * changed between two steps - or that fired on one step and not the next -
 * rewrites the head and throws the whole cached body away. The caller delivers
 * these at the tail instead; see `withTrailingInjections` in session/prompt.ts.
 */
export type Applied = {
  readonly messages: SessionV1.WithParts[]
  /** In-memory reminder texts for THIS step, in a fixed order. */
  readonly reminders: readonly string[]
}

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
  /** The session's stored todo list - the durable copy, not whatever survived
   *  in the transcript. Required rather than optional so a caller that forgets
   *  it fails to compile instead of silently dropping the re-injection. */
  todos: readonly Todo.Info[]
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  // Order is fixed by the sequence of pushes below, so two steps with the same
  // live state produce byte-identical text.
  const reminders: string[] = []
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return { messages: input.messages, reminders }

  // Ahead of the plan-mode chain below, which returns early for every agent:
  // a lost todo list is lost whichever agent is running. All three todo texts
  // are gated on this session being ABLE to write one - see `canTodo`.
  if (canTodo(input.agent, input.session)) {
    const todos = todoReminder({ messages: input.messages, todos: input.todos })
    if (todos) reminders.push(todos)

    // Both read only the inputs `apply` already has, so two steps on the same
    // state answer the same bytes - what the trailing lane needs. Mutually
    // exclusive by construction: one wants a list with open work in it, the other
    // wants no list at all.
    for (const nudge of [reconcileNudge, creationNudge]) {
      const text = nudge({ messages: input.messages, todos: input.todos })
      if (text) reminders.push(text)
    }
  }

  const calls = toolCalls(input.messages)
  const fired = (streak: number) => streak > 0 && streak % WAIT_LOOP_STREAK === 0
  for (const [streak, render] of [
    [waitStreak(calls), waitLoopReminder],
    [taskPollStreak(calls), taskPollReminder],
  ] as const) {
    if (!fired(streak)) continue
    reminders.push(render(streak))
  }

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") reminders.push(PROMPT_PLAN)
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") reminders.push(BUILD_SWITCH)
    return { messages: input.messages, reminders }
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  const previous = assistantMessage?.info.agent
  const current = input.agent.name

  // Leaving a planning agent. Each regime says its own thing on the way out,
  // and deep plan's is the opposite of plan's - see PLANNING_REGIME.
  if (!planningAgent(current) && planningAgent(previous)) {
    const ctx = yield* InstanceState.context
    const switchPrompt = PLANNING_REGIME[previous].switchPrompt
    const text =
      previous === "deep-plan"
        ? yield* deepPlanHandover(fsys, switchPrompt, Session.planFolder(input.session, ctx))
        : yield* planHandover(fsys, switchPrompt, Session.plan(input.session, ctx))
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text,
      synthetic: true,
    })
    // origami_change (t-rylleg): a synthetic part pushed into a message
    // already sent rewrites the cached prefix. Named here so the next
    // step-finish reports `divergence.source` rather than "unknown".
    SessionPromptCapture.markRewrite(userMessage.info.sessionID, "reminder")
    userMessage.parts.push(part)
    return { messages: input.messages, reminders }
  }

  // Not planning at all, or already mid-plan in the same agent. Compared
  // against `current` rather than "is planning" so that plan -> deep-plan is an
  // entry, not a continuation.
  if (!planningAgent(current) || previous === current) return { messages: input.messages, reminders }

  const ctx = yield* InstanceState.context
  const text =
    current === "deep-plan"
      ? yield* deepPlanBrief(fsys, Session.planFolder(input.session, ctx))
      : yield* planBrief(fsys, Session.plan(input.session, ctx))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text,
    synthetic: true,
  })
  // origami_change (t-rylleg): see the sibling push above.
  SessionPromptCapture.markRewrite(userMessage.info.sessionID, "reminder")
  userMessage.parts.push(part)
  return { messages: input.messages, reminders }
})

/** Plan mode's entry brief: the one file, and whether it is already there. */
const planBrief = Effect.fn("SessionReminders.planBrief")(function* (fsys: FSUtil.Interface, plan: string) {
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  return PLAN_MODE.replaceAll("${planInfo}", () =>
    exists
      ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
      : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
  )
})

/**
 * Deep plan's entry brief. Both substitutions use `replaceAll` because
 * `${planFolder}` appears more than once and `String.replace` with a string
 * pattern would fill in only the first. The folder itself is not created here,
 * unlike plan mode's parent directory: an empty folder left behind by a mode
 * the user switched straight out of is a plan that never existed, sitting in
 * the plans list looking like one that did.
 */
const deepPlanBrief = Effect.fn("SessionReminders.deepPlanBrief")(function* (fsys: FSUtil.Interface, folder: string) {
  const exists = yield* fsys.existsSafe(folder)
  return DEEP_PLAN_MODE.replaceAll("${planFolder}", () => folder).replaceAll("${planInfo}", () =>
    exists
      ? "That folder already exists. Read what is in it first and continue from there - do not start over."
      : "That folder does not exist yet. Create it by writing your first file into it.",
  )
})

/** Plan -> build: you may edit now, and there is a plan to execute. */
const planHandover = Effect.fn("SessionReminders.planHandover")(function* (
  fsys: FSUtil.Interface,
  switchPrompt: string,
  plan: string,
) {
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) return switchPrompt
  return `${switchPrompt}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
})

/**
 * Deep plan -> build: the folder is delivered. The sentence appended here is
 * deliberately the mirror image of plan mode's "execute on the plan defined
 * within it" - approving a deep plan hands it over, it does not commission it.
 */
const deepPlanHandover = Effect.fn("SessionReminders.deepPlanHandover")(function* (
  fsys: FSUtil.Interface,
  switchPrompt: string,
  folder: string,
) {
  const exists = yield* fsys.existsSafe(folder)
  return exists
    ? `${switchPrompt}\n\nThe delivered deep plan is at ${folder}. Present what is in it and hand back to the user for their decision. Executing it comes after they say so.`
    : switchPrompt
})

export * as SessionReminders from "./reminders"

import path from "path"
import { SessionV1 } from "@origami/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@origami/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
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
 * The PLANNING AGENTS, and what each is told on the way OUT to build.
 *
 * Being in this table is what makes an agent a planning agent: `planningAgent`
 * below is the type guard over its keys, so the mode chain in `apply` cannot
 * recognise one of the two and miss the other.
 *
 * The switch prompts are opposites, and that is the point. Plan mode's says
 * "you may edit now, execute the plan"; deep plan's says do NOT begin, because
 * approving a deep plan DELIVERS the folder rather than commissioning the work.
 * Sharing one text here would silently turn the second product into the first.
 *
 * The ENTRY briefs are not in the table: they are not interchangeable strings.
 * Each needs its own substitution pass (one slot vs two) and its own answer to
 * "should the directory be created up front", so they live in the two `*Brief`
 * functions at the bottom of this file.
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
 * Length of the trailing run of completed `task_list` calls.
 *
 * Kept apart from `waitStreak` rather than folded into it. A shell wait needs
 * evidence that the call was a wait (a sleep, a repeat, a kill on timeout);
 * `task_list` is a poll by shape, there is no working variant of it. The two
 * also have different ways out - resize the timeout vs. let the result arrive -
 * so one counter over a mixed run could only produce a reminder that is wrong
 * about half of what it counted.
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

/** Opening line of the todo reminder. Shared with the tests so "the engine
 *  re-injected the list" has one handle, and so the in-step dedupe below
 *  cannot drift from what it is deduping. */
export const TODO_REMINDER_HEAD = "Your todo list for this session (kept with the session, not in this transcript):"

/**
 * The todo list the model can STILL SEE, read off the newest `todowrite` call
 * left in the window, or `undefined` when the window has none.
 *
 * The tool INPUT is the right source, not the output: pruning replaces an old
 * tool output with "[Old tool result content cleared]" while leaving the input
 * intact, so a pruned-but-present call still shows the model its list.
 */
function visibleTodos(messages: readonly SessionV1.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const parts = messages[index]!.parts
    for (let part = parts.length - 1; part >= 0; part--) {
      const item = parts[part]!
      if (item.type !== "tool" || item.tool !== "todowrite") continue
      const todos = (item.state as { input?: { todos?: unknown } }).input?.todos
      return Array.isArray(todos) ? (todos as Todo.Info[]) : []
    }
  }
  return undefined
}

/**
 * The stored list, handed back to a model that can no longer see it.
 *
 * Compaction rebuilds the window as [compaction-user, summary, tail...], so
 * every `todowrite` call in the dropped head goes with it - and the summary
 * template has no todo section, so whether the list survives is left to a
 * paraphrase. The list itself is durable (its own table, keyed by session), so
 * re-state it rather than hope. Injected ONLY when the model's view is missing
 * or stale, so an ordinary turn - where its own todowrite call is still in the
 * window - pays nothing.
 */
function todoReminder(input: { messages: readonly SessionV1.WithParts[]; todos: readonly Todo.Info[] }) {
  if (input.todos.length === 0) return undefined
  const stored = renderTodoList(input.todos)
  const visible = visibleTodos(input.messages)
  if (visible && renderTodoList(visible) === stored) return undefined
  return `<system-reminder>\n${TODO_REMINDER_HEAD}\n${stored}\nKeep it current with todowrite.\n</system-reminder>`
}

function waitLoopReminder(count: number) {
  return [
    `You have made ${count} blocking shell calls in a row that only wait: a sleep, a poll, a repeat of the call before it, or a command the shell tool had to kill on timeout.`,
    `This burns context and finishes nothing.`,
    `Do one of these now instead of waiting again: run the command ONCE with a timeout sized to how long it really takes;`,
    `or start it as a background task with the task tool and carry on with other work;`,
    `or stop and tell the user what you are waiting for.`,
  ].join(" ")
}

/**
 * Said to a model watching a background task by re-listing it.
 *
 * Deliberately NOT the tool description again - the description already says
 * "do not call this repeatedly" in three places and the behaviour this fires on
 * is a model that read all three and polled anyway. What it can add is the
 * mechanism: results are PUSHED, so the next snapshot can only repeat this one.
 */
function taskPollReminder(count: number) {
  return [
    `You have called task_list ${count} times in a row with no other work between the calls.`,
    `Looking does not move a running task along, and the next snapshot will say what this one said.`,
    `You do not have to watch for the result: when a task settles the engine writes its full output into this conversation as a <task_result> message by itself -`,
    `mid-turn it reaches you at your next tool call, and if your turn has ended it starts a new one.`,
    `Do one of these now instead of listing again: carry on with work that does not touch the running task's files or topic;`,
    `or end your turn and answer the result when it arrives;`,
    `or, if you no longer want the task, cancel it with task_stop.`,
  ].join(" ")
}

/**
 * What one model step's reminders come to.
 *
 * TWO CHANNELS, AND THE SPLIT IS LOAD-BEARING.
 *
 * `messages` is the window. The plan-mode briefs below reach it through
 * `sessions.updatePart`, which PERSISTS them: they are injected once on entry
 * and the transcript carries them from there, so they are part of the
 * conversation and hold still.
 *
 * `reminders` is the other kind - text computed FRESH on every step from live
 * state (the stored todo list, a wait streak) and never written to any stored
 * message. That text used to be pushed onto the last user message in memory,
 * and it is the reason this type exists. A prefix cache is an exact match from
 * byte 0, and the last user message is the HEAD of a sub-agent's conversation
 * (one user message for its whole life), so a reminder whose text changed
 * between two steps - or that fired on one step and not the next - rewrote the
 * head and threw the whole cached body away. Measured on the fake provider: a
 * `task_list` poll loop rewrote the head on 4 of 8 requests, because
 * `WAIT_LOOP_STREAK` fires at 3 and 6 and is silent at 4 and 5.
 *
 * So the caller delivers these at the TAIL of the request instead, beside the
 * memory index and for the same reason - see `withTrailingInjections` in
 * session/prompt.ts. They stay in-memory-only, exactly as before.
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
  /** The session's STORED todo list - the durable copy, not whatever survived
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
  // a lost todo list is lost whichever agent is running.
  const todos = todoReminder({ messages: input.messages, todos: input.todos })
  if (todos) reminders.push(todos)

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

  // LEAVING a planning agent. Each regime says its own thing on the way out,
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
    userMessage.parts.push(part)
    return { messages: input.messages, reminders }
  }

  // Not planning at all, or already mid-plan in the SAME agent - the mode prompt
  // is persisted through `updatePart`, so it is injected once on entry and the
  // transcript carries it from there. Compared against `current` rather than
  // "is planning" so that plan -> deep-plan is an ENTRY, not a continuation.
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
  userMessage.parts.push(part)
  return { messages: input.messages, reminders }
})

/** Plan mode's entry brief: the ONE file, and whether it is already there. */
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
 * Deep plan's entry brief. TWO substitutions, not one: `${planFolder}` is the
 * path and it is named all through the prompt (the folder shape, the write
 * boundary), while `${planInfo}` is the one sentence about its state. Both are
 * `replaceAll` - `${planFolder}` appears more than once, and `String.replace`
 * with a string pattern would have filled in only the first.
 *
 * The folder itself is NOT created here, unlike plan mode's parent directory:
 * the agent writes the first file into it and `writeWithDirs` makes the tree.
 * An empty folder left behind by a mode the user immediately switched out of is
 * a plan that never existed, sitting in the plans list looking like one that did.
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
 * Deep plan -> build: the folder is DELIVERED. The sentence appended here is the
 * mirror image of plan mode's "you should execute on the plan defined within
 * it", and deliberately so - approving a deep plan hands it over, it does not
 * commission the work.
 */
const deepPlanHandover = Effect.fn("SessionReminders.deepPlanHandover")(function* (
  fsys: FSUtil.Interface,
  switchPrompt: string,
  folder: string,
) {
  const exists = yield* fsys.existsSafe(folder)
  return exists
    ? `${switchPrompt}\n\nThe delivered deep plan is at ${folder}. Present what is in it and stop. Do NOT begin executing it.`
    : switchPrompt
})

export * as SessionReminders from "./reminders"

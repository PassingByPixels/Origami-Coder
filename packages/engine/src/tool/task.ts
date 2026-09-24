import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@origami/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SubagentDepth } from "@/session/subagent-depth"
import {
  claimDrainer,
  dropResults,
  enqueueResult,
  injectLock,
  peekResults,
  releaseDrainer,
  requeueResults,
  taskResultsMetadata,
  taskTokensFromRow,
  taskTokensMetadata,
  type PendingResult,
  type TaskTokens,
} from "@/session/task-result"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Permission } from "@/permission"
import { FlockHealth } from "@/flock/health"
import { FlockRouting } from "@/flock/routing"
import { Provider } from "@/provider/provider"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { isRecord } from "@/util/record"
import { Cause, Effect, Exit, Option, Schedule, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RunStats } from "@/acp/run-stats"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@origami/core/database/database"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
  /** Whether a prompt would start work of its own or merely join the run
   *  already in flight. A caller that needs its OWN answer asks before it
   *  prompts. */
  busy(sessionID: SessionID): Effect.Effect<boolean>
}

const id = "task"
// Background is the default and foreground the exception the model justifies:
// foreground blocks the parent TURN, and the engine rejects a prompt to a busy
// session, so the user cannot interject at all.
const BACKGROUND_DESCRIPTION = [
  "Background mode: tasks run in the background by DEFAULT. Leave `background` unset and the subagent",
  "starts asynchronously, this call returns at once, and its result arrives on its own as a new turn -",
  "you do not have to wait for it, poll it, or ask it for status.",
  "Pass background=false ONLY when your VERY NEXT step needs the result inline. That is the expensive",
  "choice: a foreground task freezes this conversation until it returns, and the user cannot say",
  "anything to you while it does. Wanting the answer eventually is not a reason - only needing it in",
  "your next step is.",
  "Parallel subagents MUST NOT write the same files: give each a disjoint set of paths,",
  "or run them in sequence. Concurrent edits to one file are the failure mode that actually bites.",
].join(" ")
// State the no-poll rule without telling the model to end its response: a
// launch that ends the turn costs a parent one turn per job it starts.
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "If it becomes unnecessary or goes wrong, cancel it with the task_stop tool using this task's id; use task_list to see what is still running.",
  "Keep working on non-overlapping tasks while it runs, or briefly tell the user what you launched; do not poll it.",
  // Launch is the moment the id is in front of the model, so the resume path
  // (task.txt point 6) is named here or a four-step exchange becomes four
  // agents, each re-deriving what the last one knew.
  "To send this task more information, answer a question it asks, or have it carry on, call the task tool again with task_id set to this task's id (the `id` on the task tag above).",
  "That RESUMES this same agent with everything it has already read and worked out; launching a new task instead throws all of it away.",
].join("\n")
// t-dcl8fe. A resume whose job had ALREADY settled cannot be extended, so the
// tool starts a fresh job on the same child session. The parent asked to
// continue something, and "Background task started" let it believe the agent
// was still mid-thought - it was not, and anything the parent expected to be
// in flight is finished and reported. Say so, and say what DID survive.
const BACKGROUND_RESTARTED = [
  "This task had already finished, so it was STARTED AGAIN rather than resumed: the agent still has every message,",
  "file and tool output from before, but nothing it was doing is still in flight.",
].join(" ")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Keep working on non-overlapping tasks while it runs, or briefly tell the user what you sent; do not poll it.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "The id of a previous task, to CONTINUE that same subagent session instead of creating a fresh one. It keeps every message, file and tool output from before, so pass only what is new. Use this whenever you are answering an agent's question or asking it to carry on — a multi-step exchange is one resumed task, not several new ones.",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Defaults to true: the agent runs in the background and you are notified when it completes. DO NOT sleep, poll, or proactively check on its progress. Set false only when your very next step needs the result inline, which blocks this conversation until the agent finishes",
  }),
})

// One line, and only on a SETTLED task: `running` carries its own briefing
// (BACKGROUND_STARTED / BACKGROUND_UPDATED) and a "resume" line there would
// read as "it is finished".
function resumeLine(sessionID: SessionID) {
  return `Resume this task with task_id=${sessionID}; do not launch a replacement.`
}

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    ...(input.state === "running" ? [] : [resumeLine(input.sessionID)]),
    "</task>",
  ].join("\n")
}

/** A `task_id` that cannot be resumed, in words the model can act on. The id is
 *  a CLAIM - "continue the agent that has already read the file" - and creating
 *  a fresh child instead leaves the model believing it talks to an agent that
 *  knows things. A bad claim is refused, and the refusal names which check
 *  failed: the tool result is the only place the model finds out. */
export class TaskResumeError extends Schema.TaggedErrorClass<TaskResumeError>()("TaskResumeError", {
  taskID: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

/** Raised when neither write landed a batch, so the retry ladder can see it. */
class UndeliveredBatch extends Schema.TaggedErrorClass<UndeliveredBatch>()("TaskResultUndelivered", {
  cause: Schema.String,
}) {}

// A batch that neither write could land is retried before the drainer stands
// down, because the failure is usually momentary and "wait for the next
// sibling" is no plan when this batch is the LAST one. Bounded on purpose:
// after this the result stays QUEUED and the log says so.
const DELIVERY_RETRIES = 2 // three attempts in total
const DELIVERY_RETRY = Schedule.spaced("200 millis").pipe(Schedule.both(Schedule.recurs(DELIVERY_RETRIES)))

// How the drainer waits out a parent turn it wrote into. `busy` is the one
// liveness fact the tool is handed, so it is polled rather than subscribed to.
// Bounded: a parent still busy a minute after the write has taken many steps
// since, and every step re-reads its window.
const IDLE_POLL_INTERVAL = "250 millis"
const IDLE_POLL_LIMIT = 240

/**
 * t-d935qk. How long ONE sub-agent job may run before the registry stops it.
 *
 * The registry's own default is thirty minutes (BackgroundJob.DEFAULT_MAX_DURATION_MS),
 * chosen for a build or a test run, and nothing on this path ever passed a
 * ceiling of its own - so a review agent reading a repository was cut off
 * mid-investigation and the resume after it burned the cache. Four hours is
 * longer than any sub-agent turn observed and still short enough that a wedged
 * child is a nuisance rather than a permanent one. ORIGAMI_SUBAGENT_MAX_MS
 * overrides it; time the child spends waiting on a permission ask does not
 * count against it (see `blockedMs` at the start call).
 */
const DEFAULT_SUBAGENT_MAX_DURATION_MS = 4 * 60 * 60 * 1_000

/**
 * How each recorded cancel reason reads to the parent's model.
 *
 * t-di2u7z. `cancelled` alone used to render as "stopped by the parent" for
 * every canceller, and the commonest canceller is not the parent: pressing stop
 * on the parent's chat runs `SessionRunState.cancel`, whose `cancelTree`
 * (core/background-job.ts) takes every foreground child with it. The parent had
 * decided nothing, so the one line the user saw named the wrong actor.
 */
const CANCEL_SENTENCE: Record<BackgroundJob.CancelReason, string> = {
  task_stop: "stopped by the parent",
  parent_turn_stopped: "stopped because the parent's turn was stopped",
  ancestor_expired: "stopped: a parent task hit its time limit",
  session_removed: "stopped because the parent session was deleted",
  // t-q910fo. The drawer's per-row Stop. The parent turn is still running and
  // reads this sentence as the child's result, so it must name the USER - the
  // parent asked for nothing and the sibling rows are untouched.
  user_stop: "stopped by the user",
}

function cancelReason(info: BackgroundJob.Info): BackgroundJob.CancelReason | undefined {
  const raw = info.metadata?.[BackgroundJob.CANCEL_REASON_KEY]
  // `Object.hasOwn`, not `in`: a plain object answers `in` for "toString" too.
  return typeof raw === "string" && Object.hasOwn(CANCEL_SENTENCE, raw) ? (raw as BackgroundJob.CancelReason) : undefined
}

/**
 * The sentence for a job the registry stopped, or undefined when it ended for a
 * reason of its own.
 *
 * WHY IT IS BUILT FROM METADATA: the visible text used to be whatever error the
 * child's interrupted turn happened to leave behind - a bare
 * `MessageAbortedError: Aborted` card that says nothing about who stopped it or
 * why. The registry records the ceiling that fired and the elapsed wall clock
 * as NUMBERS (BackgroundJob `expire`), so the cause is read back rather than
 * parsed out of an error string.
 */
export function stopped(info: BackgroundJob.Info) {
  // A cancel that named no reason keeps the old sentence: an unknown canceller
  // is not evidence of any particular one.
  if (info.status === "cancelled") {
    const reason = cancelReason(info)
    return reason ? CANCEL_SENTENCE[reason] : "stopped by the parent"
  }
  if (info.metadata?.["expired"] !== true) return undefined
  const ceiling = info.metadata["max_duration_ms"]
  const elapsed = info.metadata["elapsed_ms"]
  if (typeof ceiling !== "number" || typeof elapsed !== "number") return "stopped: sub-agent time limit reached"
  return `stopped: ${BackgroundJob.formatDuration(ceiling)} sub-agent time limit reached after ${BackgroundJob.formatDuration(elapsed)}`
}

// A notification saying only "a task finished" makes the model declare the
// whole batch complete every time, so the count of siblings still running
// rides with it.
function outstandingNote(count: number) {
  return [
    `${count} background task${count === 1 ? "" : "s"} launched from this session`,
    `${count === 1 ? "is" : "are"} still running.`,
    "Do not report overall completion or summarise the batch until every one has reported back.",
    // origami_change: a session with no todo list gets no reminder at all
    // (reminders.ts fires only when todos exist), and this is the one moment
    // the gap is knowable.
    "Track the batch with todowrite and keep it current as tasks report back — the user follows progress there, not in your prose.",
  ].join(" ")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const flock = yield* FlockRouting.Service
    const provider = yield* Provider.Service
    const permission = yield* Permission.Service
    const subagentCeiling = flags.subagentMaxDurationMs ?? DEFAULT_SUBAGENT_MAX_DURATION_MS

    /** The model this subagent session is routed to, or undefined to fall
     *  through to the ordinary resolution. Candidates the registry does not
     *  have are walked past, and the chain from the winner onwards is carried
     *  out so the child's own call can keep walking it. */
    const resolveBinding = Effect.fn("TaskTool.resolveBinding")(function* () {
      const candidates = yield* flock.resolveSubagents()
      if (!candidates?.length) return undefined
      const outcome = yield* FlockHealth.walk({
        candidates,
        provider,
        // Route time asks only whether the binding exists, and the walk's own
        // registry lookup has answered that by the time this runs.
        attempt: (model) => Effect.succeed(FlockHealth.ok(model)),
      })
      if (outcome.kind !== "ok") {
        yield* Effect.logWarning("flock has no reachable candidate left, falling through to the session's model")
        return undefined
      }
      return { binding: outcome.binding, chain: candidates.slice(outcome.index) }
    })

    /** The live child session a `task_id` names, or a refusal the model can
     *  read. Every part of the claim is checked: the session exists, it is a
     *  child of THIS caller, and it runs the agent the call asks for. A
     *  cross-workspace id needs no guard - sessions are instance-scoped. */
    const resume = Effect.fn("TaskTool.resume")(function* (input: {
      taskID: string
      agent: string
      parentID: SessionID
    }) {
      const refuse = (detail: string) => Effect.fail(new TaskResumeError({ taskID: input.taskID, detail }))
      const gone = `Task ${input.taskID} no longer exists - launch a new task without task_id to start fresh.`
      // `SessionID.make` THROWS on a string that is not a session id, and a
      // model that invents a task_id is the caller this exists for, so the
      // shape is answered here rather than left to blow up as a defect.
      if (!input.taskID.startsWith("ses")) return yield* refuse(gone)
      // catchTag, not catchCause: "no such session" is a typed NotFoundError.
      // Anything worse is a real fault and must NOT be dressed up as a missing
      // task.
      const session = yield* sessions
        .get(SessionID.make(input.taskID))
        .pipe(Effect.catchTag("NotFoundError", () => refuse(gone)))
      if (session.parentID !== input.parentID) {
        return yield* refuse(
          `Task ${input.taskID} is not one of your tasks - you can only resume a task this session launched. Launch a new task without task_id.`,
        )
      }
      if (session.agent !== input.agent) {
        return yield* refuse(
          `Task ${input.taskID} is a ${session.agent ?? "different"} agent, not a ${input.agent} agent. Resume it with subagent_type=${session.agent ?? "its own agent"}, or launch a new ${input.agent} task without task_id.`,
        )
      }
      return session
    })

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      // With the experiment on, omitting the field means background: the model
      // has to ASK for the blocking behaviour. With it off, only foreground.
      const runInBackground = flags.experimentalBackgroundSubagents
        ? params.background !== false
        : params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require ORIGAMI_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)

      // PERMISSION FIRST, THEN THE CAP (t-h8s3xg). The order used to be the
      // other way round, so an agent whose ruleset DENIES `task` read "subagent
      // depth limit reached" - an answer about a config key it was never
      // refused on, and one that invites it to ask for the key to be raised.
      // The denial is the truer sentence, and it is the one the permission
      // service words.
      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      // The BACKSTOP. `session/tools.ts` keeps these tools out of a capped
      // session's catalog entirely, so a model should never reach this; a
      // session that got here some other way still stops, and now reads what
      // to do rather than which key to edit.
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (SubagentDepth.atCap(depth, cfg.subagent_depth)) {
        return yield* Effect.fail(new Error(SubagentDepth.capMessage(cfg.subagent_depth)))
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }
      // The whole of Flock routing: every subagent session runs on the active
      // profile's ONE binding. No profile, or no binding on it, and this is
      // undefined and nothing below changes.
      const routed = yield* resolveBinding()

      // A SUPPLIED task_id either resumes the session it names or fails the
      // call. Falling through to a fresh child is what makes a broken resume
      // invisible.
      const session = params.task_id
        ? yield* resume({ taskID: params.task_id, agent: next.name, parentID: ctx.sessionID })
        : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") {
        return yield* Effect.fail(new Error("Not an assistant message"))
      }
      const variant = msg.info.variant

      // Precedence: the PARENT CHAT's sub-agent override -> the Flock subagent
      // binding -> the agent's own model -> the parent message's model. The
      // override is first because it is the only tier a human set for THIS chat
      // deliberately. ONE DEFINITION IS EXEMPT: a `vision-profile: true` agent
      // exists to pin one vision-capable model, and that pin IS the definition,
      // so routing it elsewhere would send an image to a model that cannot see
      // it and get back a confident description of a picture nobody looked at.
      const pin = next.options["vision-profile"] ? next.model : undefined
      const override = pin ? undefined : Session.subagentModel(parent)
      const own = pin ?? override ?? routed?.binding ?? next.model
      const model = own ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      // t-dcl8fe. The child's spend so far, and the metadata it rides on.
      // `live` is mutable because the tool call's metadata is REPLACED, not
      // merged, by each `ctx.metadata` write: a token update that posted the
      // base object would drop the `background`/`jobId` keys a promotion added.
      let tokens: TaskTokens | undefined
      let live: Record<string, unknown> = { ...metadata }
      const postMetadata = Effect.fn("TaskTool.postMetadata")(function* (extra?: Record<string, unknown>) {
        if (extra) live = { ...live, ...extra }
        yield* ctx.metadata({
          title: params.description,
          metadata: { ...live, ...taskTokensMetadata(tokens) },
        })
      })

      yield* postMetadata()

      // t-dcl8fe. The subtree the ceiling's blocked-time credit is read over.
      // Registered on the RESUME path too: the link is what lets a grandchild's
      // open ask pause this child's clock, and a resumed child creates no
      // session to hang it off.
      yield* permission.link({ sessionID: nextSession.id, parentSessionID: ctx.sessionID })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) {
        return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      }

      // The chain the child may walk at call time: the binding it starts on plus
      // whatever is still behind it. Absent unless the child was routed. An
      // OVERRIDE (or a vision `pin`) drops it entirely - the walk starts at the
      // flock candidates, not at `model`, so leaving it in place would quietly
      // run the children on the profile's binding after the user pinned a model
      // for this chat. One pinned model means one attempt.
      const chain = pin || override ? undefined : routed?.chain

      // A subagent turn can fail WITHOUT throwing - a context overflow is
      // recorded on the assistant message, not raised - so the job would
      // otherwise finish "completed" with empty text and the parent would
      // absorb a failure it can neither retry nor escalate.
      const failure = (result: SessionV1.WithParts) =>
        result.info.role === "assistant" ? result.info.error : undefined
      const describe = (error: { name?: string; data?: unknown }) => {
        const data = isRecord(error.data) ? error.data : undefined
        const reason = typeof data?.["message"] === "string" ? data["message"] : undefined
        return new Error(`Sub-agent failed: ${reason ?? error.name ?? "unknown error"}`)
      }
      const answer = (result: SessionV1.WithParts) => result.parts.findLast((item) => item.type === "text")?.text ?? ""

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        // The override's context length rides every attempt, set fresh per call
        // so a later edit takes effect on the child's next turn rather than
        // being frozen at spawn. `chain` is undefined exactly when `override` is
        // set, so this is a no-op on every other routing path.
        const contextOverride = override?.context
        const attempt = (target: FlockRouting.Binding) =>
          ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: nextSession.id,
            model: {
              modelID: target.modelID,
              providerID: target.providerID,
            },
            variant: own ? undefined : variant,
            agent: next.name,
            parts,
            ...(contextOverride !== undefined ? { contextOverride } : {}),
          })

        if (!chain) {
          const result = yield* attempt(model)
          const error = failure(result)
          if (error) return yield* Effect.fail(describe(error))
          return answer(result)
        }

        const outcome = yield* FlockHealth.walk({
          candidates: chain,
          provider,
          attempt: (_, binding) =>
            attempt(binding).pipe(
              Effect.map((result) => {
                const error = failure(result)
                if (!error) return FlockHealth.ok(result)
                return FlockHealth.failed<SessionV1.WithParts>(error, FlockHealth.produced(result.parts))
              }),
            ),
        })
        if (outcome.kind === "ok") return answer(outcome.value)
        if (outcome.kind === "failed") return yield* Effect.fail(describe(outcome.failure.error))
        // Only reachable when the registry lost the binding between routing and
        // running. Nothing was spent, so say so rather than return a hollow "".
        return yield* Effect.fail(new Error("Sub-agent failed: no model is available for the flock subagent binding"))
      })

      /**
       * t-dcl8fe. Re-read the child's spend and post it on the tool call.
       *
       * t-ucndru (lazy loading L3). Read from the child's session ROW - the
       * running tokens, cost and `steps` the projector keeps from the same
       * step-finish parts `RunStats.stat` sums - so the figure agrees with the
       * ACP rider (acp/event.ts `childSpend`) and no longer costs a read of the
       * child's whole transcript. `context` is one step's figure, not on the
       * row: ONE read of the child's newest message (owner answer Q3).
       *
       * Best effort by design: an unreadable row leaves the last figure
       * standing rather than posting zeros over a real one.
       */
      const refreshTokens = Effect.fn("TaskTool.refreshTokens")(function* () {
        const row = yield* sessions.get(nextSession.id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!row) return
        // t-f6vig2. NOTHING MEASURED, NOTHING POSTED. An all-zero row is a child
        // not billed yet, and zeros read as a spend of 0 - and they OVERWRITE a
        // real figure, because every later update of this call re-sends its metadata.
        const spend = taskTokensFromRow(row)
        if (!spend) return
        const newest = yield* sessions
          .messages({ sessionID: nextSession.id, limit: 1 })
          .pipe(Effect.catchCause(() => Effect.succeed([])))
        const context = RunStats.stat(nextSession.id, newest as unknown as Parameters<typeof RunStats.stat>[1]).context
        tokens = context === undefined ? spend : { ...spend, context }
        yield* postMetadata()
      })

      /**
       * Run the child's work and post its final token figure.
       *
       * ONE READER PER CHILD STEP (t-fijy8a F7). This used to refresh on every
       * child step-finish as well, and so did `acp/event.ts childTokens` on the
       * SAME event: two full reads of the child's transcript per step, for two
       * riders carrying the same number. The ACP one survives because it is the
       * only one that works for a BACKGROUND child - the launcher's tool call
       * settles the instant the child is spawned, so a metadata write after that
       * reaches nothing (session/tools.ts refuses a write to a call that is not
       * running) - and the extension feeds the transcript card from that same
       * chunk rider (dashboard/sessionLogSubagent.ts logSubagentTokens).
       *
       * What is left here is the one write the chunk cannot make: the figure on
       * the task PART metadata, posted when the work ends, whatever it ended as,
       * so a turn that failed still carries a total. Nothing polls.
       */
      const withTokens = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        work.pipe(Effect.ensuring(refreshTokens().pipe(Effect.ignore)))

      // Background sub-agents of THIS parent that have not settled. Counted off
      // the job registry, not tracked locally, so it stays right across every
      // task call the parent made, earlier turns included.
      const outstandingSiblings = Effect.fn("TaskTool.outstandingSiblings")(function* () {
        const jobs = yield* background.list()
        return jobs.filter(
          (job) =>
            job.status === "running" &&
            job.metadata?.background === true &&
            job.metadata?.parentSessionId === ctx.sessionID,
        ).length
      })

      /** Did our own injected message reach the store? `SessionPrompt.prompt`
       *  PERSISTS the user message BEFORE it runs the turn, so a failure from
       *  inside the turn still leaves the text saved and re-injecting would show
       *  the model the same <task_result> twice. THE ORDER IS THE ASSUMPTION:
       *  if prompt() ever writes after it runs, this starts answering "no". */
      const injected = (messageID: MessageID) =>
        MessageV2.get({ sessionID: ctx.sessionID, messageID }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.as(true),
          // catchCause, not catch: a missing row is a typed failure, but the db
          // layer dies on anything worse and neither answer is "it landed".
          Effect.catchCause(() => Effect.succeed(false)),
        )

      /** One attempt at writing a batch into the parent. `noReply` decides
       *  whether it also STARTS a turn: the fallback write only has to persist,
       *  which alone puts the text in the window the running loop re-reads and
       *  fires the part event the client's roster listens to. */
      const writeBatch = Effect.fn("TaskTool.writeBackgroundResults")(function* (
        batch: PendingResult[],
        text: string,
        messageID: MessageID,
        noReply: boolean,
      ) {
        return yield* injectLock(ctx.sessionID).withPermit(
          Effect.gen(function* () {
            const currentParent = yield* sessions.get(ctx.sessionID)
            return yield* ops.prompt({
              messageID,
              sessionID: ctx.sessionID,
              agent: currentParent.agent ?? ctx.agent,
              variant,
              ...(noReply ? { noReply: true } : {}),
              // The metadata is the client's ONLY honest "this child is done"
              // signal - the launcher card completed the moment it spawned.
              parts: [
                {
                  type: "text",
                  synthetic: true,
                  text,
                  metadata: taskResultsMetadata(batch.map((item) => item.entry)),
                },
              ],
            })
          }).pipe(
            // Exit (not ignore): a DEFECT escaping here would leave the drainer
            // claimed forever and silently strand every later sibling result,
            // and `ops.prompt` is `Effect.catch(Effect.die)`, so every failure
            // it has arrives as one.
            Effect.exit,
          ),
        )
      })

      /** One pass of the write ladder for one batch: succeed, or find the write
       *  already in the store, or fall back to a persist-only write. It drops
       *  the batch off the queue on whichever rung landed. Annotated because
       *  this, `drain` and `confirmDelivery` are mutually recursive and
       *  inference cannot start anywhere inside a cycle. */
      const deliver: (batch: PendingResult[], text: string) => Effect.Effect<void, UndeliveredBatch> = Effect.fn(
        "TaskTool.deliverBackgroundResults",
      )(function* (batch: PendingResult[], text: string) {
        const children = batch.map((item) => item.entry.sessionId)
        // Asked BEFORE the write: a busy parent JOINS the run already in flight
        // (session/run-state.ts) and hands us THAT run's outcome, so its failure
        // is a log field, not evidence our write failed. It also says the write
        // got no turn of its own, hence the re-delivery below.
        const busy = yield* ops.busy(ctx.sessionID).pipe(Effect.catchCause(() => Effect.succeed(false)))
        const messageID = MessageID.ascending()
        const exit = yield* writeBatch(batch, text, messageID, false)
        if (Exit.isSuccess(exit)) {
          // Dropped BEFORE the confirmation is armed: a re-queue that beat this
          // line would be spliced straight back off again.
          dropResults(ctx.sessionID, batch)
          if (busy && !batch.some((item) => item.redelivered)) {
            yield* confirmDelivery(batch, messageID).pipe(Effect.forkIn(scope, { startImmediately: true }))
          }
          return
        }
        yield* Effect.logError("background task result injection failed", {
          "session.id": ctx.sessionID,
          children,
          joinedRunningTurn: busy,
          cause: Cause.pretty(exit.cause),
        })
        if (yield* injected(messageID)) {
          // Written, but no turn of its own ran. The parent's message window is
          // re-read at the top of every step, so a still-running turn picks it
          // up at its next tool boundary; an idle parent when the user speaks.
          yield* Effect.logWarning("background task result was persisted without a turn of its own", {
            "session.id": ctx.sessionID,
            children,
          })
          dropResults(ctx.sessionID, batch)
          return
        }
        // Nothing landed. Try again with the turn taken out of it: the part
        // carries both the result text and the terminal marker, and the
        // client's roster retires on the marker alone, so emitting it is what
        // stops a row showing "still out" forever.
        const settled = yield* writeBatch(batch, text, MessageID.ascending(), true)
        if (Exit.isSuccess(settled)) {
          yield* Effect.logWarning("background task result injected without a turn after the first write failed", {
            "session.id": ctx.sessionID,
            children,
          })
          dropResults(ctx.sessionID, batch)
          return
        }
        return yield* Effect.fail(new UndeliveredBatch({ cause: Cause.pretty(settled.cause) }))
      })

      // Drains every queued result for this parent into as few synthetic turns
      // as possible. The prompt still runs under the parent's inject lock,
      // which stays the ordering guarantee against any other inject path;
      // `agent`/`variant`/`ops` come from whichever task call started the
      // drainer, and the parent's live agent is re-read each pass.
      //
      // A write that fails is loud and the result survives it: the batch stays
      // queued until something has been written, and after the bounded retries
      // it is left queued for the next sibling to drain, with a log line.
      const drain: () => Effect.Effect<void> = Effect.fn("TaskTool.drainBackgroundResults")(function* () {
        while (true) {
          const batch = peekResults(ctx.sessionID)
          if (batch.length === 0) {
            releaseDrainer(ctx.sessionID)
            return
          }
          const outstanding = yield* outstandingSiblings()
          const text = [
            ...batch.map((item) => item.text),
            ...(outstanding > 0 ? [outstandingNote(outstanding)] : []),
          ].join("\n")
          const landed = yield* deliver(batch, text).pipe(
            Effect.retry(DELIVERY_RETRY),
            Effect.as(true),
            Effect.catchTag("TaskResultUndelivered", (error) =>
              Effect.logError("background task results could not be delivered and remain queued", {
                "session.id": ctx.sessionID,
                children: batch.map((item) => item.entry.sessionId),
                cause: error.cause,
              }).pipe(Effect.as(false)),
            ),
          )
          if (landed) continue
          releaseDrainer(ctx.sessionID)
          return
        }
      })

      /** Wait out the parent turn this write joined. Bounded: a parent still
       *  busy a minute later has taken many steps since, and every step re-reads
       *  its message window, so it has demonstrably seen the result. */
      const awaitParentIdle = Effect.fn("TaskTool.awaitParentIdle")(function* () {
        for (let poll = 0; poll < IDLE_POLL_LIMIT; poll++) {
          const busy = yield* ops.busy(ctx.sessionID).pipe(Effect.catchCause(() => Effect.succeed(false)))
          if (!busy) return true
          yield* Effect.sleep(IDLE_POLL_INTERVAL)
        }
        return false
      })

      /** Did a TURN actually READ the injected message, or did it only land in
       *  the store? HEURISTIC, not proof: a NEWER assistant message usually
       *  means a step read ours, but a step allocates its assistant id after its
       *  history read, so a message injected in that gap can be overtaken by a
       *  step that never saw it - which errs toward NOT re-delivering. The
       *  absence of a newer one is firm the other way. Anything unreadable
       *  answers "read", or a bad store read would duplicate the result. */
      const consumed = (messageID: MessageID) =>
        sessions.findMessage(ctx.sessionID, (message) => message.info.role === "assistant").pipe(
          Effect.map((match) => Option.isSome(match) && match.value.info.id > messageID),
          Effect.catchCause(() => Effect.succeed(true)),
        )

      /** ONE re-delivery for a batch written into a running turn and never read.
       *  A write into a busy parent joins the run in flight rather than starting
       *  a turn, so a result landing after that run's LAST history read is
       *  persisted and never spoken about until the next human message. Confirm
       *  at the far end of the turn instead, and re-queue an unread batch so the
       *  drainer writes it into an IDLE parent, which does take a turn.
       *
       *  Losing the drainer claim is not a loss: an incumbent peeks again after
       *  every write. The exception is a drainer already standing down, and
       *  there the batch stays queued for the next sibling. */
      const confirmDelivery: (batch: PendingResult[], messageID: MessageID) => Effect.Effect<void> = Effect.fn(
        "TaskTool.confirmBackgroundDelivery",
      )(function* (batch: PendingResult[], messageID: MessageID) {
        if (!(yield* awaitParentIdle())) return
        if (yield* consumed(messageID)) return
        yield* Effect.logWarning("background task result landed after the parent's last read, re-delivering", {
          "session.id": ctx.sessionID,
          children: batch.map((item) => item.entry.sessionId),
        })
        requeueResults(
          ctx.sessionID,
          batch.map((item) => ({ ...item, redelivered: true })),
        )
        if (!claimDrainer(ctx.sessionID)) return
        yield* drain().pipe(Effect.ensuring(Effect.sync(() => releaseDrainer(ctx.sessionID))))
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        enqueueResult(ctx.sessionID, {
          text: renderOutput({
            sessionID: nextSession.id,
            state,
            summary:
              state === "completed"
                ? `Background task completed: ${params.description}`
                : `Background task failed: ${params.description}`,
            text,
          }),
          entry: { sessionId: nextSession.id, state },
        })
        // An active drainer will pick this up on its next pass - that batching is
        // the whole point, so do NOT fork a second turn for it.
        if (!claimDrainer(ctx.sessionID)) return
        yield* drain()
          .pipe(Effect.ensuring(Effect.sync(() => releaseDrainer(ctx.sessionID))))
          .pipe(Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error")
              return inject("error", stopped(result.info) ?? result.info.error ?? "")
            // A cancel is a settled outcome the parent must be told about:
            // without this branch no terminal marker reaches the clients and a
            // cancelled child never retires. There is no "cancelled" state on
            // the wire, so it is reported as an error.
            if (result.info?.status === "cancelled") return inject("error", stopped(result.info) ?? "Task cancelled.")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      // A resume is the parent deliberately giving this child new work, so the
      // ceiling restarts from here rather than counting the hours the child
      // already spent answering the last question (t-d935qk).
      const extended = yield* background.extend({
        id: nextSession.id,
        maxDurationMs: subagentCeiling,
        run: withTokens(runTask()),
      })
      if (extended) {
        // t-f6vig2. A RESUME inherits the spend the child already made, so read
        // it before answering: the figure the drawer draws must not blank (or
        // restart from nothing) because the parent sent the child more work.
        yield* refreshTokens().pipe(Effect.ignore)
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
            ...taskTokensMetadata(tokens),
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        maxDurationMs: subagentCeiling,
        // Time this child spends parked on a permission ask nobody has answered
        // is the USER's time, not the child's, and must not spend the ceiling.
        blockedMs: permission.blockedMs(nextSession.id),
        onPromote: Effect.all([
          postMetadata({ background: true, jobId: nextSession.id }),
          notify(nextSession.id),
        ]),
        run: withTokens(runTask()).pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      // Reaching `background.start` with a task_id in hand means the extend
      // above found no live job: the resume RESTARTED this child (t-dcl8fe).
      const restarted = params.task_id !== undefined
      // Same reason as the extend branch: a restarted child keeps its transcript.
      if (restarted) yield* refreshTokens().pipe(Effect.ignore)

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
            ...taskTokensMetadata(tokens),
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: restarted ? "Background task started again" : "Background task started",
            text: restarted ? [BACKGROUND_RESTARTED, BACKGROUND_STARTED].join("\n") : BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            /** A readable failure for the parent's model, instead of a defect.
             *  `execute` is `Effect.orDie`, so anything failed from here is a
             *  CRASH card with a stack, and the parent turn ends. */
            const taskError = (text: string) => ({
              title: params.description,
              metadata: { ...metadata, ...taskTokensMetadata(tokens) },
              output: renderOutput({ sessionID: nextSession.id, state: "error" as const, text }),
            })
            // t-dcl8fe. A job the registry has LOST - removed, or never
            // registered - used to arrive here as `undefined` and be rendered
            // as a COMPLETED task with an empty <task_result>: the parent read
            // "the agent finished and said nothing" and carried on. It is a
            // failure of this tool, and it says so.
            if (!result) {
              return taskError(
                `The sub-agent job for session ${nextSession.id} is no longer registered, so its result cannot be read. Nothing was returned. Launch the task again.`,
              )
            }
            // A REFUSAL is not a crash: the user said no inside a session they
            // cannot see, so hand it back as a readable <task_error> and let the
            // parent ask what to do instead. Every other child failure still
            // fails the call.
            if (result.status === "error" && Permission.isDenial(result.error)) return taskError(result.error)
            // t-dcl8fe. Nor is the CEILING a crash. A background child reports
            // its stop as a <task_error> through `inject`; a foreground one
            // took the same stop through `Effect.fail` into `orDie`, so the one
            // difference between the two was a stack trace in the parent's
            // window. Only the registry's own stop (`stopped`) takes this
            // branch - a child that failed on its own still fails the call.
            if (result.status === "error" || result.status === "cancelled") {
              const stop = stopped(result)
              if (stop) return taskError(`Task ${stop}.`)
              return yield* Effect.fail(
                new Error(result.status === "error" ? (result.error ?? "Task failed") : "Task cancelled"),
              )
            }
            return {
              title: params.description,
              metadata: { ...metadata, ...taskTokensMetadata(tokens) },
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) {
              // A foreground child that promoted to a detached background job in
              // the instant before the interrupt outlives the turn - spare it.
              const job = yield* background.get(nextSession.id)
              if (job?.metadata?.background === true) return
              yield* Effect.all([cancel, background.cancel(nextSession.id, "parent_turn_stopped")], {
                discard: true,
              })
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

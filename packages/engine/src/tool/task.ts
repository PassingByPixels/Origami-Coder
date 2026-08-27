import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@origami/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { taskResultsMetadata, type TaskResultEntry } from "@/session/task-result"
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
import { Cause, Effect, Exit, Option, Schedule, Schema, Scope, Semaphore } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@origami/core/database/database"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
  /**
   * Whether a prompt to this session would start work of its own, or merely
   * join the run already in flight and be discarded. A caller that needs its
   * OWN answer has to ask before it prompts.
   */
  busy(sessionID: SessionID): Effect.Effect<boolean>
}

const id = "task"
// The old text asked ONE question - "do I need the result to continue?" - which
// is a dependency question asked entirely from the agent's point of view. The
// user was not represented in it at all, so a model told to write three stories
// correctly reasoned it had nothing else to do, chose foreground, and froze the
// chat until all three finished. Foreground blocks the parent TURN, and the
// engine rejects a prompt to a busy session, so the user cannot interject at
// all. Hence: background is the default, foreground is the exception you justify.
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
// "…and end your response" used to close both briefings. It was written to stop
// the model polling, and it did - by stopping the model. A launch became the
// last thing a turn did, so a parent that had four independent jobs to start
// spent four turns starting them. Say the no-poll rule without the stop.
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "If it becomes unnecessary or goes wrong, cancel it with the task_stop tool using this task's id; use task_list to see what is still running.",
  "Keep working on non-overlapping tasks while it runs, or briefly tell the user what you launched; do not poll it.",
  // The resume path exists (task.txt point 6) but nothing said so AT LAUNCH,
  // which is the moment the id is in front of the model. A transcript that
  // should have been one agent resumed four times was four separate agents,
  // each re-deriving what the last one already knew.
  "To send this task more information, answer a question it asks, or have it carry on, call the task tool again with task_id set to this task's id (the `id` on the task tag above).",
  "That RESUMES this same agent with everything it has already read and worked out; launching a new task instead throws all of it away.",
].join("\n")
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

// The id is in front of the model at exactly one moment - when the task
// settles - and the block said nothing about what to do with it, so a four-step
// exchange became four fresh agents, each paying to re-derive what the last one
// already knew. ONE line, and only on a settled task: `running` carries its own
// briefing (BACKGROUND_STARTED / BACKGROUND_UPDATED) and a "resume" line there
// would read as "it is finished".
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

/**
 * A `task_id` that cannot be resumed, in words the model can act on.
 *
 * A supplied task_id is a CLAIM - "continue the agent that has already read the
 * file" - and the old code honoured any id that resolved and answered one that
 * did not by silently creating a fresh child. So a typo, a stale id from an
 * earlier session, a sibling's child, or a root chat id all "worked": the model
 * went on believing it was talking to the agent that knew things while it was
 * talking to one that knew nothing (or, for another parent's child, putting
 * words into a conversation it cannot see). Refuse, and say which it was - the
 * tool result is the only place the model finds out.
 */
export class TaskResumeError extends Schema.TaggedErrorClass<TaskResumeError>()("TaskResumeError", {
  taskID: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

// Serializes background-result injections per PARENT session. Several sub-agents
// finishing in the same window would otherwise each fork an unserialized inject
// (below), append their <task_result> user turn in a racy order, and coalesce
// into one scrambled parent turn (mixed-stream bug). Keyed by parent sessionID so
// all task calls from the same parent share it.
const injectLocks = new Map<string, Semaphore.Semaphore>()

function injectLock(parentSessionID: string) {
  const hit = injectLocks.get(parentSessionID)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  injectLocks.set(parentSessionID, next)
  return next
}

// Finished background results waiting to be injected into their parent, and the
// set of parents that currently have a drainer running. Serializing alone gave a
// fan-out of N sub-agents N strictly-sequential parent turns - the model wrote a
// near-identical "all done" summary for every one of them. So each finished child
// only ENQUEUES its rendered result; the first one to arrive becomes the parent's
// drainer and loops (drain everything queued -> one turn -> drain again) until the
// queue is empty, which folds every sibling that finished during a turn into the
// NEXT turn instead of giving each its own. Push, claim and release never yield,
// so a result can neither be dropped (a drainer only exits with an empty queue)
// nor injected twice.
// The rendered `<task_result>` the model reads, plus the machine-readable fact
// of WHICH child settled - carried side by side so the injected turn can be
// stamped (session/task-result.ts) without a client ever parsing the text.
// `redelivered` marks a result that has ALREADY been written once and put back
// on the queue because no turn ever read it (see `confirmDelivery`). It is the
// one-shot bound on that path: a re-delivery never arms another one, so the
// worst case is one extra synthetic turn, not a parent drowning in them.
type PendingResult = { text: string; entry: TaskResultEntry; redelivered?: boolean }
const pendingResults = new Map<string, PendingResult[]>()
const draining = new Set<string>()

function enqueueResult(parentSessionID: string, result: PendingResult) {
  const queue = pendingResults.get(parentSessionID)
  if (queue) queue.push(result)
  else pendingResults.set(parentSessionID, [result])
}

/** Put a batch that was written but never READ back at the FRONT of the queue:
 *  it is older than anything queued since, and the drainer writes in order. */
function requeueResults(parentSessionID: string, batch: PendingResult[]) {
  const queue = pendingResults.get(parentSessionID)
  if (queue) queue.unshift(...batch)
  else pendingResults.set(parentSessionID, batch.slice())
}

/** True when the caller became the drainer and must run the loop. */
function claimDrainer(parentSessionID: string) {
  if (draining.has(parentSessionID)) return false
  draining.add(parentSessionID)
  return true
}

/**
 * The batch to write next, as a SNAPSHOT.
 *
 * Peek, not take: the queue is what stands between a result and oblivion, so
 * nothing leaves it until a write has actually landed (`dropResults`). It used
 * to splice first, which meant an inject that threw took the results with it -
 * no marker, no retry, and a model that never learned its sub-agent finished.
 *
 * The copy matters: siblings keep pushing onto the SAME array while the write
 * is in flight, so handing the live array out would let `dropResults` remove
 * results that were never written. The copy holds the same object references,
 * which is what lets `dropResults` find them again.
 */
function peekResults(parentSessionID: string): PendingResult[] {
  return (pendingResults.get(parentSessionID) ?? []).slice()
}

/** Remove exactly the results just written, BY IDENTITY.
 *
 *  It used to take the leading N, which was true only while pushes could only
 *  ever append. `requeueResults` puts an unread batch back at the FRONT, so a
 *  positional drop would let one drainer splice off a batch another one had
 *  just re-queued and never written. The snapshot holds the same object
 *  references the queue does, and a re-queued result is a NEW object, so
 *  identity says precisely "this was written" and nothing else. */
function dropResults(parentSessionID: string, batch: PendingResult[]) {
  const queue = pendingResults.get(parentSessionID)
  if (!queue) return
  for (const item of batch) {
    const at = queue.indexOf(item)
    if (at >= 0) queue.splice(at, 1)
  }
  if (queue.length === 0) pendingResults.delete(parentSessionID)
}

/**
 * Give up the drainer claim.
 *
 * It does NOT drop queued results any more. It used to delete the whole queue,
 * which was fine on the normal exit (the queue is empty by then) and a silent
 * mass-loss on the abnormal one: a defect anywhere in the drain loop ran this
 * from `Effect.ensuring` and every result still waiting died with it. Left in
 * place, the next sibling to finish claims the drainer and picks them up.
 *
 * The parent's inject lock goes when nothing is left to serialize - it is only
 * ever held by the drainer, and one semaphore per parent session kept for the
 * life of the process is a leak, not a cache.
 */
function releaseDrainer(parentSessionID: string) {
  draining.delete(parentSessionID)
  if (pendingResults.get(parentSessionID)?.length) return
  pendingResults.delete(parentSessionID)
  injectLocks.delete(parentSessionID)
}

/** Raised when neither write landed a batch, so the retry ladder can see it. */
class UndeliveredBatch extends Schema.TaggedErrorClass<UndeliveredBatch>()("TaskResultUndelivered", {
  cause: Schema.String,
}) {}

// A batch that neither write could land is retried before the drainer stands
// down. The failure is usually momentary - a parent mid-cancel or mid-restart -
// and "wait for the next sibling to finish" is no plan at all when this batch
// is the LAST one. Bounded on purpose: after this the result stays QUEUED
// (nothing is dropped) and the log says so. Durable storage is a separate job.
const DELIVERY_RETRIES = 2 // three attempts in total
const DELIVERY_RETRY = Schedule.spaced("200 millis").pipe(Schedule.both(Schedule.recurs(DELIVERY_RETRIES)))

// How the drainer waits out a parent turn it wrote into. `busy` is the one
// liveness fact the task tool is handed (TaskPromptOps), so it is polled rather
// than subscribed to - no new service, and the stub in the tests drives it
// directly. Bounded: a parent still busy a minute after the write has taken
// many steps since, and every step re-reads its window.
const IDLE_POLL_INTERVAL = "250 millis"
const IDLE_POLL_LIMIT = 240

// Without this the model was told a task finished and nothing else, so it
// declared the whole batch complete on EVERY notification - the transcript that
// prompted this fix has six consecutive "all 10 stories complete" turns, one of
// them written while its own reasoning said nine.
function outstandingNote(count: number) {
  return [
    `${count} background task${count === 1 ? "" : "s"} launched from this session`,
    `${count === 1 ? "is" : "are"} still running.`,
    "Do not report overall completion or summarise the batch until every one has reported back.",
    // origami_change: the session that prompted the scratchbook fix narrated
    // "todo updated" six times without ONE todowrite call — and a session with
    // no list gets no reminder (reminders.ts fires only when todos exist). This
    // is the one moment the gap is knowable, so say it here.
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

    /**
     * The model this subagent session is routed to, or undefined to fall
     * through to today's resolution (D10). Candidates the provider registry does
     * not have are walked past rather than ending the routing, and the chain
     * from the winner onwards is carried out so the child's own call can keep
     * walking it when the binding turns out to be sick rather than merely absent.
     */
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

    /**
     * The live child session a `task_id` names, or a refusal the model can read.
     *
     * Every part of the claim is checked before it is honoured: that the session
     * exists, that it is a child of THIS caller, and that it runs the agent the
     * call asks for. A cross-WORKSPACE id needs no guard of its own - sessions
     * are instance-scoped, so it simply does not resolve.
     */
    const resume = Effect.fn("TaskTool.resume")(function* (input: {
      taskID: string
      agent: string
      parentID: SessionID
    }) {
      const refuse = (detail: string) => Effect.fail(new TaskResumeError({ taskID: input.taskID, detail }))
      const gone = `Task ${input.taskID} no longer exists - launch a new task without task_id to start fresh.`
      // `SessionID.make` THROWS on a string that is not a session id, and a
      // model that invents a task_id is exactly the caller this exists for, so
      // the shape is answered here rather than left to blow up as a defect.
      if (!input.taskID.startsWith("ses")) return yield* refuse(gone)
      // catchTag, not catchCause: "no such session" is a typed NotFoundError and
      // gets its own answer. Anything worse is a real fault and must NOT be
      // dressed up as a missing task - the old catchCause swallowed both.
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
      // has to ASK for the blocking behaviour, because that is the one that
      // freezes the conversation. With it off there is only foreground.
      const runInBackground = flags.experimentalBackgroundSubagents
        ? params.background !== false
        : params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require ORIGAMI_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

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

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }
      // The whole of Flock routing, as of E1: every subagent session runs on the
      // active profile's ONE binding, whatever agent it is. No profile, or no
      // binding on it, and this is undefined and nothing below changes.
      const routed = yield* resolveBinding()

      // A SUPPLIED task_id either resumes the session it names or fails the
      // call. It never falls through to creating a fresh child - that fallback
      // is what made a broken resume invisible.
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
      // override is first because it is the only tier a human set for THIS chat,
      // deliberately, and the tiers under it are all defaults someone configured
      // once. With no override and Flock off, `own` is `next.model` and every
      // line below reads exactly as it did before.
      //
      // ONE DEFINITION IS EXEMPT. A `vision-profile: true` agent exists to pin
      // ONE vision-capable model - that pin IS the definition, which is why
      // tool/vision-request.ts refuses outright rather than falling back when a
      // profile has no model. Routing such a child onto the chat's sub-agent
      // override (or onto a flock binding) sends an image to a model that
      // cannot see it, and rounds 1-3 of that tool proved what comes back: a
      // confident description of a picture nobody looked at. The pin wins.
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

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) {
        return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      }

      // The chain the child may walk at call time: the binding it starts on plus
      // whatever is still behind it. Absent unless the child was routed, so an
      // unrouted child runs exactly the single attempt it ran before.
      //
      // An OVERRIDE drops the chain entirely. The walk starts at the flock
      // candidates, not at `model`, so leaving it in place would have quietly
      // run the children on the profile's binding after the user pinned a model
      // for this chat — the precedence would hold in the metadata and nowhere
      // else. One pinned model means one attempt, and an honest failure if it
      // cannot serve. A vision profile's `pin` is read the same way, for the
      // same reason - one pinned model, one attempt.
      const chain = pin || override ? undefined : routed?.chain

      // A subagent turn can fail WITHOUT throwing - e.g. a context overflow is
      // recorded as an error on the assistant message, not raised - so the job
      // would otherwise finish "completed" with an empty text result and the
      // parent would silently absorb it (a masked failure it can neither retry
      // nor escalate). Surface it as a real failure so the parent receives a
      // <task_error> with the reason instead of a hollow "completed" success.
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
        // t-lmqe0g: the override's context length, when set, rides every attempt
        // on the child session the same way `temperature`/`topP` ride a normal
        // prompt — set fresh per call so a later override edit (or clear) takes
        // effect on the child's very next turn rather than being frozen at spawn.
        // `chain` is undefined exactly when `override` is set (see the comment on
        // `chain` above), so this is a no-op on every OTHER routing path.
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
        // Only reachable when the registry lost the binding between routing this
        // child and running it. Nothing was spent, and there is no result to
        // report, so say so rather than return a hollow "".
        return yield* Effect.fail(new Error("Sub-agent failed: no model is available for the flock subagent binding"))
      })

      // Background sub-agents of THIS parent that have not settled yet. Counted off
      // the job registry rather than tracked locally so it stays right across every
      // task call the parent made, including ones from earlier turns.
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
       *  PERSISTS the user message (createUserMessage) BEFORE it runs the turn
       *  (`loop`), so a failure raised from inside the turn - or handed to us by
       *  a run we merely joined - still leaves the text and its stamp saved, and
       *  re-injecting it would give the model the same <task_result> twice. Ask
       *  the store rather than guess. THE ORDER IS THE ASSUMPTION: if prompt()
       *  ever writes after it runs, this check silently starts answering "no". */
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
       *  because that alone puts the text in the window the running loop
       *  re-reads and fires the part event the client's roster listens to. */
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
              // The text is byte-for-byte what the model saw before the
              // stamp existed; the metadata is the client's ONLY honest
              // "this child is done" signal (the launcher card completed
              // the moment it spawned).
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
            // claimed forever and silently strand every later sibling result.
            // `ops.prompt` is `Effect.catch(Effect.die)`, so EVERY failure it
            // has arrives as one - which is exactly how a lost inject stayed
            // invisible.
            Effect.exit,
          ),
        )
      })

      /** One pass of the write ladder for one batch: succeed, or find the write
       *  already in the store, or fall back to a persist-only write. It drops
       *  the batch off the queue itself, on whichever rung landed - nothing
       *  leaves the queue until something has actually been written.
       *
       *  Annotated because this, `drain` and `confirmDelivery` are mutually
       *  recursive - deliver arms confirmDelivery, which re-enters drain, which
       *  delivers - and inference cannot start anywhere inside a cycle (the same
       *  reason SessionPrompt.runLoop carries its type). */
      const deliver: (batch: PendingResult[], text: string) => Effect.Effect<void, UndeliveredBatch> = Effect.fn(
        "TaskTool.deliverBackgroundResults",
      )(function* (batch: PendingResult[], text: string) {
        const children = batch.map((item) => item.entry.sessionId)
        // Asked BEFORE the write: a busy parent JOINS the run already in flight
        // (session/run-state.ts) and hands us THAT run's outcome, so its failure
        // is not evidence that our own write failed - it is a LOG field. It is
        // also what says the write got no turn of its own, which is why an
        // unread result can be found and re-delivered below.
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
          // Written, but no turn of its own ran. The parent's message window
          // is re-read at the top of every step, so a still-running turn
          // picks this up at its next tool boundary; an idle parent reads it
          // when the user next speaks.
          yield* Effect.logWarning("background task result was persisted without a turn of its own", {
            "session.id": ctx.sessionID,
            children,
          })
          dropResults(ctx.sessionID, batch)
          return
        }
        // Nothing landed. Try again with the turn taken out of it - the part
        // is what carries both the result text and the terminal marker, and
        // the client's roster retires on the marker alone. Emitting it even
        // when the model never gets its own turn is the difference between a
        // row that settles and a sub-agent that shows as "still out" forever.
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

      // Drains every queued result for this parent into as few synthetic turns as
      // possible. The prompt still runs under the parent's inject lock: the drainer
      // is the only writer per parent, but the lock remains the ordering guarantee
      // against any other inject path. `agent`/`variant`/`ops` come from whichever
      // task call started the drainer - all task calls of one parent share a
      // session, and the parent's live agent is re-read each pass.
      //
      // A WRITE THAT FAILS IS LOUD AND THE RESULT SURVIVES IT. The batch stays
      // queued until something has actually been written, and the ladder never
      // spins: `deliver` tries every rung, the whole ladder is retried a bounded
      // number of times, and after that the batch is left queued for the next
      // sibling to drain and the log says so.
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
       *  the store? HEURISTIC, not proof: every step writes a fresh assistant
       *  message with an ascending id (session/prompt.ts), so an assistant
       *  message NEWER than ours usually means a step read ours - but a step
       *  allocates its assistant id well after its history read, so a message
       *  injected inside that gap can be overtaken by an assistant id whose
       *  step never saw it (a strictly smaller residue of the original race,
       *  and it errs toward NOT re-delivering, never toward duplicating).
       *  The absence of a newer one is firm the other way: the turn ended
       *  without ever looking. Anything unreadable answers "read": a
       *  re-delivery on a bad store read would show the model the same result
       *  twice for no reason at all. */
      const consumed = (messageID: MessageID) =>
        sessions.findMessage(ctx.sessionID, (message) => message.info.role === "assistant").pipe(
          Effect.map((match) => Option.isSome(match) && match.value.info.id > messageID),
          Effect.catchCause(() => Effect.succeed(true)),
        )

      /** ONE re-delivery for a batch that was written into a running turn and
       *  never read.
       *
       *  A write into a busy parent does not start a turn - it joins the run in
       *  flight - so a result that lands after that run's LAST history read is
       *  persisted, acknowledged, and never spoken about: it waits for the next
       *  human message. Confirm at the far end of the turn instead, and put an
       *  unread batch back on the queue so the drainer writes it into an IDLE
       *  parent, which does take a turn.
       *
       *  Losing the drainer claim is not a loss: an incumbent drainer peeks
       *  again after every write (and `peek`/`release` are adjacent with nothing
       *  between them), so it picks the batch up. The one exception is a drainer
       *  already standing down, and there the batch stays queued for the next
       *  sibling - exactly what it would have done anyway. */
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
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
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
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
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
            // A REFUSAL is not a crash. Failing the tool call would tell the model
            // its own call broke; what actually happened is that the user said no
            // inside a session the user cannot see. Hand it back as a readable
            // <task_error> so the parent stays alive and can ask what to do
            // instead. Every other child failure still fails the call, unchanged.
            // (The background path already renders <task_error> for job errors.)
            if (result?.status === "error" && Permission.isDenial(result.error)) {
              return {
                title: params.description,
                metadata,
                output: renderOutput({ sessionID: nextSession.id, state: "error", text: result.error }),
              }
            }
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) {
              // If this foreground child promoted to a detached background job in the
              // instant before the interrupt, spare it - it now outlives the turn.
              const job = yield* background.get(nextSession.id)
              if (job?.metadata?.background === true) return
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
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

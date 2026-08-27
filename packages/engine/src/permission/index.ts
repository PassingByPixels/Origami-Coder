import { LayerNode } from "@origami/core/effect/layer-node"
import { ConfigPermissionV1 } from "@origami/core/v1/config/permission"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@origami/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@origami/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"

export const Event = PermissionV1.Event

/**
 * How long a SUB-AGENT's unanswered permission request waits before it is
 * refused, in seconds. Overridable per install with
 * `experimental.subagent_permission_timeout_seconds`; 0 turns it off.
 */
export const DEFAULT_SUBAGENT_ASK_TIMEOUT_SECONDS = 300

/**
 * `AskInput`, plus the one fact the timeout below needs and the wire schema
 * does not carry: whether the asking session has a parent.
 *
 * Widened HERE rather than in `@origami/schema` on purpose. It is an
 * engine-internal routing hint, not part of the permission API - adding it to
 * the shared `AskInput` would put it in the OpenAPI document and the generated
 * SDK, where an external caller could set it and nothing would read it.
 */
export type AskInput = PermissionV1.AskInput & {
  /** The asking session's parent, when it has one. Its presence is what makes
   *  this ask UNATTENDED: a sub-agent session has no window of its own. */
  readonly parentSessionID?: string | undefined
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
  /** How many concurrent asks are parked on this ONE request (see `ask`). The entry
   *  leaves `pending` only when the LAST waiter does, so an interrupted waiter can
   *  never strand its siblings on a deferred nobody can reply to any more. */
  waiters: number
}

/** An identical ask already pending for this session: same permission, same patterns
 *  in the same order. Concurrent sub-agents hammering one tool stacked a separate
 *  pending request each (nine, in the observed run), and every one of them needed
 *  its own human answer. */
function findIdentical(
  pending: Map<PermissionV1.ID, PendingEntry>,
  request: { sessionID: string; permission: string; patterns: ReadonlyArray<string> },
): PendingEntry | undefined {
  for (const entry of pending.values()) {
    if (entry.info.sessionID !== request.sessionID) continue
    if (entry.info.permission !== request.permission) continue
    if (entry.info.patterns.length !== request.patterns.length) continue
    if (entry.info.patterns.some((pattern, index) => pattern !== request.patterns[index])) continue
    return entry
  }
  return undefined
}

/** Park on a pending entry until it is replied to, holding it alive for the duration. */
function awaitEntry(pending: Map<PermissionV1.ID, PendingEntry>, entry: PendingEntry) {
  entry.waiters++
  return Effect.ensuring(
    Deferred.await(entry.deferred),
    Effect.sync(() => {
      entry.waiters--
      if (entry.waiters <= 0 && pending.get(entry.info.id) === entry) pending.delete(entry.info.id)
    }),
  )
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@origami/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    /**
     * Wait for an answer — with a deadline when nobody is watching.
     *
     * A MAIN session's ask has a window: the user is looking at the permission
     * bar, and waiting forever is correct because the answer is coming when
     * they get to it. A SUB-AGENT's ask has no window of its own. If the shell
     * cannot surface it (an ACP client with no registered ancestor, a headless
     * run, a client that never wired `requestPermission`), the deferred is
     * never replied to, the sub-agent's tool call sits `running` for the life
     * of the session, and the PARENT's `task` call hangs behind it. The user
     * sees a spinner and no reason for it.
     *
     * So an unattended ask fails as a RejectedError carrying a named reason.
     * Rejected, not died: a refusal is a result the agent can act on and
     * report, which is exactly what "a blocked sub-agent is never silent"
     * means. Main sessions are untouched, deliberately.
     */
    const awaitAnswer = (
      effect: Effect.Effect<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>,
      input: { parentSessionID?: string | undefined; permission: string },
    ) =>
      Effect.gen(function* () {
        if (!input.parentSessionID) return yield* effect
        const configured = (yield* config.get()).experimental?.subagent_permission_timeout_seconds
        const seconds = configured ?? DEFAULT_SUBAGENT_ASK_TIMEOUT_SECONDS
        if (seconds <= 0) return yield* effect
        return yield* effect.pipe(
          Effect.timeoutOrElse({
            duration: `${seconds * 1000} millis`,
            orElse: () =>
              Effect.fail(
                new PermissionV1.RejectedError({
                  reason: `no answer for "${input.permission}" after ${seconds}s — nobody was watching this sub-agent's session`,
                }),
              ),
          }),
        )
      })

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, parentSessionID, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
            // Named so the model reading the error knows WHICH gate closed and
            // on what, rather than being handed a rules dump to infer it from.
            permission: request.permission,
            pattern,
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      // Attach to an identical live request instead of stacking a second one, so a
      // single answer releases every waiter. Skipped when the caller supplied its own
      // id: that id is addressable (workflow_tool_approval replies by it), so it has
      // to stay a request of its own.
      if (request.id === undefined) {
        const identical = findIdentical(pending, request)
        if (identical)
          return yield* awaitAnswer(awaitEntry(pending, identical), {
            parentSessionID,
            permission: request.permission,
          })
      }

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      const entry: PendingEntry = { info, deferred, waiters: 0 }
      pending.set(id, entry)
      yield* events.publish(Event.Asked, info)
      return yield* awaitAnswer(awaitEntry(pending, entry), { parentSessionID, permission: request.permission })
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

/**
 * Prefix that marks an assistant-message error as "the user refused this tool
 * call" - the one turn-ending failure a PARENT session can act on by asking the
 * user, rather than by retrying.
 *
 * It rides the error TEXT because the assistant-error schema has no permission
 * variant (see AssistantErrorSchema in @origami/schema/v1/session), and the
 * schema is shared with the generated SDK. session/processor.ts writes it on a
 * refused SUB-agent turn; tool/task.ts reads it back to render <task_error>
 * instead of failing the parent's tool call.
 */
export const DENIED_PREFIX = "Permission denied: "

/** Was this error text written by {@link DENIED_PREFIX}? */
export function isDenial(text: string | undefined): text is string {
  return typeof text === "string" && text.includes(DENIED_PREFIX)
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Config.node] })

export * as Permission from "."

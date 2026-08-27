export * as SessionStatusEvent from "./session-status-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Status = Event.define({
  type: "session.status",
  schema: {
    sessionID: SessionID,
    status: Info,
    /**
     * How many prompts arrived while this session was already running a turn.
     * `SessionRunState.ensureRunning` JOINS the run in flight and DISCARDS the
     * new work, so those messages are invisible until the current step ends -
     * from the outside the session simply looks busy, and the user cannot tell
     * a message that was received from one that was dropped. This is the count
     * that says so.
     *
     * It rides on the EVENT rather than on `Info` on purpose: the processor
     * re-publishes `{type:"busy"}` at every step, so a field inside the status
     * union would be wiped by the next step of the very turn it describes.
     */
    queued: optional(NonNegativeInt),
  },
})

// deprecated
export const Idle = Event.define({
  type: "session.idle",
  schema: {
    sessionID: SessionID,
  },
})

export const Definitions = Event.inventory(Status, Idle)

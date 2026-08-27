export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@origami/schema/permission-v1"
import { ID } from "@origami/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {
  /**
   * WHY it was rejected, when something other than a human did the rejecting.
   *
   * Optional so every existing `new RejectedError()` still reads the same. It
   * exists for the rejections nobody chose: a sub-agent's ask that timed out
   * because no window was showing it (see `permission/index.ts`), or a client
   * with no permission channel at all. "The user rejected permission" is a
   * lie in both cases, and it is the lie that sends an agent back to retry the
   * same call.
   */
  reason: Schema.optional(Schema.String),
}) {
  override get message() {
    if (this.reason) return `Permission was refused: ${this.reason}`
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

/**
 * A configured RULE refused the call — nobody was asked, and nobody will be.
 *
 * The message is the whole point of the class. It used to say only that "the
 * user has specified a rule", followed by a JSON dump, which left an agent
 * unable to tell a denial from a transient failure: the observed behaviour was
 * a sub-agent retrying the same denied call until its step budget ran out. So
 * it now names the PERMISSION and the PATTERN that were refused, says plainly
 * that retrying cannot work, and gives one way forward.
 *
 * `permission` and `pattern` are optional because the ruleset dump was the only
 * field before this and a caller that has neither still produces a sentence
 * that reads correctly.
 */
export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
  permission: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
}) {
  override get message() {
    const target = this.permission
      ? `the "${this.permission}" permission${this.pattern ? ` for "${this.pattern}"` : ""}`
      : "this specific tool call"
    return [
      `A configuration rule denies ${target}, so this call was refused without asking anyone.`,
      "Retrying it will be refused the same way.",
      "Do the work another way, or tell the user which rule to change.",
      `Relevant rules: ${JSON.stringify(this.ruleset)}`,
    ].join(" ")
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError

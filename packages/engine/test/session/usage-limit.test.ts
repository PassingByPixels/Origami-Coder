import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import { Effect, Exit, Schedule, Schema } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { SessionUsageLimit } from "../../src/session/usage-limit"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionStatus.node, CrossSpawnSpawner.node])))

// The body the ChatGPT backend sent the owner's Plus account on 2026-09-07,
// verbatim in shape (numbers changed). A 429 the SDK marks retryable.
const CODEX_BODY =
  '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1788810709,"eligible_promo":null,"resets_in_seconds":5196}}'

function apiError(body: string, status = 429): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "The usage limit has been reached",
      statusCode: status,
      isRetryable: true,
      responseBody: body,
    }).toObject(),
  )
}

describe("session.usage-limit.detect", () => {
  test("reads the ChatGPT usage_limit_reached body: plan and reset", () => {
    expect(SessionUsageLimit.detect(apiError(CODEX_BODY))).toEqual({ plan: "plus", resetsInSeconds: 5196 })
  })

  test("a 429 that does not name a usage limit is not one", () => {
    expect(SessionUsageLimit.detect(apiError('{"error":{"type":"rate_limit_exceeded"}}'))).toBeUndefined()
    expect(SessionUsageLimit.detect(apiError("not json"))).toBeUndefined()
  })

  test("a body with the type but no usable reset still counts, without a time", () => {
    expect(SessionUsageLimit.detect(apiError('{"error":{"type":"usage_limit_reached"}}'))).toEqual({
      plan: undefined,
      resetsInSeconds: undefined,
    })
  })
})

describe("session.usage-limit.notice", () => {
  test("names the connection as the user knows it, the plan and the wait in minutes", () => {
    expect(SessionUsageLimit.notice({ plan: "plus", resetsInSeconds: 5196 }, "openai")).toBe(
      "ChatGPT usage limit reached on the plus plan. It resets in about 87 minutes. The message was not sent — try again after the reset, or pick another connection.",
    )
  })

  test("rounds long waits to hours and short ones to a minute", () => {
    expect(SessionUsageLimit.notice({ resetsInSeconds: 3 * 3600 + 200 }, "xai")).toContain("SuperGrok usage limit reached. It resets in about 3 hours.")
    expect(SessionUsageLimit.notice({ resetsInSeconds: 40 }, "anthropic")).toContain("Claude usage limit reached. It resets in about a minute.")
  })

  test("an unknown provider keeps its id and an unknown reset says nothing about time", () => {
    expect(SessionUsageLimit.notice({}, "acme")).toBe(
      "acme usage limit reached. The message was not sent — try again after the reset, or pick another connection.",
    )
  })
})

describe("session.retry.policy on a usage limit", () => {
  it.instance("ends the ladder on the first attempt, after one notice in the chat, with no retry status set", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-usage-limit-test")
      const status = yield* SessionStatus.Service
      const notices: string[] = []
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "openai",
          sessionID,
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          notice: (input) => Effect.sync(() => void notices.push(input.text)),
          set: (info) =>
            status.set(sessionID, { type: "retry", attempt: info.attempt, message: info.message, next: info.next }),
        }),
      )
      const exit = yield* Effect.exit(step(apiError(CODEX_BODY)))
      // Done, not a wait: the schedule stops and the error propagates.
      expect(Exit.isFailure(exit)).toBe(true)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain("ChatGPT usage limit reached on the plus plan. It resets in about 87 minutes.")
      expect((yield* status.get(sessionID)).type).not.toBe("retry")
    }),
  )

  it.instance("an ordinary retryable 429 still climbs the ladder", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-usage-limit-control")
      const status = yield* SessionStatus.Service
      const notices: string[] = []
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "openai",
          sessionID,
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          notice: (input) => Effect.sync(() => void notices.push(input.text)),
          set: (info) =>
            status.set(sessionID, { type: "retry", attempt: info.attempt, message: info.message, next: info.next }),
        }),
      )
      yield* step(apiError('{"error":{"type":"rate_limit_exceeded"}}'))
      expect(notices).toHaveLength(0)
      expect(yield* status.get(sessionID)).toMatchObject({ type: "retry", attempt: 1 })
    }),
  )
})

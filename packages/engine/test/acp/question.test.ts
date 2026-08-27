import { describe, expect, it } from "bun:test"
import type { AgentSideConnection, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, ManagedRuntime } from "effect"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"

type QuestionEvent = Extract<Event, { type: "question.asked" }>
type QuestionReplyParams = Parameters<OrigamiClient["question"]["reply"]>[0]
type QuestionRejectParams = Parameters<OrigamiClient["question"]["reject"]>[0]

const pollUntil = async (check: () => boolean, message: string, timeoutMs = 2000) => {
  const started = Date.now()
  while (true) {
    if (check()) return
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function makeSessionService() {
  return ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function createHarness(
  requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse> = () =>
    Promise.resolve({ outcome: { outcome: "selected", optionId: "0" } }),
) {
  const replies: QuestionReplyParams[] = []
  const rejects: QuestionRejectParams[] = []
  const requests: RequestPermissionRequest[] = []
  const session = makeSessionService()
  const sdk = {
    question: {
      reply: (params: QuestionReplyParams) => {
        replies.push(params)
        return Promise.resolve({ data: true })
      },
      reject: (params: QuestionRejectParams) => {
        rejects.push(params)
        return Promise.resolve({ data: true })
      },
    },
  } as unknown as OrigamiClient
  const connection = {
    requestPermission: (params: RequestPermissionRequest) => {
      requests.push(params)
      return requestPermission(params)
    },
    sessionUpdate: () => Promise.resolve(),
  } satisfies Pick<AgentSideConnection, "requestPermission" | "sessionUpdate">
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })

  return { connection, replies, rejects, requests, sdk, session, subscription }
}

async function createSession(session: ACPSession.Interface, sessionId: string, cwd = "/workspace") {
  await Effect.runPromise(session.create({ id: sessionId, cwd }))
}

function questionAsked(
  sessionID: string,
  id: string,
  questions: Array<{ question: string; options: Array<{ label: string; description: string }>; multiple?: boolean }>,
  tool?: { messageID: string; callID: string },
) {
  return {
    id: `evt_${id}`,
    type: "question.asked",
    properties: {
      id,
      sessionID,
      questions: questions.map((q) => ({ header: "Q", custom: false, ...q })),
      ...(tool ? { tool } : {}),
    },
  } as QuestionEvent
}

// Three questions with DISTINCT label sets, so an answer mapped to the wrong
// question is visible in the assertion rather than coincidentally identical.
const first = {
  question: "First?",
  options: [
    { label: "A", description: "" },
    { label: "B", description: "" },
  ],
}
const second = {
  question: "Second?",
  options: [
    { label: "C", description: "" },
    { label: "D", description: "" },
  ],
}
const third = {
  question: "Third?",
  options: [
    { label: "E", description: "" },
    { label: "F", description: "" },
  ],
}

const planExit = (sessionID: string, id: string, tool?: { messageID: string; callID: string }) =>
  questionAsked(
    sessionID,
    id,
    [
      {
        question: "Plan is complete. Switch to the build agent?",
        options: [
          { label: "Yes", description: "Switch to build" },
          { label: "No", description: "Keep planning" },
        ],
      },
    ],
    tool,
  )

describe("acp questions", () => {
  it("surfaces the question via requestPermission and replies with the selected LABEL (not the optionId)", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "selected", optionId: "0" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_1", { messageID: "msg_1", callID: "call_1" }))

    await pollUntil(() => harness.replies.length === 1, "question was never replied")

    // The prompt rides requestPermission, titled with the question, options by label.
    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_a",
      toolCall: { toolCallId: "call_1", status: "pending", title: "Plan is complete. Switch to the build agent?" },
      options: [
        { optionId: "0", name: "Yes" },
        { optionId: "1", name: "No" },
        // The synthetic free-text escape hatch, always last.
        { optionId: "2", name: "Other" },
      ],
    })
    // plan_exit checks `answers[0]?.[0] === "No"` — so the reply MUST carry the
    // human label, never the "0"/"1" optionId. This assertion is the whole point.
    expect(harness.replies[0]).toMatchObject({ requestID: "que_1", directory: "/workspace", answers: [["Yes"]] })
    expect(harness.rejects).toHaveLength(0)
  })

  it("maps the second option back to its label ('No')", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "selected", optionId: "1" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_no"))

    await pollUntil(() => harness.replies.length === 1, "question was never replied")
    expect(harness.replies[0]).toMatchObject({ requestID: "que_no", answers: [["No"]] })
  })

  it("rejects the question when the user dismisses the prompt (cancelled)", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "cancelled" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_cancel"))

    await pollUntil(() => harness.rejects.length === 1, "cancelled question was never rejected")
    expect(harness.rejects[0]).toMatchObject({ requestID: "que_cancel", directory: "/workspace" })
    expect(harness.replies).toHaveLength(0)
  })

  it("rejects when the client permission UI throws", async () => {
    const harness = createHarness(() => Promise.reject(new Error("client UI failed")))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_fail"))

    await pollUntil(() => harness.rejects.length === 1, "failed question was never rejected")
    expect(harness.rejects[0]).toMatchObject({ requestID: "que_fail" })
  })

  it("appends a synthetic 'Other' option after the asker's own answers", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "selected", optionId: "0" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_other_opt"))

    await pollUntil(() => harness.replies.length === 1, "question was never replied")
    expect(harness.requests[0].options).toEqual([
      { optionId: "0", kind: "allow_once", name: "Yes" },
      { optionId: "1", kind: "reject_once", name: "No" },
      { optionId: "2", kind: "reject_once", name: "Other" },
    ])
  })

  it("replies with the user's TYPED text when 'Other' carries _meta.answerText", async () => {
    const harness = createHarness(() =>
      Promise.resolve({
        outcome: {
          outcome: "selected",
          optionId: "2",
          _meta: { answerText: "  neither — rewrite the plan first  " },
        },
      } as unknown as RequestPermissionResponse),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_other_text"))

    await pollUntil(() => harness.replies.length === 1, "question was never replied")
    // Trimmed, and the free text — not the option name — is what the asker sees.
    expect(harness.replies[0]).toMatchObject({
      requestID: "que_other_text",
      answers: [["neither — rewrite the plan first"]],
    })
  })

  it("replies 'Other' when the option is picked with no answerText", async () => {
    const harness = createHarness(() =>
      Promise.resolve({ outcome: { outcome: "selected", optionId: "2" } } as RequestPermissionResponse),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_other_bare"))

    await pollUntil(() => harness.replies.length === 1, "question was never replied")
    expect(harness.replies[0]).toMatchObject({ requestID: "que_other_bare", answers: [["Other"]] })
    // An "Other" pick is an ANSWER, not a dismissal — it must not reject.
    expect(harness.rejects).toHaveLength(0)
  })

  it("replies 'Other' when answerText is present but blank or the wrong type", async () => {
    for (const answerText of ["   ", 42, null]) {
      const harness = createHarness(() =>
        Promise.resolve({
          outcome: { outcome: "selected", optionId: "2", _meta: { answerText } },
        } as unknown as RequestPermissionResponse),
      )
      await createSession(harness.session, "ses_a")

      harness.subscription.handle(planExit("ses_a", `que_other_${String(answerText)}`))

      await pollUntil(() => harness.replies.length === 1, "question was never replied")
      expect(harness.replies[0]).toMatchObject({ answers: [["Other"]] })
    }
  })

  it("keeps the ordinary option's label when a normal answer is picked", async () => {
    const harness = createHarness(() =>
      Promise.resolve({ outcome: { outcome: "selected", optionId: "1" } } as RequestPermissionResponse),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_plain"))

    await pollUntil(() => harness.replies.length === 1, "question was never replied")
    // plan_exit still compares against the human label, so this must not drift.
    expect(harness.replies[0]).toMatchObject({ answers: [["No"]] })
  })

  it("lets typed text win even when an ordinary option was the one clicked", async () => {
    const harness = createHarness(() =>
      Promise.resolve({
        outcome: { outcome: "selected", optionId: "0", _meta: { answerText: "yes, but only the API" } },
      } as unknown as RequestPermissionResponse),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_typed_on_option"))

    await pollUntil(() => harness.replies.length === 1, "question was never replied")
    expect(harness.replies[0]).toMatchObject({ answers: [["yes, but only the API"]] })
  })

  it("still rejects an out-of-range optionId (past the synthetic Other)", async () => {
    const harness = createHarness(() =>
      Promise.resolve({ outcome: { outcome: "selected", optionId: "9" } } as RequestPermissionResponse),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(planExit("ses_a", "que_oob"))

    await pollUntil(() => harness.rejects.length === 1, "out-of-range option was never rejected")
    expect(harness.replies).toHaveLength(0)
  })

  it("LEGACY client: a reply with no _meta.answers answers the head only, so the rest are re-offered", async () => {
    const harness = createHarness((params) =>
      // Pick option 0 of whichever question is being asked. No `_meta.answers`
      // — this is a client that never learned about the batch.
      Promise.resolve({
        outcome: { outcome: "selected", optionId: "0" } as const,
        _params: params,
      } as RequestPermissionResponse),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(questionAsked("ses_a", "que_multi", [first, second]))

    await pollUntil(() => harness.replies.length === 1, "multi-question was never replied")
    // Two prompts, because each reply resolved exactly one question — no
    // question is dropped just because the client cannot render the batch.
    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[1]!.toolCall.title).toBe("Second?")
    expect(harness.replies[0]).toMatchObject({ requestID: "que_multi", answers: [["A"], ["C"]] })
  })

  it("offers a 3-question request as ONE prompt carrying all 3 in _meta.questions", async () => {
    const harness = createHarness(() =>
      Promise.resolve({
        outcome: {
          outcome: "selected",
          optionId: "0",
          _meta: {
            answers: [{ optionId: "1" }, { optionId: "0" }, { optionId: "1" }],
          },
        },
      } as unknown as RequestPermissionResponse),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(questionAsked("ses_a", "que_three", [first, second, third]))

    await pollUntil(() => harness.replies.length === 1, "3-question batch was never replied")

    // ONE ask, not three. This is the whole point: the user is interrupted once.
    expect(harness.requests).toHaveLength(1)
    const meta = harness.requests[0]!._meta as { questions?: Array<{ question: string }> }
    expect(meta.questions?.map((q) => q.question)).toEqual(["First?", "Second?", "Third?"])
    // Each question carries its OWN options (plus the synthetic Other), so a
    // "Question 1 of 3" client can render every step without another round trip.
    expect((meta.questions as unknown as Array<{ options: Array<{ name: string }> }>)[2]!.options.map((o) => o.name)).toEqual([
      "E",
      "F",
      "Other",
    ])
    // Top-level title/options still describe question 1 exactly as before.
    expect(harness.requests[0]).toMatchObject({
      toolCall: { title: "First?" },
      options: [{ optionId: "0", name: "A" }, { optionId: "1", name: "B" }, { optionId: "2", name: "Other" }],
    })
  })

  it("maps each batched answer back to ITS OWN question's labels, in order", async () => {
    const harness = createHarness(() =>
      Promise.resolve({
        outcome: {
          outcome: "selected",
          optionId: "0",
          // B from question 1, C from question 2, F from question 3 — deliberately
          // NOT all the same index, so a per-question mapping bug cannot pass.
          _meta: { answers: [{ optionId: "1" }, { optionId: "0" }, { optionId: "1" }] },
        },
      } as unknown as RequestPermissionResponse),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(questionAsked("ses_a", "que_map", [first, second, third]))

    await pollUntil(() => harness.replies.length === 1, "batch was never replied")
    expect(harness.replies[0]).toMatchObject({ requestID: "que_map", answers: [["B"], ["C"], ["F"]] })
    expect(harness.rejects).toHaveLength(0)
  })

  it("honours per-question free text and a per-question 'Other' inside one batch", async () => {
    const harness = createHarness(() =>
      Promise.resolve({
        outcome: {
          outcome: "selected",
          optionId: "0",
          _meta: {
            answers: [
              { optionId: "0", answerText: "  neither, revert it  " },
              { optionId: "2" }, // the synthetic Other, with no text
              { optionId: "0" },
            ],
          },
        },
      } as unknown as RequestPermissionResponse),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(questionAsked("ses_a", "que_text", [first, second, third]))

    await pollUntil(() => harness.replies.length === 1, "batch was never replied")
    expect(harness.replies[0]).toMatchObject({ answers: [["neither, revert it"], ["Other"], ["E"]] })
  })

  it("BACK-COMPAT: a single-question request is still one plain prompt, unchanged", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "selected", optionId: "1" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(questionAsked("ses_a", "que_one", [first]))

    await pollUntil(() => harness.replies.length === 1, "single question was never replied")
    expect(harness.requests).toHaveLength(1)
    expect(harness.replies[0]).toMatchObject({ requestID: "que_one", answers: [["B"]] })
    // The batch rides _meta as a 1-element array; the client may ignore it and
    // answer with a bare optionId, exactly as the plan_exit tests above do.
    const meta = harness.requests[0]!._meta as { questions?: unknown[] }
    expect(meta.questions).toHaveLength(1)
  })

  it("re-offers the remainder when a batch reply is SHORT (partial answers)", async () => {
    let round = 0
    const harness = createHarness(() => {
      round += 1
      return Promise.resolve(
        round === 1
          ? ({ outcome: { outcome: "selected", optionId: "0", _meta: { answers: [{ optionId: "1" }] } } } as unknown as RequestPermissionResponse)
          : ({ outcome: { outcome: "selected", optionId: "0", _meta: { answers: [{ optionId: "0" }, { optionId: "0" }] } } } as unknown as RequestPermissionResponse),
      )
    })
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(questionAsked("ses_a", "que_partial", [first, second, third]))

    await pollUntil(() => harness.replies.length === 1, "partial batch was never completed")
    expect(harness.requests).toHaveLength(2)
    // Round 2 re-offers ONLY the two still unanswered.
    const meta = harness.requests[1]!._meta as { questions?: Array<{ question: string }> }
    expect(meta.questions?.map((q) => q.question)).toEqual(["Second?", "Third?"])
    expect(harness.replies[0]).toMatchObject({ answers: [["B"], ["C"], ["E"]] })
  })

  it("rejects the whole batch when the user CANCELS a multi-question prompt", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "cancelled" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(questionAsked("ses_a", "que_batch_cancel", [first, second, third]))

    await pollUntil(() => harness.rejects.length === 1, "cancelled batch was never rejected")
    expect(harness.rejects[0]).toMatchObject({ requestID: "que_batch_cancel", directory: "/workspace" })
    expect(harness.replies).toHaveLength(0)
    // One prompt, one rejection — cancel must not re-ask the remaining questions.
    expect(harness.requests).toHaveLength(1)
  })

  it("rejects rather than inventing an answer when a batch entry is unusable", async () => {
    // null coerces to 0 in JS; an entry like this must NOT silently answer "A".
    for (const bad of [{ optionId: null }, { optionId: "" }, {}, "not-an-object", { optionId: "9" }]) {
      const harness = createHarness(() =>
        Promise.resolve({
          outcome: { outcome: "selected", optionId: "0", _meta: { answers: [{ optionId: "0" }, bad] } },
        } as unknown as RequestPermissionResponse),
      )
      await createSession(harness.session, "ses_a")

      harness.subscription.handle(questionAsked("ses_a", `que_bad_${JSON.stringify(bad)}`, [first, second]))

      await pollUntil(() => harness.rejects.length === 1, `unusable batch entry ${JSON.stringify(bad)} was not rejected`)
      expect(harness.replies).toHaveLength(0)
    }
  })
})

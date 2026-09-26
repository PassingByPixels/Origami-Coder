// t-vs5p1y: the prompt capture computed after the send must report exactly what
// the immediate `record` reports. Two sessions get the same requests, one
// recorded now and one recorded after the send; every reading must be equal.

import { beforeEach, describe, expect, test } from "bun:test"
import { SessionPromptCapture } from "@/session/prompt-capture"

beforeEach(() => SessionPromptCapture.reset())

type Step = {
  at: string
  messages: { role: "user" | "assistant"; content: string }[]
  /** A rewriter names itself before this request is prepared. */
  markBefore?: "tool-aging" | "reminder"
  compactedBefore?: boolean
}

const BIG = "x".repeat(70 * 1024)

const STEPS: Step[] = [
  { at: "2026-09-24T10:00:00.000Z", messages: [{ role: "user", content: "hello" }] },
  {
    at: "2026-09-24T10:00:01.000Z",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: `a big reply ${BIG}` },
    ],
  },
  {
    // An already-sent message comes back rewritten, and the rewriter said so.
    at: "2026-09-24T10:00:02.000Z",
    markBefore: "tool-aging",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "[aged out]" },
      { role: "user", content: "next" },
    ],
  },
  {
    at: "2026-09-24T10:05:00.000Z",
    compactedBefore: true,
    messages: [{ role: "user", content: "summary" }],
  },
]

function prepare(sessionID: string, step: Step, deferred: boolean) {
  if (step.markBefore) SessionPromptCapture.markRewrite(sessionID, step.markBefore)
  if (step.compactedBefore) SessionPromptCapture.markCompacted(sessionID)
  SessionPromptCapture.draft(sessionID, [SessionPromptCapture.part("env", "system text")])
  const input = {
    sessionID,
    capturedAt: step.at,
    model: "test/model",
    base: ["base"],
    finalSystem: ["system text"],
    tools: {} as never,
    messages: step.messages,
  }
  if (deferred) SessionPromptCapture.recordAfterSend(input)
  else SessionPromptCapture.record(input)
}

/** Everything a reader can see, with the session id taken out. */
const reading = (sessionID: string) => ({
  facts: SessionPromptCapture.lastRequest(sessionID),
  prefix: SessionPromptCapture.prefixDigest(sessionID),
  capture: SessionPromptCapture.get(sessionID),
})

describe("prompt capture after the send", () => {
  test("every step reads the same as the immediate record", () => {
    for (const step of STEPS) {
      prepare("ses_now", step, false)
      prepare("ses_later", step, true)
      expect(reading("ses_later")).toEqual(reading("ses_now"))
    }
  })

  test("a mark for the NEXT request, set before the deferred work runs, is not taken by it", () => {
    // Immediate: record step 1, then the next step's mark, then step 2.
    const next = { ...STEPS[2]!, markBefore: undefined }
    prepare("ses_now", STEPS[1]!, false)
    SessionPromptCapture.markRewrite("ses_now", "reminder")
    prepare("ses_now", next, false)
    // Deferred, with no reader in between: step 1's work is still pending when
    // the mark arrives, and runs only when step 2 is recorded.
    prepare("ses_later", STEPS[1]!, true)
    SessionPromptCapture.markRewrite("ses_later", "reminder")
    prepare("ses_later", next, true)
    const later = reading("ses_later")
    const now = reading("ses_now")
    expect(later).toEqual(now)
    // The mark belongs to the request prepared after it.
    expect(now.facts?.divergence?.source).toBe("reminder")
  })
})

// t-po041k. THE ENVELOPE A SUB-AGENT'S QUESTION ARRIVES IN.
//
// Three claims are worth a test here and they are all claims about somebody
// ELSE reading this: the parent's MODEL (which must be told who is asking and
// which tool releases them), the extension's peerEnvelope.ts (which strips the
// frame by regex and must keep matching), and the drawer row (whose label must
// name the same agent the envelope does).
//
// The mirror test is the load-bearing one. `subagentLabel` is declared twice —
// here and in the extension, which cannot import from the engine — so it is
// read out of BOTH files and compared, the house pattern from Part 5 of
// docs/WORKING_ON_ORIGAMI_CODER.md.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AgentBroker } from "@/origami/agent-broker"
import { peerMessage } from "@/session/peer-message"
import { SubagentQuestion } from "@/session/subagent-question"
import { SubagentQuestionRoute } from "@/session/subagent-question-route"

const CHILD = "ses_child_1"

function entry(sessionIds: readonly string[], httpBase = "http://127.0.0.1:4096"): AgentBroker.Entry {
  return {
    version: 1,
    pid: process.pid,
    name: "origami-coder",
    cwd: "C:/repo",
    httpBase,
    kind: "interactive",
    sessionIds: [...sessionIds],
    lastSeen: Date.now(),
  }
}

const input = (over: Partial<SubagentQuestion.DeliverInput> = {}): SubagentQuestion.DeliverInput => ({
  label: "Explore · T2 · audit the bundle",
  sessionID: CHILD,
  requestID: "que_01",
  questions: [{ question: "Which store?", options: ["SQLite", "Postgres"] }],
  ancestors: ["ses_parent"],
  ...over,
})

describe("subagent question envelope", () => {
  test("names the child, the request and the tool that releases it", () => {
    const text = SubagentQuestion.renderSubagentQuestion(input())
    expect(text).toContain('<peer_message from="Explore · T2 · audit the bundle"')
    expect(text).toContain(`kind="${SubagentQuestion.QUESTION_KIND}"`)
    expect(text).toContain("Which store?")
    expect(text).toContain("options: SQLite | Postgres")
    // The one sentence without which the model answers into the chat and the
    // child waits for ever.
    expect(text).toContain('call question_reply with request_id "que_01"')
    expect(text).toContain("cannot read this transcript")
  })

  test("still matches the frame the extension's peerBody strips", () => {
    // Derived from the external thing rather than restated: the regex is read
    // out of the leaf that ships (PeerMessageRow.svelte re-exports it), so a
    // change there fails here.
    const component = fs.readFileSync(
      path.join(__dirname, "../../../vscode/webview/dashboard/components/peerEnvelope.ts"),
      "utf8",
    )
    const source = /const match = (\/.+\/)\.exec/.exec(component)?.[1]
    expect(source).toBeTruthy()
    const body = "Which store?\n   options: SQLite | Postgres"
    const text = SubagentQuestion.renderSubagentQuestion(input())
    // eslint-disable-next-line no-eval -- the literal is read from the shipped component on purpose.
    const pattern: RegExp = eval(source!)
    expect(pattern.exec(text.trim())?.[2]).toBe(body)
  })

  test("a multi-question envelope numbers every question", () => {
    const text = SubagentQuestion.renderSubagentQuestion(
      input({ questions: [{ question: "A?" }, { question: "B?" }] }),
    )
    expect(text).toContain("1. A?")
    expect(text).toContain("2. B?")
    expect(text).toContain("(2 answers, in order)")
  })
})

describe("subagent question label", () => {
  test("mirrors subagentLabel.ts in the extension", () => {
    const shipped = fs.readFileSync(
      path.join(__dirname, "../../../vscode/webview/dashboard/panes/subagentLabel.ts"),
      "utf8",
    )
    // The extension's own rule, lifted out of the file that renders the row.
    const joined = /return \[row\.agentType, subagentShort\(row\), row\.description\]\.filter\(Boolean\)\.join\('(.+)'\)/.exec(
      shipped,
    )?.[1]
    expect(joined).toBe(" · ")
    const short = /return row\.ordinal >= 1 \? `T\$\{row\.ordinal\}` : '(.+)'/.exec(shipped)?.[1]
    expect(short).toBe("T?")

    expect(SubagentQuestion.subagentLabel({ agentType: "Explore", ordinal: 2, description: "audit" })).toBe(
      "Explore · T2 · audit",
    )
    // A missing part is DROPPED, never padded — the extension's rule, asserted
    // on this side so the two cannot drift.
    expect(SubagentQuestion.subagentLabel({ ordinal: 2, description: "audit" })).toBe("T2 · audit")
    expect(SubagentQuestion.subagentLabel({ agentType: "Explore", ordinal: 0 })).toBe("Explore · T?")
  })

  test("reads the description back off either title tool/task.ts writes", () => {
    expect(SubagentQuestionRoute.descriptionOf("audit the bundle (@Explore subagent)")).toBe("audit the bundle")
    expect(SubagentQuestionRoute.descriptionOf("audit the bundle")).toBe("audit the bundle")
  })
})

describe("subagent question delivery", () => {
  test("lands in the nearest ancestor with a chat open, and rides the subagent origin", async () => {
    const posted: { url: string; body: string }[] = []
    const outcome = await SubagentQuestion.deliver(
      { ...input(), ancestors: ["ses_middle", "ses_top"] },
      {
        // The middle session is a sub-agent itself: no window, so the question
        // has to keep climbing.
        locate: async (id) => (id === "ses_top" ? entry(["ses_top"]) : undefined),
        post: async (call) => {
          posted.push(call)
          return true
        },
      },
    )
    expect(outcome).toEqual({ ok: true, sessionID: "ses_top" })
    expect(posted).toHaveLength(1)
    expect(posted[0]!.url).toContain("/session/ses_top/prompt_async")
    const part = JSON.parse(posted[0]!.body).parts[0]
    const origin = peerMessage(part.metadata)
    expect(origin?.subagent).toEqual({
      label: "Explore · T2 · audit the bundle",
      requestID: "que_01",
      sessionID: CHILD,
    })
    // The rider is ADDED to the existing shape, not swapped for it: a client
    // that knows only `from`/`replyTo` still badges the row.
    expect(origin?.from).toBe("Explore · T2 · audit the bundle")
    expect(origin?.replyTo).toBe(CHILD)
  })

  test("refuses when no ancestor has a chat open, rather than reporting success", async () => {
    const outcome = await SubagentQuestion.deliver(input(), {
      locate: async () => undefined,
      post: async () => {
        throw new Error("must not post")
      },
    })
    expect(outcome.ok).toBe(false)
  })

  test("refuses a broker entry that is not on loopback", async () => {
    const outcome = await SubagentQuestion.deliver(input(), {
      locate: async () => entry(["ses_parent"], "http://10.0.0.4:4096"),
      post: async () => {
        throw new Error("must not post off-loopback")
      },
    })
    expect(outcome.ok).toBe(false)
  })

  test("an engine that refuses the POST is not counted as delivered", async () => {
    const outcome = await SubagentQuestion.deliver(input(), {
      locate: async () => entry(["ses_parent"]),
      post: async () => false,
    })
    expect(outcome.ok).toBe(false)
  })
})

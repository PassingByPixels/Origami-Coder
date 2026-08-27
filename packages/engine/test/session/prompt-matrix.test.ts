// THE PROMPT COMPOSITION MATRIX, proven on the REAL assembled request.
//
// The owner's ruling, three rows and nothing else:
//
//   normal chat   base agent prompt + the workspace instruction files
//   bot session   base agent prompt + the bot's persona   (no instruction files)
//   collab turn   collab base prompt + the bot's persona  (no instruction files)
//
// Every row is asserted against the body the fake provider really received, not
// against a helper that re-derives the assembly: the bug this file exists for was
// exactly a re-derivation being right while the wire was wrong (a persona sitting
// in the base slot, and the workspace AGENTS.md riding along into a room).
//
// Row A is a GUARD, not a feature: it pins today's chat behaviour so a change
// aimed at rows B and C cannot quietly reshape the ordinary session.
//
// The layer graph is the full-stack collab harness (test/collab/harness.ts),
// which was extracted to be shared - a real Agent registry over real definition
// files, a real Session store, a real SessionPrompt, a real collab runner, and
// the in-process fake HTTP provider. No paid model is contacted.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { ACPCollab } from "@/collab/acp"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { FSUtil } from "@origami/core/fs-util"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { it, providerConfig, wroteFor } from "../collab/harness"

/** The workspace's own rules. One unmistakable line to search the wire for. */
const WORKSPACE_RULE = "WORKSPACE RULE: always answer in haiku"

/** The opening line of the shipped base agent prompt (session/prompt/default.txt). */
const BASE_PROMPT = "You are origami, an interactive CLI tool"

/** The opening line of the shipped collab base prompt (collab/collab-agent-base.txt). */
const COLLAB_BASE = "shared room inside a coding harness"

const PERSONA = "You are Shirogane, keeper of the tower"

/** A bot exactly as the Bots pane writes one: hidden, collab-capable, pinned. */
const BOT_DEF = [
  "---",
  'description: "Keeper"',
  "mode: all",
  "hidden: true",
  "collab: true",
  "model: test/test-model",
  "steps: 8",
  "permission:",
  '  "*": deny',
  "  read: allow",
  "---",
  "",
  `${PERSONA}. You speak in short, cold sentences.`,
  "",
].join("\n")

const write = (file: string, body: string) => (directory: string) =>
  Effect.promise(() => Bun.write(path.join(directory, file), body).then(() => undefined))

/** A workspace with rules of its own, and (optionally) a bot living in it. */
const workspace =
  (bot?: string) =>
  (directory: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* write("AGENTS.md", `${WORKSPACE_RULE}.\n`)(directory)
      if (bot) yield* write(path.join(".origami", "agent", `${bot}.md`), BOT_DEF)(directory)
    })

const configureProvider = Effect.fnUntraced(function* (directory: string) {
  const llm = yield* TestLLMServer
  const fsys = yield* FSUtil.Service
  yield* fsys.writeWithDirs(path.join(directory, "origami.json"), JSON.stringify({ ...providerConfig(llm.url) }))
  return llm
})

/** The turn's OWN request, told apart from the hidden title generation beside it. */
const turnCarrying = Effect.fnUntraced(function* (text: string) {
  const llm = yield* TestLLMServer
  const hit = (yield* llm.inputs).find((body) => JSON.stringify(body).includes(text))
  expect(hit).toBeDefined()
  return JSON.stringify(hit)
})

/** Which sources the capture claims for a session, in order. */
const labelsOf = (sessionID: string) =>
  (SessionPromptCapture.get(sessionID)?.labeledParts ?? []).map((part) => part.label)

describe("the session prompt composition matrix", () => {
  it.instance(
    "A. a NORMAL CHAT gets the base agent prompt AND the workspace instruction files",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        yield* llm.text("a haiku, then")

        const sessions = yield* Session.Service
        const prompts = yield* SessionPrompt.Service
        const chat = yield* sessions.create({ title: "Ordinary" })
        yield* prompts.prompt({
          sessionID: chat.id,
          parts: [{ type: "text", text: "who are you" }],
        })

        const sent = yield* turnCarrying("who are you")
        expect(sent).toContain(BASE_PROMPT)
        expect(sent).toContain(WORKSPACE_RULE)
        // …and no collab layer leaked into an ordinary chat.
        expect(sent).not.toContain(COLLAB_BASE)

        // The capture reports the same two sources it really sent.
        expect(labelsOf(chat.id)).toContain("base-or-agent-prompt")
        expect(labelsOf(chat.id)).toContain("instructions")
      }),
    { init: workspace() },
    60_000,
  )

  it.instance(
    "B. a BOT SESSION gets the base agent prompt AND the persona, and NOT the workspace instruction files",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        yield* llm.text("the gate is shut")

        const sessions = yield* Session.Service
        const prompts = yield* SessionPrompt.Service
        const chat = yield* sessions.create({ title: "Keeper chat", agent: "keeper" })
        yield* prompts.prompt({
          sessionID: chat.id,
          agent: "keeper",
          parts: [{ type: "text", text: "what persona are you" }],
        })

        const sent = yield* turnCarrying("what persona are you")
        // The persona COMPOSES on top of the base prompt - it never replaces it.
        expect(sent).toContain(BASE_PROMPT)
        expect(sent).toContain(PERSONA)
        // The workspace's own rules are not a character's to read.
        expect(sent).not.toContain(WORKSPACE_RULE)
        // A bot session is not a room.
        expect(sent).not.toContain(COLLAB_BASE)

        // The capture the owner reads says the same thing: both halves of the
        // base slot are there, and no instruction block is claimed.
        expect(labelsOf(chat.id).filter((label) => label === "base-or-agent-prompt")).toHaveLength(2)
        expect(labelsOf(chat.id)).not.toContain("instructions")
      }),
    { init: workspace("keeper") },
    60_000,
  )

  it.instance(
    "C. a COLLAB TURN gets the collab base AND the persona, and NOT the workspace instruction files",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        yield* llm.pushMatch(wroteFor("keeper"), reply().text("understood").stop().item())

        const store = yield* CollabStore.Service
        const runner = yield* CollabRunner.Service
        const collab = yield* store.create({ title: "Roomed", agentSlugs: ["keeper"] })
        yield* ACPCollab.post(directory, { collabId: collab.id, text: "go" })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        const llmHits = yield* llm.hits
        const hit = llmHits.find((entry) => wroteFor("keeper")(entry))
        expect(hit).toBeDefined()
        const sent = JSON.stringify(hit?.body)

        expect(sent).toContain(COLLAB_BASE)
        expect(sent).toContain(PERSONA)
        // A room agent gets the ROOM's base, never the chat one.
        expect(sent).not.toContain(BASE_PROMPT)
        expect(sent).not.toContain(WORKSPACE_RULE)

        const sessions = yield* Session.Service
        const child = (yield* sessions.list()).find((session) => session.title === "Roomed — keeper")
        expect(child).toBeDefined()
        expect(labelsOf(child!.id)).toContain("collab-agent-base")
        expect(labelsOf(child!.id)).toContain("base-or-agent-prompt")
        expect(labelsOf(child!.id)).not.toContain("instructions")
      }),
    { init: workspace("keeper") },
    60_000,
  )
})

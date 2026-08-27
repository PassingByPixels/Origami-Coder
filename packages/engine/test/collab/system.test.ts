// The collab SYSTEM layers. Two questions, and neither can be answered by
// reading the runner:
//
//  1. does a `collab-agent-base.md` in the global config dir actually replace
//     the shipped base prompt, and does a half-cleared buffer fail SAFE?
//  2. when a collab turn runs, what does the model really receive, and in what
//     order?
//
// (2) is asserted against the REAL `LLMRequestPrep.prepare` - the same function
// the prompt loop calls - because the ordering rule lives there and nowhere
// else. Composing the layers here and checking the composition would prove only
// that this file can concatenate strings.

import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { jsonSchema } from "ai"
import { CollabSystem } from "@/collab/collab-system"
import { CollabRunner } from "@/collab/runner"
import { Runner } from "@/effect/runner"
import { LLMRequestPrep } from "@/session/llm/request"

const previous = process.env["ORIGAMI_CONFIG_DIR"]
const directories: string[] = []

const withConfigDir = (files: Record<string, string> = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "collab-system-"))
  directories.push(directory)
  process.env["ORIGAMI_CONFIG_DIR"] = directory
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents, "utf8")
  return directory
}

afterEach(() => {
  if (previous === undefined) delete process.env["ORIGAMI_CONFIG_DIR"]
  else process.env["ORIGAMI_CONFIG_DIR"] = previous
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("collab agent base prompt", () => {
  it("states its identity: one agent in a shared room, tools per permission, final text is the message", () => {
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("one agent in a shared room")
    expect(text).toContain("Your permissions decide what you can actually do")
    expect(text).toContain("your message to the room")
  })

  it("states the protocol: prose never wakes anyone, only a tool routes work", () => {
    // The core rule the v1 text got backwards: talking is free and wakes
    // nobody, and a name inside prose is a reference, never a call.
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("tools move work, prose does not")
    expect(text).toContain("Writing @name in prose is a REFERENCE - it wakes nobody")
    expect(text).toContain("ask(to, task, context, expect)")
    expect(text).toContain("handoff(to, task, context)")
    expect(text).toContain("done(summary?)")
    expect(text).toContain("silence is valid")
  })

  it("states ask discipline: everything inside task/context, a concrete expect, no identical retries", () => {
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("INSIDE task and context")
    expect(text).toContain("Keep expect concrete")
    expect(text).toContain("Never retry the identical call")
  })

  it("tells the agent a brief may be LONG, and that an unwritten spec does not exist", () => {
    // Test 4's brief pointed at "the spec I posted in the room", which had
    // never been written. A one-line brief is the failure mode, not a long one.
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("A spec you did not write down does not exist")
    expect(text).toContain("Write as much as the work needs")
    expect(text).toContain("too short is the common failure, never too long")
  })

  it("gives the interim-doc pattern for a brief longer than a page", () => {
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("longer than a page, write it to a file in the workspace")
    expect(text).toContain("put the path in task")
  })

  it("separates ask from hand-off by whether the answer has to come back", () => {
    // Test 4: the human asked deepseek to verify crane's work; deepseek chose
    // handoff, so the verification never returned to anyone.
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("verify, validate or report onward stays an ask - only an ask returns")
    expect(text).toContain("The next step is theirs and you do not need the result")
  })

  it("points the agent at the board id its own brief names", () => {
    expect(CollabSystem.AGENT_BASE_BUILTIN).toContain("Your brief names the board task it opened")
  })

  it("absorbs the room manual's author rule: others' messages are THEIR words", () => {
    // The one rule the deleted `collab-base.md` carried that this file did not.
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("each labelled with its author")
    expect(text).toContain("never speak for another agent")
    expect(text).toContain("Address the stream, not the system")
  })

  it("states the task board discipline: add, claim, done-with-evidence, accept-when-verified, reopen", () => {
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("task_add")
    expect(text).toContain("task_claim")
    expect(text).toContain("Claim before starting; done with evidence; accept after verifying")
    expect(text).toContain("task_accept")
    expect(text).toContain("task_reopen")
    // Both sharpened from the UAT Atlas long-form run: deepseek task_add'd
    // every slice it then handed off (4 orphan open tasks), and never accepted
    // a single verified result.
    expect(text).toContain("NEVER task_add a piece you are about to hand off")
    expect(text).toContain("task_accept or task_reopen(id, note)")
  })

  it("names who routes next, by how the turn began - the stall v1 never addressed", () => {
    // The Test 4 stall in one stanza: an agent that was handed work and simply
    // talked left the issuer asleep, and a driving agent that ended without
    // routing stopped the whole chain.
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("You were ASKED: your reply IS the routing")
    expect(text).toContain("You were HANDED work: finish it, then task_done(id, result)")
    expect(text).toContain("ending your turn without routing it is a failure")
  })

  it("states honesty: the trace is visible, an empty trace on a claimed build is fabrication", () => {
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("visible to the room as a trace")
    expect(text).toContain("reads as fabrication")
    expect(text).toContain("If a tool fails twice, stop and say exactly where you are")
  })

  it("states verification: prove a claim with a check, evidence goes in the result", () => {
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("run the check that proves it")
    expect(text).toContain("Put the evidence in the result, not a claim")
  })

  it("keeps message discipline: no bare acknowledgements, reply only into the room", () => {
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("No bare acknowledgements")
    expect(text).toContain("Communicate with text, never through code comments")
  })

  it("teaches the IMAGE protocol both ways: describe what you see, never pretend you saw it", () => {
    // The engine shows an image only to a def that declared vision, and tells
    // every other agent it is there. Both halves need saying, or a blind agent
    // answers about a picture it was only told about.
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("# Images")
    expect(text).toContain("If your model has vision, look at the image")
    expect(text).toContain("other participants may not be able to see it")
    expect(text).toContain("never pretend to have seen it")
  })

  it("tells the agent to ASK rather than guess when the call is not its own", () => {
    const text = CollabSystem.AGENT_BASE_BUILTIN
    expect(text).toContain("do not silently guess")
    expect(text).toContain("A quick question is cheap; a wrong assumption stalls the whole chain")
  })

  it("is plain ASCII - it is a prompt file a user is invited to copy and edit", () => {
    const bad = [...CollabSystem.AGENT_BASE_BUILTIN].filter((c) => c.charCodeAt(0) > 127)
    expect(bad).toEqual([])
  })

  it("uses the built-in when the user has written no override", () => {
    withConfigDir()
    expect(CollabSystem.agentBaseOverride()).toBeUndefined()
    expect(CollabSystem.agentBase()).toBe(CollabSystem.AGENT_BASE_BUILTIN)
  })

  it("lets a collab-agent-base.md in the global config dir REPLACE the built-in", () => {
    withConfigDir({ "collab-agent-base.md": "# My agents\nSpeak plainly.\n" })
    expect(CollabSystem.agentBase()).toBe("# My agents\nSpeak plainly.\n")
    expect(CollabSystem.agentBase()).not.toContain("shared room inside a coding harness")
  })

  it("resolves the override path under whatever config dir is active NOW", () => {
    const directory = withConfigDir()
    expect(CollabSystem.agentBasePath()).toBe(path.join(directory, "collab-agent-base.md"))
  })

  it("ignores a whitespace-only override instead of sending an empty base prompt", () => {
    // Saving a half-cleared buffer must not put an agent in the stream with no
    // statement of what it is - that is worse than any override it meant.
    withConfigDir({ "collab-agent-base.md": "   \n\t\n" })
    expect(CollabSystem.agentBase()).toBe(CollabSystem.AGENT_BASE_BUILTIN)
  })

  it("falls back to the built-in when the config dir does not exist", () => {
    process.env["ORIGAMI_CONFIG_DIR"] = path.join(os.tmpdir(), "collab-system-absent-dir")
    expect(CollabSystem.agentBase()).toBe(CollabSystem.AGENT_BASE_BUILTIN)
  })

  it("is the ONLY collab prompt file - a leftover collab-base.md changes nothing", () => {
    // The room manual and its override seam are gone. A user who still has the
    // old file on disk must not be silently running a second, stale rulebook.
    withConfigDir({ "collab-base.md": "[STALE ROOM MANUAL]" })
    expect(CollabSystem.agentBase()).toBe(CollabSystem.AGENT_BASE_BUILTIN)
    expect(CollabSystem.agentBase()).not.toContain("[STALE ROOM MANUAL]")
  })
})

// --- What the model actually gets. The layers are provided the way the runner
// provides them (on the fiber) and read the way the request layer reads them.

const sessionID = "ses_collab_test"

const model = {
  id: "anthropic/claude-test",
  providerID: "anthropic",
  api: { id: "claude-test", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
  name: "claude-test",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0.03, output: 0.06, cache: { read: 0.001, write: 0.002 } },
  limit: { context: 200_000, output: 8_192 },
  status: "active",
  options: {},
  headers: {},
} as any

/** An ordinary definition with a prompt of its own. Not a bot. */
const AGENT = { name: "collab-crane", mode: "subagent", prompt: "[PERSONA]", options: {}, permission: [] } as any

/** The def shape the Bots pane writes: non-native, hidden, collab-capable. */
const BOT = { ...AGENT, native: false, hidden: true, options: { collab: true } } as any

const prepared = (layers: CollabSystem.Layers | undefined, system: string[] = ["[ENVIRONMENT]"], agent: any = AGENT) =>
  Effect.runPromise(
    LLMRequestPrep.prepare({
      user: {
        id: "msg_user-test",
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "collab-crane",
        model: { providerID: "anthropic", modelID: "claude-test" },
      } as any,
      sessionID,
      model,
      agent,
      system,
      messages: [{ role: "user", content: "[ENVELOPE]" }],
      tools: { read: { description: "Read a file", inputSchema: jsonSchema({ type: "object", properties: {} }) } },
      provider: { id: "anthropic", options: {} } as any,
      auth: undefined,
      plugin: {
        trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
        list: () => Effect.succeed([]),
        init: () => Effect.void,
      } as any,
      flags: { outputTokenMax: 32_000, client: "test" } as any,
      isWorkflow: false,
    }).pipe(Effect.provideService(CollabSystem.Turn, layers)),
  )

const layersFor = (title: string) =>
  CollabRunner.systemLayers({
    title,
    agentSlug: "collab-crane",
    displayName: "Crane",
    roster: [
      { agentSlug: "collab-crane", displayName: "Crane" },
      { agentSlug: "collab-heron", displayName: "Heron" },
    ],
    lead: null,
    objective: null,
    hops: { remaining: 6 },
    tasks: [],
  })

describe("what a collab turn's system prompt carries", () => {
  it("puts the collab base ABOVE the persona and the room state BELOW it", async () => {
    withConfigDir()
    const result = await prepared(layersFor("Ship it"))
    const system = result.system.join("\n")

    const order = [
      system.indexOf("shared room inside a coding harness"), // collab-agent-base
      system.indexOf("[PERSONA]"),
      system.indexOf('You are @collab-crane ("Crane")'), // room state
      system.indexOf("[ENVIRONMENT]"),
    ]
    for (const index of order) expect(index).toBeGreaterThan(-1)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it("sends ONE prose layer, not two - there is no room manual any more", async () => {
    withConfigDir()
    const system = (await prepared(layersFor("Ship it"))).system.join("\n")

    // The deleted layer, by its own heading and by the rules it duplicated.
    expect(system).not.toContain("How this collab works")
    expect(system).not.toContain("Rules of the room:")
    // Said once, in the base prompt, and not again below the persona.
    expect(system.split("never speak for another agent")).toHaveLength(2)
  })

  it("carries a user's override of the base layer, still above the persona", async () => {
    withConfigDir({ "collab-agent-base.md": "[MY BASE]" })
    const system = (await prepared(layersFor("Ship it"))).system.join("\n")

    expect(system).not.toContain("shared room inside a coding harness")
    expect(system.indexOf("[MY BASE]")).toBeLessThan(system.indexOf("[PERSONA]"))
    // The room state is never overridable: an agent that is wrong about the
    // roster @mentions handles that do not exist.
    expect(system.indexOf("[PERSONA]")).toBeLessThan(system.indexOf("- @collab-heron: Heron"))
  })

  it("gives an ORDINARY chat neither layer", async () => {
    withConfigDir()
    const system = (await prepared(undefined)).system.join("\n")

    expect(system).toContain("[PERSONA]")
    expect(system).not.toContain("shared room inside a coding harness")
    expect(system).not.toContain('You are @collab-crane ("Crane")')
  })

  it("leaves the user message carrying the messages alone - the rules are not something a participant said", async () => {
    withConfigDir()
    const result = await prepared(layersFor("Ship it"))
    const user = result.messages.filter((message) => message.role === "user")

    expect(user.map((message) => message.content)).toEqual(["[ENVELOPE]"])
  })

  it("survives the FORK the prompt loop runs behind", async () => {
    // The runner provides the layers on its own fiber, but `SessionPrompt.loop`
    // hands the work to `SessionRunState.ensureRunning`, which forks it into a
    // separate scope (src/effect/runner.ts). If that fork did not inherit the
    // fiber context, every collab turn would silently lose both layers and the
    // unit assertions above would still pass. This runs the real primitive.
    const layers = layersFor("Forked")
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          const runner = Runner.make<CollabSystem.Layers | undefined>(scope)
          return yield* runner.ensureRunning(CollabSystem.Turn)
        }),
      ).pipe(Effect.provideService(CollabSystem.Turn, layers)),
    )

    expect(seen).toEqual(layers)
  })
})

// THE COMPOSITION MATRIX, at the layer that owns the BASE SLOT.
//
//   normal chat   base agent prompt + the workspace instruction files
//   bot session   base agent prompt + persona   (no instruction files)
//   collab turn   collab base prompt + persona  (no instruction files)
//
// Only the first half of each row - which base sits above the persona - is
// decided here. The instruction files are excluded at the SOURCE, in
// session/prompt.ts, so that the transparency capture cannot report a block
// that never went out; the end-to-end proof for all three rows, asserted on the
// real request body, is test/session/prompt-matrix.test.ts.
describe("which base prompt sits above the persona", () => {
  it("renders a CHAT turn's system exactly as before - a pinned fixture, byte for byte", async () => {
    withConfigDir()
    const result = await prepared(undefined)
    // No collab layers, and this def is not a bot: the persona joins directly
    // with the rest of `input.system`, the same expression as always. Pinned so
    // a refactor that touches this path shows up as a diff here, not as a
    // silent reordering the model receives.
    expect(result.system).toEqual(["[PERSONA]\n[ENVIRONMENT]"])
  })

  it("puts the CHAT base prompt above a BOT's persona - a persona composes, it never replaces", async () => {
    withConfigDir()
    // The shape the Bots pane writes: non-native, hidden, collab-capable.
    const system = (await prepared(undefined, ["[ENVIRONMENT]"], BOT)).system.join("\n")

    expect(system).toContain("You are origami, an interactive CLI tool")
    expect(system.indexOf("You are origami, an interactive CLI tool")).toBeLessThan(system.indexOf("[PERSONA]"))
    // A bot session is not a room: it takes the chat base, never the collab one.
    expect(system).not.toContain("shared room inside a coding harness")
  })

  it("sends a bot with an EMPTY body one base prompt, not two", async () => {
    withConfigDir()
    // A definition can carry frontmatter and no persona at all. The composed
    // expression must not then stack the base prompt on top of itself.
    const system = (await prepared(undefined, ["[ENVIRONMENT]"], { ...BOT, prompt: undefined })).system.join("\n")

    expect(system.split("You are origami, an interactive CLI tool")).toHaveLength(2)
  })

  it("gives a bot in a ROOM the collab base instead - the room's base wins, and only one base is sent", async () => {
    withConfigDir()
    const system = (await prepared(layersFor("Ship it"), ["[ENVIRONMENT]"], BOT)).system.join("\n")

    expect(system.indexOf("shared room inside a coding harness")).toBeLessThan(system.indexOf("[PERSONA]"))
    expect(system).not.toContain("You are origami, an interactive CLI tool")
  })

  it("leaves an ORDINARY agent definition alone - only a bot composes", async () => {
    withConfigDir()
    // Same file shape minus `collab:`, which is what a vision-profile def and a
    // hand-written subagent look like. Its prompt still replaces the base.
    const system = (await prepared(undefined, ["[ENVIRONMENT]"], { ...BOT, options: {} })).system.join("\n")

    expect(system).not.toContain("You are origami, an interactive CLI tool")
    expect(system).toContain("[PERSONA]")
  })
})

// The end-to-end proof for the transparency capture: the REAL prompt loop, a
// real request over HTTP to a fake provider, and then the question that the
// unit tests can only simulate — does what the store holds match what actually
// went over the wire?
//
// The two halves of the capture are written in different files (the labelled
// parts in session/prompt.ts, the prepared output in session/llm/request.ts).
// Nothing but a full loop proves they pair up, so that is what this runs.

import { ConfigV1 } from "@origami/core/v1/config/config"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "@/env"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { SessionReminders } from "@/session/reminders"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { FSUtil } from "@origami/core/fs-util"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { SystemPrompt } from "@/session/system"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Ripgrep } from "@origami/core/ripgrep"
import { Format } from "@/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

// Same stubs prompt.test.ts uses: summarisation off (it is a SECOND model call
// on the same session, and this test is about the first one), no LSP, no MCP.
const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  testLLMServerNode,
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const providerCfg = (url: string): Partial<ConfigV1.Info> => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
  return msg
})

const systemFromBody = (body: unknown): string =>
  ((body as { messages?: { role: string; content: string }[] })?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n")

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("")
}

/** The LAST user message of a request — where the memory blocks are delivered. */
const lastUserFromBody = (body: unknown): string => {
  const msgs = (body as { messages?: { role: string; content: unknown }[] })?.messages ?? []
  const user = msgs.filter((m) => m.role === "user")
  return textOf(user[user.length - 1]?.content)
}

it.instance(
  "the capture matches the system prompt the provider really received",
  () =>
    Effect.gen(function* () {
      SessionPromptCapture.reset()
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      const fs = yield* FSUtil.Service
      // A project instruction file, so `instructions` is a non-empty labelled part.
      yield* fs.writeWithDirs(path.join(dir, "AGENTS.md"), "PROJECT RULE: always answer in haiku.")
      yield* fs.writeWithDirs(
        path.join(dir, "origami.json"),
        JSON.stringify({ ...providerCfg(llm.url) }),
      )
      // A memory store, so there is a TAIL part to check assertion 3 against.
      // Without it `tailParts` is empty and the half of the invariant that
      // guards the prefix would pass while asserting nothing.
      yield* fs.writeWithDirs(
        path.join(dir, ".origami", "memory", "MEMORY.md"),
        "# Memory Index\n\n## References\n- [gitea](gitea.md) - the git host\n",
      )

      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.hang
      yield* user(chat.id, "hello")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for the model request", "10 seconds")
      const hits = yield* llm.hits
      yield* Fiber.interrupt(fiber)

      const capture = SessionPromptCapture.get(chat.id)
      expect(capture).not.toBeNull()

      // 1. The captured final system IS the system content the provider got.
      expect(capture!.finalSystem.map((b) => b.text).join("\n")).toBe(systemFromBody(hits[0]?.body))

      // 2. The labelled parts are the real ones — the project AGENTS.md text is
      //    present AND attributed, which sizes alone could never tell you.
      const instructions = capture!.labeledParts.filter((p) => p.label === "instructions")
      expect(instructions.some((p) => p.text.includes("always answer in haiku"))).toBe(true)
      expect(capture!.labeledParts[0]!.label).toBe("base-or-agent-prompt")
      expect(capture!.labeledParts[0]!.chars).toBeGreaterThan(0)

      // 3. Every labelled part really is inside what was sent — AT THE PLACE THE
      //    CAPTURE CLAIMS. A `system` part must be in the system prompt; a `tail`
      //    part must NOT be, because it rides the message list instead (that is
      //    the whole point of moving memory out of the cached prefix). Asserting
      //    only the first half would go quietly vacuous the moment a tail part
      //    exists, which is exactly how this guard nearly died.
      const sent = systemFromBody(hits[0]?.body)
      const systemParts = capture!.labeledParts.filter((p) => p.delivery === "system")
      const tailParts = capture!.labeledParts.filter((p) => p.delivery === "tail")
      for (const p of systemParts) expect(sent).toContain(p.text)
      for (const p of tailParts) expect(sent).not.toContain(p.text)
      expect(systemParts.length).toBeGreaterThan(0)
      // ...and the fixture really does produce a tail part, so the line above it
      // is a real assertion rather than an empty loop.
      expect(tailParts.map((p) => p.label)).toContain("memory")

      // 4. The tool inventory is the one the request carried.
      const toolNames = ((hits[0]?.body as { tools?: { function?: { name?: string } }[] })?.tools ?? [])
        .map((t) => t.function?.name)
        .filter((n): n is string => typeof n === "string")
      expect(capture!.tools.map((t) => t.name)).toEqual(toolNames.toSorted((a, b) => a.localeCompare(b)))
      expect(capture!.tools.length).toBeGreaterThan(0)
      expect(capture!.model).toBe("test/test-model")
    }),
  // `git: true` is what makes the memory fixture above count: the store is found
  // under `ctx.worktree`, and without a repo that is not the fixture's directory,
  // so the seeded MEMORY.md would be invisible and assertion 3's tail half would
  // silently assert nothing.
  { git: true },
  20_000,
)

// THE STALL. While the memory index lived in the system prompt, every provider's
// prefix cache was invalidated by a single remembered fact —
// measured at 7.9% cache-hit on the step after a remember against 96-99% after
// every other tool, and 190-240s steps at the worst. So the requirement is a
// pair: the system prefix must survive a memory write UNCHANGED, and the model
// must still be given the memory index. Either half alone is a bad fix.
//
// SCOPE, stated honestly: `remember` is the tool a USER hits this with, not the
// only way to hit it. The real class is any prompt content that can differ
// between two steps of one conversation, and `Instruction.read` memoises
// nothing — so an agent editing AGENTS.md mid-session, or a remote instruction
// URL that times out for one step (instruction.ts swallows the error to "",
// dropping the whole block), busts the prefix exactly the same way. Those are
// NOT fixed here. Human-authored rules arguably belong in the prefix; a flapping
// remote URL does not, and is worth its own fix.
it.instance(
  "a remembered fact leaves the system prefix byte-identical, and the index still reaches the model",
  () =>
    Effect.gen(function* () {
      SessionPromptCapture.reset()
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      const fs = yield* FSUtil.Service
      const memdir = path.resolve(path.join(dir, ".origami", "memory"))

      yield* fs.writeWithDirs(path.join(dir, "AGENTS.md"), "PROJECT RULE: always answer in haiku.")
      yield* fs.writeWithDirs(path.join(dir, "origami.json"), JSON.stringify({ ...providerCfg(llm.url) }))
      // A store that already has one topic, so BOTH requests carry memory and
      // the only difference between them is the entry `remember` adds.
      yield* fs.writeWithDirs(
        path.join(memdir, "MEMORY.md"),
        "# Memory Index\n\n## References\n- [gitea](gitea.md) - the git host\n",
      )

      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Step 1 writes a NEW topic into the index; step 2 just answers.
      yield* llm.tool("remember", { fact: "the flock map lives in .origami/map", topic: "flock-map" })
      yield* llm.text("done")
      yield* user(chat.id, "remember where the flock map lives")
      yield* prompt.loop({ sessionID: chat.id })
      const hits = (yield* llm.hits).filter((h) => !JSON.stringify(h.body).includes("Generate a title"))
      expect(hits.length).toBeGreaterThanOrEqual(2)

      // The index really did change — otherwise this test proves nothing.
      const index = yield* fs.readFileString(path.join(memdir, "MEMORY.md"))
      expect(index).toContain("[flock-map](flock-map.md)")
      expect(index).toContain("[gitea](gitea.md)")

      // 1. THE FIX: the cached prefix is untouched by the write.
      expect(systemFromBody(hits[1]?.body)).toBe(systemFromBody(hits[0]?.body))
      // ...because the memory never rode in it in the first place.
      expect(systemFromBody(hits[1]?.body)).not.toContain("Memory Index")

      // 2. THE GUARD: the model is still given the index and the recall footer,
      //    at the tail. A fix that blinds the agent to its own memory is worse
      //    than the stall it cures.
      const tail = lastUserFromBody(hits[1]?.body)
      expect(tail).toContain("# Memory Index")
      expect(tail).toContain("- [gitea](gitea.md) - the git host")
      expect(tail).toContain("[flock-map](flock-map.md)")
      expect(tail).toContain("Read the topic file with the read tool for detail before acting on a hook.")
      expect(tail).toContain(`Memory directory: ${memdir}`)

    }),
  { git: true },
  30_000,
)

// THE SUB-AGENT CACHE PIN. Two sub-agent sessions grew to 225k of context while
// the provider's `cache.read` never moved past the system+tools boundary: every
// step re-billed the whole body. The cause was the memory block being FOLDED
// into the last user message on step 1 and standing alone from step 2 - and a
// sub-agent has exactly ONE user message for its whole life (tool/task.ts
// prompts once), so that message IS the head of the conversation. A prefix cache
// matches from byte 0, so a head that changes between two steps throws the body
// away.
//
// The requirement is therefore a pair, and both halves are asserted below:
//   1. Every step of one turn sends a BYTE-IDENTICAL conversation head, even
//      when the memory store is rewritten mid-turn (this turn's step 1 calls
//      `remember`, which rewrites the index the next step reads).
//   2. The updated memory still reaches the model - a fix that freezes the
//      agent's view of its own store is worse than the cache miss it cures.
//
// The head is checked on the WIRE bodies as well as on the instrument's own
// digests: the digests are the thing a maintainer will read, and a guard that
// only trusts them would pass if the instrument itself were wrong.
it.instance(
  "every step of a turn sends the same conversation head, even when memory is rewritten mid-turn",
  () =>
    Effect.gen(function* () {
      SessionPromptCapture.reset()
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      const fs = yield* FSUtil.Service
      const memdir = path.resolve(path.join(dir, ".origami", "memory"))

      yield* fs.writeWithDirs(path.join(dir, "AGENTS.md"), "PROJECT RULE: always answer in haiku.")
      yield* fs.writeWithDirs(path.join(dir, "origami.json"), JSON.stringify({ ...providerCfg(llm.url) }))
      yield* fs.writeWithDirs(
        path.join(memdir, "MEMORY.md"),
        "# Memory Index\n\n## References\n- [gitea](gitea.md) - the git host\n",
      )

      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Step 1 rewrites the memory index, step 2 answers. The rewrite is what
      // makes the head assertion mean something: the block the engine appends
      // really is different on the two steps.
      yield* llm.tool("remember", { fact: "the flock map lives in .origami/map", topic: "flock-map" })
      yield* llm.text("done")
      yield* user(chat.id, "remember where the flock map lives")
      yield* prompt.loop({ sessionID: chat.id })

      const hits = (yield* llm.hits).filter((h) => !JSON.stringify(h.body).includes("Generate a title"))
      expect(hits.length).toBeGreaterThanOrEqual(2)

      const bodyMessages = (body: unknown) =>
        (body as { messages?: { role: string; content: unknown }[] })?.messages ?? []
      // Index 0 is the system message, 1 is the user's own turn - the entire
      // conversation body a sub-agent ever has.
      const head = hits.map((h) => JSON.stringify(bodyMessages(h.body).slice(0, 2)))
      for (const entry of head) expect(entry).toBe(head[0]!)
      // The fixture really did put a user message there, so the line above is
      // not comparing two empty slices.
      expect(bodyMessages(hits[0]?.body)[1]?.role).toBe("user")

      // 1. THE INSTRUMENT SAYS THE SAME. Two steps are retained, so both are
      //    here; the second one's first difference must fall PAST the user's
      //    turn. `divergenceMessage` is 2 or more: the memory message from the
      //    step before has been replaced by the model's real reply, which is an
      //    append at the tail, not a rewrite of the head.
      const capture = SessionPromptCapture.get(chat.id)
      expect(capture!.steps).toHaveLength(2)
      const [first, second] = capture!.steps
      expect(second!.step).toBe(first!.step + 1)
      expect(second!.divergenceMessage).toBeGreaterThanOrEqual(2)
      expect(second!.messages[1]!.hash).toBe(first!.messages[1]!.hash)
      expect(second!.messages[0]!.hash).toBe(first!.messages[0]!.hash)

      // 2. THE GUARD. The rewritten index still reaches the model on the very
      //    next step, and again on the next TURN.
      expect(lastUserFromBody(hits[1]?.body)).toContain("[flock-map](flock-map.md)")

      yield* llm.text("second turn")
      yield* user(chat.id, "and now?")
      yield* prompt.loop({ sessionID: chat.id })
      const later = (yield* llm.hits).filter((h) => !JSON.stringify(h.body).includes("Generate a title"))
      expect(later.length).toBeGreaterThan(hits.length)
      expect(lastUserFromBody(later[later.length - 1]?.body)).toContain("[flock-map](flock-map.md)")
    }),
  { git: true },
  30_000,
)

// THE SECOND HEAD REWRITER: session reminders. Same defect as the memory fold,
// a different writer. `SessionReminders.apply` used to push its in-memory text
// onto the LAST USER MESSAGE - for a sub-agent, the only one it has - and that
// text is recomputed on every step from live state. So it changed the head
// whenever it changed at all, and it changes often:
//   - a stored todo list edited mid-turn (this test), and
//   - the `WAIT_LOOP_STREAK` gate, which fires at 3 and 6 and is silent at 4
//     and 5 - measured at 4 head rewrites in 8 requests on a `task_list` loop.
//
// The turn below is the toggle in its simplest deterministic form: step 1 has
// no `todowrite` in the window, so the reminder fires; step 1 CALLS todowrite,
// so by step 2 the model can see the list again and the reminder goes quiet.
// The head must not notice, and the reminder must still have been delivered.
it.instance(
  "a reminder that fires on one step and not the next leaves the conversation head untouched",
  () =>
    Effect.gen(function* () {
      SessionPromptCapture.reset()
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      const fs = yield* FSUtil.Service

      yield* fs.writeWithDirs(path.join(dir, "AGENTS.md"), "PROJECT RULE: always answer in haiku.")
      yield* fs.writeWithDirs(path.join(dir, "origami.json"), JSON.stringify({ ...providerCfg(llm.url) }))

      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const todo = yield* Todo.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // A stored list with NO todowrite call in the window - the post-compaction
      // shape, and the one the reminder exists for.
      yield* todo.update({
        sessionID: chat.id,
        todos: [{ content: "find the bug", status: "in_progress", priority: "high" }],
      })

      const rewritten = [
        { content: "find the bug", status: "completed", priority: "high" },
        { content: "fix the bug", status: "in_progress", priority: "high" },
      ]
      yield* llm.tool("todowrite", { todos: rewritten })
      yield* llm.text("done")
      yield* user(chat.id, "work the list")
      yield* prompt.loop({ sessionID: chat.id })

      const hits = (yield* llm.hits).filter((h) => !JSON.stringify(h.body).includes("Generate a title"))
      expect(hits.length).toBeGreaterThanOrEqual(2)

      const bodyMessages = (body: unknown) =>
        (body as { messages?: { role: string; content: unknown }[] })?.messages ?? []
      // 1. THE FIX. Index 0 is the system message, 1 the user's own turn. Every
      //    request sends them byte-identical, whatever the reminder did.
      const head = hits.map((h) => JSON.stringify(bodyMessages(h.body).slice(0, 2)))
      for (const entry of head) expect(entry).toBe(head[0]!)
      expect(bodyMessages(hits[0]?.body)[1]?.role).toBe("user")
      // ...and the user's message really is bare, which is the whole claim. A
      // reminder hiding inside it would still satisfy the line above as long as
      // it hid there on every step - and then the NEXT change would break it.
      expect(head[0]!).not.toContain(SessionReminders.TODO_REMINDER_HEAD)

      // 2. THE GUARD. It was still delivered, at the tail, on the step it fired.
      expect(lastUserFromBody(hits[0]?.body)).toContain(SessionReminders.TODO_REMINDER_HEAD)
      expect(lastUserFromBody(hits[0]?.body)).toContain("- [in_progress] find the bug (priority: high)")
      // ...and it really did go quiet on the next step, so the toggle this test
      // is named for actually happened.
      expect(lastUserFromBody(hits[1]?.body)).not.toContain(SessionReminders.TODO_REMINDER_HEAD)

      // 3. THE INSTRUMENT AGREES: the first difference between the two steps
      //    falls past the user's turn.
      const capture = SessionPromptCapture.get(chat.id)
      expect(capture!.steps).toHaveLength(2)
      const [first, second] = capture!.steps
      expect(second!.divergenceMessage).toBeGreaterThanOrEqual(2)
      expect(second!.messages[0]!.hash).toBe(first!.messages[0]!.hash)
      expect(second!.messages[1]!.hash).toBe(first!.messages[1]!.hash)
    }),
  { git: true },
  30_000,
)

it.instance(
  "a session that never sent a turn has no capture at all",
  () =>
    Effect.gen(function* () {
      SessionPromptCapture.reset()
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      expect(SessionPromptCapture.get(chat.id)).toBeNull()
    }),
  10_000,
)

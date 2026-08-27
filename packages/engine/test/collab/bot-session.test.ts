// A BOT INSIDE A ROOM, end to end.
//
// Two claims that only the full stack can answer, because both live where the
// agent registry, the collab runner and the session store meet:
//
//  1. THE ROOM SEAL COMPOSES WITH THE DEFINITION, stricter-wins. A definition
//     that grants itself `task`, `todowrite` and `send_message` must still lose
//     them inside a room - and `deriveSubagentSessionPermission` will NOT close
//     them, because its own guard skips a subagent whose ruleset already
//     permits them. That is exactly the hole this covers.
//  2. A DEFINITION IS READ AS THIS BUILD READS IT. A file written against an
//     older build still carries `model_prefer:`, the capability list an unpinned
//     bot used to resolve its model through. The key is GONE (owner's ruling: "a
//     bot simply needs a pinned model, period"), and the file must still load,
//     still join a room, and still end on the clean needs-a-model reason rather
//     than on a parse error or a guessed provider.
//
// The provider is the in-process fake HTTP server. No paid model is contacted.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { ACPCollab } from "@/collab/acp"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { FSUtil } from "@origami/core/fs-util"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { it, providerConfig, wroteFor } from "./harness"

/** A definition that grants itself everything a room has to take back. */
const GREEDY = [
  "---",
  'description: "Greedy"',
  "mode: all",
  "hidden: true",
  "collab: true",
  "model: test/test-model",
  "permission:",
  '  "*": deny',
  "  read: allow",
  "  task: allow",
  "  todowrite: allow",
  "  send_message: allow",
  "---",
  "",
  "You are greedy.",
  "",
].join("\n")

/**
 * A definition written against the OLD build: no `model:` pin, and a
 * `model_prefer:` list this build no longer reads.
 *
 * The second entry is a literal id that WOULD have resolved here, so the file is
 * the strongest form of the compat case: if anything still honoured the key, the
 * bot would take its turn and this test would see a reply.
 */
const STALE_PREFER = [
  "---",
  'description: "Preferred"',
  "mode: all",
  "hidden: true",
  "collab: true",
  "steps: 8",
  "model_prefer:",
  "  - local+large-context",
  "  - test/test-model",
  "permission:",
  '  "*": deny',
  "  read: allow",
  "---",
  "",
  "You are unpinned, and this build will say so.",
  "",
].join("\n")

const writeDef = (slug: string, body: string) => (directory: string) =>
  Effect.promise(() => Bun.write(path.join(directory, ".origami", "agent", `${slug}.md`), body).then(() => undefined))

const configureProvider = Effect.fnUntraced(function* (directory: string) {
  const llm = yield* TestLLMServer
  const fsys = yield* FSUtil.Service
  yield* fsys.writeWithDirs(path.join(directory, "origami.json"), JSON.stringify({ ...providerConfig(llm.url) }))
  return llm
})

/** The child session the runner made for one roster member. */
const childSessionFor = Effect.fnUntraced(function* (title: string, slug: string) {
  const sessions = yield* Session.Service
  return (yield* sessions.list()).find((session) => session.title === `${title} — ${slug}`)
})

describe("a bot definition inside a room", () => {
  it.instance(
    "loses task, todowrite and send_message to the room seal even though its own def granted them",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        yield* llm.pushMatch(wroteFor("collab-greedy"), reply().text("understood").stop().item())

        const store = yield* CollabStore.Service
        const runner = yield* CollabRunner.Service
        const collab = yield* store.create({ title: "Sealed", agentSlugs: ["collab-greedy"] })
        yield* ACPCollab.post(directory, { collabId: collab.id, text: "go" })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        const child = yield* childSessionFor("Sealed", "collab-greedy")
        expect(child).toBeDefined()

        // The ruleset a tool call really evaluates: the agent's own rules first,
        // the session's last (session/tools.ts merges them in that order).
        const info = yield* Agent.Service.use((svc) => svc.get("collab-greedy"))
        const effective = Permission.merge(info!.permission, child!.permission ?? [])
        const act = (permission: string) => Permission.evaluate(permission, "*", effective).action

        expect(act("task")).toBe("deny")
        expect(act("todowrite")).toBe("deny")
        expect(act("send_message")).toBe("deny")
        // …and the seal took nothing it has no opinion about.
        expect(act("read")).toBe("allow")
      }),
    { init: writeDef("collab-greedy", GREEDY) },
    60_000,
  )

  it.instance(
    "loads a def that still carries `model_prefer:` and IGNORES it - unpinned is unpinned",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        // Queued but never claimed: reaching it would mean something still
        // resolved a model out of the stale key.
        yield* llm.pushMatch(wroteFor("collab-preferred"), reply().text("resolved and running").stop().item())

        const store = yield* CollabStore.Service
        const runner = yield* CollabRunner.Service
        const collab = yield* store.create({ title: "Stale", agentSlugs: ["collab-preferred"] })
        yield* ACPCollab.post(directory, { collabId: collab.id, text: "go" })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        // The def PARSED - it joined the room and was given a turn - and the
        // turn ended on the one honest answer: pick a model.
        const state = yield* ACPCollab.state(directory, { collabId: collab.id })
        expect(state.agents[0]?.lastError).toContain(CollabRunner.needsModelReason("collab-preferred"))
        expect((yield* store.listMessages(collab.id)).map((message) => message.text)).toEqual(["go"])

        const child = yield* childSessionFor("Stale", "collab-preferred")
        expect(child?.model).toBeUndefined()
      }),
    { init: writeDef("collab-preferred", STALE_PREFER) },
    60_000,
  )
})

/**
 * A BOT SESSION is an ordinary session created with that definition - there is
 * no `session.kind` in this engine and none is needed. What makes it a bot
 * session is that its `agent` names a NON-NATIVE definition, and the three
 * things a bot needs follow from that alone: the definition's permissions and
 * skills gate (applied in the registry, so every run mode gets them), its own
 * memory (keyed to the definition file), and its model.
 *
 * A CHAT never goes through the collab runner, so it is the second place the
 * stale `model_prefer:` key had a reader. It has none now, and a chat with an
 * unpinned bot falls to the ordinary session precedence: the model the human
 * picked, the model this session has already used, then the provider default.
 */
describe("a bot session outside a room", () => {
  const TWO_MODELS = (url: string) => {
    const base = providerConfig(url)
    const test = base.provider!["test"]!
    return {
      provider: {
        test: {
          ...test,
          models: {
            ...test.models,
            // A SECOND model, so "the stale key decided nothing" cannot be
            // confused with "there was only one model to pick".
            "test-big": { ...test.models!["test-model"]!, id: "test-big", name: "Test Big" },
          },
        },
      },
    }
  }

  const PREFERS_BIG = [
    "---",
    'description: "Bigly"',
    "mode: all",
    "steps: 8",
    "model_prefer:",
    "  - test/test-big",
    "---",
    "",
    "You prefer the big model.",
    "",
  ].join("\n")

  it.instance(
    "a stale `model_prefer:` decides nothing - the chat falls to the ordinary precedence",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fsys = yield* FSUtil.Service
        yield* fsys.writeWithDirs(path.join(directory, "origami.json"), JSON.stringify(TWO_MODELS(llm.url)))
        yield* llm.text("on whichever one")

        const sessions = yield* Session.Service
        const prompts = yield* SessionPrompt.Service
        const chat = yield* sessions.create({ title: "Bot chat", agent: "bigly" })
        const result = yield* prompts.prompt({
          sessionID: chat.id,
          agent: "bigly",
          parts: [{ type: "text", text: "hello" }],
        })

        // The turn still RUNS - dropping the key must not brick a chat with an
        // unpinned bot - and `test-big` is not what decided it.
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") {
          expect(`${result.info.providerID}/${result.info.modelID}`).not.toBe("test/test-big")
        }
      }),
    { init: writeDef("bigly", PREFERS_BIG) },
    60_000,
  )

  /**
   * THE WHOLE IDENTITY, ON ONE REQUEST (W7-L1). Persona, the bot's own memory,
   * the definition's tool denies and its pinned model all key off ONE thing —
   * the `agent` a turn carries — so this pins all four on the SAME request
   * rather than four tests that could each pass off a different session.
   *
   * Why it matters here and not only in the ACP test beside it: the ACP layer
   * can prove it now creates the session AS the bot and sends that name on the
   * first prompt, but only the full stack can prove that name is what the
   * request the provider receives is actually built from.
   *
   * The pin is the SECOND model, which nothing else resolves to (the
   * `model_prefer:` test above shows the ordinary precedence lands on
   * `test-model`), so "the pin decided it" cannot be confused with "there was
   * only one model".
   */
  /**
   * WRITTEN AS THE BOTS PANE WRITES IT. `hidden: true` and `collab: true` are
   * on every file that pane saves (the extension's collabAgentSerialize.ts
   * emits the `mode: all` + `hidden: true` header), and their absence here is
   * what let the quad pass over a definition shape no user has on disk. The
   * ACP route drops a hidden def from `availableModes` unless the W8-L1 fix is
   * in, so the two halves are now asserted against the SAME file shape - see
   * test/collab/hot-defs.test.ts for the registry side of the join.
   */
  const KEEPER = [
    "---",
    'description: "Keeper"',
    "mode: all",
    "hidden: true",
    "collab: true",
    "model: test/test-big",
    "steps: 8",
    "memory: true",
    "permission:",
    '  "*": deny',
    "  read: allow",
    "---",
    "",
    "You are Shirogane, keeper of the tower. You speak in short, cold sentences.",
    "",
  ].join("\n")

  /** The def, plus a fact this bot kept in an earlier session. */
  const keeperWithMemory = (directory: string) =>
    Effect.gen(function* () {
      yield* writeDef("keeper", KEEPER)(directory)
      const dir = path.join(directory, ".origami", "bot", "keeper", "memory")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "general.md"),
          "# general\n\n- [2026-08-01] the tower gate closes at dusk\n",
        ).then(() => undefined),
      )
    })

  it.instance(
    "the FIRST turn carries the persona, the bot's own memory, the def's tool denies and its pinned model",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fsys = yield* FSUtil.Service
        yield* fsys.writeWithDirs(path.join(directory, "origami.json"), JSON.stringify(TWO_MODELS(llm.url)))
        yield* llm.text("the gate is shut")

        const sessions = yield* Session.Service
        const prompts = yield* SessionPrompt.Service
        // Created AS the bot — what ACP newSession now does off `_meta.agent`
        // instead of creating a `build` chat and re-pointing it afterwards.
        const chat = yield* sessions.create({ title: "Keeper chat", agent: "keeper" })
        // The turn names it too. Proven load-bearing: dropping this line alone
        // puts default.txt and the ungated tool set on the wire even though the
        // ROW says "keeper" — creating as the bot is necessary, not sufficient,
        // which is why ACP newSession seeds `modeId` as well as the row.
        yield* prompts.prompt({
          sessionID: chat.id,
          agent: "keeper",
          parts: [{ type: "text", text: "what persona are you" }],
        })

        // The turn's OWN request, not the hidden title generation beside it.
        const turn = (yield* llm.inputs).find((body) => JSON.stringify(body).includes("what persona are you"))
        expect(turn).toBeDefined()
        const sent = JSON.stringify(turn)

        // 1. PERSONA — the definition's body reaches the wire. It COMPOSES on
        //    top of default.txt rather than replacing it (the owner's
        //    composition matrix: a bot session is base prompt + persona), so
        //    the base prompt is expected here and the persona sits after it.
        //    The reported bug was the definition's body going missing
        //    altogether, leaving default.txt alone on the wire.
        expect(sent).toContain("You are Shirogane, keeper of the tower")
        expect(sent).toContain("You are origami, an interactive CLI tool")
        expect(sent.indexOf("You are origami, an interactive CLI tool")).toBeLessThan(
          sent.indexOf("You are Shirogane, keeper of the tower"),
        )

        // 2. MEMORY — the bot's own store, injected because the definition it
        //    resolved is the one the store is keyed to.
        expect(sent).toContain("## Your memory")
        expect(sent).toContain("the tower gate closes at dusk")

        // 3. TOOLS — the def's `"*": deny` really gated the tools OFFERED, so
        //    the model is never shown a door this bot may not open.
        const offered = ((turn as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []).map(
          (tool) => tool.function?.name,
        )
        expect(offered).toContain("read")
        expect(offered).not.toContain("bash")
        expect(offered).not.toContain("edit")

        // 4. MODEL — the def's pin, not the model ACP seeded the session row
        //    with at create time (`selectDefaultModel`). Same identity again:
        //    session/prompt.ts resolves `input.model ?? ag.model ?? current`.
        expect((turn as { model?: string }).model).toBe("test-big")
      }),
    { init: keeperWithMemory },
    60_000,
  )
})

// A SESSION THAT COMES UP AS AN AGENT.
//
// The bug this pins (W7-L1, live UAT): "Start session" on a bot opened a chat
// named after the bot that answered as the engine default - "I'm Origami … no
// specialized persona loaded". The shell created an ordinary chat and THEN
// pointed its `mode` option at the slug, so between the two calls the session
// existed as `build`, and whenever the second call was refused it STAYED that
// way while looking completely normal.
//
// `newSession` had no way to be told. It always created the engine session as
// `snapshot.defaultModeID`, so the identity that a turn resolves everything
// from - persona, the bot's own memory, its permission tier - was decided
// before the client could say which bot it wanted.
//
// The seam is the ACP `session/new` `_meta` bag: `_meta.agent` is the agent the
// session is created AS. One channel, the one the prompt already reads
// (`session.prompt`'s `agent` field, service.ts prompt()), so nothing here is a
// second way to say who is speaking.
//
// The SDK is a stub. What it records - what `session.create` and
// `session.prompt` were really asked for - is the whole assertion.

import { describe, expect, it } from "bun:test"
import type { OrigamiClient } from "@origami/sdk/v2"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Effect } from "effect"
import * as ACPError from "@/acp/error"
import * as ACPService from "@/acp/service"

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")

const provider = {
  id: providerID,
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: {
    [modelID]: {
      id: modelID,
      providerID,
      api: { id: modelID, url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
      name: "Test Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128000, output: 4096 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

const NATIVE = [
  { name: "build", mode: "primary", native: true, permission: [], options: {} },
  { name: "plan", mode: "primary", native: true, description: "Plan first", permission: [], options: {} },
  // The engine's OWN prompt agents. `hidden: true` AND `native: true`: they are
  // not chat identities, and a session must never be created as one. They are
  // here so "hidden agents are reachable" cannot be read as "every hidden agent
  // is reachable" (W8-L1).
  { name: "title", mode: "primary", native: true, hidden: true, permission: [], options: {} },
  { name: "summary", mode: "primary", native: true, hidden: true, permission: [], options: {} },
]

/**
 * A BOT DEFINITION AS THE BOTS PANE REALLY WRITES IT.
 *
 * `hidden: true` is not decoration - the extension's serializer emits it on
 * EVERY def it saves (packages/vscode/src/dashboard/collabAgentSerialize.ts,
 * the `mode: all` + `hidden: true` header), so that a bot stays off the
 * ordinary chat picker. `native` is false because nothing in the engine
 * declared it (agent.ts `build` stamps `native: false` on every entry that came
 * from a definition file).
 *
 * This test used to omit `hidden`, and that omission is the whole reason W7
 * shipped green over a route that has never worked: `loadDirectorySnapshot`
 * dropped every hidden agent before `availableModes` was built, so the LIVE
 * Bots pane's defs were absent from the one list `resolveRequestedAgent`
 * checks. The fixture, not the fix, was what passed.
 */
const CRANE = {
  name: "crane",
  mode: "all",
  native: false,
  hidden: true,
  description: "The crane bot",
  permission: [],
  options: {},
}

/**
 * @param lateAgents definitions the registry only reports AFTER `config.refresh`
 *   - a bot definition written after this engine built its agent registry, which
 *   is every bot the Bots pane has just scaffolded.
 */
const makeService = (options?: { agents?: readonly unknown[]; lateAgents?: readonly unknown[] }) => {
  const creates: Array<Record<string, unknown>> = []
  const prompts: Array<Record<string, unknown>> = []
  const refreshes: string[] = []
  let refreshed = false

  const sdk = {
    config: {
      providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
      get: () => Promise.resolve({ data: {} }),
      refresh: (input: { directory: string }) => {
        refreshes.push(input.directory)
        refreshed = true
        return Promise.resolve({ data: true })
      },
    },
    app: {
      agents: () =>
        Promise.resolve({
          data: [...(options?.agents ?? NATIVE), ...(refreshed ? (options?.lateAgents ?? []) : [])],
        }),
      skills: () => Promise.resolve({ data: [] }),
    },
    command: { list: () => Promise.resolve({ data: [] }) },
    session: {
      create: (input: Record<string, unknown>) => {
        creates.push(input)
        return Promise.resolve({ data: { id: `ses_${creates.length}` } })
      },
      get: () => Promise.resolve({ data: { id: "ses_1" } }),
      list: () => Promise.resolve({ data: [] }),
      messages: () => Promise.resolve({ data: [] }),
      prompt: (input: Record<string, unknown>) => {
        prompts.push(input)
        return Promise.resolve({
          data: {
            info: {
              id: "msg_1",
              role: "assistant",
              sessionID: "ses_1",
              time: { created: 1, completed: 2 },
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID,
              providerID,
            },
          },
        })
      },
      update: () => Promise.resolve({ data: {} }),
    },
    mcp: { add: () => Promise.resolve({ data: {} }) },
  } as unknown as OrigamiClient

  return { service: ACPService.make({ sdk }), creates, prompts, refreshes }
}

const modeOption = (response: { configOptions?: readonly unknown[] | null }) =>
  (response.configOptions ?? []).find((option) => (option as { id?: string }).id === "mode") as
    | { currentValue?: string; options?: Array<{ value: string }> }
    | undefined

describe("a session created AS an agent", () => {
  it("creates the engine session as the requested agent, and its FIRST prompt speaks as it", async () => {
    const { service, creates, prompts } = makeService({ agents: [...NATIVE, CRANE] })

    const created = await Effect.runPromise(
      service.newSession({ cwd: "/workspace", mcpServers: [], _meta: { agent: "crane" } }),
    )
    // No setSessionConfigOption in between: this is the FIRST turn of a chat the
    // user just opened from the Bots pane.
    await Effect.runPromise(
      service.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "what persona are you" }],
      } as never),
    )

    // The engine session row carries the bot, so anything reading the row (and
    // any later `session.get`) agrees with the turn.
    expect(creates[0]).toMatchObject({ agent: "crane" })
    // The turn resolves persona, bot memory and the definition's permission
    // tier from THIS field - engine session/prompt.ts createUserMessage.
    expect(prompts[0]).toMatchObject({ agent: "crane" })
    // …and the picker agrees, so the composer does not read "build" over a chat
    // that is answering as Crane.
    expect(modeOption(created)?.currentValue).toBe("crane")
  })

  it("still defaults when no agent is asked for", async () => {
    const { service, creates, prompts } = makeService({ agents: [...NATIVE, CRANE] })

    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    await Effect.runPromise(
      service.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] } as never),
    )

    expect(creates[0]).toMatchObject({ agent: "build" })
    expect(prompts[0]).toMatchObject({ agent: "build" })
  })

  it("refuses a definition it has not loaded, names the ones it offers, and creates NOTHING", async () => {
    const { service, creates } = makeService({ agents: [...NATIVE, CRANE] })

    const error = await Effect.runPromise(
      service.newSession({ cwd: "/workspace", mcpServers: [], _meta: { agent: "heron" } }).pipe(Effect.flip),
    )

    // The sentence the SHELL reads: RefusalError is rehydrated verbatim by the
    // client (error.ts toRequestError), so this is what the Bots pane shows.
    const message = ACPError.toRequestError(error).message
    expect(message).toContain("heron")
    // The alternatives have to be IN the refusal: a shell cannot fix an
    // identity it is not told the valid values for.
    expect(message).toContain("crane")
    expect(message).toContain("build")
    // A chat that opened, named after a bot, answering as the engine default IS
    // the reported bug. Refusing means refusing to create it.
    expect(creates).toEqual([])
  })

  it("says DEFINITION, not model, and says the Bots pane's defs are in the list", async () => {
    // The owner read the old sentence as a complaint about his MODEL - "deepseek
    // was being served absolutely fine" - and went looking at the provider. The
    // refusal has to name what kind of thing is missing, and where it is looked
    // for, or the next reader loses the same hour (W8-L1).
    const { service } = makeService({ agents: [...NATIVE, CRANE] })

    const message = ACPError.toRequestError(
      await Effect.runPromise(
        service.newSession({ cwd: "/workspace", mcpServers: [], _meta: { agent: "deepseek" } }).pipe(Effect.flip),
      ),
    ).message

    expect(message).toContain("DEFINITION")
    expect(message).toContain("NOT a model")
    // WHERE it looked, and that the pane the user just used writes there.
    expect(message).toContain("agent/*.md")
    expect(message).toContain("Bots pane")
    // …and the offers really do include a Bots-pane def now, so the sentence is
    // not just a promise. This is the assertion that would catch the old bug
    // class coming back: a hidden def dropped from the list makes it fail.
    expect(message).toContain("crane")
  })

  it("will not create a session as one of the engine's OWN hidden prompt agents", async () => {
    // `title` and `summary` are hidden AND native. Widening the list to hidden
    // definitions must not widen it to these: they are prompt machinery, not
    // identities, and a chat created as one would answer as a title generator.
    const { service, creates } = makeService({ agents: [...NATIVE, CRANE] })

    const error = await Effect.runPromise(
      service.newSession({ cwd: "/workspace", mcpServers: [], _meta: { agent: "title" } }).pipe(Effect.flip),
    )

    expect(ACPError.toRequestError(error).message).not.toContain("summary")
    expect(creates).toEqual([])
  })

  it("keeps a bot OFF the picker except in its own chat", async () => {
    // `hidden: true` is what the Bots pane writes to keep a roster of bots out
    // of the ordinary chat agent list; making them session-capable must not
    // undo that. The one exception is the bot's own chat, or its agent control
    // would render blank over a chat that is answering as the bot.
    const { service } = makeService({ agents: [...NATIVE, CRANE] })

    const plain = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    expect(modeOption(plain)?.options?.map((option) => option.value)).toEqual(["build", "plan"])

    const bot = await Effect.runPromise(
      service.newSession({ cwd: "/workspace", mcpServers: [], _meta: { agent: "crane" } }),
    )
    expect(modeOption(bot)?.options?.map((option) => option.value)).toEqual(["build", "plan", "crane"])
  })

  it("resolves a bot written after this engine built its registry, by re-reading config once", async () => {
    // The Bots pane scaffolds a definition; the engine's agent registry was
    // built before the file existed, so the first look does not see it. This is
    // the ordinary case for "create a bot, then start a session with it", and
    // it is what made the refusal fire in UAT.
    const { service, creates, refreshes } = makeService({ agents: NATIVE, lateAgents: [CRANE] })

    const created = await Effect.runPromise(
      service.newSession({ cwd: "/workspace", mcpServers: [], _meta: { agent: "crane" } }),
    )

    expect(refreshes).toEqual(["/workspace"])
    expect(creates[0]).toMatchObject({ agent: "crane" })
    expect(modeOption(created)?.options?.map((option) => option.value)).toContain("crane")
  })

  it("switching mode mid-chat re-reads config once before refusing, so a fresh def is reachable", async () => {
    // The same root cause on the surviving post-hoc path (the Folds board's
    // per-session agent-type picker): the `mode` branch validated against the
    // snapshot FROZEN at session start and never refreshed it, unlike the
    // `model` branch beside it.
    const { service } = makeService({ agents: NATIVE, lateAgents: [CRANE] })

    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const updated = await Effect.runPromise(
      service.setSessionConfigOption({ sessionId: created.sessionId, configId: "mode", value: "crane" }),
    )

    expect(modeOption(updated)?.currentValue).toBe("crane")
  })
})

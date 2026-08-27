// PER-BOT MEMORY, on the surface that matters: the request that reaches the
// provider, and the file that lands on disk.
//
// A unit test can prove the block composes and the fence refuses. Only this can
// prove the two seams are WIRED - that a bot's own store is injected into its
// prompt at session start, and that the `remember` tool a bot calls writes into
// that store instead of the project's.
//
// The provider is the in-process fake HTTP server. No paid model is contacted.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { ACPCollab } from "@/collab/acp"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { FSUtil } from "@origami/core/fs-util"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { it, providerConfig, wroteFor } from "./harness"

const SLUG = "collab-keeper"

const KEEPER = [
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
  "  remember: allow",
  "---",
  "",
  "You are the Keeper. You remember things.",
  "",
].join("\n")

/** Where this bot's store lives for an instance-local definition. */
const botMemoryDir = (directory: string) => path.join(directory, ".origami", "bot", SLUG, "memory")

const writeKeeper = (directory: string) =>
  Effect.promise(() => Bun.write(path.join(directory, ".origami", "agent", `${SLUG}.md`), KEEPER).then(() => undefined))

/** The def, plus a memory the bot supposedly kept in an earlier session. */
const withPriorMemory = (directory: string) =>
  Effect.gen(function* () {
    yield* writeKeeper(directory)
    yield* Effect.promise(async () => {
      const dir = botMemoryDir(directory)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "general.md"), "# general\n\n- [2026-08-01] the deploy script is scripts/ship.ps1\n")
    })
  })

const configureProvider = Effect.fnUntraced(function* (directory: string) {
  const llm = yield* TestLLMServer
  const fsys = yield* FSUtil.Service
  yield* fsys.writeWithDirs(path.join(directory, "origami.json"), JSON.stringify({ ...providerConfig(llm.url) }))
  return llm
})

const runOneTurn = Effect.fnUntraced(function* (directory: string, title: string) {
  const store = yield* CollabStore.Service
  const runner = yield* CollabRunner.Service
  const collab = yield* store.create({ title, agentSlugs: [SLUG] })
  yield* ACPCollab.post(directory, { collabId: collab.id, text: "go" })
  yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")
  return collab
})

describe("a bot's own memory", () => {
  it.instance(
    "is injected into the bot's prompt, and reaches the provider",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        yield* llm.pushMatch(wroteFor(SLUG), reply().text("noted").stop().item())

        yield* runOneTurn(directory, "Recall")

        const body = JSON.stringify((yield* llm.hits).filter((hit) => wroteFor(SLUG)(hit))[0]?.body ?? {})
        expect(body).toContain("## Your memory")
        expect(body).toContain("the deploy script is scripts/ship.ps1")
      }),
    { init: withPriorMemory },
    60_000,
  )

  it.instance(
    "is NOT injected into an ordinary chat, whose agent is native",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        yield* llm.pushMatch(wroteFor(SLUG), reply().text("noted").stop().item())
        yield* runOneTurn(directory, "Recall")

        // The bot's own request carries it; nothing else does. A main session
        // runs a NATIVE agent, which has no store to read.
        const others = (yield* llm.hits).filter((hit) => !wroteFor(SLUG)(hit))
        for (const hit of others) {
          expect(JSON.stringify(hit.body)).not.toContain("the deploy script is scripts/ship.ps1")
        }
      }),
    { init: withPriorMemory },
    60_000,
  )

  it.instance(
    "is where the bot's own `remember` call lands — never the project store",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        yield* llm.pushMatch(
          wroteFor(SLUG),
          reply().tool("remember", { fact: "the room lead is the keeper", topic: "room" }).item(),
        )
        yield* llm.pushMatch(wroteFor(SLUG), reply().text("remembered").stop().item())

        yield* runOneTurn(directory, "Keep")

        const kept = yield* Effect.promise(() =>
          fs.readFile(path.join(botMemoryDir(directory), "room.md"), "utf8").catch(() => ""),
        )
        expect(kept).toContain("the room lead is the keeper")

        // The project store must not have grown a bot's private fact.
        const projectStore = yield* Effect.promise(() =>
          fs.readdir(path.join(directory, ".origami", "memory")).catch(() => [] as string[]),
        )
        expect(projectStore).toEqual([])
      }),
    { init: writeKeeper },
    60_000,
  )
})

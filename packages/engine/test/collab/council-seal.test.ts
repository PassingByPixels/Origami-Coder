// THE COUNCIL ROUND SEAL, on the real child session.
//
// The owner's ruling this file holds: turning council mode on must WORK for a
// room of ordinary working bots. It used to be refused unless every member was
// already read-only for files, and the refusal was a paragraph about permission
// rulesets - so the answer moved from the SETTING to the TURN. A council round
// turn runs read-only; the same member keeps `edit` and `bash` in the room's
// discuss turns.
//
// Proven on the tool list the MODEL is actually given, not on a ruleset read
// back out of a store. `LLMRequestPrep.resolveTools` drops every tool the
// merged ruleset denies at wildcard scope, so a sealed turn's request carries
// no `edit` and no `bash` at all - the model cannot call what it was never
// offered. A test that only asserted the stored rules would pass on a seal that
// was written after the request went out.
//
// The provider is the in-process fake HTTP server. No paid model is contacted.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { ACPCollab } from "@/collab/acp"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { FSUtil } from "@origami/core/fs-util"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { it, providerConfig, wroteFor } from "./harness"

/**
 * A WORKER, in the shape the bot contract's `standard` tier means: it reads and
 * it builds. This is the definition the old gate refused a council over.
 */
const worker = (slug: string) =>
  [
    "---",
    `description: "${slug}"`,
    "mode: all",
    "hidden: true",
    "collab: true",
    "model: test/test-model",
    "steps: 8",
    "permission:",
    '  "*": deny',
    "  read: allow",
    "  edit: allow",
    "  bash: allow",
    "---",
    "",
    `You are ${slug}.`,
    "",
  ].join("\n")

const writeDefs = (slugs: readonly string[]) => (directory: string) =>
  Effect.promise(async () => {
    for (const slug of slugs) {
      await Bun.write(path.join(directory, ".origami", "agent", `${slug}.md`), worker(slug))
    }
  })

const configureProvider = Effect.fnUntraced(function* (directory: string) {
  const llm = yield* TestLLMServer
  const fsys = yield* FSUtil.Service
  yield* fsys.writeWithDirs(path.join(directory, "origami.json"), JSON.stringify({ ...providerConfig(llm.url) }))
  return llm
})

/** Every tool name offered on the requests written for one agent. */
const offeredTo = Effect.fnUntraced(function* (slug: string) {
  const llm = yield* TestLLMServer
  const matches = (yield* llm.hits).filter((hit) => wroteFor(slug)(hit))
  return matches.flatMap((hit) => {
    const tools = (hit.body as { tools?: { function?: { name?: string } }[] }).tools ?? []
    return tools.map((tool) => tool.function?.name)
  })
})

const settle = (runner: CollabRunner.Interface) =>
  awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

describe("a council of WORKERS", () => {
  it.instance(
    "turns on without a refusal, and its round turns are offered no way to write",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        yield* llm.pushMatch(wroteFor("crane"), reply().text("crane's opinion").item())
        yield* llm.pushMatch(wroteFor("heron"), reply().text("heron's opinion").item())
        // The synthesis: crane is the lead, so it reconciles after its opinion.
        yield* llm.pushMatch(wroteFor("crane"), reply().text("the decision").item())

        const store = yield* CollabStore.Service
        const runner = yield* CollabRunner.Service
        const collab = yield* store.create({ title: "Council", agentSlugs: ["crane", "heron"] })
        yield* store.setLead(collab.id, "crane")

        // THE OWNER'S PATH: two working bots, flip the switch. No refusal.
        expect(yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "council" })).toEqual({ ok: true })

        yield* ACPCollab.post(directory, { collabId: collab.id, text: "should we rewrite the parser?" })
        yield* settle(runner)

        // The round ran.
        const log = yield* store.listMessages(collab.id)
        expect(log.filter((message) => message.kind === "opinion")).toHaveLength(2)

        // …and not one of those turns was given a tool that puts bytes on disk.
        for (const slug of ["crane", "heron"]) {
          const offered = yield* offeredTo(slug)
          expect(offered.length, `${slug} was never asked`).toBeGreaterThan(0)
          expect(offered, `${slug} kept edit inside a round`).not.toContain("edit")
          expect(offered, `${slug} kept bash inside a round`).not.toContain("bash")
          // The seal takes nothing it has no opinion about: a council reads.
          expect(offered, `${slug} lost read inside a round`).toContain("read")
        }
      }),
    { init: writeDefs(["crane", "heron"]) },
    60_000,
  )

  it.instance(
    "gives the same member its tools back in a DISCUSS turn of the same room",
    () =>
      Effect.gen(function* () {
        // The seal is the ROUND'S, not the room's. A seal that outlived the
        // round would take a bot's tools away for good the first time anyone
        // tried council mode - which is a worse trap than the refusal was.
        const { directory } = yield* TestInstance
        const llm = yield* configureProvider(directory)
        yield* llm.pushMatch(wroteFor("crane"), reply().text("crane's opinion").item())
        yield* llm.pushMatch(wroteFor("crane"), reply().text("the decision").item())
        yield* llm.pushMatch(wroteFor("crane"), reply().text("on it").item())

        const store = yield* CollabStore.Service
        const runner = yield* CollabRunner.Service
        const collab = yield* store.create({ title: "ThenDiscuss", agentSlugs: ["crane"] })
        yield* store.setLead(collab.id, "crane")
        yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "council" })
        yield* ACPCollab.post(directory, { collabId: collab.id, text: "should we rewrite the parser?" })
        yield* settle(runner)
        const duringRound = (yield* offeredTo("crane")).length

        yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "discuss" })
        yield* ACPCollab.post(directory, { collabId: collab.id, text: "now go and do it" })
        yield* settle(runner)

        const afterRound = (yield* offeredTo("crane")).slice(duringRound)
        expect(afterRound.length, "the discuss turn never ran").toBeGreaterThan(0)
        expect(afterRound).toContain("edit")
        expect(afterRound).toContain("bash")

        // The stored ruleset is back where it started too - the overlay is not
        // allowed to leave a residue on the child session.
        const sessions = yield* Session.Service
        const child = (yield* sessions.list()).find((session) => session.title === "ThenDiscuss — crane")
        expect(child?.permission?.some((rule) => rule.permission === "edit" && rule.action === "deny")).toBeFalsy()
      }),
    { init: writeDefs(["crane"]) },
    60_000,
  )
})

import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { ACPCollab } from "@/collab/acp"
import { CollabParallel } from "@/collab/parallel"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * `collab_set_concurrency` — the room control, and the WRITE-SAFETY GATE it
 * carries.
 *
 * The gate is the whole reason this method is not a one-line setter: a room may
 * only raise its width when every member is provably read-only for files. See
 * the DECISION block in src/collab/parallel.ts for why that is a gate and not
 * a worktree.
 */
const it = testEffect(
  LayerNode.compile(LayerNode.group([CollabStore.node, CollabRunner.node, Agent.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({})],
  ]),
)

const withAgentDir = {
  init: (directory: string) =>
    Effect.promise(() => fs.mkdir(path.join(directory, ".origami", "agent"), { recursive: true })),
}

const def = (slug: string, tier: string) => `---
description: ${slug}
model: anthropic/sonnet-test
collab: true
permissions: ${tier}
---
You are ${slug}.
`

const writeDef = (directory: string, slug: string, tier: string) =>
  Effect.promise(() => fs.writeFile(path.join(directory, ".origami", "agent", `${slug}.md`), def(slug, tier)))

const room = (agentSlugs: readonly string[]) =>
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const store = yield* CollabStore.Service
    const collab = yield* store.create({ title: "Council", agentSlugs })
    return { directory, store, collab }
  })

const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.map(() => undefined as string | undefined),
    Effect.catch((error: E) => Effect.succeed((error as { safeMessage?: string }).safeMessage ?? String(error))),
  )

describe("collab_set_concurrency", () => {
  it.instance(
    "raises the width for a room whose members are all read-only",
    () =>
      Effect.gen(function* () {
        const { directory, store, collab } = yield* room(["scribe", "reader"])
        yield* writeDef(directory, "scribe", "strict")
        yield* writeDef(directory, "reader", "strict")

        expect(yield* ACPCollab.setConcurrency(directory, { collabId: collab.id, concurrency: 3 })).toEqual({
          ok: true,
        })
        expect((yield* store.get(collab.id))?.concurrency).toBe(3)
      }),
    withAgentDir,
  )

  it.instance(
    "REFUSES a room whose member can still write files, and names it",
    () =>
      Effect.gen(function* () {
        const { directory, store, collab } = yield* room(["scribe", "builder"])
        yield* writeDef(directory, "scribe", "strict")
        yield* writeDef(directory, "builder", "standard")

        const refusal = yield* failure(ACPCollab.setConcurrency(directory, { collabId: collab.id, concurrency: 2 }))
        expect(refusal).toContain("builder")
        expect(refusal).toContain("edit")
        // Refused means UNCHANGED: a room that half-applied the setting would
        // be running parallel writers with a refusal on screen.
        expect((yield* store.get(collab.id))?.concurrency).toBeNull()
      }),
    withAgentDir,
  )

  it.instance(
    "lets any room go back to SERIAL - lowering is never gated",
    () =>
      Effect.gen(function* () {
        const { directory, store, collab } = yield* room(["scribe", "builder"])
        yield* writeDef(directory, "scribe", "strict")
        yield* writeDef(directory, "builder", "standard")
        // Even the room the gate would refuse to widen can be narrowed: the
        // gate exists to stop parallel writes, not to trap a room at a width.
        yield* store.setConcurrency(collab.id, 3)
        expect(yield* ACPCollab.setConcurrency(directory, { collabId: collab.id, concurrency: 1 })).toEqual({
          ok: true,
        })
        expect((yield* store.get(collab.id))?.concurrency).toBe(1)
      }),
    withAgentDir,
  )

  it.instance(
    "refuses a width that is not a whole number in range",
    () =>
      Effect.gen(function* () {
        const { directory, collab } = yield* room(["scribe"])
        yield* writeDef(directory, "scribe", "strict")
        expect(
          yield* failure(ACPCollab.setConcurrency(directory, { collabId: collab.id, concurrency: 0 })),
        ).toBeString()
        expect(
          yield* failure(
            ACPCollab.setConcurrency(directory, {
              collabId: collab.id,
              concurrency: CollabParallel.CONCURRENCY_MAX + 1,
            }),
          ),
        ).toContain(String(CollabParallel.CONCURRENCY_MAX))
      }),
    withAgentDir,
  )

  it.instance(
    "reports the width on collab_state, so a shell can render the control",
    () =>
      Effect.gen(function* () {
        const { directory, collab } = yield* room(["scribe"])
        yield* writeDef(directory, "scribe", "strict")
        expect((yield* ACPCollab.state(directory, { collabId: collab.id })).collab.concurrency).toBeNull()
        yield* ACPCollab.setConcurrency(directory, { collabId: collab.id, concurrency: 2 })
        expect((yield* ACPCollab.state(directory, { collabId: collab.id })).collab.concurrency).toBe(2)
      }),
    withAgentDir,
  )
})

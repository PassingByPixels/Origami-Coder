import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import * as ACPError from "@/acp/error"
import { Agent } from "@/agent/agent"
import { ACPCollab } from "@/collab/acp"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * `collab_set_flavor` — turning a room into a COUNCIL.
 *
 * IT IS NOT GATED, and this file is where that is held. A council used to be
 * refused unless every member was already read-only for files, which put a
 * paragraph about permission rulesets in front of a person whose whole ask was
 * "these three bots, this question". The hazard the gate was built for is real
 * and has not gone anywhere - it is now answered where it happens, by sealing
 * the ROUND TURNS read-only (collab/seal.ts COUNCIL_SEAL) instead of by refusing
 * the setting.
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

/** The error itself, for the assertions that are about HOW it is presented. */
const raised = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.map(() => undefined as unknown),
    Effect.catch((error: E) => Effect.succeed(error as unknown)),
  )

describe("collab_set_flavor", () => {
  it.instance(
    "makes a council of a room whose members are all read-only",
    () =>
      Effect.gen(function* () {
        const { directory, store, collab } = yield* room(["scribe", "reader"])
        yield* writeDef(directory, "scribe", "strict")
        yield* writeDef(directory, "reader", "strict")

        expect(yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "council" })).toEqual({ ok: true })
        expect((yield* store.get(collab.id))?.flavor).toBe("council")
      }),
    withAgentDir,
  )

  it.instance(
    "makes a council of a room of WORKERS too - the flavor is never refused on permissions",
    () =>
      Effect.gen(function* () {
        // The owner's own path: build two bots that can work, put them in a
        // room, turn council on. A `standard` member holds `edit` and `bash`,
        // which is exactly what the old gate refused on.
        const { directory, store, collab } = yield* room(["scribe", "builder"])
        yield* writeDef(directory, "scribe", "standard")
        yield* writeDef(directory, "builder", "standard")

        expect(yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "council" })).toEqual({ ok: true })
        expect((yield* store.get(collab.id))?.flavor).toBe("council")
      }),
    withAgentDir,
  )

  it.instance(
    "a room with a member whose definition file is GONE still becomes a council",
    () =>
      Effect.gen(function* () {
        // The other half of the old gate: it also refused when a slug had no
        // definition left, because it could not prove that member read-only.
        // A missing definition cannot take a turn at all, so it is not a reason
        // to keep the human out of the setting.
        const { directory, store, collab } = yield* room(["scribe", "ghost"])
        yield* writeDef(directory, "scribe", "strict")

        expect(yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "council" })).toEqual({ ok: true })
        expect((yield* store.get(collab.id))?.flavor).toBe("council")
      }),
    withAgentDir,
  )

  it.instance(
    "lets any room go back to DISCUSS - leaving is never gated",
    () =>
      Effect.gen(function* () {
        const { directory, store, collab } = yield* room(["scribe", "builder"])
        yield* writeDef(directory, "scribe", "strict")
        yield* writeDef(directory, "builder", "standard")
        yield* store.setFlavor(collab.id, "council")
        expect(yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "discuss" })).toEqual({ ok: true })
        expect((yield* store.get(collab.id))?.flavor).toBe("discuss")
      }),
    withAgentDir,
  )

  it.instance(
    "refuses a flavor it does not have, and says which it does",
    () =>
      Effect.gen(function* () {
        const { directory, collab } = yield* room(["scribe"])
        yield* writeDef(directory, "scribe", "strict")
        const refusal = yield* failure(ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "senate" }))
        expect(refusal).toContain("senate")
        expect(refusal).toContain("council")
      }),
    withAgentDir,
  )

  it.instance(
    "a refusal arrives as a REFUSAL, not as an internal error",
    () =>
      Effect.gen(function* () {
        // What the owner actually saw: a sentence he could act on, with
        // `Internal error: ` glued on the front of it by the ACP mapping. The
        // engine is not broken when it declines something - and the client
        // renders whatever `message` it is handed, verbatim.
        const { directory, collab } = yield* room(["scribe"])
        yield* writeDef(directory, "scribe", "strict")
        const error = yield* raised(ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "senate" }))

        expect((error as { _tag?: string })._tag).toBe("ACPRefusalError")
        const wire = ACPError.toRequestError(error as ACPError.Error)
        expect(wire.message).toBe("unknown collab flavor: senate — it is one of discuss, council")
        expect(wire.message).not.toContain("Internal error")
      }),
    withAgentDir,
  )

  it.instance(
    "reports the flavor on collab_state, resolved rather than raw",
    () =>
      Effect.gen(function* () {
        const { directory, store, collab } = yield* room(["scribe"])
        yield* writeDef(directory, "scribe", "strict")
        expect((yield* ACPCollab.state(directory, { collabId: collab.id })).collab.flavor).toBe("discuss")
        yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "council" })
        expect((yield* ACPCollab.state(directory, { collabId: collab.id })).collab.flavor).toBe("council")
        // A flavor written by a newer shell reads as the safest one this build
        // can enforce, never as an error and never as a council.
        yield* store.setFlavor(collab.id, "senate")
        expect((yield* ACPCollab.state(directory, { collabId: collab.id })).collab.flavor).toBe("discuss")
      }),
    withAgentDir,
  )
})

describe("the composer preview in a council", () => {
  it.instance(
    "an unaddressed draft previews the WHOLE council, not the lead",
    () =>
      Effect.gen(function* () {
        // One rule stack, so the line under the box is the routing the room
        // will actually do. A preview naming the lead here would teach a rule
        // the room does not have.
        const { directory, store, collab } = yield* room(["scribe", "reader"])
        yield* writeDef(directory, "scribe", "strict")
        yield* writeDef(directory, "reader", "strict")
        yield* store.setLead(collab.id, "scribe")

        expect((yield* ACPCollab.preview(directory, { collabId: collab.id })).wake).toEqual(["scribe"])
        yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "council" })
        expect((yield* ACPCollab.preview(directory, { collabId: collab.id })).wake).toEqual(["scribe", "reader"])
      }),
    withAgentDir,
  )

  it.instance(
    "a LEADLESS council does not claim nobody would answer",
    () =>
      Effect.gen(function* () {
        // The `no-lead` notice is read off the ANSWER now, not off the seat: a
        // leadless council still wakes its whole roster.
        const { directory, store, collab } = yield* room(["scribe", "reader"])
        yield* writeDef(directory, "scribe", "strict")
        yield* writeDef(directory, "reader", "strict")
        yield* store.setLead(collab.id, null)

        expect((yield* ACPCollab.preview(directory, { collabId: collab.id })).notice).toBe("no-lead")
        yield* ACPCollab.setFlavor(directory, { collabId: collab.id, flavor: "council" })
        const preview = yield* ACPCollab.preview(directory, { collabId: collab.id })
        expect(preview.wake).toEqual(["scribe", "reader"])
        expect(preview.notice).toBeUndefined()
      }),
    withAgentDir,
  )

  it.instance(
    "an ADDRESSED draft still previews exactly the members it names",
    () =>
      Effect.gen(function* () {
        const { directory, store, collab } = yield* room(["scribe", "reader"])
        yield* writeDef(directory, "scribe", "strict")
        yield* writeDef(directory, "reader", "strict")
        yield* store.setFlavor(collab.id, "council")
        expect((yield* ACPCollab.preview(directory, { collabId: collab.id, mentions: ["reader"] })).wake).toEqual([
          "reader",
        ])
      }),
    withAgentDir,
  )
})

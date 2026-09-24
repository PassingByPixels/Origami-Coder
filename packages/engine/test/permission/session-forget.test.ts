import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { SessionProjector } from "@origami/core/session/projector"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Fiber, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

/**
 * t-fijy8a F11. The permission service's `blocked` and `parents` maps were
 * never pruned. `blockedMs` — read by the background-job watchdog on every
 * tick — walks every blocked row and then walks `parents` upward from each, so
 * the cost of the watchdog grew with the number of sessions the engine had
 * ever seen, dead ones included.
 *
 * `Session.remove` now forgets them. Asserted through `blockedMs`, the only
 * reader of either map: a removed child must stop crediting its parent.
 */
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      Permission.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Todo.node,
    ]),
    [
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

/** One real block: the child asks, waits long enough to measure, is refused. */
const block = (permission: Permission.Interface, sessionID: SessionID, parentSessionID: SessionID) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(
      permission
        .ask({
          sessionID,
          parentSessionID,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })
        .pipe(Effect.ignore),
    )
    yield* Effect.sleep("40 millis")
    for (const request of yield* permission.list()) {
      yield* permission.reply({ requestID: request.id, reply: "reject" })
    }
    yield* Fiber.await(fiber)
  })

it.instance("Session.remove forgets the session's blocked time and parent link", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const parent = yield* sessions.create({ title: "parent" })
    const child = yield* sessions.create({ parentID: parent.id, title: "child" })
    yield* permission.link({ sessionID: child.id, parentSessionID: parent.id })

    yield* block(permission, child.id, parent.id)

    // The block is recorded, and it credits the parent through the link.
    expect(yield* permission.blockedMs(child.id)).toBeGreaterThan(0)
    expect(yield* permission.blockedMs(parent.id)).toBeGreaterThan(0)

    yield* sessions.remove(child.id)

    // Both maps are clean: no row for the child, and no link left to walk.
    expect(yield* permission.blockedMs(child.id)).toBe(0)
    expect(yield* permission.blockedMs(parent.id)).toBe(0)
  }),
)

it.instance("removing a PARENT forgets the whole tree, child rows included", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const parent = yield* sessions.create({ title: "parent" })
    const child = yield* sessions.create({ parentID: parent.id, title: "child" })
    yield* permission.link({ sessionID: child.id, parentSessionID: parent.id })
    yield* block(permission, child.id, parent.id)
    expect(yield* permission.blockedMs(child.id)).toBeGreaterThan(0)

    // `remove` recurses into the children first, so the whole tree goes.
    yield* sessions.remove(parent.id)

    expect(yield* permission.blockedMs(parent.id)).toBe(0)
    expect(yield* permission.blockedMs(SessionID.make(child.id))).toBe(0)
  }),
)

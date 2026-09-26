// t-w2txb2: an "always allow" answer outlives the engine process, for that chat only
// (owner decision 2026-09-24). The extension stops a long-idle engine and starts it again
// on the next message; before this, the restarted engine asked again for every answer the
// user had already given. The restart is the harness one (test/lib/restart-harness.ts): a
// new runtime over the same database, every process store emptied.

import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { runProcesses, setup, type Ctx } from "../lib/restart-harness"

const TIMEOUT = 120_000

/** Ask for `bash <command>` with the rules that make it an ask. The answer the user can
 *  give "always" to is the engine's own broadening, `git status *`. */
const askGit = (sessionID: string, command: string, parentSessionID?: string) =>
  Permission.Service.use((permission) =>
    permission.ask({
      sessionID: SessionID.make(sessionID),
      permission: "bash",
      patterns: [command],
      always: ["git status *"],
      metadata: {},
      ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      ...(parentSessionID ? { parentSessionID } : {}),
    }),
  )

/** Resolves true when the ask was answered without a human (allowed), false when it
 *  waited for an answer (it is then rejected so the test can go on). */
const answeredAlone = (sessionID: string, command: string, parentSessionID?: string) =>
  Effect.gen(function* () {
    const fiber = yield* askGit(sessionID, command, parentSessionID).pipe(Effect.exit, Effect.forkChild)
    for (let i = 0; i < 50; i++) {
      if (fiber.pollUnsafe()) return true
      const pending = yield* Permission.Service.use((p) => p.list())
      if (pending.length > 0) {
        for (const request of pending)
          yield* Permission.Service.use((p) => p.reply({ requestID: request.id, reply: "reject" }))
        yield* Fiber.await(fiber)
        return false
      }
      yield* Effect.sleep("10 millis")
    }
    throw new Error("the ask neither resolved nor waited")
  })

test(
  "an always-allow answer survives a restart for the chat that gave it, and only for it",
  async () => {
    const seen: Record<string, boolean> = {}
    const id = (ctx: Ctx, key: string) => ctx.ids.get(key)!
    await runProcesses({
      segments: [
        (ctx) =>
          Effect.gen(function* () {
            yield* setup(ctx, "chat")
            const other = yield* Session.Service.use((s) => s.create({ title: "Other chat" }))
            ctx.ids.set("other", other.id)
            // The user answers "always" once, in the chat.
            const fiber = yield* askGit(id(ctx, "chat"), "git status").pipe(Effect.forkChild)
            let pending: readonly { id: string }[] = []
            for (let i = 0; i < 100 && pending.length === 0; i++) {
              pending = yield* Permission.Service.use((p) => p.list())
              if (pending.length === 0) yield* Effect.sleep("10 millis")
            }
            yield* Permission.Service.use((p) => p.reply({ requestID: pending[0]!.id as never, reply: "always" }))
            yield* Fiber.join(fiber)
            seen.sameProcess = yield* answeredAlone(id(ctx, "chat"), "git status --short")
          }),
        (ctx) =>
          Effect.gen(function* () {
            seen.restoredChat = yield* answeredAlone(id(ctx, "chat"), "git status --short")
            // A sub-agent of that chat asks as the chat does.
            seen.restoredChild = yield* answeredAlone("ses_child_of_chat", "git status -b", id(ctx, "chat"))
          }),
        (ctx) =>
          Effect.gen(function* () {
            // Another chat's engine (a fresh process that serves only it) is asked again.
            seen.otherChat = yield* answeredAlone(id(ctx, "other"), "git status --short")
          }),
      ],
      restartAfter: () => true,
    })
    expect(seen).toEqual({ sameProcess: true, restoredChat: true, restoredChild: true, otherChat: false })
  },
  TIMEOUT,
)

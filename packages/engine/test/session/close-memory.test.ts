// A chat closed and reopened in the same engine sends the bytes it would have
// sent without the close (t-w2u5vf).
//
// `session/close` frees the chat's per-session memory in this process
// (EngineProcessMemory.evictSession, test/acp/service-close-memory.test.ts).
// The stores that feed the request bytes are persisted (t-w2qb1x) and load
// back on the first miss, so a reopen must not change a byte. The reference is
// the same script without a close, in the harness of restart-identity.test.ts;
// nothing is recorded.
//
// C1  close after every turn of the request-steps-golden script.
// C2  a decision learned and not yet written survives a close.

import { Database } from "@origami/core/database/database"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EngineProcessMemory } from "@/engine-process-memory"
import { SessionDegrade } from "@/session/degrade"
import { SessionImageCap } from "@/session/image-cap"
import { SessionRequestMemory } from "@/session/request-memory"
import { SessionToolAging } from "@/session/tool-aging"
import { AGED, count, runProcesses, setup, stepsScript, type Ctx, type Run } from "../lib/restart-harness"

// The shell tool describes the shell from $SHELL; unset, as in the steps golden.
delete process.env.SHELL

const TIMEOUT = 240_000

function expectSame(closed: Run, reference: Run) {
  expect(closed.bodies.length).toBe(reference.bodies.length)
  for (const [index, body] of closed.bodies.entries()) {
    const expected = reference.bodies[index]!
    if (body === expected) continue
    let at = 0
    while (at < body.length && body[at] === expected[at]) at++
    const around = (text: string) => text.slice(Math.max(0, at - 120), at + 120)
    expect(
      { request: index, aged: count(body, AGED), around: around(body) },
      "request " + index + " differs after a close",
    ).toEqual({ request: index, aged: count(expected, AGED), around: around(expected) })
  }
}

describe("C1: close after every turn == no close", () => {
  for (const [label, flags] of [
    ["native", {}],
    ["aisdk", { nativeLlmFamilies: "none" }],
  ] as const) {
    test(
      label + " runtime",
      async () => {
        const evicted: boolean[] = []
        const reference = await runProcesses({ flags, segments: stepsScript(), restartAfter: () => false })
        const closed = await runProcesses({
          flags,
          segments: stepsScript().map((segment) => (ctx: Ctx) =>
            segment(ctx).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  const id = ctx.ids.get("chat")!
                  EngineProcessMemory.evictSession(id)
                  evicted.push(SessionToolAging.has(id))
                }),
              ),
            ),
          ),
          restartAfter: () => false,
        })
        // One runtime: the close is not a restart. Each close really emptied
        // the aging store, so every later turn loaded it back.
        expect(closed.processes).toBe(1)
        expect(evicted).toEqual([false, false, false, false, false])
        expect(reference.bodies.length).toBe(9)
        expect(count(reference.bodies[3]!, AGED)).toBe(22)
        expect(count(reference.bodies[4]!, AGED)).toBe(40)
        expectSame(closed, reference)
      },
      TIMEOUT,
    )
  }
})

test(
  "C2: a refused knob and an image cap not yet written survive a close",
  async () => {
    const seen: Record<string, unknown> = {}
    const effort = SessionDegrade.KNOBS.find((knob) => knob.label === "reasoning effort")!
    await runProcesses({
      segments: [
        (ctx) =>
          Effect.gen(function* () {
            yield* setup(ctx, "chat")
            const id = ctx.ids.get("chat")!
            // Learned from a refusal; written only by the next request, which
            // has not happened when the chat closes.
            SessionDegrade.record(id, effort)
            SessionImageCap.record(id, 2)
            EngineProcessMemory.evictSession(id)
            seen.closed = { degrade: SessionDegrade.has(id), cap: SessionImageCap.has(id) }
            yield* Database.Service.use(({ db }) => SessionRequestMemory.ensure(db, id))
            seen.reopened = {
              stripped: SessionDegrade.strip(id, { reasoningEffort: "high", temperature: 1 }),
              cap: SessionImageCap.limit(id),
            }
          }),
      ],
      restartAfter: () => false,
    })
    expect(seen.closed).toEqual({ degrade: false, cap: false })
    expect(seen.reopened).toEqual({ stripped: { temperature: 1 }, cap: 2 })
  },
  TIMEOUT,
)

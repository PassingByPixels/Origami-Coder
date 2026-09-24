// `storage_stats` / `storage_prune` dispatch — the Insights Storage card's two
// wire methods (t-dcjs40). The bug worth catching is the destructive one: a
// window that arrives as a string, as NaN or not at all must be REFUSED, and a
// call that forgets `dryRun` must measure rather than write.

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"

const stub = (seen: unknown[] = []) =>
  ({
    storageStats: () => Effect.succeed({ fileBytes: 1 }),
    storagePrune: (input: { olderThanDays: number; dryRun: boolean }) => {
      seen.push(input)
      return Effect.succeed({ ...input, parts: 0 })
    },
  }) as unknown as ACPService.Interface

describe("storage ext method dispatch", () => {
  it("accepts the `_` wire prefix clients send for extension methods", async () => {
    const agent = new Agent(stub())
    expect(await agent.extMethod("_storage_stats", {})).toEqual(await agent.extMethod("storage_stats", {}))
  })

  it("refuses a window that is missing, non-numeric, NaN or not positive", () => {
    const agent = new Agent(stub())
    expect(() => agent.extMethod("storage_prune", {})).toThrow("Invalid params")
    expect(() => agent.extMethod("storage_prune", { olderThanDays: "60" })).toThrow("Invalid params")
    expect(() => agent.extMethod("storage_prune", { olderThanDays: Number.NaN })).toThrow("Invalid params")
    expect(() => agent.extMethod("storage_prune", { olderThanDays: 0 })).toThrow("Invalid params")
    expect(() => agent.extMethod("storage_prune", { olderThanDays: -30 })).toThrow("Invalid params")
  })

  it("writes only for an exact dryRun:false; anything else measures", async () => {
    const seen: unknown[] = []
    const agent = new Agent(stub(seen))

    await agent.extMethod("storage_prune", { olderThanDays: 60, dryRun: false })
    await agent.extMethod("storage_prune", { olderThanDays: 60 })
    await agent.extMethod("storage_prune", { olderThanDays: 60, dryRun: "false" })

    expect(seen).toEqual([
      { olderThanDays: 60, dryRun: false },
      { olderThanDays: 60, dryRun: true },
      { olderThanDays: 60, dryRun: true },
    ])
  })
})

// origami_change: `storage_compact` / `storage_vacuum` dispatch (t-rz12wq). Both
// rewrite the store, so the bug worth catching is a call that writes when the
// caller did not say so: a missing `dryRun` must measure, and anything short of
// an exact `confirm: true` must not vacuum.
const journalStub = (seen: unknown[] = []) =>
  ({
    storageCompact: (input: { dryRun: boolean; sessionId?: string }) => {
      seen.push(input)
      return Effect.succeed({ ...input, compacted: 0 })
    },
    storageVacuum: (input: { confirm: boolean }) => {
      seen.push(input)
      return Effect.succeed({ ...input, ran: false })
    },
  }) as unknown as ACPService.Interface

describe("journal ext method dispatch", () => {
  it("compacts dry unless dryRun is exactly false, and passes a session id through", async () => {
    const seen: unknown[] = []
    const agent = new Agent(journalStub(seen))

    await agent.extMethod("storage_compact", { dryRun: false })
    await agent.extMethod("storage_compact", {})
    await agent.extMethod("storage_compact", { dryRun: "false" })
    await agent.extMethod("storage_compact", { dryRun: false, sessionId: "ses_one" })
    await agent.extMethod("storage_compact", { sessionId: 7 })

    expect(seen).toEqual([
      { dryRun: false },
      { dryRun: true },
      { dryRun: true },
      { dryRun: false, sessionId: "ses_one" },
      { dryRun: true },
    ])
  })

  it("vacuums only on an exact confirm:true", async () => {
    const seen: unknown[] = []
    const agent = new Agent(journalStub(seen))

    await agent.extMethod("storage_vacuum", { confirm: true })
    await agent.extMethod("storage_vacuum", {})
    await agent.extMethod("storage_vacuum", { confirm: "true" })
    await agent.extMethod("storage_vacuum", { confirm: 1 })

    expect(seen).toEqual([{ confirm: true }, { confirm: false }, { confirm: false }, { confirm: false }])
  })
})

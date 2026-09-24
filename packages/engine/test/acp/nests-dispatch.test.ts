// Nests L4a (t-s9jgzh) wire dispatch. The bugs worth catching: a nest method
// that runs while the host says Nests is off (the feature must be inert), a
// refusal the host cannot tell apart from a fault, and a write whose shape was
// coerced instead of refused.

import { describe, expect, it } from "bun:test"
import { RequestError } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"

const METHODS = [
  "nest_index",
  "nest_apply_index",
  "nest_export",
  "nest_import",
  "nest_storage",
  "nest_retention",
  // L5 (t-sb9tlk)
  "nest_continue",
  "nest_release",
  "nest_reconcile",
]

const stub = (seen: { method: string; input: unknown }[] = []) => {
  const record = (method: string) => (input: unknown) => {
    seen.push({ method, input })
    return Effect.succeed({ ok: true })
  }
  return {
    nestIndex: record("nestIndex"),
    nestApplyIndex: record("nestApplyIndex"),
    nestExport: record("nestExport"),
    nestImport: record("nestImport"),
    nestStorage: record("nestStorage"),
    nestRetention: record("nestRetention"),
    nestContinue: record("nestContinue"),
    nestRelease: record("nestRelease"),
    nestReconcile: record("nestReconcile"),
  } as unknown as ACPService.Interface
}

/** Valid params for each method, so the only thing a test varies is the gate. */
const valid: Record<string, Record<string, unknown>> = {
  nest_index: {},
  nest_apply_index: { desk: "deskAAAAAAA", rows: [] },
  nest_export: { sessionId: "ses_one" },
  nest_import: { chunk: { sessionId: "ses_one", events: [] } },
  nest_storage: {},
  nest_retention: {},
  nest_continue: { sessionId: "ses_one", ownerOnline: true, ownerRunning: false },
  nest_release: { sessionId: "ses_one" },
  nest_reconcile: { sessionId: "ses_one", remoteSeq: 4 },
}

const thrown = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe("nest gate", () => {
  it("refuses every method unless enabled is exactly true, and runs nothing", () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    for (const method of METHODS)
      for (const enabled of [undefined, false, "true", 1]) {
        const error = thrown(() =>
          agent.extMethod(method, {
            ...valid[method],
            deviceId: "deskBBBBBBB",
            ...(enabled === undefined ? {} : { enabled }),
          }),
        )
        expect(error).toBeInstanceOf(RequestError)
        expect((error as RequestError).data).toEqual({ service: "nests", reason: "nests-off" })
      }
    expect(seen).toEqual([])
  })

  it("accepts the `_` wire prefix and passes deviceId through", async () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    await agent.extMethod("_nest_storage", { enabled: true, deviceId: "deskBBBBBBB" })
    expect(seen).toEqual([{ method: "nestStorage", input: { deviceId: "deskBBBBBBB" } }])
  })

  // t-vbivj4: the host asks for the partial sums of a slow measure with waitMs.
  it("passes nest_storage waitMs through and refuses a bad one", async () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    await agent.extMethod("_nest_storage", { enabled: true, deviceId: "deskBBBBBBB", waitMs: 1000 })
    expect(seen).toEqual([{ method: "nestStorage", input: { deviceId: "deskBBBBBBB", waitMs: 1000 } }])
    for (const waitMs of [-1, "1000", Number.NaN]) {
      const error = thrown(() => agent.extMethod("_nest_storage", { enabled: true, deviceId: "deskBBBBBBB", waitMs }))
      expect(String((error as RequestError).data)).toContain("waitMs")
    }
  })

  it("refuses a call with no deviceId", () => {
    const agent = new Agent(stub())
    for (const method of METHODS) {
      const error = thrown(() => agent.extMethod(method, { ...valid[method], enabled: true }))
      expect((error as RequestError).message).toBe("Invalid params")
      expect(String((error as RequestError).data)).toContain("deviceId")
    }
  })
})

describe("nest params", () => {
  const on = { enabled: true, deviceId: "deskBBBBBBB" }

  it("export resumes from after (default -1) and refuses a bad range", async () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    await agent.extMethod("nest_export", { ...on, sessionId: "ses_one" })
    await agent.extMethod("nest_export", { ...on, sessionId: "ses_one", after: 41, maxBytes: 1000 })
    expect(seen.map((entry) => entry.input)).toEqual([
      { deviceId: "deskBBBBBBB", sessionId: "ses_one", after: -1, maxBytes: 48 * 1024 },
      { deviceId: "deskBBBBBBB", sessionId: "ses_one", after: 41, maxBytes: 1000 },
    ])
    for (const bad of [{ after: "3" }, { after: 1.5 }, { after: -2 }, { maxBytes: 0 }, { sessionId: "" }])
      expect(() => agent.extMethod("nest_export", { ...on, sessionId: "ses_one", ...bad })).toThrow("Invalid params")
  })

  it("apply_index needs a desk and an array; replace only on an exact true", async () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    await agent.extMethod("nest_apply_index", { ...on, desk: "deskAAAAAAA", rows: [], replace: "true" })
    await agent.extMethod("nest_apply_index", { ...on, desk: "deskAAAAAAA", rows: [], replace: true })
    expect(seen.map((entry) => (entry.input as { replace: boolean }).replace)).toEqual([false, true])
    expect(() => agent.extMethod("nest_apply_index", { ...on, rows: [] })).toThrow("Invalid params")
    expect(() => agent.extMethod("nest_apply_index", { ...on, desk: "deskAAAAAAA", rows: {} })).toThrow(
      "Invalid params",
    )
  })

  it("retention refuses a window that is not a positive number or null; apply is dry by default", async () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    await agent.extMethod("nest_retention", { ...on, set: { chats: 30, toolOutput: null }, apply: {} })
    await agent.extMethod("nest_retention", { ...on, apply: { dryRun: false } })
    expect(seen.map((entry) => entry.input)).toEqual([
      { deviceId: "deskBBBBBBB", set: { chats: 30, toolOutput: null }, apply: { dryRun: true } },
      { deviceId: "deskBBBBBBB", apply: { dryRun: false } },
    ])
    for (const set of [{ chats: "30" }, { chats: 0 }, { chats: Number.NaN }, { bodies: 30 }])
      expect(() => agent.extMethod("nest_retention", { ...on, set })).toThrow("Invalid params")
  })

  it("t-vb87lt: a dry run may name windows to measure with; a real apply may not, and they take the set checks", async () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    await agent.extMethod("nest_retention", { ...on, apply: { dryRun: true, windows: { artifacts: 30, toolOutput: null } } })
    expect(seen[0]!.input).toEqual({
      deviceId: "deskBBBBBBB",
      apply: { dryRun: true, windows: { artifacts: 30, toolOutput: null } },
    })
    expect(() =>
      agent.extMethod("nest_retention", { ...on, apply: { dryRun: false, windows: { artifacts: 30 } } }),
    ).toThrow("Invalid params")
    for (const windows of [{ artifacts: 0 }, { bodies: 30 }, "30"])
      expect(() => agent.extMethod("nest_retention", { ...on, apply: { windows } })).toThrow("Invalid params")
  })

  it("continue needs a sessionId and both owner flags as booleans", async () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    await agent.extMethod("nest_continue", { ...on, sessionId: "ses_one", ownerOnline: false, ownerRunning: true })
    expect(seen[0]!.input).toEqual({
      deviceId: "deskBBBBBBB",
      sessionId: "ses_one",
      ownerOnline: false,
      ownerRunning: true,
    })
    for (const bad of [{ ownerRunning: "false" }, { ownerOnline: 1 }, { ownerRunning: undefined }, { sessionId: "" }])
      expect(() =>
        agent.extMethod("nest_continue", {
          ...on,
          sessionId: "ses_one",
          ownerOnline: true,
          ownerRunning: false,
          ...bad,
        }),
      ).toThrow("Invalid params")
  })

  it("release and reconcile: optional owner and deskName pass through, a bad one is refused", async () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    await agent.extMethod("nest_release", { ...on, sessionId: "ses_one" })
    await agent.extMethod("nest_release", { ...on, sessionId: "ses_one", owner: "deskAAAAAAA" })
    await agent.extMethod("nest_reconcile", { ...on, sessionId: "ses_one", remoteSeq: -1 })
    await agent.extMethod("nest_reconcile", {
      ...on,
      sessionId: "ses_one",
      remoteSeq: 7,
      owner: "deskAAAAAAA",
      deskName: "5090",
    })
    expect(seen.map((entry) => entry.input)).toEqual([
      { deviceId: "deskBBBBBBB", sessionId: "ses_one" },
      { deviceId: "deskBBBBBBB", sessionId: "ses_one", owner: "deskAAAAAAA" },
      { deviceId: "deskBBBBBBB", sessionId: "ses_one", remoteSeq: -1 },
      { deviceId: "deskBBBBBBB", sessionId: "ses_one", remoteSeq: 7, owner: "deskAAAAAAA", deskName: "5090" },
    ])
    expect(() => agent.extMethod("nest_release", { ...on, sessionId: "ses_one", owner: 5 })).toThrow("Invalid params")
    for (const remoteSeq of [undefined, "3", 1.5, -2])
      expect(() => agent.extMethod("nest_reconcile", { ...on, sessionId: "ses_one", remoteSeq })).toThrow(
        "Invalid params",
      )
    expect(() =>
      agent.extMethod("nest_reconcile", { ...on, sessionId: "ses_one", remoteSeq: 1, deskName: "" }),
    ).toThrow("Invalid params")
  })

  it("index passes only string ids from open", async () => {
    const seen: { method: string; input: unknown }[] = []
    const agent = new Agent(stub(seen))
    await agent.extMethod("nest_index", { ...on, deskName: "Surface", open: ["ses_a", 7, null, "ses_b"] })
    expect(seen[0]!.input).toEqual({ deviceId: "deskBBBBBBB", deskName: "Surface", open: ["ses_a", "ses_b"] })
  })
})

// `session_delete` — the one DESTRUCTIVE ext method. Two things are worth
// pinning and nothing else is: that a malformed request never reaches the
// store, and that a well-formed one calls exactly `sdk.session.delete` with
// the id it was given (the CASCADE itself — children, messages, parts — is the
// store's own behaviour and is proven in session/*, not re-asserted here).
//
// The fake sdk below FORBIDS every other session method by recording a
// `MUTATION:` marker, the same shape run-stats.test.ts uses, so a future
// implementation that "helpfully" loaded or listed the session first shows up
// as a failure rather than as extra latency nobody noticed.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"

function deleteSdk(calls: unknown[], fail?: Error) {
  const forbid =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`MUTATION:${name}`)
      void args
      return Promise.resolve({ data: {} })
    }
  return {
    session: {
      delete: (params: unknown) => {
        calls.push(params)
        return fail ? Promise.reject(fail) : Promise.resolve({ data: { id: "ses_a" } })
      },
      create: forbid("create"),
      get: forbid("get"),
      list: forbid("list"),
      messages: forbid("messages"),
      prompt: forbid("prompt"),
    },
  } as unknown as OrigamiClient
}

describe("session_delete service method", () => {
  it("deletes the named session in the given directory, and touches nothing else", async () => {
    const calls: unknown[] = []
    const service = ACPService.make({ sdk: deleteSdk(calls) })

    const result = await Effect.runPromise(service.sessionDelete({ sessionId: "ses_a", cwd: "/workspace" }))

    expect(calls).toEqual([{ sessionID: "ses_a", directory: "/workspace" }])
    expect(result).toEqual({ ok: true })
  })

  it("omits the directory when none was supplied, so the engine resolves its own", async () => {
    const calls: unknown[] = []
    await Effect.runPromise(ACPService.make({ sdk: deleteSdk(calls) }).sessionDelete({ sessionId: "ses_a" }))

    expect(calls).toEqual([{ sessionID: "ses_a" }])
  })

  // The reaper at the top of listSessions passes `throwOnError: false` and
  // swallows failures, because it is tidying. This is the opposite case: a user
  // pressed Delete, and a row that silently survives is worse than an error.
  it("FAILS the call when the store refuses, rather than reporting ok", async () => {
    const calls: unknown[] = []
    const service = ACPService.make({ sdk: deleteSdk(calls, new Error("locked")) })

    await expect(Effect.runPromise(service.sessionDelete({ sessionId: "ses_a" }))).rejects.toThrow()
  })
})

describe("session_delete ext method dispatch", () => {
  const service = {
    sessionDelete: (input: { sessionId: string; cwd?: string }) => Effect.succeed({ ok: true as const, ...input }),
  } as unknown as ACPService.Interface

  it("accepts the `_` wire prefix clients send for extension methods", async () => {
    const agent = new Agent(service)
    const prefixed = await agent.extMethod("_session_delete", { sessionId: "ses_a" })
    const bare = await agent.extMethod("session_delete", { sessionId: "ses_a" })
    expect(prefixed).toEqual(bare)
  })

  // Synchronously, exactly as `run_steps`/`run_stats` reject theirs: the
  // JSON-RPC layer turns a throw into an error response, so a client never gets
  // a plausible-looking `{ ok: true }` back for a request that deleted nothing.
  it("rejects a missing, non-string or EMPTY sessionId rather than guessing one", () => {
    const agent = new Agent(service)
    expect(() => agent.extMethod("session_delete", {})).toThrow("Invalid params")
    expect(() => agent.extMethod("session_delete", { sessionId: 42 })).toThrow("Invalid params")
    expect(() => agent.extMethod("session_delete", { sessionId: "" })).toThrow("Invalid params")
    expect(() => agent.extMethod("session_delete", { sessionId: null })).toThrow("Invalid params")
  })

  it("passes cwd through and omits it when absent", async () => {
    const seen: (string | undefined)[] = []
    const tracking = {
      sessionDelete: (input: { sessionId: string; cwd?: string }) => {
        seen.push(input.cwd)
        return Effect.succeed({ ok: true as const })
      },
    } as unknown as ACPService.Interface
    const agent = new Agent(tracking)

    await agent.extMethod("session_delete", { sessionId: "ses_a", cwd: "/workspace" })
    await agent.extMethod("session_delete", { sessionId: "ses_a" })

    expect(seen).toEqual(["/workspace", undefined])
  })
})

// origami_change: proves the fix for the interject incident - `request()`'s
// generic (non-ACP, non-auth) failure branch used to discard the real cause
// entirely. `fromUnknownError` still returns the same redacted
// `ServiceFailureError`, so the client-visible shape is untouched; the
// difference is that the raw error now reaches the engine log first, tagged
// with the failing service, via `mapRequestError` in acp/service.ts.

import { describe, expect, it } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import { Effect, Logger } from "effect"
import * as ACPService from "@/acp/service"
import * as ACPError from "@/acp/error"

/** Same shape @flock/routing.test.ts uses: a Logger that records raw messages
 * instead of formatting/writing them, so a test can assert on log content
 * without touching the real `~/.local/share/origami/log/origami.log` file. */
function captureLogs() {
  const lines: string[] = []
  const logger = Logger.make<unknown, void>((options) => {
    lines.push(JSON.stringify(options.message))
  })
  return { lines, layer: Logger.layer([logger]) }
}

/** Minimal SDK stub: `newSession` -> `loadDirectorySnapshot` calls
 * `sdk.config.providers` first inside a `Promise.all`, so making that call
 * fail is enough to reach `request(..., "directory")` - the other stubs only
 * need to exist for the cast, `Promise.all` never waits on them. */
function makeService(providers: () => Promise<unknown>) {
  const sdk = {
    config: {
      providers,
      get: () => Promise.resolve({ data: {} }),
    },
    app: {
      agents: () => Promise.resolve({ data: [] }),
      skills: () => Promise.resolve({ data: [] }),
    },
    command: { list: () => Promise.resolve({ data: [] }) },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: (_update: SessionNotification) => Promise.resolve(),
    extNotification: () => Promise.resolve(),
  } as unknown as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
  return ACPService.make({ sdk, connection })
}

describe("acp.service request logging", () => {
  it("logs the underlying cause for an unrecognized error, but the client still gets only the safe message", async () => {
    const service = makeService(() => Promise.reject(new Error("boom: upstream directory blew up")))
    const { lines, layer } = captureLogs()

    const requestError = await Effect.runPromise(
      service
        .newSession({ cwd: "/workspace", mcpServers: [] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip, Effect.provide(layer)),
    )

    // Wire contract: unchanged. The safe message and service tag are all the
    // client gets - no message, no stack.
    expect(requestError.code).toBe(-32603)
    expect(requestError.message).toBe("Internal error: Origami service failure")
    expect(requestError.data).toEqual({ service: "directory" })
    const wire = JSON.stringify(requestError.toErrorResponse())
    expect(wire).not.toContain("boom: upstream directory blew up")

    // The real cause reached the log sink - this is the fix. Before it, this
    // assertion is what fails: the array is empty.
    const logged = lines.join("\n")
    expect(logged).toContain("boom: upstream directory blew up")
    expect(logged).toContain("directory")
  })

  it("does not log an auth-required failure - fromUnknownError did not discard anything for it", async () => {
    const service = makeService(() => Promise.reject({ name: "ProviderAuthError", data: { providerID: "test" } }))
    const { lines, layer } = captureLogs()

    const requestError = await Effect.runPromise(
      service
        .newSession({ cwd: "/workspace", mcpServers: [] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip, Effect.provide(layer)),
    )

    expect(requestError.code).toBe(-32000)
    expect(lines).toHaveLength(0)
  })

  it("does not log an already-ACP error - it is returned as-is, nothing was discarded", async () => {
    const acpError = new ACPError.InvalidModelError({ modelId: "gpt-missing" })
    const service = makeService(() => Promise.reject(acpError))
    const { lines, layer } = captureLogs()

    const requestError = await Effect.runPromise(
      service
        .newSession({ cwd: "/workspace", mcpServers: [] })
        .pipe(Effect.mapError(ACPError.toRequestError), Effect.flip, Effect.provide(layer)),
    )

    expect(requestError.code).toBe(-32602)
    expect(requestError.data).toEqual({ modelId: "gpt-missing" })
    expect(lines).toHaveLength(0)
  })
})

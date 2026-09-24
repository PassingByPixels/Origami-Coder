// t-wusuep — a model switch used to be able to hang forever.
//
// `setSessionConfigOption("model", ...)` for a model the session snapshot has
// not seen self-heals: it re-reads the config and REBUILDS the directory
// snapshot. That rebuild lists every provider, and a catalog provider does it
// over the network, so it had no ceiling. The shell held its model lock for the
// whole of it and said nothing, which is how a brand-new chat came to answer
// its first model pick with "A model operation is already running".
//
// The engine's half of the fix: the rebuild is bounded, and the failure NAMES
// THE PROVIDER the user was switching to, because "timed out" alone does not
// tell them which box to go and look at.

import { describe, expect, it } from "bun:test"
import { Effect, Exit } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import type { ProviderV2 } from "@origami/core/provider"
import type { Provider } from "@/provider/provider"
import * as ACPService from "@/acp/service"
import { Directory } from "@/acp/directory"
import type { ACPSession } from "@/acp/session"

const CWD = "/workspace"
const SESSION = "ses_switch"

const emptySnapshot = () =>
  Directory.build({
    directory: CWD,
    providers: {} as Record<ProviderV2.ID, Provider.Info>,
    modes: [{ id: "build", name: "build" }],
    defaultModeID: "build",
    commands: [],
  })

const sdk = () =>
  ({
    config: { refresh: () => Promise.resolve({}) },
  }) as unknown as OrigamiClient

const session = () =>
  ({
    get: () => Effect.succeed({ id: SESSION, cwd: CWD } as unknown as ACPSession.Info),
  }) as unknown as ACPSession.Interface

/** A directory service whose rebuild never answers — the stalled provider. */
const hangingDirectory = (snapshot: Directory.Snapshot, refreshes: string[]) =>
  ({
    get: () => Effect.succeed(snapshot),
    refresh: (directory: string) => {
      refreshes.push(directory)
      return Effect.never
    },
  }) as unknown as Directory.Interface

/** The `safeMessage` the client would actually render for a failed switch. */
const failureMessage = async (effect: Effect.Effect<unknown, unknown>): Promise<string> => {
  const error = (await Effect.runPromise(Effect.flip(effect))) as { safeMessage?: string }
  return error?.safeMessage ?? String(error)
}

const settledDirectory = (snapshot: Directory.Snapshot) =>
  ({
    get: () => Effect.succeed(snapshot),
    refresh: () => Effect.succeed(snapshot),
  }) as unknown as Directory.Interface

describe("a model switch's directory rebuild is bounded, and the failure names the provider", () => {
  it("gives up on a rebuild that never answers instead of hanging the switch", async () => {
    const refreshes: string[] = []
    const service = ACPService.make({
      sdk: sdk(),
      session: session(),
      directory: hangingDirectory(emptySnapshot(), refreshes),
      directoryRefreshTimeoutMs: 40,
    })

    const exit = await Effect.runPromiseExit(
      service.setSessionConfigOption({ sessionId: SESSION, configId: "model", value: "slowprov/slowmodel" }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(refreshes).toEqual([CWD])
  })

  it("names the provider the user was switching to, and the ceiling it passed", async () => {
    const service = ACPService.make({
      sdk: sdk(),
      session: session(),
      directory: hangingDirectory(emptySnapshot(), []),
      directoryRefreshTimeoutMs: 40,
    })

    const failure = await failureMessage(
      service.setSessionConfigOption({ sessionId: SESSION, configId: "model", value: "slowprov/slowmodel" }),
    )
    expect(failure).toContain("slowprov")
    expect(failure).toContain("model list is still refreshing")
  })

  it("the DEFAULT ceiling sits under the shell's 30 s switch deadline, so the engine fails first", () => {
    expect(ACPService.DIRECTORY_REFRESH_TIMEOUT_MS).toBeLessThan(30_000)
    expect(ACPService.DIRECTORY_REFRESH_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it("a provider that answers is unaffected — the switch fails on the MODEL, not on a timeout", async () => {
    const service = ACPService.make({
      sdk: sdk(),
      session: session(),
      directory: settledDirectory(emptySnapshot()),
      directoryRefreshTimeoutMs: 40,
    })

    const failure = await failureMessage(
      service.setSessionConfigOption({ sessionId: SESSION, configId: "model", value: "fastprov/absent-model" }),
    )
    expect(failure).not.toContain("model list is still refreshing")
  })
})

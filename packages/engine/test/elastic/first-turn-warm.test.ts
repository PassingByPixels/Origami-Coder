// t-woacbl: the first prompt of every engine process built the provider catalog
// (350-450 ms, one block of the main thread) and the folder's location services
// (600+ ms) on the user's first message. A new chat, an adopted warm spare and a
// restored engine all paid it. The engine now builds that state after the
// session call answered, in the background. A warm spare stays inert until a
// chat adopts it.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { cliIt, type CliFixture } from "../lib/cli-process"
import { createAcpClient, expectOk } from "../cli/acp/acp-test-client"
import { verifierConfig } from "../cli/acp/helpers"

function initializeParams() {
  return {
    protocolVersion: 1,
    clientCapabilities: { _meta: { "terminal-auth": true } },
    clientInfo: { name: "origami-local-acp", version: "0.1.0" },
  }
}

/** The "first-turn warm" lines the engines of THIS test home logged. */
function warmLines(home: string): string[] {
  const file = path.join(home, ".local", "share", "origami", "log", "origami.log")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes('message="first-turn warm'))
}

const settle = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

function until<T>(read: () => T, check: (value: T) => boolean, ms: number) {
  return Effect.gen(function* () {
    const end = Date.now() + ms
    let value = read()
    while (!check(value) && Date.now() < end) {
      yield* settle(100)
      value = read()
    }
    return value
  })
}

function boot(origami: CliFixture["origami"], env: Record<string, string>) {
  return Effect.gen(function* () {
    const acp = createAcpClient(yield* origami.acp({ env }))
    expectOk(yield* acp.request("initialize", initializeParams()))
    return acp
  })
}

describe("first-turn warm (subprocess)", () => {
  cliIt.live(
    "a new session builds the provider catalog and the environment state before any prompt",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const acp = yield* boot(origami, { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) })
        expectOk(yield* acp.request("session/new", { cwd: home, mcpServers: [] }))
        const lines = yield* until(() => warmLines(home), (list) => list.length > 0, 20_000)
        expect(lines).toHaveLength(1)
        // Built, not skipped on an error (a warm that fails silently warms nothing).
        expect(lines[0]).toContain('message="first-turn warm"')
        expect(lines[0]).toContain("providerMs=")
        expect(yield* llm.hits).toHaveLength(0)
      }),
    90_000,
  )

  cliIt.live(
    "a warm spare warms nothing while it waits, and warms on adoption",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const spare = yield* boot(origami, {
          ORIGAMI_SPARE: "1",
          ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)),
        })
        expectOk(yield* spare.request("session/list", { cwd: home }))
        yield* settle(2000)
        expect(warmLines(home)).toEqual([])

        expectOk(yield* spare.request("session/new", { cwd: home, mcpServers: [] }))
        const lines = yield* until(() => warmLines(home), (list) => list.length > 0, 20_000)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('message="first-turn warm"')
      }),
    90_000,
  )
})

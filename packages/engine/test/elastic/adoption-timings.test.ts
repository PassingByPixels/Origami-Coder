// t-xnvp72: in the owner's UAT the first instance boot of every adopted warm spare took
// 5-8 s (Project.fromDirectory), and a store copy does not reproduce it. The engine now
// writes the boot's step timings and one `adoption timings` line to its log, so the next
// UAT log names the slow step. Real engine processes.
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

/** The log lines of THIS test home whose message is `message`. */
function lines(home: string, message: string): string[] {
  const file = path.join(home, ".local", "share", "origami", "log", "origami.log")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes(`message="${message}"`))
}

const field = (line: string, key: string) => new RegExp(`\\b${key}=("[^"]*"|\\S+)`).exec(line)?.[1]
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

describe("adoption timings (subprocess)", () => {
  cliIt.live(
    "an adopted spare logs one `adoption timings` line and the step timings of its first boot; its probe boot is not logged",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const spare = yield* boot(origami, {
          ORIGAMI_SPARE: "1",
          ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)),
        })
        // The window boot's probe: boots an instance while the spare waits.
        expectOk(yield* spare.request("session/list", { cwd: home }))
        yield* settle(1500)
        expect(lines(home, "boot timings")).toEqual([])
        expect(lines(home, "adoption timings")).toEqual([])

        expectOk(yield* spare.request("session/new", { cwd: home, mcpServers: [] }))
        const adoption = yield* until(() => lines(home, "adoption timings"), (list) => list.length > 0, 20_000)
        expect(adoption).toHaveLength(1)
        expect(field(adoption[0], "call")).toBe("session/new")
        for (const key of ["readyMs", "adoptMs", "disposeMs", "peersMs", "sessionMs", "mainThreadMaxBlockMs"])
          expect(Number(field(adoption[0], key))).toBeGreaterThanOrEqual(0)

        const timings = lines(home, "boot timings")
        expect(timings.map((line) => field(line, "boot"))).toEqual(["after-adoption"])
        expect(Number(field(timings[0], "fromDirectoryMs"))).toBeGreaterThan(0)
        expect(Number(field(timings[0], "bootstrapMs"))).toBeGreaterThan(0)
        const steps = lines(home, "boot step")
        expect(steps.length).toBeGreaterThan(0)
        expect(steps.every((line) => field(line, "boot") === "after-adoption")).toBe(true)
        expect(steps.some((line) => line.includes("Project.fromDirectory"))).toBe(true)

        // A second chat on the same engine: no second adoption line, no more boot lines.
        expectOk(yield* spare.request("session/new", { cwd: home, mcpServers: [] }))
        yield* settle(1500)
        expect(lines(home, "adoption timings")).toHaveLength(1)
        expect(lines(home, "boot timings")).toHaveLength(1)
      }),
    90_000,
  )

  cliIt.live(
    "an ordinary engine logs its first boot for comparison, and no adoption",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const acp = yield* boot(origami, { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) })
        expectOk(yield* acp.request("session/new", { cwd: home, mcpServers: [] }))
        const timings = yield* until(() => lines(home, "boot timings"), (list) => list.length > 0, 20_000)
        expect(timings.map((line) => field(line, "boot"))).toEqual(["first"])
        expect(Number(field(timings[0], "fromDirectoryMs"))).toBeGreaterThan(0)
        yield* settle(1000)
        expect(lines(home, "adoption timings")).toEqual([])
        expect(lines(home, "boot timings")).toHaveLength(1)
      }),
    90_000,
  )
})

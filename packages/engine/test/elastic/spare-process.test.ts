// t-w2u2ki (Elastic E6): a WARM SPARE engine, as real processes.
//
// The VS Code shell starts one engine per window ahead of time (ORIGAMI_SPARE=1)
// so a new chat does not wait for a process start. Until its first session the
// spare must be invisible and inert: no peer heartbeat (list_agents), no Flock
// service, no MCP servers. And a chat that adopts it must send the SAME bytes a
// freshly started engine would (scope C test S1) - including after the spare
// served the window's restore probe (`session/list`) and after the global
// origami.json changed while it waited.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cliIt, type CliFixture } from "../lib/cli-process"
import { createAcpClient, expectOk, type AcpClient } from "../cli/acp/acp-test-client"
import { verifierConfig } from "../cli/acp/helpers"

const SPARE = { ORIGAMI_SPARE: "1" }

function initializeParams() {
  return {
    protocolVersion: 1,
    clientCapabilities: { _meta: { "terminal-auth": true } },
    clientInfo: { name: "origami-local-acp", version: "0.1.0" },
  }
}

/** The peer heartbeat files the engines of THIS test home wrote (`~/.origami/agents`). */
function heartbeats(home: string): Array<{ name: string; pid: number }> {
  const dir = path.join(home, ".origami", "agents")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { name: string; pid: number })
}

const settle = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

/** Poll until `check` holds or `ms` passes; returns the last value. */
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

/** One engine: initialize, then (optionally) the restore probe the window runs on the spare. */
function boot(origami: CliFixture["origami"], env: Record<string, string>) {
  return Effect.gen(function* () {
    const acp = createAcpClient(yield* origami.acp({ env }))
    const init = expectOk(yield* acp.request<{ agentInfo?: { _meta?: { peerName?: string } } }>("initialize", initializeParams()))
    return { acp, peerName: init.agentInfo?._meta?.peerName }
  })
}

function chat(acp: AcpClient, cwd: string, text: string) {
  return Effect.gen(function* () {
    const created = expectOk(yield* acp.request<{ sessionId: string }>("session/new", { cwd, mcpServers: [] }))
    expectOk(yield* acp.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text }] }))
    return created.sessionId
  })
}

describe("warm spare engine (subprocess)", () => {
  cliIt.live(
    "a spare writes no peer heartbeat until its first session, then registers under the name initialize reported",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const env = { ...SPARE, ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) }
        const spare = yield* boot(origami, env)
        // The window's restore probe runs on the spare; it must not make it a peer.
        expectOk(yield* spare.acp.request("session/list", { cwd: home }))
        yield* settle(1500)
        expect(heartbeats(home)).toEqual([])
        // The chat that adopts the spare shows its peer name from initialize.
        expect(spare.peerName).toMatch(/-\d+$/)
        expect(expectOk(yield* spare.acp.request("_elastic_spare", {}))).toEqual({ spare: true, adopted: false })

        expectOk(yield* spare.acp.request("session/new", { cwd: home, mcpServers: [] }))
        const after = yield* until(() => heartbeats(home), (list) => list.length > 0, 10_000)
        expect(after.map((entry) => entry.name)).toEqual([spare.peerName!])
        expect(expectOk(yield* spare.acp.request("_elastic_spare", {}))).toEqual({ spare: false, adopted: true })
      }),
    90_000,
  )

  cliIt.live(
    "an engine started without the variable registers at boot and never reports itself a spare",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const plain = yield* boot(origami, { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) })
        const registered = yield* until(() => heartbeats(home), (list) => list.length > 0, 10_000)
        expect(registered.map((entry) => entry.name)).toEqual([plain.peerName!])
        expect(expectOk(yield* plain.acp.request("_elastic_spare", {}))).toEqual({ spare: false, adopted: false })
      }),
    90_000,
  )

  cliIt.live(
    "a spare starts no MCP server before it is adopted (guard)",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        // A "server" that only records that it was started. It never answers, so
        // the engine gives up on it - the start is what this test is about.
        const marker = path.join(home, "mcp-started.txt")
        const script = path.join(home, "fake-mcp.js")
        writeFileSync(script, `require("fs").appendFileSync(${JSON.stringify(marker)}, "start\\n"); setInterval(() => {}, 1000)\n`)
        const config = {
          ...verifierConfig(llm.url),
          mcp: { probe: { type: "local", command: [process.execPath, script], enabled: true } },
        }
        const spare = yield* boot(origami, { ...SPARE, ORIGAMI_CONFIG_CONTENT: JSON.stringify(config) })
        expectOk(yield* spare.acp.request("session/list", { cwd: home }))
        yield* settle(3000)
        expect(existsSync(marker)).toBe(false)

        expectOk(yield* spare.acp.request("session/new", { cwd: home, mcpServers: [] }))
        const started = yield* until(() => existsSync(marker), (seen) => seen, 20_000)
        expect(started).toBe(true)
      }),
    90_000,
  )

  cliIt.live(
    "S1: an adopted spare sends the same first request as a fresh engine, after a probe and a global config change",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        // The global origami.json on DISK (not ORIGAMI_CONFIG_CONTENT), so a change
        // made while the spare waits is a change a fresh engine would read.
        const configFile = path.join(home, ".config", "origami", "origami.json")
        mkdirSync(path.dirname(configFile), { recursive: true })
        writeFileSync(configFile, JSON.stringify({ ...verifierConfig(llm.url), model: "test/test-model" }, null, 2))
        const env = { ORIGAMI_CONFIG_CONTENT: "", ORIGAMI_DB: path.join(home, "s1.db") }

        const spare = yield* boot(origami, { ...env, ...SPARE })
        expectOk(yield* spare.acp.request("session/list", { cwd: home }))
        yield* settle(1000)

        // The owner edits the global config while the spare waits.
        const instruction = path.join(home, "EXTRA.md")
        writeFileSync(instruction, "SPARE-S1-INSTRUCTION: answer briefly.\n")
        writeFileSync(
          configFile,
          JSON.stringify({ ...verifierConfig(llm.url), model: "test/test-model", instructions: [instruction] }, null, 2),
        )

        const adopted = yield* chat(spare.acp, home, "hello from a new chat")
        const fresh = yield* boot(origami, env)
        const other = yield* chat(fresh.acp, home, "hello from a new chat")

        const hits = (yield* llm.hits).filter((hit) => !hit.raw.includes("Generate a title for this conversation"))
        const bodies = [adopted, other].map((sessionId) => {
          const hit = hits.find((item) => item.raw.includes(sessionId)) ?? hits[[adopted, other].indexOf(sessionId)]
          return hit.raw.split(sessionId).join("<SESSION>")
        })
        expect(bodies).toHaveLength(2)
        expect(bodies[1]).toContain("SPARE-S1-INSTRUCTION")
        expect(bodies[0]).toBe(bodies[1])
      }),
    120_000,
  )
})


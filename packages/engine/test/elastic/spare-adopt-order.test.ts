// t-y4x518: a new chat on the warm spare. In the owner's 0.4.179 UAT the pane's first
// call reached the spare 10 ms before `session/new` adopted it: that call booted an
// instance, the adoption waited for the boot (up to its limit) and disposed it, and the
// chat's own instance booted again. And the spare waits lowered (IDLE + EcoQoS): the
// chat's work must not run throttled. Real engine processes, the calls in the order
// WarmSpare.take() and the pane send them, without waiting for the answers in between.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import os from "node:os"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { cliIt, type AcpHandle } from "../lib/cli-process"
import { createAcpClient, expectOk } from "../cli/acp/acp-test-client"
import { verifierConfig } from "../cli/acp/helpers"
import { ElasticOs } from "../../src/elastic/os"

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
    .filter((line) => line.includes(`message="${message}"`) || line.includes(`message=${message} `))
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

/** Send several requests without waiting in between (the extension does not wait), then collect every answer. */
function burst(handle: AcpHandle, calls: Array<{ method: string; params: unknown; afterMs?: number }>, firstId: number) {
  return Effect.gen(function* () {
    const ids = calls.map((_, index) => firstId + index)
    for (const [index, call] of calls.entries()) {
      if (call.afterMs) yield* settle(call.afterMs)
      yield* handle.send({ jsonrpc: "2.0", id: ids[index], method: call.method, params: call.params })
    }
    const answers = new Map<number, { result?: unknown; error?: unknown }>()
    const end = Date.now() + 60_000
    while (answers.size < ids.length && Date.now() < end) {
      const message = (yield* handle.receive) as { id?: number; method?: string; result?: unknown; error?: unknown }
      if (typeof message?.id === "number" && message.method === undefined && ids.includes(message.id)) answers.set(message.id, message)
    }
    return ids.map((id) => answers.get(id))
  })
}

/** The OS priority of this test's child processes (the engine and what it started). Windows only. */
function childPriorities(): number[] {
  const kernel = ElasticOs.kernel32()
  return ElasticOs.descendantsOf(process.pid, kernel.parents(), new Set(), (pid) => kernel.createdAt(pid))
    .map((pid) => {
      try {
        return os.getPriority(pid)
      } catch {
        return undefined
      }
    })
    .filter((value): value is number => value !== undefined)
}

describe("warm spare adoption order (subprocess)", () => {
  cliIt.live(
    "the chat's first call and session/new, sent right after the adoption signal, boot one instance; no boot is thrown away",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const handle = yield* origami.acp({
          env: { ORIGAMI_SPARE: "1", ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        })
        const spare = createAcpClient(handle)
        expectOk(yield* spare.request("initialize", initializeParams()))
        expectOk(yield* spare.request("_elastic_spare", {}))
        expectOk(yield* spare.request("_elastic_class", { class: "idle" }))
        yield* settle(500)

        // WarmSpare.take(): the class, then the adoption signal; then the pane's first call and,
        // 10 ms later, the chat's session/new. None waits for an answer.
        const answers = yield* burst(
          handle,
          [
            { method: "_elastic_class", params: { class: "active" } },
            { method: "_elastic_adopt", params: {} },
            { method: "_list_skills", params: { cwd: home } },
            { method: "session/new", params: { cwd: home, mcpServers: [] }, afterMs: 10 },
          ],
          100,
        )
        // The adoption line is written last, after session/new answered; the log is written behind.
        yield* until(() => lines(home, "adoption timings"), (list) => list.length > 0, 20_000)
        // One boot, the chat's own; none started before the adoption and was disposed by it.
        expect(lines(home, "boot timings").map((line) => field(line, "boot"))).toEqual(["after-adoption"])
        expect(lines(home, "creating instance")).toHaveLength(1)
        expect(lines(home, "disposing instance")).toHaveLength(0)
        const adoption = lines(home, "adoption timings")
        expect(adoption).toHaveLength(1)
        expect(field(adoption[0], "disposeLimitHit")).toBe("false")
        for (const answer of answers) expect(answer?.error).toBeUndefined()
        expect(answers[1]?.result).toEqual({ adopted: true })
      }),
    90_000,
  )

  cliIt.live(
    "an adoption lifts a spare that waits at the idle class, also when no `_elastic_class active` comes",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return // the OS priority read-back below is the Windows one
        const spare = createAcpClient(
          yield* origami.acp({ env: { ORIGAMI_SPARE: "1", ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) } }),
        )
        expectOk(yield* spare.request("initialize", initializeParams()))
        const lowered = expectOk(yield* spare.request<{ priority: string }>("_elastic_class", { class: "idle" }))
        expect(lowered.priority).toBe("idle")
        expect(childPriorities()).toContain(os.constants.priority.PRIORITY_LOW)

        expectOk(yield* spare.request("session/new", { cwd: home, mcpServers: [] }))
        const after = childPriorities()
        expect(after.length).toBeGreaterThan(0)
        expect(after).not.toContain(os.constants.priority.PRIORITY_LOW)
      }),
    90_000,
  )
})

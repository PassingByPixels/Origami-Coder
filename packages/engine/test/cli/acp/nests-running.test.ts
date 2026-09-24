// t-tc2b6c. A TURN THAT RUNS IN ANOTHER ENGINE ON THE SAME STORE.
//
// Every chat pane (and the per-window host engine, t-sh7cog) is its own engine
// process, and all of them open one store. The Nests calls reach whichever
// engine the host picked. Three REAL engine processes:
//
//   - E2 (desk A, store A) runs a turn that does not end (the model hangs).
//   - E1 (desk A, store A) serves the nest calls. It never loaded the chat.
//   - E3 (desk B, store B) is the other desk.
//
// The claims:
//   1. E1's index row says `running`, so desk B's "Continue here" (the host
//      computes `ownerRunning` from that row, nestHub.ts `continueHere`) FORKS
//      the chat instead of taking it.
//   2. A release on E1 stops the turn in E2, and E2 then refuses a new prompt.
import { Database } from "bun:sqlite"
import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import path from "node:path"
import { cliIt, type AcpHandle } from "../../lib/cli-process"
import { verifierConfig } from "./helpers"

const DESK_A = "deskAAAAAAA"
const DESK_B = "deskBBBBBBB"

type Message = { id?: number; method?: string; result?: Record<string, unknown>; error?: { message?: string } }

/** A JSON-RPC client that can leave a request open (the prompt that runs) and
 *  answer it later. Every message is kept; a reply is found by id. */
function rpc(handle: AcpHandle) {
  const seen: Message[] = []
  let next = 1
  const pump = Effect.forkScoped(
    Effect.forever(handle.receive.pipe(Effect.map((message) => void seen.push(message as Message)))),
  )
  const send = (method: string, params: unknown) =>
    Effect.gen(function* () {
      const id = next++
      yield* handle.send({ jsonrpc: "2.0", id, method, params })
      return id
    })
  const reply = (id: number, ms = 20_000) =>
    Effect.gen(function* () {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const found = seen.find((message) => message.id === id && message.method === undefined)
        if (found) return found
        yield* Effect.sleep(Duration.millis(50))
      }
      return undefined
    })
  const call = (method: string, params: unknown, ms?: number) =>
    Effect.gen(function* () {
      const found = yield* reply(yield* send(method, params), ms)
      if (!found) throw new Error(`${method}: no reply`)
      if (found.error) throw new Error(`${method}: ${JSON.stringify(found.error)}`)
      return found.result as Record<string, any>
    })
  return { pump, send, reply, call }
}

const init = {
  protocolVersion: 1,
  clientCapabilities: { _meta: { "terminal-auth": true } },
  clientInfo: { name: "origami-local-acp", version: "0.1.0" },
}

describe("nests with a turn in another engine on the same store (t-tc2b6c)", () => {
  cliIt.live(
    "the index says running, desk B forks, and a release stops the turn in the other engine",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const config = JSON.stringify(verifierConfig(llm.url))
        const storeA = { ORIGAMI_CONFIG_CONTENT: config, ORIGAMI_DB: path.join(home, "desk-a.db") }
        const storeB = { ORIGAMI_CONFIG_CONTENT: config, ORIGAMI_DB: path.join(home, "desk-b.db") }
        const e1 = rpc(yield* origami.acp({ env: storeA }))
        const e2 = rpc(yield* origami.acp({ env: storeA }))
        const e3 = rpc(yield* origami.acp({ env: storeB }))
        for (const engine of [e1, e2, e3]) {
          yield* engine.pump
          yield* engine.call("initialize", init, 60_000)
        }
        const nest = (engine: typeof e1, method: string, deviceId: string, params: Record<string, unknown>) =>
          engine.call(`_${method}`, { enabled: true, deviceId, ...params })

        // E2 runs a first turn BEFORE Nests is on for this store: E2's guard
        // reads no device, and the turn makes no lease.
        const { sessionId } = yield* e2.call("session/new", { cwd: home, mcpServers: [] })
        yield* llm.text("first answer")
        yield* e2.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "first" }] })
        // Nests is turned on (the host's first index call, on E1), then E2 runs
        // a turn that does not end.
        yield* nest(e1, "nest_index", DESK_A, { deskName: "5090", open: [] })
        const hits = yield* llm.calls
        yield* llm.hang
        const prompt = yield* e2.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] })
        yield* llm.wait(hits + 1)
        // The turn is in flight on E2 and nowhere else.
        expect(yield* e2.reply(prompt, 500)).toBeUndefined()

        // 1. E1 never loaded the chat, but its index sees the turn.
        const index = yield* nest(e1, "nest_index", DESK_A, { deskName: "5090", open: [] })
        const row = (index.rows as Array<{ id: string; state: string }>).find((item) => item.id === sessionId)
        expect(row?.state).toBe("running")

        // Desk B pulls the chat and presses "Continue here" as the host does.
        let after = -1
        while (true) {
          const chunk = yield* nest(e1, "nest_export", DESK_A, { sessionId, after, maxBytes: 1 << 20 })
          const imported = yield* nest(e3, "nest_import", DESK_B, { chunk })
          expect(imported.refused).toBeUndefined()
          after = imported.have
          if (imported.done) break
        }
        const continued = yield* nest(e3, "nest_continue", DESK_B, {
          sessionId,
          ownerOnline: true,
          ownerRunning: row?.state === "running",
        })
        expect(continued.result).toBe("forked")
        expect(continued.sessionId).not.toBe(sessionId)

        // 2. The hand-over frame reaches desk A on E1: the turn in E2 stops.
        const released = yield* nest(e1, "nest_release", DESK_A, { sessionId, owner: DESK_B })
        expect(released).toMatchObject({ sessionId, owner: DESK_B, aborted: true })
        const stopped = yield* e2.reply(prompt, 15_000)
        expect(stopped?.result?.["stopReason"]).toBe("cancelled")
        // t-tjhmhw: the turn stops BEFORE the owner flips, so its closing state
        // is written on desk A: every assistant message of the chat is completed.
        const file = new Database(storeA.ORIGAMI_DB, { readonly: true })
        const assistants = (
          file.query("SELECT data FROM message WHERE session_id = ?").all(sessionId) as Array<{ data: string }>
        )
          .map((row) => JSON.parse(row.data) as { role: string; time: { completed?: number }; error?: { name: string } })
          .filter((message) => message.role === "assistant")
        file.close()
        expect(assistants).toHaveLength(2)
        for (const message of assistants) expect(typeof message.time.completed).toBe("number")
        expect(assistants.map((message) => message.error?.name)).toContain("MessageAbortedError")
        // The seq the release reports includes what the stop wrote.
        const after2 = yield* nest(e1, "nest_index", DESK_A, { deskName: "5090", open: [] })
        const held = (after2.rows as Array<{ id: string; seq: number; state: string }>).find(
          (item) => item.id === sessionId,
        )
        expect(held?.state).not.toBe("running")
        expect(released.seq).toBe(held?.seq)

        // E2 made no nest call itself; the chat is now read only there too.
        const refused = yield* e2.reply(
          yield* e2.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] }),
        )
        expect(refused?.error?.message ?? "").toContain("read only")
      }),
    180_000,
  )
})

// t-tjhmhw. A TURN THAT PASSED THE READ-ONLY GUARD BEFORE THE OWNER FLIPPED.
//
// The nest_run lease (t-tc2b6c) stops a turn the release can see. A prompt
// that the ACP guard admitted in the instant before the owner flip can still
// start after the release looked for running turns, so nothing stops it. Here
// the flip is made directly in the store while the turn waits on the model (no
// release, so no stop request): the turn is exactly that unseen turn.
//
// The claim: once another desk owns the chat, no durable write from this
// engine lands in it. The turn ends with the read-only refusal (not a hang,
// not a retry loop), and the engine still serves other chats.
import { Database } from "bun:sqlite"
import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import path from "node:path"
import { cliIt, type AcpHandle } from "../../lib/cli-process"
import { verifierConfig } from "./helpers"

const DESK_A = "deskAAAAAAA"
const DESK_B = "deskBBBBBBB"

type Message = { id?: number; method?: string; result?: Record<string, unknown>; error?: { message?: string } }

/** The same JSON-RPC client as nests-running.test.ts: a request can stay open
 *  (the prompt that runs) and be answered later. */
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

describe("nests: a turn that passed the guard before the owner flip (t-tjhmhw)", () => {
  cliIt.live(
    "writes nothing into the chat once another desk owns it, and ends with the read-only refusal",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const file = path.join(home, "desk-a.db")
        const env = { ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)), ORIGAMI_DB: file }
        const engine = rpc(yield* origami.acp({ env }))
        yield* engine.pump
        yield* engine.call("initialize", init, 60_000)

        // A chat of this desk with one finished turn, then Nests on (desk A).
        const { sessionId } = yield* engine.call("session/new", { cwd: home, mcpServers: [] })
        yield* llm.text("first answer")
        yield* engine.call("session/prompt", { sessionId, prompt: [{ type: "text", text: "first" }] })
        yield* engine.call("_nest_index", { enabled: true, deviceId: DESK_A, deskName: "5090", open: [] })

        // The next prompt passes the guard (desk A still owns the chat) and
        // waits on the model.
        let answer!: () => void
        const held = new Promise<void>((resolve) => (answer = resolve))
        const hits = yield* llm.calls
        yield* llm.hold("an answer that must not land", held)
        const prompt = yield* engine.send("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] })
        yield* llm.wait(hits + 1)

        // The owner flips to desk B while the turn is in flight.
        const store = new Database(file)
        store.run("PRAGMA busy_timeout = 5000")
        const seq = () =>
          (store.query("SELECT seq FROM event_sequence WHERE aggregate_id = ?").get(sessionId) as { seq: number }).seq
        store.run("UPDATE event_sequence SET owner_id = ? WHERE aggregate_id = ?", [DESK_B, sessionId])
        const flippedAt = seq()
        answer()

        // The turn ends, visibly, with the read-only refusal.
        const ended = yield* engine.reply(prompt, 30_000)
        expect(ended).toBeDefined()
        expect(ended?.result).toBeUndefined()
        expect(ended?.error?.message ?? "").toContain("read only")
        // Nothing reached the chat after the flip, and the owner is still desk B.
        expect(seq()).toBe(flippedAt)
        expect(store.query("SELECT owner_id FROM event_sequence WHERE aggregate_id = ?").get(sessionId)).toEqual({
          owner_id: DESK_B,
        })
        // No retry loop: the model was not asked again for this chat.
        yield* Effect.sleep(Duration.millis(1_500))
        expect(yield* llm.calls).toBe(hits + 1)
        store.close()

        // The engine is healthy: a chat this desk owns still runs a turn.
        const other = yield* engine.call("session/new", { cwd: home, mcpServers: [] })
        yield* llm.text("still here")
        const fine = yield* engine.call("session/prompt", {
          sessionId: other.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        })
        expect(fine.stopReason).toBe("end_turn")
      }),
    180_000,
  )
})

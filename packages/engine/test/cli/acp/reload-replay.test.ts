// What a WINDOW RELOAD actually gets back. Two engine processes, one database:
// the first runs a tool turn and dies, the second calls `session/load` and its
// whole notification stream is captured. That second stream is the contract the
// VS Code client rebuilds a reopened chat from, and it is the only place the
// two reload defects can be separated - the client cannot render what the
// engine never sent, and the engine cannot be blamed for what it did send.
//
// The same capture is the fixture for the client-side half of the fix
// (packages/vscode/webview/dashboard/__tests__/reloadReplay.fixture.json).
import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { verifierConfig } from "./helpers"

const DRAINED = Symbol("drained")

type Update = { sessionUpdate?: string; title?: string; toolCallId?: string; status?: string; _meta?: Record<string, unknown> }
type Notification = { method?: string; params?: { sessionId?: string; update?: Update } }

/** A JSON-RPC client that KEEPS every notification instead of discarding the
 *  ones it was not waiting for - the discarded ones are the subject here. */
function recorder(acp: { send: (msg: object) => Effect.Effect<void>; receive: Effect.Effect<unknown> }) {
  const log: unknown[] = []
  const state = { nextId: 1 }

  const request = <T>(method: string, params?: unknown) =>
    Effect.gen(function* () {
      const id = state.nextId++
      yield* acp.send(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params })
      while (true) {
        const received = yield* acp.receive.pipe(Effect.timeout(Duration.seconds(60)))
        log.push(received)
        const msg = received as { id?: number; method?: string; result?: T }
        if (msg && typeof msg === "object" && msg.id === id && msg.method === undefined) return msg
      }
    })

  /** Read until the stream goes quiet - a replay has no "done" marker. */
  const drain = (ms: number) =>
    Effect.gen(function* () {
      while (true) {
        const got = yield* acp.receive.pipe(
          Effect.timeoutOrElse({ duration: Duration.millis(ms), orElse: () => Effect.succeed(DRAINED as unknown) }),
        )
        if (got === DRAINED) return
        log.push(got)
      }
    })

  const updates = () =>
    (log as Notification[])
      .filter((msg) => msg.method === "session/update" && msg.params?.update !== undefined)
      .map((msg) => msg.params!.update!)

  return { request, drain, updates }
}

function initializeParams() {
  return {
    protocolVersion: 1,
    clientCapabilities: { _meta: { "terminal-auth": true } },
    clientInfo: { name: "origami-local-acp", version: "0.1.0" },
  }
}

describe("origami acp reload replay subprocess", () => {
  cliIt.live(
    "a session reopened in a NEW engine process replays its tool call and its stored title",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        const target = path.join(home, "CAPTURE.md")
        yield* Effect.promise(() => writeFile(target, "# capture fixture\nline two\n"))

        // test/preload.ts pins ORIGAMI_DB=":memory:" in THIS process, and
        // cli-process.ts spawns children with `{...process.env}`, so without an
        // explicit file database each subprocess would get its own empty store
        // and "reload" could not see the first process's session at all.
        const env = {
          ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)),
          ORIGAMI_DB: path.join(home, "reload.db"),
        }

        const live = yield* origami.acp({ env })
        const first = recorder(live)
        yield* first.request("initialize", initializeParams())
        const created = yield* first.request<{ sessionId: string }>("session/new", { cwd: home, mcpServers: [] })
        const sessionId = (created.result as { sessionId: string }).sessionId

        yield* llm.tool("read", { filePath: target })
        yield* llm.text("read the file")
        yield* first.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "Read CAPTURE.md please." }],
        })
        // The title turn runs after the prompt returns; let it land on the row.
        yield* first.drain(6000)
        expect(first.updates().some((update) => update.sessionUpdate === "tool_call")).toBe(true)

        // The reload: this engine process is gone before the next one starts, so
        // nothing can be served out of its memory.
        yield* Effect.sync(() => live.close())
        yield* Effect.promise(() => live.exited).pipe(
          Effect.timeoutOrElse({ duration: Duration.seconds(10), orElse: () => Effect.succeed(-1) }),
        )

        const reloaded = yield* origami.acp({ env })
        const second = recorder(reloaded)
        yield* second.request("initialize", initializeParams())
        yield* second.request("session/load", { cwd: home, sessionId, mcpServers: [] })
        yield* second.drain(6000)

        const replay = second.updates()

        // Defect 1's evidence: the replay DOES carry the tool events, with the
        // `origami_tool_name` rider the client draws the card from. A client
        // that shows plain text here is losing them itself.
        const call = replay.find((update) => update.sessionUpdate === "tool_call")
        expect(call?.toolCallId).toBe("call_1")
        expect(call?._meta?.["origami_tool_name"]).toBe("read")
        const done = replay.find(
          (update) => update.sessionUpdate === "tool_call_update" && update.status === "completed",
        )
        expect(done?.toolCallId).toBe("call_1")
        expect(done?._meta?.["origami_tool_name"]).toBe("read")

        // Defect 2: the stored title, pushed on load. `session.updated` fired in
        // the process that generated it - which no longer exists - so this
        // notification is the ONLY way a reconnecting client can learn the name
        // of the chat it just reopened. Without it the client has nothing to
        // show but its own placeholder.
        const info = replay.find((update) => update.sessionUpdate === "session_info_update")
        expect(info?.title).toBe("E2E Title")

        // Order matters: a client applies the title to a session it already
        // knows about, and the transcript follows it.
        expect(replay.indexOf(info!)).toBeLessThan(replay.indexOf(call!))
      }),
    180_000,
  )
})

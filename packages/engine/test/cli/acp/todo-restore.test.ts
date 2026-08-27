// What a client gets back when the engine process that owned the todo list is
// gone. Two engine processes, one database: the first runs a turn that calls
// `todowrite` and dies, the second calls `session/load` and its whole
// notification stream is captured.
//
// The point of running it across a process boundary is that nothing can be
// served out of the first engine's memory - the list has to come off the store.
// The transcript replay carries the old `todowrite` frame too, so the assertion
// is on the `origami/todoSnapshot` notification specifically: that is the one
// that reads the SESSION ROW, and it is the only source `session/resume` (which
// replays no messages at all) has.
import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { verifierConfig } from "./helpers"

const DRAINED = Symbol("drained")

type TodoSnapshot = {
  sessionId?: string
  source?: string
  todos?: { id?: number; content?: string; activeForm?: string; status?: string }[]
}
type Notification = { method?: string; params?: Record<string, unknown> }

/** A JSON-RPC client that KEEPS every notification. The ext notification under
 *  test is not a `session/update`, so the reload-replay recorder's filter would
 *  drop exactly the thing being measured. */
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

  /** Read until the stream goes quiet - a restore has no "done" marker. */
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

  const notifications = (method: string) =>
    (log as Notification[]).filter((msg) => msg.method === method || msg.method === `_${method}`)

  const updates = () =>
    (log as { method?: string; params?: { update?: { sessionUpdate?: string } } }[])
      .filter((msg) => msg.method === "session/update" && msg.params?.update !== undefined)
      .map((msg) => msg.params!.update!)

  return { request, drain, notifications, updates }
}

function initializeParams() {
  return {
    protocolVersion: 1,
    clientCapabilities: { _meta: { "terminal-auth": true } },
    clientInfo: { name: "origami-local-acp", version: "0.1.0" },
  }
}

const TODOS = [
  { content: "reproduce the failure", status: "completed", priority: "high" },
  { content: "fix the parser", status: "in_progress", priority: "high" },
  { content: "run the suite", status: "pending", priority: "medium" },
]

describe("origami acp todo restore subprocess", () => {
  cliIt.live(
    "a session reopened in a NEW engine process gets its stored todo list back",
    ({ home, llm, origami }) =>
      Effect.gen(function* () {
        // test/preload.ts pins ORIGAMI_DB=":memory:" in THIS process and
        // cli-process.ts spawns children with `{...process.env}`, so without an
        // explicit file database each subprocess would get its own empty store
        // and the reload could not see the first process's session at all.
        const env = {
          ORIGAMI_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)),
          ORIGAMI_DB: path.join(home, "todo-restore.db"),
        }

        const live = yield* origami.acp({ env })
        const first = recorder(live)
        yield* first.request("initialize", initializeParams())
        const created = yield* first.request<{ sessionId: string }>("session/new", { cwd: home, mcpServers: [] })
        const sessionId = (created.result as { sessionId: string }).sessionId

        yield* llm.tool("todowrite", { todos: TODOS })
        yield* llm.text("tracking the work")
        yield* first.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "Plan this out and track it." }],
        })
        yield* first.drain(6000)
        // Sanity: the write really happened in the first process.
        expect(first.updates().some((update) => update.sessionUpdate === "tool_call")).toBe(true)

        // The reload: this engine process is gone before the next one starts.
        yield* Effect.sync(() => live.close())
        yield* Effect.promise(() => live.exited).pipe(
          Effect.timeoutOrElse({ duration: Duration.seconds(10), orElse: () => Effect.succeed(-1) }),
        )

        const reloaded = yield* origami.acp({ env })
        const second = recorder(reloaded)
        yield* second.request("initialize", initializeParams())
        yield* second.request("session/load", { cwd: home, sessionId, mcpServers: [] })
        yield* second.drain(6000)

        const snapshots = second.notifications("origami/todoSnapshot")
        expect(snapshots).toHaveLength(1)
        const params = snapshots[0]!.params as TodoSnapshot
        expect(params.sessionId).toBe(sessionId)
        // The provenance the client renders in the strip's tooltip, and the
        // proof this came off the row rather than the replayed transcript.
        expect(params.source).toBe("session_restore")
        expect(params.todos?.map((todo) => [todo.content, todo.status])).toEqual([
          ["reproduce the failure", "completed"],
          ["fix the parser", "in_progress"],
          ["run the suite", "pending"],
        ])
      }),
    180_000,
  )
})

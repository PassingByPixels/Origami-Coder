import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { AppProcess } from "@origami/core/process"
import { Effect } from "effect"
import net from "net"
import path from "path"
import { ProcessTool, parseNetstat, parseTasklist, parsePs, parseLsof } from "../../src/tool/process"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test-process-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([AppProcess.node, CrossSpawnSpawner.node, Truncate.node, Agent.node])),
)

const run = Effect.fn("ProcessToolTest.run")(function* (args: Tool.InferParameters<typeof ProcessTool>) {
  const info = yield* ProcessTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

/** Binds a real loopback listener on an ephemeral port and closes it afterwards. Nothing is killed. */
const listener = Effect.gen(function* () {
  const server = yield* Effect.promise(
    () =>
      new Promise<net.Server>((resolve) => {
        const srv = net.createServer()
        srv.listen(0, "127.0.0.1", () => resolve(srv))
      }),
  )
  yield* Effect.addFinalizer(() => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))))
  return (server.address() as net.AddressInfo).port
})

describe("tool.process", () => {
  describe("processes", () => {
    it.instance("lists this very process", () =>
      Effect.gen(function* () {
        const result = yield* run({ kind: "processes" })

        const rows = result.output.split("\n").slice(1)
        expect(rows.some((row) => row.split("\t")[0] === String(process.pid))).toBe(true)
        expect(result.metadata.count).toBeGreaterThan(0)
      }),
    )

    it.instance("filters by process name", () =>
      Effect.gen(function* () {
        const self = path.basename(process.execPath).replace(/\.exe$/i, "")

        const result = yield* run({ kind: "processes", filter: self })

        const rows = result.output.split("\n").slice(1)
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) expect(row.toLowerCase()).toContain(self.toLowerCase())
        expect(rows.some((row) => row.split("\t")[0] === String(process.pid))).toBe(true)
      }),
    )

    it.instance("reports an empty result set plainly", () =>
      Effect.gen(function* () {
        const result = yield* run({ kind: "processes", filter: "zzz-no-such-process-zzz" })

        expect(result.output).toBe('No processes found matching "zzz-no-such-process-zzz".')
        expect(result.metadata.count).toBe(0)
      }),
    )
  })

  describe("ports", () => {
    it.instance("finds a port this process is listening on, with the owning pid", () =>
      Effect.gen(function* () {
        const port = yield* listener

        const result = yield* run({ kind: "ports", filter: String(port) })

        const rows = result.output.split("\n").slice(1)
        const mine = rows.find((row) => row.includes(`:${port}`))
        expect(mine).toBeDefined()
        expect(mine!.split("\t")[1]).toBe(String(process.pid))
      }),
    )

    it.instance("reports an empty result set plainly", () =>
      Effect.gen(function* () {
        const result = yield* run({ kind: "ports", filter: "zzz-no-such-port-zzz" })

        expect(result.output).toBe('No listening TCP sockets found matching "zzz-no-such-port-zzz".')
        expect(result.metadata.count).toBe(0)
      }),
    )

    it.instance("lists more sockets unfiltered than for one port", () =>
      Effect.gen(function* () {
        const port = yield* listener

        const all = yield* run({ kind: "ports" })
        const one = yield* run({ kind: "ports", filter: String(port) })

        expect(all.metadata.count).toBeGreaterThanOrEqual(one.metadata.count)
        expect(one.metadata.count).toBeGreaterThan(0)
      }),
    )
  })

  describe("output parsing", () => {
    it.live("keeps listening rows and drops established ones", () =>
      Effect.gen(function* () {
        const sample = [
          "Active Connections",
          "",
          "  Proto  Local Address          Foreign Address        State           PID",
          "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044",
          "  TCP    127.0.0.1:53318        127.0.0.1:53319        ESTABLISHED     9999",
          "  TCP    [::]:445               [::]:0                 LISTENING       4",
          "  UDP    0.0.0.0:5353           *:*                                    2222",
        ].join("\r\n")

        const rows = parseNetstat(sample)

        expect(rows).toEqual([
          { pid: "1044", name: "", address: "0.0.0.0:135" },
          { pid: "4", name: "", address: "[::]:445" },
        ])
      }),
    )

    it.live("parses tasklist CSV including names containing commas", () =>
      Effect.gen(function* () {
        const sample = ['"bun.exe","1234","Console","1","250,000 K"', '"a,b.exe","7","Console","1","4 K"'].join("\r\n")

        expect(parseTasklist(sample)).toEqual([
          { pid: "1234", name: "bun.exe" },
          { pid: "7", name: "a,b.exe" },
        ])
      }),
    )

    it.live("parses ps and lsof output", () =>
      Effect.gen(function* () {
        expect(parsePs("  101 node\n  202 my program\nheader junk\n")).toEqual([
          { pid: "101", name: "node" },
          { pid: "202", name: "my program" },
        ])
        expect(
          parseLsof(
            [
              "COMMAND PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
              "node    811 me     23u  IPv4  12345      0t0  TCP 127.0.0.1:8787 (LISTEN)",
            ].join("\n"),
          ),
        ).toEqual([{ pid: "811", name: "node", address: "127.0.0.1:8787" }])
      }),
    )
  })
})

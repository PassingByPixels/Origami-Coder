import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { Effect, ManagedRuntime } from "effect"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import * as ACPSession from "@/acp/session"
import { AgentBroker } from "@/origami/agent-broker"

/**
 * THE ATTACHED SET, end to end (t-kgu05m round 4).
 *
 * agent-broker.test.ts proves the broker republishes whatever reader it was
 * handed. This proves the reader is wired to the thing that actually changes:
 * the ACP session store. The two are joined at exactly one place in the shipped
 * engine — `store` and `remove` in acp/session.ts call `AgentBroker.refresh()`
 * — and nothing tested that, which is how round 4 could ask whether the RESTORE
 * path marks a session attached with no test able to answer.
 *
 * Everything here reads the FILE. The file is the only thing a peer process can
 * see, so an assertion against the in-memory map would prove the wrong half.
 */

let home: string
let previousHome: string | undefined
let previousClient: string | undefined
let previousName: string | undefined
let previousKind: string | undefined
let broker: { stop: () => Promise<void> } | undefined

/** The ACP session store, built exactly as acp/service.ts builds it. */
function sessionService() {
  return ManagedRuntime.make(AppNodeBuilder.build(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

/** Register this process the way cli/cmd/acp.ts does, reading the store the way
 *  acp/service.ts does. */
function registerEngine(session: ACPSession.Interface) {
  AgentBroker.attachSessions(() => Effect.runSync(session.list()).map((info) => info.id))
  broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: path.join("/repos", "cortex") })
}

/** What a PEER would read out of this engine's heartbeat, sorted so the store's
 *  newest-first ordering is not what is under test. The write is async and
 *  fire-and-forget, so poll rather than sleep on a guess. */
async function published(): Promise<string[]> {
  const file = AgentBroker.entryPath(process.pid)
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = await fsp.readFile(file, "utf8").catch(() => undefined)
    if (text !== undefined) {
      try {
        return [...(JSON.parse(text).sessionIds as string[])].sort()
      } catch {
        // A half-written entry: read again rather than fail on a torn file.
      }
    }
    await Bun.sleep(10)
  }
  return ["<no entry written>"]
}

/** Poll until the published set matches, so a test fails on the CONTENT rather
 *  than on losing a race with the writer. */
async function publishedEventually(expected: string[]): Promise<string[]> {
  let last: string[] = []
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await published()
    if (last.length === expected.length && last.every((id, index) => id === expected[index])) return last
    await Bun.sleep(10)
  }
  return last
}

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "attach-"))
  previousHome = process.env.ORIGAMI_TEST_HOME
  previousClient = process.env.ORIGAMI_CLIENT
  previousName = process.env.ORIGAMI_AGENT_NAME
  previousKind = process.env.ORIGAMI_AGENT_KIND
  process.env.ORIGAMI_TEST_HOME = home
  process.env.ORIGAMI_CLIENT = "acp"
  delete process.env.ORIGAMI_AGENT_NAME
  delete process.env.ORIGAMI_AGENT_KIND
})

afterEach(async () => {
  await broker?.stop()
  broker = undefined
  AgentBroker.attachSessions(() => [])
  restore("ORIGAMI_TEST_HOME", previousHome)
  restore("ORIGAMI_CLIENT", previousClient)
  restore("ORIGAMI_AGENT_NAME", previousName)
  restore("ORIGAMI_AGENT_KIND", previousKind)
  await fsp.rm(home, { recursive: true, force: true })
})

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe("what the heartbeat says a chat is showing", () => {
  test("a session CREATED by a new chat is published without waiting for a beat", async () => {
    const session = sessionService()
    registerEngine(session)

    await Effect.runPromise(session.create({ id: "ses_fresh", cwd: "/repos/cortex" }))

    expect(await publishedEventually(["ses_fresh"])).toEqual(["ses_fresh"])
  })

  test("a session RESTORED on startup is published too — load is an attach", async () => {
    // The round-4 report: a chat reopened after a VS Code restart is invisible
    // to peers both ways. Restore goes through ACP loadSession -> session.load,
    // a different entry point from newSession -> session.create, and only the
    // create side had ever been exercised. If the refresh hook is ever moved
    // out of the shared `store` onto the create path alone, this is what says
    // so — the two calls are one line apart in the source and one restart apart
    // for the user.
    const session = sessionService()
    registerEngine(session)

    await Effect.runPromise(session.load({ id: "ses_restored", cwd: "/repos/cortex" }))

    expect(await publishedEventually(["ses_restored"])).toEqual(["ses_restored"])
  })

  test("a chat CLOSED stops being advertised", async () => {
    // The other half, and the one that costs a peer a lost handoff: an entry
    // still naming a closed session is an address a peer resolves, delivers to,
    // and is told succeeded.
    const session = sessionService()
    registerEngine(session)
    await Effect.runPromise(session.create({ id: "ses_a", cwd: "/repos/cortex" }))
    await Effect.runPromise(session.load({ id: "ses_b", cwd: "/repos/cortex" }))
    expect(await publishedEventually(["ses_a", "ses_b"])).toEqual(["ses_a", "ses_b"])

    await Effect.runPromise(session.remove("ses_a"))

    expect(await publishedEventually(["ses_b"])).toEqual(["ses_b"])
  })

  test("an engine that closes cleanly leaves no entry behind at all", async () => {
    // What the shell's graceful shutdown buys (vscode/src/engineShutdown.ts):
    // the stop hook is only reachable when the process is allowed to finish, so
    // a chat closed by killing its engine leaves this file in place instead.
    const session = sessionService()
    registerEngine(session)
    await Effect.runPromise(session.create({ id: "ses_gone", cwd: "/repos/cortex" }))
    await publishedEventually(["ses_gone"])

    await broker?.stop()
    broker = undefined

    expect(await fsp.readFile(AgentBroker.entryPath(process.pid), "utf8").catch(() => "absent")).toBe("absent")
  })
})

describe("the wiring the tests above assume", () => {
  test("the ACP service still hands the broker a reader for its session store", async () => {
    // A drift guard, in the house pattern: everything above builds the join by
    // hand, so deleting it from the shipped service would leave the whole suite
    // green and peer discovery publishing an empty set forever.
    const source = await fsp.readFile(path.join(import.meta.dir, "..", "..", "src", "acp", "service.ts"), "utf8")
    expect(source).toContain("AgentBroker.attachSessions(")
  })
})

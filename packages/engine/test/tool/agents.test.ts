import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from "bun:test"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { ServerAuth } from "@/server/auth"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { AgentBroker } from "../../src/origami/agent-broker"
import { peerMessage, resetPeerMessages } from "../../src/session/peer-message"
import { ListAgentsTool, SendMessageTool, renderPeerMessage } from "../../src/tool/agents"
import { testEffect } from "../lib/effect"

// These tools speak HTTP to a peer, so the peer here is a REAL loopback server
// and the assertions are made on the request it actually received. A fake client
// would only prove this file agrees with itself; the whole risk in the feature
// is the shape of the request that crosses the process boundary.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([FSUtil.node, Truncate.node, Agent.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

let home: string
let previousHome: string | undefined
let previousClient: string | undefined
let previousName: string | undefined

/**
 * The pids the fixture peers are written at.
 *
 * REAL processes, because `readPeers` asks the OS whether an entry's owner is
 * still running and the tool gives its caller no way to stub that. These used
 * to be `process.pid + 1`, which is not a pid the OS agrees about: Windows
 * aliases the low two bits onto the same process, so it reads ALIVE there and
 * ESRCH on POSIX. Spawning is the honest version — the peer entry names a
 * process that genuinely exists, which is what the entry claims.
 */
let peerPid: number
let peerPid2: number
let idle: Array<{ kill: () => void; exited: Promise<number> }> = []

function spawnIdle() {
  return Bun.spawn({
    cmd: [process.execPath, "-e", "await new Promise(() => {})"],
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
}

beforeAll(() => {
  const first = spawnIdle()
  const second = spawnIdle()
  idle = [first, second]
  peerPid = first.pid
  peerPid2 = second.pid
})

afterAll(async () => {
  for (const proc of idle) {
    proc.kill()
    await proc.exited
  }
  idle = []
})

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "agents-tool-"))
  previousHome = process.env.ORIGAMI_TEST_HOME
  previousClient = process.env.ORIGAMI_CLIENT
  previousName = process.env.ORIGAMI_AGENT_NAME
  process.env.ORIGAMI_TEST_HOME = home
  process.env.ORIGAMI_CLIENT = "acp"
  process.env.ORIGAMI_AGENT_NAME = "sender"
  // TWO sessions, and the tool's ctx runs in the SECOND one. The reply address
  // has to name the session executing the call, so a broker-derived answer
  // (which would take the first entry) is a visibly different string.
  AgentBroker.attachSessions(() => ["ses_other", "ses_mine"])
  // The delivered ledger is module state shared by every test in this process.
  resetPeerMessages()
})

afterEach(async () => {
  restore("ORIGAMI_TEST_HOME", previousHome)
  restore("ORIGAMI_CLIENT", previousClient)
  restore("ORIGAMI_AGENT_NAME", previousName)
  await fsp.rm(home, { recursive: true, force: true })
})

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

type Received = { url: string; auth: string | null; body: unknown }

/** A stand-in peer engine: answers the liveness probe and records the prompt. */
function startPeer() {
  const received: Received[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/session/status") return new Response("{}", { status: 200 })
      received.push({
        url: url.pathname,
        auth: request.headers.get("authorization"),
        body: await request.json(),
      })
      return new Response(null, { status: 204 })
    },
  })
  return { received, server, base: `http://127.0.0.1:${server.port}` }
}

async function writePeerEntry(input: {
  pid: number
  name: string
  httpBase: string
  sessionIds?: string[]
  lastSeen?: number
}) {
  const file = path.join(home, ".origami", "agents", `${input.pid}.json`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(
    file,
    JSON.stringify({
      version: 1,
      pid: input.pid,
      name: input.name,
      cwd: "/work",
      httpBase: input.httpBase,
      kind: "interactive",
      sessionIds: input.sessionIds ?? ["ses_peer"],
      lastSeen: input.lastSeen ?? Date.now(),
    }),
    "utf8",
  )
}

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_mine"),
  messageID: MessageID.make("msg_agents-test"),
  callID: "agents-call",
  agent: "heron",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const tools = Effect.gen(function* () {
  return {
    list: yield* (yield* ListAgentsTool).init(),
    send: yield* (yield* SendMessageTool).init(),
  }
})

describe("list_agents", () => {
  it.instance("lists a reachable peer with the reply address send_message takes", () =>
    Effect.gen(function* () {
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "reviewer", httpBase: peer.base }))

      const result = yield* (yield* tools).list.execute({}, ctx)

      expect(result.metadata.peers).toBe(1)
      expect(result.output).toContain("reviewer#ses_peer")
      expect(result.output).toContain("kind=interactive")
    }))

  it.instance("a peer whose engine is gone is NOT listed - the file outlives the process", () =>
    Effect.gen(function* () {
      // The exact failure the probe exists for: a killed engine leaves a fresh
      // heartbeat behind for up to STALE_MS, so age alone would list a corpse.
      const peer = startPeer()
      peer.server.stop(true)
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "ghost", httpBase: peer.base }))

      const probed = yield* (yield* tools).list.execute({}, ctx)
      expect(probed.metadata.peers).toBe(0)
      expect(probed.output).toContain("No other agent sessions are reachable")

      // ...and without the probe the same stale file DOES list, which is what
      // makes the assertion above about the probe rather than about the file.
      const unprobed = yield* (yield* tools).list.execute({ probe: false }, ctx)
      expect(unprobed.metadata.peers).toBe(1)
    }))

  it.instance("a dead engine is NOT listed even while something else answers its port", () =>
    Effect.gen(function* () {
      // The case the probe cannot see, and the one the FIRST engine on a
      // machine is uniquely exposed to: server/server.ts prefers port 4096 and
      // falls back to an ephemeral port, so 4096 is the only httpBase a later
      // process inherits. Kill the engine holding it and its successor answers
      // the probe for it — a fresh entry, a live port, and a chat that is gone.
      // Probing harder cannot fix that; only asking who owns the pid can.
      const successor = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => successor.server.stop(true)))
      const corpse = spawnIdle()
      corpse.kill()
      yield* Effect.promise(() => corpse.exited)
      yield* Effect.promise(() =>
        writePeerEntry({ pid: corpse.pid, name: "inherited", httpBase: successor.base }),
      )

      const result = yield* (yield* tools).list.execute({}, ctx)

      expect(result.metadata.peers).toBe(0)
      expect(result.output).not.toContain("inherited")
      // And the entry is reclaimed now rather than lingering for STALE_MS,
      // which is what made agents flicker in and out of the roster.
      const ghostFile = path.join(home, ".origami", "agents", `${corpse.pid}.json`)
      const stillThere = yield* Effect.promise(() =>
        fsp
          .stat(ghostFile)
          .then(() => true)
          .catch(() => false),
      )
      expect(stillThere).toBe(false)
    }))

  it.instance("opens with the caller's OWN address, because the roster deliberately excludes it", () =>
    Effect.gen(function* () {
      // Reported as "the first chat opened in a window never appears in any
      // roster". It never does: readPeers excludes our own pid, so the one
      // agent a list can never contain is the one asking for it — and nothing
      // said so, which made a working exclusion read as a missing agent.
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "reviewer", httpBase: peer.base }))
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).list.execute({}, ctx)

      // The SESSION EXECUTING THE CALL, not the broker's first published id —
      // the same address send_message hands a peer as reply_to. This engine
      // publishes ses_other first, so a broker-derived answer reads differently.
      expect(result.output).toContain("You are sender#ses_mine")
      expect(result.output).not.toContain("sender#ses_other")
      // ...and the caller is still absent from the roster itself. The line
      // explains the exclusion; it does not undo it.
      expect(result.metadata.peers).toBe(1)
      expect(result.output).toContain("reviewer#ses_peer")
    }))

  it.instance("says who you are even when no peers are reachable at all", () =>
    Effect.gen(function* () {
      // The emptiest roster is where the confusion bites hardest: "no agent
      // sessions" and "I cannot see myself" are the same screen otherwise.
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).list.execute({}, ctx)

      expect(result.metadata.peers).toBe(0)
      expect(result.output).toContain("You are sender#ses_mine")
      expect(result.output).toContain("No other agent sessions are reachable")
    }))
})

describe("send_message", () => {
  // Incident: during a real session the lead agent and its subagents sent
  // unsolicited peer messages asking OTHER agents to do work; the receiver had
  // no context for the request and Passing had to intervene twice. The tool's
  // published DESCRIPTION is the one place every caller — lead or subagent —
  // reads before deciding to call it, so the guard has to live there, not in a
  // parameter's prose where a model skimming for `to`/`message` could miss it.
  it.instance("the published description forbids messaging a peer without being asked to collaborate", () =>
    Effect.gen(function* () {
      const send = (yield* tools).send

      expect(send.description).toContain(
        "Do not message other agents unless the user has explicitly told you that you are collaborating with them",
      )
    }))

  it.instance("POSTs the peer's prompt_async with the envelope, the provenance and the auth header", () =>
    Effect.gen(function* () {
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "reviewer", httpBase: peer.base }))
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).send.execute({ to: "reviewer", message: "schema is frozen" }, ctx)

      expect(result.metadata.delivered).toBe(true)
      expect(peer.received).toHaveLength(1)
      const call = peer.received[0]
      expect(call.url).toBe("/session/ses_peer/prompt_async")
      // Same reuse acp.ts:34 makes: our own ServerAuth credentials are the peer's,
      // so what goes on the wire must be EXACTLY what ServerAuth yields and never
      // a header this tool rolled itself.
      //
      // HONEST LIMIT: preload.ts:78 deletes ORIGAMI_SERVER_PASSWORD and
      // core/flag/flag.ts snapshots process.env at module load, so no engine in
      // this suite HAS credentials — the assertion below pins the source, not the
      // populated branch. The line after it pins the exact value a peer would
      // receive once a password is set.
      expect(call.auth).toBe(ServerAuth.headers()?.Authorization ?? null)
      expect(ServerAuth.header({ password: "hunter2" })).toBe(`Basic ${Buffer.from("origami:hunter2").toString("base64")}`)
      const part = (call.body as { parts: Array<{ text: string; metadata: unknown }> }).parts[0]
      expect(part.text).toBe(
        renderPeerMessage({ from: "sender", replyTo: "sender#ses_mine", text: "schema is frozen" }),
      )
      // THE REPLY ADDRESS IS THE SENDER'S OWN EXECUTION SESSION (ctx.sessionID).
      // Round-3 UAT could not tell that apart from the broker's answer, because
      // this engine published exactly one session and it was the same id. Here
      // it publishes ses_other FIRST, so a broker-derived reply_to would read
      // "sender#ses_other" — replies aimed at a session the sender is not in.
      expect(part.text).toContain('<peer_message from="sender" reply_to="sender#ses_mine">')
      expect(part.text).not.toContain("ses_other")
      expect(result.output).toContain("sender#ses_mine")
      // The rider the receiving UI badges from, read back through the SAME
      // reader acp/event.ts uses rather than by poking at the raw key.
      const origin = peerMessage(part.metadata)
      expect(origin?.from).toBe("sender")
      expect(origin?.replyTo).toBe("sender#ses_mine")
      // ...and it carries the idempotency id the receiver dedupes on.
      expect(origin?.id).toMatch(/^[0-9a-f]{16}$/)
    }))

  it.instance("refuses a target session that no chat is attached to, and NAMES the ones that are", () =>
    Effect.gen(function* () {
      // The round-3 defect. A third engine on the same folder held a session
      // with no chat; three handoffs were POSTed into it, all three answered
      // 204, all three reported "Delivered", and nobody ever saw one. The POST
      // status cannot catch this — an engine accepts a prompt for any session
      // it holds — so the check has to happen before the request is made.
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() =>
        writePeerEntry({ pid: peerPid, name: "ghost", httpBase: peer.base, sessionIds: ["ses_visible"] }),
      )
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).send.execute({ to: "ghost#ses_headless", message: "are you there" }, ctx)

      expect(result.metadata.delivered).toBe(false)
      expect(peer.received).toHaveLength(0)
      // Refused BY RESOLUTION here — the session is not in the entry at all.
      expect(result.output).toContain("ses_headless")
    }))

  it.instance("refuses when the peer's heartbeat is too old to prove anyone is still watching", () =>
    Effect.gen(function* () {
      // The same defect from the other direction: the id IS listed, but by an
      // entry old enough to have been written before the chat closed. Listing
      // forgives a missed beat (STALE_MS); delivering must not.
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() =>
        writePeerEntry({
          pid: peerPid,
          name: "drifted",
          httpBase: peer.base,
          lastSeen: Date.now() - AgentBroker.ATTACH_FRESH_MS - 1,
        }),
      )
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).send.execute({ to: "drifted", message: "still there?" }, ctx)

      expect(result.metadata.delivered).toBe(false)
      expect(peer.received).toHaveLength(0)
      expect(result.output).toContain("NOT delivered")
      // It must say what WOULD work, or the model's only move is to guess again
      // from the list that just misled it — which is what the UAT shows it doing.
      expect(result.output).toContain("Reachable sessions right now: (none)")
    }))

  it.instance("names the reachable sessions when there ARE some", () =>
    Effect.gen(function* () {
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() =>
        writePeerEntry({
          pid: peerPid,
          name: "drifted",
          httpBase: peer.base,
          lastSeen: Date.now() - AgentBroker.ATTACH_FRESH_MS - 1,
        }),
      )
      yield* Effect.promise(() =>
        writePeerEntry({ pid: peerPid2, name: "reviewer", httpBase: peer.base, sessionIds: ["ses_live"] }),
      )
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).send.execute({ to: "drifted", message: "still there?" }, ctx)

      expect(result.output).toContain("reviewer#ses_live")
      expect(peer.received).toHaveLength(0)
    }))

  it.instance("refuses an identical re-send inside the window — once delivered is once", () =>
    Effect.gen(function* () {
      // What the user watched happen: no answer came back, so the model sent
      // the same probe again, and again. Each one was a real delivery.
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "reviewer", httpBase: peer.base }))
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const first = yield* (yield* tools).send.execute({ to: "reviewer", message: "did you get my message" }, ctx)
      const again = yield* (yield* tools).send.execute({ to: "reviewer", message: "did you get my message" }, ctx)
      const different = yield* (yield* tools).send.execute({ to: "reviewer", message: "different words" }, ctx)

      expect(first.metadata.delivered).toBe(true)
      expect(again.metadata.delivered).toBe(false)
      expect(again.output).toContain("already went to reviewer")
      expect(different.metadata.delivered).toBe(true)
      // Two POSTs, not three: the repeat never reached the wire.
      expect(peer.received).toHaveLength(2)
    }))

  it.instance("refuses a peer that is not on a loopback address, and sends nothing", () =>
    Effect.gen(function* () {
      // The broker file is ordinary user-writable JSON. A tampered entry must not
      // turn an agent handoff into an outbound request to the network.
      yield* Effect.promise(() =>
        writePeerEntry({ pid: peerPid, name: "exfil", httpBase: "http://192.168.1.20:4096" }),
      )
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).send.execute({ to: "exfil", message: "hi" }, ctx)

      expect(result.metadata.delivered).toBe(false)
      expect(result.output).toContain("loopback")
    }))

  it.instance("refuses a message long enough to be a transcript rather than a handoff", () =>
    Effect.gen(function* () {
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "reviewer", httpBase: peer.base }))
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).send.execute({ to: "reviewer", message: "x".repeat(2001) }, ctx)

      expect(result.metadata.delivered).toBe(false)
      expect(result.output).toContain("2001 characters")
      expect(result.output).toContain("shorten the message")
      expect(result.output).toContain("max_chars: 2001")
      expect(result.output).toContain("receiver's context")
      expect(peer.received).toHaveLength(0)
    }))

  it.instance("delivers an over-default message when the agent explicitly raises the cap", () =>
    Effect.gen(function* () {
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "reviewer", httpBase: peer.base }))
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))
      const message = "x".repeat(2001)

      const result = yield* (yield* tools).send.execute({ to: "reviewer", message, max_chars: 2001 }, ctx)

      expect(result.metadata.delivered).toBe(true)
      expect(peer.received).toHaveLength(1)
      const part = (peer.received[0].body as { parts: Array<{ text: string }> }).parts[0]
      expect(part.text).toContain(message)
    }))

  it.instance("refuses when the raised cap is still smaller than the message", () =>
    Effect.gen(function* () {
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "reviewer", httpBase: peer.base }))
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).send.execute(
        { to: "reviewer", message: "x".repeat(3001), max_chars: 3000 },
        ctx,
      )

      expect(result.metadata.delivered).toBe(false)
      expect(result.output).toContain("over the 3000 limit")
      expect(result.output).toContain("max_chars: 3001")
      expect(peer.received).toHaveLength(0)
    }))

  it.instance("refuses an explicit cap above the 10000 character hard ceiling", () =>
    Effect.gen(function* () {
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "reviewer", httpBase: peer.base }))
      const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:1", cwd: "/repos/cortex" })
      yield* Effect.addFinalizer(() => Effect.promise(() => broker.stop()))

      const result = yield* (yield* tools).send.execute(
        { to: "reviewer", message: "x".repeat(10_001), max_chars: 10_001 },
        ctx,
      )

      expect(result.metadata.delivered).toBe(false)
      expect(result.output).toContain("hard ceiling is 10000")
      expect(peer.received).toHaveLength(0)
    }))

  it.instance("refuses when THIS engine never registered - a reply would have nowhere to land", () =>
    Effect.gen(function* () {
      const peer = startPeer()
      yield* Effect.addFinalizer(() => Effect.sync(() => peer.server.stop(true)))
      yield* Effect.promise(() => writePeerEntry({ pid: peerPid, name: "reviewer", httpBase: peer.base }))

      const result = yield* (yield* tools).send.execute({ to: "reviewer", message: "hi" }, ctx)

      expect(result.metadata.delivered).toBe(false)
      expect(result.output).toContain("not registered for peer messaging")
      expect(peer.received).toHaveLength(0)
    }))
})

describe("renderPeerMessage", () => {
  // t-r300pn: a UAT screenshot showed the receiving MODEL answer a peer's
  // question in its own transcript — where the sender never sees it — instead
  // of calling send_message. The envelope's attributes carry the provenance
  // for a client to badge, but nothing told the MODEL that typing an answer
  // does not deliver it, or which tool and address do.
  it.effect("tells the receiving model a chat reply never reaches the sender, and how to actually answer", () =>
    Effect.sync(() => {
      const text = renderPeerMessage({ from: "reviewer", replyTo: "reviewer#ses_x", text: "schema is frozen" })

      // Agent-origin framing survives unchanged: still explicit this is not the user.
      expect(text).toContain("not the user")
      // The exact registered tool name — a wrong name here is worse than none.
      expect(text).toContain("send_message")
      // The sender's OWN reply address, verbatim: what send_message's `to` must
      // be given back, not the bare name or some other rendering of it.
      expect(text).toContain("reviewer#ses_x")
      // The envelope itself — provenance labels, dedupe, delivery — is untouched.
      expect(text).toContain('<peer_message from="reviewer" reply_to="reviewer#ses_x">')
    }),
  )
})

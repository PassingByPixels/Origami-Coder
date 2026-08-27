import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { AgentBroker } from "../../src/origami/agent-broker"

// The broker is a FILE protocol between separate engine processes, so every test
// here works on real files under a scratch home. `Global.Path.origami` is a
// getter over ORIGAMI_TEST_HOME, which is what makes that isolation possible.

let home: string
let previousHome: string | undefined
let previousName: string | undefined
let previousClient: string | undefined
let previousOptIn: string | undefined
let previousKind: string | undefined

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "broker-"))
  previousHome = process.env.ORIGAMI_TEST_HOME
  previousName = process.env.ORIGAMI_AGENT_NAME
  previousClient = process.env.ORIGAMI_CLIENT
  previousOptIn = process.env.ORIGAMI_AGENT_PEERS
  previousKind = process.env.ORIGAMI_AGENT_KIND
  process.env.ORIGAMI_TEST_HOME = home
  delete process.env.ORIGAMI_AGENT_NAME
  delete process.env.ORIGAMI_AGENT_PEERS
  delete process.env.ORIGAMI_AGENT_KIND
  process.env.ORIGAMI_CLIENT = "acp"
  AgentBroker.attachSessions(() => [])
})

afterEach(async () => {
  restore("ORIGAMI_TEST_HOME", previousHome)
  restore("ORIGAMI_AGENT_NAME", previousName)
  restore("ORIGAMI_CLIENT", previousClient)
  restore("ORIGAMI_AGENT_PEERS", previousOptIn)
  restore("ORIGAMI_AGENT_KIND", previousKind)
  await fsp.rm(home, { recursive: true, force: true })
})

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const exists = (file: string) =>
  fsp
    .stat(file)
    .then(() => true)
    .catch(() => false)

/**
 * The peers below are written at pids nothing is running, and `readPeers` now
 * asks the OS whether an entry's owner is still alive. Tests that are about
 * something else (staleness, self-exclusion, a torn file) say so by declaring
 * every pid alive, which leaves the liveness gate to its own tests.
 *
 * Injected rather than chosen: `process.pid + 1` used to stand in for "some
 * other process", and Windows aliases the low two bits of a pid onto the same
 * process — so that fixture reads ALIVE on Windows and ESRCH on POSIX, and the
 * suite would pass here and fail in CI for a reason nothing on screen explains.
 */
const anyoneAlive = { alive: () => true }

/** A REAL process, so a test can talk about liveness without inventing a pid. */
function spawnIdle() {
  return Bun.spawn({
    cmd: [process.execPath, "-e", "await new Promise(() => {})"],
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
}

/** A peer written by SOME OTHER process — a pid that is not ours. */
async function writePeer(entry: Partial<AgentBroker.Entry> & { pid: number }) {
  const file = path.join(home, ".origami", "agents", `${entry.pid}.json`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(
    file,
    JSON.stringify({
      version: 1,
      name: `peer-${entry.pid}`,
      cwd: "/work",
      httpBase: "http://127.0.0.1:4096",
      kind: "interactive",
      sessionIds: ["ses_1"],
      lastSeen: Date.now(),
      ...entry,
    }),
    "utf8",
  )
  return file
}

describe("the heartbeat file", () => {
  test("registering writes this engine's entry, and stopping removes it", async () => {
    AgentBroker.attachSessions(() => ["ses_a", "ses_b"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: path.join("/repos", "cortex") })

    const file = AgentBroker.entryPath(process.pid)
    // The first beat is fired synchronously by start(), but its write is async.
    await Bun.sleep(30)
    const written = JSON.parse(await fsp.readFile(file, "utf8"))
    expect(written.pid).toBe(process.pid)
    expect(written.httpBase).toBe("http://127.0.0.1:5555")
    expect(written.kind).toBe("interactive")
    expect(written.sessionIds).toEqual(["ses_a", "ses_b"])

    await broker.stop()
    expect(await exists(file)).toBe(false)
  })

  test("stopping while the first beat is still IN FLIGHT still leaves no entry", async () => {
    // What stop()'s drain is for, and the case every other stop() test misses by
    // construction: they all wait for the file to appear first, so the write
    // chain has already settled and there is nothing left to drain. Here stop()
    // runs in the SAME TICK as start(), so the first beat's write is genuinely
    // mid-flight when the removal happens.
    //
    // Not a contrived shape. cli/cmd/acp.ts beats once at listen time (:41) and
    // then stops on stdin EOF (:86), and the shell closes stdin the moment the
    // window goes (vscode/src/engineShutdown.ts) — an engine spawned and
    // disposed quickly exits inside its own first write. Undrained, the rm finds
    // nothing to remove and the write lands after it, so a process that has
    // exited stays advertised as a live peer for a full STALE_MS.
    AgentBroker.attachSessions(() => ["ses_ghost"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/repos/cortex" })

    await broker.stop()

    const file = AgentBroker.entryPath(process.pid)
    expect(await exists(file)).toBe(false)
    // And it STAYS gone. Checking once proves little: an undrained write is
    // still in the threadpool when stop() resolves, so the file it resurrects
    // appears a few milliseconds AFTER the naive assertion has already passed.
    await Bun.sleep(100)
    expect(await exists(file)).toBe(false)
  })

  test("the published sessions are read at beat time, not captured at register time", async () => {
    // The point of handing over a READER: a session opened after startup has to
    // show up without the broker being told again.
    let open: string[] = []
    AgentBroker.attachSessions(() => open)
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/repos/cortex" })
    open = ["ses_late"]

    expect(AgentBroker.self()?.sessionIds).toEqual(["ses_late"])
    await broker.stop()
  })
})

describe("names", () => {
  test("ORIGAMI_AGENT_NAME wins, and is NOT suffixed — the user already said which window this is", () => {
    process.env.ORIGAMI_AGENT_NAME = "  reviewer  "
    expect(AgentBroker.displayName(path.join("/repos", "origami-coder"), 44956)).toBe("reviewer")
  })

  test("the fallback keeps basename(cwd) READABLE and makes it unique per engine", () => {
    // The round-3 defect exactly: two windows on one folder, two agents both
    // called "Origami UAT", so every bare address was ambiguous and the model
    // had to guess which one it was itself.
    const cwd = path.join("/users", "dev", "Downloads", "Origami UAT")
    const first = AgentBroker.displayName(cwd, 44956)
    const second = AgentBroker.displayName(cwd, 52236)

    expect(first).toBe("Origami UAT-4956")
    expect(second).toBe("Origami UAT-2236")
    expect(first).not.toBe(second)
  })

  test("a blank name is not a name — the fallback still applies", () => {
    process.env.ORIGAMI_AGENT_NAME = "   "
    expect(AgentBroker.displayName("/repos/cortex", 7)).toBe("cortex-7")
  })
})

describe("who counts as watched", () => {
  test("the shell's declaration beats the transport it arrived on", () => {
    // ORIGAMI_CLIENT names the TRANSPORT. The VS Code shell spawns one engine
    // per local session over that same transport, chat or not, so a headless
    // Agent-Manager session read as "a human is watching" — and peer handoffs
    // were delivered into it, seen by nobody.
    expect(AgentBroker.kindOf("acp", undefined)).toBe("interactive")
    expect(AgentBroker.kindOf("acp", "background")).toBe("background")
    expect(AgentBroker.kindOf("acp", "  BACKGROUND  ")).toBe("background")
    expect(AgentBroker.kindOf("script", "interactive")).toBe("interactive")
    // Anything that is not one of the two words is not a declaration.
    expect(AgentBroker.kindOf("acp", "yes")).toBe("interactive")
    expect(AgentBroker.kindOf("script", "")).toBe("background")
  })

  test("a declared-background engine needs the opt-in like any other unwatched one", async () => {
    process.env.ORIGAMI_CLIENT = "acp"
    process.env.ORIGAMI_AGENT_KIND = "background"
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/repos/cortex" })
    await Bun.sleep(30)

    expect(broker.entry).toBeUndefined()
    expect(await exists(AgentBroker.entryPath(process.pid))).toBe(false)
    await broker.stop()
  })
})

describe("republishing on change", () => {
  test("refresh() writes the CURRENT session set without waiting for the next beat", async () => {
    // Twenty seconds of a heartbeat describing a session set that has changed
    // is twenty seconds in which a peer delivers into a chat that closed. The
    // ACP session store calls this on every attach and detach.
    let open: string[] = ["ses_a"]
    AgentBroker.attachSessions(() => open)
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/repos/cortex" })
    await Bun.sleep(30)

    open = []
    AgentBroker.refresh()
    await Bun.sleep(30)

    const written = JSON.parse(await fsp.readFile(AgentBroker.entryPath(process.pid), "utf8"))
    expect(written.sessionIds).toEqual([])
    await broker.stop()
  })

  test("refresh() on an engine that never registered writes nothing", async () => {
    AgentBroker.refresh()
    await Bun.sleep(20)
    expect(await exists(AgentBroker.entryPath(process.pid))).toBe(false)
  })
})

describe("attachment", () => {
  const entry = (sessionIds: string[], age = 0): AgentBroker.Entry => ({
    version: 1,
    pid: 11,
    name: "cortex",
    cwd: "/work",
    httpBase: "http://127.0.0.1:4096",
    kind: "interactive",
    sessionIds,
    lastSeen: Date.now() - age,
  })

  test("only a session in a FRESH entry counts as attached", () => {
    expect(AgentBroker.attached(entry(["ses_a"]), "ses_a")).toBe(true)
    // Listed, but by an entry old enough to predate a close: the file is the
    // only evidence there is, and stale evidence is not evidence.
    expect(AgentBroker.attached(entry(["ses_a"], AgentBroker.ATTACH_FRESH_MS + 1), "ses_a")).toBe(false)
    expect(AgentBroker.attached(entry(["ses_a"]), "ses_b")).toBe(false)
    expect(AgentBroker.attached(entry([]), "ses_a")).toBe(false)
  })

  test("delivery is stricter than listing — a missed beat still LISTS", () => {
    // Deliberate, and the reason the two constants differ: "is it alive" can
    // forgive a busy engine missing a beat, "will a human read this" cannot.
    expect(AgentBroker.ATTACH_FRESH_MS).toBeLessThan(AgentBroker.STALE_MS)
  })
})

describe("the opt-in gate", () => {
  test("a background engine registers nothing unless it opted in", async () => {
    process.env.ORIGAMI_CLIENT = "script"
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/repos/cortex" })
    await Bun.sleep(30)

    expect(broker.entry).toBeUndefined()
    expect(AgentBroker.self()).toBeUndefined()
    expect(await exists(AgentBroker.entryPath(process.pid))).toBe(false)
    await broker.stop()
  })

  test("an opted-in background engine registers, and is hidden from a default listing", async () => {
    process.env.ORIGAMI_CLIENT = "script"
    process.env.ORIGAMI_AGENT_PEERS = "true"
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/repos/cortex" })
    await Bun.sleep(30)
    expect(broker.entry?.kind).toBe("background")

    await writePeer({ pid: process.pid + 1, kind: "background" })
    expect((await AgentBroker.readPeers(anyoneAlive)).map((entry) => entry.pid)).toEqual([])
    expect(
      (await AgentBroker.readPeers({ ...anyoneAlive, includeBackground: true })).map((entry) => entry.pid),
    ).toEqual([process.pid + 1])
    await broker.stop()
  })
})

describe("reading peers", () => {
  test("a stale entry is dropped AND its file deleted — a killed engine cannot clean up after itself", async () => {
    const dead = await writePeer({ pid: process.pid + 2, lastSeen: Date.now() - AgentBroker.STALE_MS - 1 })
    const alive = await writePeer({ pid: process.pid + 3 })

    expect((await AgentBroker.readPeers(anyoneAlive)).map((entry) => entry.pid)).toEqual([process.pid + 3])
    expect(await exists(dead)).toBe(false)
    expect(await exists(alive)).toBe(true)
  })

  test("an entry whose ENGINE PROCESS is gone is dropped and deleted, however fresh its heartbeat", async () => {
    // The ghost that age cannot catch. server/server.ts prefers port 4096 and
    // falls back to an ephemeral one, so the first engine on the machine is the
    // only one whose httpBase a LATER process can inherit — kill it and its
    // successor answers the liveness probe on its behalf. The entry is fresh,
    // the port answers, and the chat it names is gone: the one question that
    // separates them is whether the pid still exists.
    const runner = spawnIdle()
    const corpse = spawnIdle()
    corpse.kill()
    await corpse.exited

    const ghost = await writePeer({ pid: corpse.pid, httpBase: "http://127.0.0.1:4096", lastSeen: Date.now() })
    const real = await writePeer({ pid: runner.pid })

    // The real default, asking the real OS — no injection, or this would be
    // proving the stub.
    const peers = await AgentBroker.readPeers()

    expect(peers.map((entry) => entry.pid)).toEqual([runner.pid])
    expect(await exists(ghost)).toBe(false)
    expect(await exists(real)).toBe(true)

    runner.kill()
    await runner.exited
  })

  test("processAlive answers the OS, and refuses a pid that is not one", async () => {
    const running = spawnIdle()
    expect(AgentBroker.processAlive(running.pid)).toBe(true)
    running.kill()
    await running.exited
    expect(AgentBroker.processAlive(running.pid)).toBe(false)
    // pid 0 is not "some process": on POSIX `kill(0, …)` addresses the caller's
    // OWN process group, so a mangled entry could otherwise read as alive.
    expect(AgentBroker.processAlive(0)).toBe(false)
    expect(AgentBroker.processAlive(-1)).toBe(false)
  })

  test("our own entry is never a peer", async () => {
    await writePeer({ pid: process.pid })
    await writePeer({ pid: process.pid + 4 })

    expect((await AgentBroker.readPeers(anyoneAlive)).map((entry) => entry.pid)).toEqual([process.pid + 4])
  })

  test("a corrupt entry is a missing peer, not a crash", async () => {
    const file = path.join(home, ".origami", "agents", "999999.json")
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, '{"pid": 999999, "name": "half', "utf8")
    await writePeer({ pid: process.pid + 5 })

    expect((await AgentBroker.readPeers(anyoneAlive)).map((entry) => entry.pid)).toEqual([process.pid + 5])
  })

  test("no agents directory at all reads as no peers", async () => {
    expect(await AgentBroker.readPeers(anyoneAlive)).toEqual([])
  })
})

describe("loopback", () => {
  test("only a loopback host is addressable", () => {
    expect(AgentBroker.isLoopback("http://127.0.0.1:4096")).toBe(true)
    expect(AgentBroker.isLoopback("http://localhost:4096")).toBe(true)
    expect(AgentBroker.isLoopback("http://[::1]:4096")).toBe(true)
    // The case the check exists for: the broker file is user-writable, so a
    // tampered entry must not be able to aim a peer POST off this machine.
    expect(AgentBroker.isLoopback("http://192.168.1.20:4096")).toBe(false)
    expect(AgentBroker.isLoopback("http://evil.example.com/")).toBe(false)
    expect(AgentBroker.isLoopback("file:///etc/passwd")).toBe(false)
    expect(AgentBroker.isLoopback("not a url")).toBe(false)
  })
})

describe("resolving an address", () => {
  const peer = (name: string, pid: number, sessionIds: string[] = ["ses_1"]): AgentBroker.Entry => ({
    version: 1,
    pid,
    name,
    cwd: "/work",
    httpBase: "http://127.0.0.1:4096",
    kind: "interactive",
    sessionIds,
    lastSeen: Date.now(),
  })

  test("a bare name resolves to that agent's session", () => {
    // One instance, compared by identity: `peer()` stamps lastSeen from the
    // clock, so two calls are never equal.
    const only = peer("cortex", 11)
    expect(AgentBroker.resolve([only], "cortex")).toEqual({ entry: only, sessionID: "ses_1" })
  })

  test("an ambiguous bare name is REFUSED with the qualified addresses", () => {
    // Two windows on the same folder share the fallback name. Picking the newer
    // heartbeat would deliver a handoff to whichever window happened to beat
    // last — silently, and differently each time.
    const result = AgentBroker.resolve([peer("cortex", 11, ["ses_a"]), peer("cortex", 12, ["ses_b"])], "cortex")
    expect("error" in result && result.error).toContain("ambiguous")
    expect("error" in result && result.error).toContain("cortex#ses_a")
    expect("error" in result && result.error).toContain("cortex#ses_b")
  })

  test("a qualified address picks the exact session", () => {
    const peers = [peer("cortex", 11, ["ses_a"]), peer("cortex", 12, ["ses_b"])]
    const result = AgentBroker.resolve(peers, "cortex#ses_b")
    expect("sessionID" in result && result.sessionID).toBe("ses_b")
    expect("entry" in result && result.entry.pid).toBe(12)
  })

  test("an unknown name and a closed session both refuse, and say what is live", () => {
    const peers = [peer("cortex", 11, ["ses_a"])]
    expect(AgentBroker.resolve(peers, "nobody")).toEqual({
      error: 'Refused: no live agent named "nobody". Live agents: cortex#ses_a.',
    })
    expect("error" in AgentBroker.resolve(peers, "cortex#ses_gone")).toBe(true)
    expect("error" in AgentBroker.resolve([peer("cortex", 11, [])], "cortex")).toBe(true)
  })
})

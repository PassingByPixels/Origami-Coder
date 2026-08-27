import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@origami/core/global"

/**
 * PEER AGENT BROKER — how one engine process finds the others (t-kgu05m).
 *
 * The topology this serves: one engine per VS Code window, each already running
 * a private loopback HTTP server on a random port (cli/cmd/acp.ts). Nothing on
 * the machine knows those ports, so discovery is a directory of heartbeat files:
 * every engine writes `~/.origami/agents/<pid>.json` at startup, refreshes
 * `lastSeen` on a timer, and deletes the file on a clean exit. A reader drops
 * anything older than STALE_MS, which is what covers the unclean exits.
 *
 * Why files and not mDNS/a daemon: the peers are the SAME user on the SAME
 * machine, so the user's own home directory is both the rendezvous point and the
 * access-control boundary — another user cannot read the directory, and every
 * `httpBase` is asserted loopback before anything is POSTed to it. There is no
 * LAN surface here at all, by construction.
 *
 * Plain `node:fs` rather than the FSUtil service: the writer is a timer and a
 * process finalizer, neither of which runs inside an Effect context, and
 * `Global.Path` (which this keys off, so ORIGAMI_TEST_HOME isolates tests) is
 * itself plain fs.
 */

export type AgentKind = "interactive" | "background"

export type Entry = {
  readonly version: 1
  readonly pid: number
  readonly name: string
  readonly cwd: string
  readonly httpBase: string
  readonly kind: AgentKind
  readonly sessionIds: readonly string[]
  readonly lastSeen: number
}

/** Heartbeat period. */
export const REFRESH_MS = 20_000
/** An entry older than this is treated as dead and its file removed. Deliberately
 *  several refresh periods: a busy engine can miss a beat without vanishing. */
export const STALE_MS = 90_000
/**
 * How recent a heartbeat must be before its `sessionIds` may be treated as the
 * peer's ATTACHED set — the sessions a chat is actually rendering right now.
 *
 * Tighter than STALE_MS on purpose, because the two answer different questions.
 * LISTING asks "is this engine alive", and a busy engine that missed a beat is
 * still worth showing. DELIVERING asks "will a human see this", and an answer
 * that may be a minute and a half old is not evidence of that. `refresh()` is
 * what makes the tighter bound affordable: the set is republished the moment it
 * changes, so a fresh file is a current file rather than merely a recent one.
 */
export const ATTACH_FRESH_MS = 2 * REFRESH_MS

/** `~/.origami/agents`. A function, not a const, so it honours ORIGAMI_TEST_HOME. */
export function agentsDir(): string {
  return path.join(Global.Path.origami, "agents")
}

export function entryPath(pid: number): string {
  return path.join(agentsDir(), `${pid}.json`)
}

/**
 * This engine's display name.
 *
 * `ORIGAMI_AGENT_NAME` is the config home, and the choice is forced by what the
 * entry has to be unique across: one entry per ENGINE PROCESS, one process per
 * VS Code window. The engine's other config homes are all wrong for that —
 * `origami.json` (global) is shared by every window on the machine, so a name
 * set there would make every peer identical, and a project-level `origami.json`
 * is shared by every window open on the same repo. An environment variable is
 * the only per-process value the shell can already vary per window, and the
 * shell already composes exactly such an overlay at spawn (vscode/src/
 * engineEnv.ts), so the user-facing surface is the ordinary VS Code setting
 * `origami.agentName` with no config-schema change anywhere.
 */
export function displayName(cwd: string, pid = process.pid): string {
  const set = process.env["ORIGAMI_AGENT_NAME"]?.trim()
  if (set) return set
  // The FALLBACK carries a suffix, the user's own name does not. Round-3 UAT
  // opened two windows on the same folder and got two agents both called
  // "Origami UAT": every bare address was then ambiguous, so the sending model
  // had to guess which one it was itself, and guessed wrong. basename(cwd) is
  // still the readable half — the suffix only has to separate the peers, and
  // the pid is the one value that is already unique per engine process and
  // stable for its whole life. A user who sets a name has said which window is
  // which, and suffixing that would be undoing their answer.
  const base = path.basename(cwd) || "agent"
  return `${base}-${String(pid).slice(-4)}`
}

/**
 * Interactive means a human is WATCHING this engine's transcript — not merely
 * that a client is attached to it.
 *
 * `ORIGAMI_CLIENT` alone cannot tell those apart. It names the TRANSPORT, and
 * the VS Code shell spawns one engine per LOCAL SESSION (acpClient.start), so
 * "acp" is equally true of a chat tab and of a headless Agent-Manager or loop
 * session that no chat renders. Round-3 UAT delivered three times into exactly
 * such a session: the POST was accepted, the tool said "Delivered", and the
 * text was never shown to anybody.
 *
 * Only the shell knows which of its sessions has a chat, so it DECLARES it in
 * `ORIGAMI_AGENT_KIND` at spawn (vscode/src/peerName.ts). A declared background
 * engine then falls under the existing opt-in gate and stays out of discovery,
 * which is the behaviour that already existed for every other unwatched engine.
 */
export function kindOf(
  client = process.env["ORIGAMI_CLIENT"],
  declared = process.env["ORIGAMI_AGENT_KIND"],
): AgentKind {
  const said = declared?.trim().toLowerCase()
  if (said === "background" || said === "interactive") return said
  return ["acp", "app", "desktop"].includes(client ?? "") ? "interactive" : "background"
}

/** The opt-in a background engine needs before it registers at all. */
export function backgroundOptIn(value = process.env["ORIGAMI_AGENT_PEERS"]): boolean {
  const flag = value?.toLowerCase()
  return flag === "true" || flag === "1"
}

/**
 * Only ever a loopback host. Enforced at the CALL site as well as here, because
 * the broker file is ordinary user-writable JSON: a tampered or stale entry must
 * not be able to aim a peer POST at a LAN address.
 */
export function isLoopback(httpBase: string): boolean {
  if (!URL.canParse(httpBase)) return false
  const url = new URL(httpBase)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
}

// ------------------------------- the writer -------------------------------

let sessions: () => readonly string[] = () => []
let live: { entry: Entry; timer: ReturnType<typeof setInterval>; beat: () => void } | undefined

/**
 * Where the published session ids come from. The ACP session store is the only
 * place that knows which sessions are INTERACTIVE — a sub-agent's session is
 * never registered there — so "interactive sessions only" is a property of the
 * source, not a filter applied afterwards.
 */
export function attachSessions(read: () => readonly string[]): void {
  sessions = read
}

/**
 * Republish this engine's entry NOW, outside the beat.
 *
 * The heartbeat alone would leave the published set up to REFRESH_MS out of
 * date, and every one of those seconds is a window in which a peer delivers a
 * handoff into a session that has just been closed and reports it delivered.
 * The ACP layer calls this on every attach and detach, so the file describes
 * the session set as it IS rather than as it was up to twenty seconds ago —
 * which is what lets delivery trust it (ATTACH_FRESH_MS).
 *
 * A no-op for an engine that never registered, like every other writer here.
 */
export function refresh(): void {
  live?.beat()
}

/**
 * Writes are SERIALISED, because two of them overlapping can publish the older
 * one (t-kgu05m round 4).
 *
 * Every write goes tmp + rename so a reader never sees half an entry, and every
 * write in a process aims at the same two paths — one entry file, named for the
 * pid, and one scratch file beside it. Overlap them and the steps interleave:
 * the second write fills the scratch file, the FIRST write's rename publishes
 * it, and the second write's rename then finds nothing to move and is swallowed
 * as a missing-file error. Land the ordering the other way round and the file
 * published is the older content, permanently — nothing rewrites it until the
 * next twenty-second beat.
 *
 * That is not a rare shape here, it is the ordinary one: `start()` beats once
 * with an empty session set, and the attach that follows it calls `refresh()`
 * milliseconds later. An engine that loses that race advertises itself with NO
 * attached sessions, so peers can neither address it nor deliver to it while it
 * sits there looking alive — which is the round-4 report exactly.
 *
 * A queue rather than a unique scratch name per write: unique names stop the
 * two from corrupting each other but not from finishing out of order, and
 * out-of-order is the half that costs the attached set. The chain never
 * rejects, so a failed write cannot break the ones behind it.
 */
let writes: Promise<void> = Promise.resolve()

function write(entry: Entry): Promise<void> {
  writes = writes.then(() => publish(entry)).catch(() => {})
  return writes
}

async function publish(entry: Entry): Promise<void> {
  const file = entryPath(entry.pid)
  await fs.mkdir(path.dirname(file), { recursive: true })
  // tmp + rename: a reader must never see a half-written entry.
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(entry, null, 2), "utf8")
  await fs.rename(tmp, file)
}

/**
 * Register this engine and start the heartbeat. Returns the stop hook; calling
 * it removes the file. A background engine that has not opted in registers
 * nothing and returns a no-op, so the caller needs no branch of its own.
 */
export function start(input: {
  httpBase: string
  cwd: string
  kind?: AgentKind
  now?: () => number
}): { entry?: Entry; stop: () => Promise<void> } {
  const kind = input.kind ?? kindOf()
  if (kind === "background" && !backgroundOptIn()) {
    // The other half of the receipt: an engine that registers NOTHING is the
    // hardest case to diagnose from the outside, because it looks exactly like
    // one whose write failed. Say which of the two it is.
    console.error(`[peer] skipped pid=${process.pid} kind=background — set ORIGAMI_AGENT_PEERS=true to be discoverable`)
    return { stop: async () => {} }
  }
  const now = input.now ?? Date.now
  const base: Entry = {
    version: 1,
    pid: process.pid,
    name: displayName(input.cwd),
    cwd: input.cwd,
    httpBase: input.httpBase,
    kind,
    sessionIds: [],
    lastSeen: now(),
  }

  const beat = () => void write({ ...base, sessionIds: sessions(), lastSeen: now() }).catch(() => {})
  beat()
  const timer = setInterval(beat, REFRESH_MS)
  // The heartbeat must never be the reason the process stays alive.
  timer.unref?.()
  live = { entry: base, timer, beat }
  // The registration RECEIPT. Peer discovery is otherwise the one subsystem
  // with no visible surface until it misbehaves: a chat missing from a roster
  // looks identical whether its engine never registered, registered under a
  // name nobody expected, or registered fine and is simply the caller itself.
  // stderr needs no new plumbing — the VS Code shell already forwards it to the
  // output channel (vscode/src/acpClient.ts) — so one line per engine turns
  // that question into a lookup.
  console.error(`[peer] registered pid=${base.pid} name=${base.name} base=${base.httpBase} kind=${kind}`)

  return {
    entry: base,
    stop: async () => {
      clearInterval(timer)
      live = undefined
      // Drain first: a write still queued behind this would otherwise land
      // after the removal and put the entry back, leaving a cleanly exited
      // engine advertised as a live peer until it aged out.
      await writes.catch(() => {})
      await fs.rm(entryPath(base.pid), { force: true }).catch(() => {})
    },
  }
}

/** This engine's own entry, or undefined when it never registered. */
export function self(): Entry | undefined {
  return live ? { ...live.entry, sessionIds: sessions() } : undefined
}

// ------------------------------- the reader -------------------------------

function parse(text: string): Entry | undefined {
  const raw: unknown = JSON.parse(text)
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (
    typeof value.pid !== "number" ||
    typeof value.name !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.httpBase !== "string" ||
    typeof value.lastSeen !== "number"
  ) {
    return undefined
  }
  return {
    version: 1,
    pid: value.pid,
    name: value.name,
    cwd: value.cwd,
    httpBase: value.httpBase,
    kind: value.kind === "background" ? "background" : "interactive",
    sessionIds: Array.isArray(value.sessionIds) ? value.sessionIds.filter((id) => typeof id === "string") : [],
    lastSeen: value.lastSeen,
  }
}

/**
 * Is the process that wrote this entry still running?
 *
 * Freshness alone cannot answer that, and there is one address on the machine
 * where the difference bites. `Server.listen` prefers port 4096 and falls back
 * to an ephemeral one (server/server.ts), so the FIRST engine to start owns
 * 4096 and every other engine owns a port no later process will choose while it
 * is in use. 4096 is therefore the only `httpBase` a DIFFERENT process can
 * inherit: kill the first engine and the next one to start answers on its
 * corpse's behalf. For the rest of STALE_MS the liveness probe then confirms a
 * dead chat (it only ever asked whether SOMETHING answers the port, never
 * whether it is the process this entry names), and a handoff addressed to it is
 * POSTed into a stranger's engine.
 *
 * Signal 0 sends nothing; it asks the OS whether the pid can be signalled.
 * ESRCH is the only answer that means GONE — EPERM means it exists and belongs
 * to somebody else, which is a reason to leave it alone, not to delete it. A
 * recycled pid can still fool this, which is why the freshness bound stays.
 */
export function processAlive(pid: number): boolean {
  // A pid from a hand-mangled entry, and on POSIX `kill(0, …)` addresses the
  // caller's whole process group rather than a process — never a live peer.
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH"
  }
}

/**
 * Every live peer, newest heartbeat first. An entry whose engine is gone is
 * DELETED as it is found — a killed engine cannot clean up after itself, so the
 * next reader is the only thing that can. Our own entry is excluded: an agent
 * messaging itself is a loop, not a handoff.
 *
 * `alive` is injectable for the same reason `now` is: the default asks the real
 * OS, and a test that wants a peer at a pid it does not own cannot otherwise
 * say so. Windows makes that sharper than it looks — it aliases the low two
 * bits of a pid onto the same process, so `process.pid + 1` reads ALIVE there
 * and ESRCH on POSIX, and a fixture built on it would make the suite disagree
 * with itself across platforms.
 */
export async function readPeers(options?: {
  now?: number
  includeBackground?: boolean
  selfPid?: number
  alive?: (pid: number) => boolean
}): Promise<readonly Entry[]> {
  const now = options?.now ?? Date.now()
  const selfPid = options?.selfPid ?? process.pid
  const alive = options?.alive ?? processAlive
  const dir = agentsDir()
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const found = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const file = path.join(dir, name)
        const text = await fs.readFile(file, "utf8").catch(() => undefined)
        const entry = text === undefined ? undefined : parseSafe(text)
        if (!entry) return undefined
        // Asked BEFORE the clock, because it is the stronger evidence and the
        // cheaper question: a dead owner is dead however recently it beat.
        if (!alive(entry.pid)) {
          await fs.rm(file, { force: true }).catch(() => {})
          return undefined
        }
        if (now - entry.lastSeen > STALE_MS) {
          await fs.rm(file, { force: true }).catch(() => {})
          return undefined
        }
        return entry
      }),
  )
  return found
    .filter((entry): entry is Entry => !!entry)
    .filter((entry) => entry.pid !== selfPid)
    .filter((entry) => options?.includeBackground || entry.kind === "interactive")
    .toSorted((a, b) => b.lastSeen - a.lastSeen)
}

function parseSafe(text: string): Entry | undefined {
  try {
    return parse(text)
  } catch {
    // A half-written or hand-mangled entry is a missing peer, not an error: the
    // owning engine rewrites it on its next beat, and a stale one ages out.
    return undefined
  }
}

/**
 * Resolve a `to` address against the live peers. Accepts a bare name or
 * `name#sessionId`. Two windows opened on the same folder share a fallback name,
 * so an ambiguous bare name is REFUSED with the qualified addresses rather than
 * silently resolved to whichever heartbeat happens to be newer.
 */
export function resolve(
  peers: readonly Entry[],
  to: string,
): { entry: Entry; sessionID: string } | { error: string } {
  const raw = to.trim()
  if (!raw) return { error: "Refused: `to` is empty. Call list_agents for the reply addresses." }
  const hash = raw.lastIndexOf("#")
  const name = hash === -1 ? raw : raw.slice(0, hash)
  const wanted = hash === -1 ? undefined : raw.slice(hash + 1)

  const matches = peers.filter((entry) => entry.name.toLowerCase() === name.toLowerCase())
  if (!matches.length) {
    const known = peers.length ? peers.map(replyAddress).join(", ") : "(none)"
    return { error: `Refused: no live agent named "${name}". Live agents: ${known}.` }
  }
  if (wanted) {
    const hit = matches.find((entry) => entry.sessionIds.includes(wanted))
    if (!hit) return { error: `Refused: "${name}" has no live session ${wanted}. Call list_agents again.` }
    return { entry: hit, sessionID: wanted }
  }
  if (matches.length > 1) {
    return {
      error:
        `Refused: "${name}" is ambiguous — ${matches.length} live agents share that name. ` +
        `Address one of: ${matches.map(replyAddress).join(", ")}.`,
    }
  }
  const only = matches[0]
  if (!only.sessionIds.length) {
    return { error: `Refused: "${name}" has no open session to deliver to.` }
  }
  return { entry: only, sessionID: only.sessionIds[0] }
}

/** The address a peer replies to — a bare name while it is unambiguous. */
export function replyAddress(entry: Entry): string {
  return entry.sessionIds.length ? `${entry.name}#${entry.sessionIds[0]}` : entry.name
}

/**
 * Is this session one a peer is CURRENTLY showing somebody?
 *
 * The gate delivery has to pass, and deliberately two questions rather than
 * one. Membership answers "does a client hold this session open" — the entry
 * only ever lists what the ACP store holds. Freshness answers "was that still
 * true just now": the file is the only evidence available, so an entry old
 * enough to predate a close cannot be counted as evidence of attachment, no
 * matter what it says.
 *
 * A session that fails this is not a delivery failure to hide — it is the
 * round-3 defect itself, where three handoffs were accepted by an engine that
 * had no chat to show them in and the tool called all three "Delivered".
 */
export function attached(entry: Entry, sessionID: string, now = Date.now()): boolean {
  if (now - entry.lastSeen > ATTACH_FRESH_MS) return false
  return entry.sessionIds.includes(sessionID)
}

export * as AgentBroker from "./agent-broker"

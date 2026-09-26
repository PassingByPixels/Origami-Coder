import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@origami/core/global"
import { ElasticState } from "@/elastic/state"

/**
 * PEER AGENT BROKER - how one engine process finds the others.
 *
 * Topology: one engine per VS Code window, each running a private loopback HTTP
 * server on a random port. Discovery is a directory of heartbeat files: every
 * engine writes `~/.origami/agents/<pid>.json`, refreshes `lastSeen` on a timer
 * and deletes it on a clean exit; a reader drops anything older than STALE_MS.
 * Files rather than mDNS because the peers are the SAME user on the SAME
 * machine: the home directory is both rendezvous point and access-control
 * boundary, and every `httpBase` is asserted loopback before a POST - there is
 * no LAN surface by construction. Plain `node:fs` rather than FSUtil: the
 * writer is a timer and a process finalizer, neither inside an Effect context.
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
  /** origami_change (t-w2qlop): the writer's heartbeat period when it is not
   *  REFRESH_MS. Readers scale their staleness bounds by it, so an idle engine
   *  that beats slowly is neither listed as dead nor refused as detached.
   *  Absent in an entry from an older build: REFRESH_MS applies. */
  readonly refreshMs?: number
}

/** Heartbeat period. */
export const REFRESH_MS = 20_000
/** An entry older than this is treated as dead and its file removed. Deliberately
 *  several refresh periods: a busy engine can miss a beat without vanishing. */
export const STALE_MS = 90_000
/**
 * How recent a heartbeat must be before its `sessionIds` may be treated as the
 * peer's ATTACHED set. Tighter than STALE_MS: listing asks "is this engine
 * alive", delivering asks "will a human see this". `refresh()` republishes the
 * set the moment it changes, which is what makes the tighter bound affordable.
 */
export const ATTACH_FRESH_MS = 2 * REFRESH_MS
/** origami_change (t-w2qlop): the heartbeat period of an engine in the elastic
 *  `idle` class. Hidden and quiet for minutes: nothing changes its set, and
 *  `refresh()` still republishes the moment an attach or detach does. */
export const IDLE_REFRESH_MS = 60_000

/** The bounds a reader applies to one entry: the fixed ones, scaled up in the
 *  same ratio when the writer said it beats more slowly than REFRESH_MS. */
export function staleMs(entry: Pick<Entry, "refreshMs">): number {
  return Math.max(STALE_MS, ((entry.refreshMs ?? REFRESH_MS) * STALE_MS) / REFRESH_MS)
}
export function attachFreshMs(entry: Pick<Entry, "refreshMs">): number {
  return Math.max(ATTACH_FRESH_MS, ((entry.refreshMs ?? REFRESH_MS) * ATTACH_FRESH_MS) / REFRESH_MS)
}

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
 * `ORIGAMI_AGENT_NAME` is the config home because the entry must be unique per
 * ENGINE PROCESS: `origami.json`, global or project-level, is shared by every
 * window, so a name set there would make peers identical. The shell composes
 * the per-window overlay at spawn (vscode/src/engineEnv.ts).
 */
export function displayName(cwd: string, pid = process.pid): string {
  const set = process.env["ORIGAMI_AGENT_NAME"]?.trim()
  if (set) return set
  // The FALLBACK carries a suffix, the user's own name does not. Two windows
  // on the same folder would otherwise share one name and every bare address
  // would be ambiguous; the pid is unique per engine process and stable for
  // its life. A user who set a name has already said which window is which.
  const base = path.basename(cwd) || "agent"
  return `${base}-${String(pid).slice(-4)}`
}

/**
 * Interactive means a human is WATCHING this engine's transcript — not merely
 * that a client is attached to it.
 *
 * `ORIGAMI_CLIENT` names the TRANSPORT only, and the shell spawns one engine
 * per local session, so "acp" is equally true of a headless Agent-Manager or
 * loop session that no chat renders. Only the shell knows which session has a
 * chat, so it declares it in `ORIGAMI_AGENT_KIND` at spawn; a declared
 * background engine falls under the opt-in gate and stays out of discovery.
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

/** Only ever a loopback host. Enforced at the CALL site as well as here, because
 *  the broker file is ordinary user-writable JSON: a tampered or stale entry must
 *  not be able to aim a peer POST at a LAN address. */
export function isLoopback(httpBase: string): boolean {
  if (!URL.canParse(httpBase)) return false
  const url = new URL(httpBase)
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
}

// ------------------------------- the writer -------------------------------

let sessions: () => readonly string[] = () => []
let live:
  | { entry: Entry; beat: () => void; stop: () => Promise<void>; withdraw: () => Promise<void>; register: () => void }
  | undefined
/** origami_change (t-wdybz9): the registration `park()` withdrew, so
 *  `reregister()` can put the same entry back when the engine is kept up. */
let withdrawn: (() => void) | undefined
/** origami_change (t-wdybz9): the sessions this engine parked, from the moment
 *  `park()` is called until `leaveParking()`. While set, a prompt_async for
 *  one of them is kept in its mailbox and starts no turn. */
let parked: { readonly ids: readonly string[] } | undefined

/** Where the published session ids come from. The ACP session store is the only
 *  place that knows which sessions are INTERACTIVE - a sub-agent's session is
 *  never registered there - so the filter is a property of the source. */
export function attachSessions(read: () => readonly string[]): void {
  sessions = read
}

/**
 * Republish this engine's entry NOW, outside the beat.
 *
 * The heartbeat alone would leave the published set up to REFRESH_MS stale, and
 * a peer could deliver a handoff into a just-closed session and report it
 * delivered. The ACP layer calls this on every attach and detach, which is what
 * lets delivery trust the file (ATTACH_FRESH_MS). A no-op if never registered.
 */
export function refresh(): void {
  live?.beat()
}

/**
 * Writes are SERIALISED, because two overlapping ones can publish the older.
 *
 * Every write goes tmp + rename, and every write in a process aims at the same
 * two paths. Overlapped, the second write fills the scratch file, the first
 * write's rename publishes it, and the second's rename finds nothing to move -
 * so the published file can stay the older content until the next beat. A queue
 * rather than a unique scratch name per write: unique names stop the two from
 * corrupting each other but not from finishing out of order, and out-of-order
 * is the half that costs the attached set. The chain never rejects, so a failed
 * write cannot break the ones behind it.
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

/** Register this engine and start the heartbeat. Returns the stop hook; calling
 *  it removes the file. A background engine that has not opted in registers
 *  nothing and returns a no-op, so the caller needs no branch of its own. */
export function start(input: {
  httpBase: string
  cwd: string
  kind?: AgentKind
  now?: () => number
}): { entry?: Entry; stop: () => Promise<void> } {
  const kind = input.kind ?? kindOf()
  if (kind === "background" && !backgroundOptIn()) {
    // An engine that registers NOTHING looks, from the outside, exactly like
    // one whose write failed. Say which of the two it is.
    console.error(`[peer] skipped pid=${process.pid} kind=background — set ORIGAMI_AGENT_PEERS=true to be discoverable`)
    // The final stop ends a park too (t-wdybz9), registered or not.
    return {
      stop: async () => {
        parked = undefined
      },
    }
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

  // origami_change (t-w2qlop): the period follows the elastic class - slower
  // while the engine is `idle` - and the period in use is written into the
  // entry, so a reader judges it by the right bounds.
  const periodMs = () => (ElasticState.effectiveClass() === "idle" ? IDLE_REFRESH_MS : REFRESH_MS)
  let period = periodMs()
  const beat = () =>
    void write({
      ...base,
      sessionIds: sessions(),
      lastSeen: now(),
      ...(period === REFRESH_MS ? {} : { refreshMs: period }),
    }).catch(() => {})
  let timer: ReturnType<typeof setInterval> | undefined
  const arm = () => {
    timer = setInterval(beat, period)
    // The heartbeat must never be the reason the process stays alive.
    timer.unref?.()
  }
  let unfollow = () => {}
  // origami_change (t-wdybz9): registering is a step of its own, so an engine
  // kept up after a park can register again with the same entry.
  const register = () => {
    period = periodMs()
    beat()
    arm()
    // A new period is PUBLISHED at once, before the longer gap starts: a reader
    // that still saw the old period would count the idle engine as missing.
    unfollow = ElasticState.onChange(() => {
      const next = periodMs()
      if (next === period) return
      period = next
      clearInterval(timer)
      beat()
      arm()
    })
    live = { entry: base, beat, stop, withdraw, register }
  }
  const withdraw = async () => {
    unfollow()
    clearInterval(timer)
    live = undefined
    // Drain first: a write still queued behind this would land after the
    // removal and put the entry back, advertising a cleanly exited engine.
    await writes.catch(() => {})
    await fs.rm(entryPath(base.pid), { force: true }).catch(() => {})
  }
  // The final stop (process exit, tests): nothing may register again after it.
  const stop = async () => {
    withdrawn = undefined
    parked = undefined
    await withdraw()
  }
  register()
  // The registration RECEIPT. A chat missing from a roster looks identical
  // whether its engine never registered, registered under an unexpected name,
  // or is the caller itself; stderr already reaches the VS Code output channel.
  console.error(`[peer] registered pid=${base.pid} name=${base.name} base=${base.httpBase} kind=${kind}`)

  return { entry: base, stop }
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
    // Bounded: a hand-edited or hostile entry must not buy itself an unbounded
    // staleness window.
    ...(typeof value.refreshMs === "number" && value.refreshMs > REFRESH_MS && value.refreshMs <= 10 * 60_000
      ? { refreshMs: value.refreshMs }
      : {}),
  }
}

/**
 * Is the process that wrote this entry still running?
 *
 * Freshness alone cannot answer that. `Server.listen` prefers port 4096 and
 * falls back to an ephemeral one, so 4096 is the only `httpBase` a DIFFERENT
 * process can inherit: kill the first engine and the next one to start answers
 * on its corpse's behalf, and a handoff addressed to it is POSTed into a
 * stranger's engine. Signal 0 sends nothing; ESRCH is the only answer that
 * means GONE - EPERM means it exists and belongs to somebody else. A recycled
 * pid can still fool this, which is why the freshness bound stays.
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
 * DELETED as it is found - a killed engine cannot clean up after itself. Our
 * own entry is excluded: an agent messaging itself is a loop, not a handoff.
 *
 * `alive` is injectable so a test can claim a peer at a pid it does not own.
 * Windows aliases the low two bits of a pid onto the same process, so a fixture
 * built on `process.pid + 1` would make the suite disagree with POSIX.
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
        if (now - entry.lastSeen > staleMs(entry)) {
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

/** Resolve a `to` address against the live peers. Accepts a bare name or
 *  `name#sessionId`. Two windows on the same folder share a fallback name, so an
 *  ambiguous bare name is REFUSED with the qualified addresses. */
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
 * Is this session one a peer is CURRENTLY showing somebody? The gate delivery
 * has to pass, and two questions rather than one: membership (does a client
 * hold this session open - the entry lists what the ACP store holds) and
 * freshness (was that still true just now). An entry old enough to predate a
 * close is not evidence of attachment, whatever it says.
 */
export function attached(entry: Entry, sessionID: string, now = Date.now()): boolean {
  if (now - entry.lastSeen > attachFreshMs(entry)) return false
  return entry.sessionIds.includes(sessionID)
}

/** The session ids this engine publishes now (the ACP store's list). */
export function published(): readonly string[] {
  return sessions()
}

/** Resolves when every heartbeat write queued so far is on disk. */
export function settled(): Promise<void> {
  return writes.catch(() => {})
}

// ---------------------------- parked chats (t-w2txb2) ----------------------------
//
// The extension stops a chat's engine after a long idle and starts it again on
// the next use, on the same engine session id. While it is stopped the chat has
// no heartbeat, so a STAND-IN file keeps it addressable: a message to it is kept
// in `<agentsDir>/mailbox/<sessionId>/` (agent-mailbox.ts) and the extension,
// which watches that folder, starts the chat again to read it. A stand-in has no
// clock: a parked chat can sleep for hours. It lives while the extension host
// that parked it lives, and is deleted as found once that host is gone.

/** Folder names under agentsDir(). The extension mirrors both (drift-guarded). */
export const PARKED_DIR = "parked"
export const MAILBOX_DIR = "mailbox"

export type Parked = {
  readonly version: 1
  readonly parked: true
  readonly name: string
  readonly cwd: string
  readonly kind: AgentKind
  readonly sessionId: string
  readonly hostPid: number
  readonly parkedAt: number
}

/** A session id is used as a file and folder name. The stand-in is ordinary
 *  user-writable JSON, so an id that could leave its folder is refused. */
export function safeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

export function parkedPath(sessionId: string): string {
  return path.join(agentsDir(), PARKED_DIR, `${sessionId}.json`)
}

/**
 * Write a stand-in for every session this engine publishes, then WITHDRAW the
 * live entry. The extension closes the engine's stdin next; until then a live
 * entry would still win every lookup and take a message into an engine that is
 * about to exit. An engine that never registered writes nothing. Returns the
 * parked session ids.
 *
 * origami_change (t-wdybz9): two-phase and reversible. The PARKING flag is set
 * synchronously, before the first await, so the caller's idle check and the
 * flag are one step: from here on a prompt_async for these sessions goes to
 * the mailbox (handlers/session.ts). `reregister()` + `leaveParking()` undo it
 * when the extension keeps the engine up (acp/elastic.ts `_elastic_unpark`).
 * A second call while parked answers the same ids and writes nothing.
 */
export async function park(input: { hostPid: number; now?: number }): Promise<string[]> {
  if (parked) return [...parked.ids]
  const me = self()
  const current = live
  const ids = me ? me.sessionIds.filter(safeSessionId) : []
  parked = { ids }
  if (!me || !current) return []
  const parkedAt = input.now ?? Date.now()
  await fs.mkdir(path.join(agentsDir(), PARKED_DIR), { recursive: true })
  await Promise.all(
    ids.map(async (sessionId) => {
      const standIn: Parked = {
        version: 1,
        parked: true,
        name: me.name,
        cwd: me.cwd,
        kind: me.kind,
        sessionId,
        hostPid: input.hostPid,
        parkedAt,
      }
      const file = parkedPath(sessionId)
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(standIn, null, 2), "utf8")
      await fs.rename(tmp, file)
    }),
  )
  withdrawn = current.register
  await current.withdraw()
  console.error(`[peer] parked pid=${process.pid} name=${me.name} sessions=${ids.join(",") || "(none)"}`)
  return ids
}

/** The sessions this engine parked, while it is parking or parked; undefined
 *  when it is not. Read by the prompt_async route on every POST. */
export function parking(): readonly string[] | undefined {
  return parked?.ids
}

/** Register the entry that `park()` withdrew, if any. The live entry is written
 *  before this returns its promise chain (`settled()` waits for it). */
export function reregister(): void {
  const again = withdrawn
  withdrawn = undefined
  if (again && !live) again()
}

/** End parking. Returns the ids that were parked (empty when none were). */
export function leaveParking(): readonly string[] {
  const ids = parked?.ids ?? []
  parked = undefined
  return ids
}

function parseParked(text: string, fileId: string): Parked | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null
    if (!value || typeof value !== "object" || value.parked !== true) return undefined
    if (
      typeof value.name !== "string" ||
      typeof value.cwd !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.hostPid !== "number"
    ) {
      return undefined
    }
    // The file name and the content must agree, or a hand-edited stand-in
    // could route a message into another chat's mailbox.
    if (value.sessionId !== fileId || !safeSessionId(value.sessionId)) return undefined
    return {
      version: 1,
      parked: true,
      name: value.name,
      cwd: value.cwd,
      kind: value.kind === "background" ? "background" : "interactive",
      sessionId: value.sessionId,
      hostPid: value.hostPid,
      parkedAt: typeof value.parkedAt === "number" ? value.parkedAt : 0,
    }
  } catch {
    return undefined
  }
}

/** Every stand-in whose extension host is still running. A dead host's
 *  stand-in is deleted as found: nothing would ever start that chat again. */
export async function readParked(options?: { alive?: (pid: number) => boolean }): Promise<readonly Parked[]> {
  const alive = options?.alive ?? processAlive
  const dir = path.join(agentsDir(), PARKED_DIR)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const found = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const file = path.join(dir, name)
        const text = await fs.readFile(file, "utf8").catch(() => undefined)
        const standIn = text === undefined ? undefined : parseParked(text, name.slice(0, -".json".length))
        if (!standIn) return undefined
        if (!alive(standIn.hostPid)) {
          await fs.rm(file, { force: true }).catch(() => {})
          return undefined
        }
        return standIn
      }),
  )
  return found.filter((item): item is Parked => !!item).toSorted((a, b) => b.parkedAt - a.parkedAt)
}

export async function removeParked(sessionId: string): Promise<void> {
  if (!safeSessionId(sessionId)) return
  await fs.rm(parkedPath(sessionId), { force: true }).catch(() => {})
}

/** The address of a parked chat. Always qualified: its engine is gone, so the
 *  session id is the only part of the address that outlives it. */
export function parkedAddress(standIn: Parked): string {
  return `${standIn.name}#${standIn.sessionId}`
}

/**
 * Resolve `to` against the parked chats, for an address NO live engine holds.
 * A live engine always wins: undefined when a live peer carries the name (bare
 * address) or the name and the session (qualified address), and when no
 * stand-in matches at all - the caller then keeps its own live refusal.
 */
export function resolveParked(
  peers: readonly Entry[],
  parked: readonly Parked[],
  to: string,
): { standIn: Parked } | { error: string } | undefined {
  const raw = to.trim()
  const hash = raw.lastIndexOf("#")
  const name = (hash === -1 ? raw : raw.slice(0, hash)).toLowerCase()
  const wanted = hash === -1 ? undefined : raw.slice(hash + 1)
  if (!name) return undefined
  const liveNamed = peers.filter((entry) => entry.name.toLowerCase() === name)
  if (wanted ? liveNamed.some((entry) => entry.sessionIds.includes(wanted)) : liveNamed.length) return undefined
  const matches = parked.filter(
    (standIn) => standIn.name.toLowerCase() === name && (!wanted || standIn.sessionId === wanted),
  )
  if (!matches.length) return undefined
  if (matches.length > 1) {
    return {
      error:
        `Refused: "${raw}" is ambiguous — ${matches.length} stopped chats share that name. ` +
        `Address one of: ${matches.map(parkedAddress).join(", ")}.`,
    }
  }
  return { standIn: matches[0] }
}

export * as AgentBroker from "./agent-broker"

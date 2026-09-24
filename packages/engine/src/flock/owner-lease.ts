import fs from "node:fs"
import path from "node:path"
import { Global } from "@origami/core/global"

/**
 * Which engine holds the flock links.
 *
 * `service.ts` holds one relay socket per friend for the life of the engine, but
 * every VS Code window spawns its own engine and the relay allows ONE socket per
 * role per rid — so two windows took each friend's slot from each other in a
 * loop. That rule is right; what changes is that a second engine ASKS before it
 * dials.
 *
 * A FILE, not a port: the two engines share nothing but the filesystem.
 * `flock-owner.json` lives in the DATA directory, deliberately NOT beside
 * `flock.json` and the owner's private keys in the config directory, which is a
 * file a person reviews and where a heartbeat would only be noise.
 *
 * A PID PLUS A HEARTBEAT: a heartbeat alone makes every window close cost
 * STALE_MS of silence, and a pid alone is wrong the moment the OS recycles one.
 *
 * ADVISORY, NOT A LOCK — there is no atomic create-if-absent. The write is a
 * temp file and a rename and the claim re-reads afterwards, so two racing engines
 * produce one winner and one that stands down. The relay's 4001 is the backstop.
 */

export const FILE = "flock-owner.json"

/** How often the owner says it is alive. */
export const HEARTBEAT_MS = 5_000

/**
 * Three missed beats — the ceiling on how long a RECYCLED pid can keep the flock
 * unreachable, and rarely the thing anyone waits for: {@link Owner.claim}
 * refuses only for a lease that is fresh AND whose pid is a LIVE process, and
 * `flock/exit.ts` deletes the record on a normal window close.
 *
 * Not lower: below three beats a garbage-collected or briefly-blocked engine is
 * declared dead by a sibling and loses sockets it was using. Not higher: fifteen
 * seconds is already the edge of what someone waits before deciding the feature
 * is broken, and `tool/flock.ts` reads the lease itself to answer sooner.
 */
export const STALE_MS = 15_000

export interface Lease {
  readonly pid: number
  /** When this engine took the lease. For a human reading the file. */
  readonly startedAt: string
  readonly heartbeatAt: number
  /** The owner engine's own loopback HTTP base, e.g. `http://127.0.0.1:53411`. A
   *  window whose engine did not win the lease still has to ask a flock question,
   *  and the lease is the file both processes already agree on. OPTIONAL, and
   *  every reader must tolerate its absence: a lease written by an older build has
   *  none, and a half-upgraded machine must degrade rather than crash. */
  readonly httpBase?: string
}

export interface Options {
  /** Defaults to the engine's data directory. Tests always pass one. */
  readonly directory?: string
  readonly pid?: number
  /** This engine's loopback HTTP base, written into the record. Omitted by a
   *  caller that has no server (the CLI), and by every test that does not
   *  exercise forwarding. */
  readonly httpBase?: string
  readonly now?: () => number
  /** Whether a pid is a live process. Injected so a test states the fact
   *  instead of killing something. */
  readonly alive?: (pid: number) => boolean
  readonly staleMs?: number
}

export function file(directory?: string): string {
  return path.join(directory ?? Global.Path.data, FILE)
}

/** The lease on disk, or undefined. Anything that is not a well-formed record is
 *  ABSENT rather than trusted: a truncated write, a hand edit or a half-upgraded
 *  build must not produce a lease no engine can ever take. */
export function read(directory?: string): Lease | undefined {
  const raw = fs.existsSync(file(directory)) ? fs.readFileSync(file(directory), "utf8") : undefined
  if (raw === undefined) return undefined
  const parsed = ((): unknown => {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  })()
  const record = parsed as Partial<Lease> | undefined
  if (!record || typeof record.pid !== "number" || typeof record.heartbeatAt !== "number") return undefined
  return {
    pid: record.pid,
    startedAt: String(record.startedAt ?? ""),
    heartbeatAt: record.heartbeatAt,
    // ABSENT stays absent. An older build wrote no address, and a string is the
    // only shape a caller may act on — anything else is treated as not written.
    ...(typeof record.httpBase === "string" && record.httpBase ? { httpBase: record.httpBase } : {}),
  }
}

/** `process.kill(pid, 0)` is the portable "does this pid exist". EPERM means it
 *  exists and belongs to somebody else, which still counts as alive. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export class Owner {
  private readonly directory: string | undefined
  private readonly pid: number
  private readonly httpBase: string | undefined
  private readonly now: () => number
  private readonly alive: (pid: number) => boolean
  private readonly staleMs: number
  private claimed = false

  constructor(options: Options = {}) {
    this.directory = options.directory
    this.pid = options.pid ?? process.pid
    this.httpBase = options.httpBase
    this.now = options.now ?? (() => Date.now())
    this.alive = options.alive ?? running
    this.staleMs = options.staleMs ?? STALE_MS
  }

  get holds(): boolean {
    return this.claimed
  }

  /** True when the lease is free, stale, dead or already ours. False means
   *  another engine owns the flock and this one must not open a socket. */
  claim(): boolean {
    const record = read(this.directory)
    if (record && record.pid !== this.pid && this.live(record)) return false
    this.write()
    // RE-READ. Two engines can pass the check in the same moment; the one whose
    // rename landed second owns the file, and the other has to see that here.
    this.claimed = read(this.directory)?.pid === this.pid
    return this.claimed
  }

  /** One beat. Refreshes our record, or drops the claim if another engine has
   *  taken the file — a beat must never steal a lease back. */
  beat(): void {
    if (!this.claimed) return
    if (read(this.directory)?.pid !== this.pid) {
      this.claimed = false
      return
    }
    this.write()
  }

  /** Give the flock up on the way out, so the next engine claims on its first
   *  try instead of waiting out STALE_MS for a process that is already gone. */
  release(): void {
    if (!this.claimed) return
    this.claimed = false
    if (read(this.directory)?.pid !== this.pid) return
    fs.rmSync(file(this.directory), { force: true })
  }

  /** Alive = the process exists AND it has said so inside the stale window.
   *  Either alone is wrong: pids are recycled, and a heartbeat outlives a kill. */
  private live(record: Lease): boolean {
    return this.now() - record.heartbeatAt < this.staleMs && this.alive(record.pid)
  }

  private write(): void {
    const target = file(this.directory)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const record: Lease = {
      pid: this.pid,
      startedAt: new Date(this.now()).toISOString(),
      heartbeatAt: this.now(),
      ...(this.httpBase ? { httpBase: this.httpBase } : {}),
    }
    // Temp file + rename, so a reader never sees a half-written record. The
    // temp name carries the pid: two engines writing at once must not collide
    // on the temp file itself.
    const temp = `${target}.${this.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
    try {
      fs.renameSync(temp, target)
    } catch {
      // Windows can refuse a rename over a file another process has open. The
      // record is small and single-line-atomic enough for a heartbeat, so a
      // direct write is the right fallback rather than a failed claim.
      fs.writeFileSync(target, JSON.stringify(record, null, 2), { mode: 0o600 })
      fs.rmSync(temp, { force: true })
    }
  }
}

export * as FlockOwnerLease from "./owner-lease"

import { ElasticState } from "@/elastic/state"
import { FlockDeliver } from "./deliver"
import { FlockExit } from "./exit"
import { FlockFrontDesk } from "./frontdesk"
import { FlockOwnerLease } from "./owner-lease"
import { FlockPeer } from "./peer"
import { FlockPolicy } from "./policy"
import { FlockRelayTransport } from "./relay-transport"
import type { Friend, Store } from "./store"
import { FlockTransport } from "./transport"

/**
 * Holds a Flock open for the life of the engine: one relay socket per friend,
 * reconnecting on its own. `peer.ts` moves one frame, `frontdesk.ts` decides
 * one answer; this file is the caller that keeps them alive.
 *
 * Idle is a real state and the default, for three reasons: another engine holds
 * the links (`owner-lease.ts` arbitrates; the loser reports `other-engine` and
 * retries), `ORIGAMI_DISABLE_FLOCK=1`, or no contacts in `flock.json`.
 *
 * A missing front desk model is NOT one of them: asking needs only contacts and
 * a wire, so the socket opens on contacts alone; an inbound question with no
 * model still gets the signed refusal `frontdesk.ts` sends, plus an UNREAD row.
 *
 * `runner` is injected — this file never chooses the model or runs the turn.
 */

/** Where a friendship goes when the invite named no relay and the config sets none. */
export const DEFAULT_RELAY_URL = "wss://relay.origamilabs.nl"

/** Set to `1` and nothing here opens a socket. */
export const DISABLE_ENV = "ORIGAMI_DISABLE_FLOCK"

/** What this engine's Flock links are riding on: `relay` — this engine owns
 *  them; `other-engine` — another window's engine does, and this one is
 *  deliberately silent; `none` — idle, or never started. */
export type Kind = "relay" | "other-engine" | "none"

/** What the owner is told when a second window's engine stands down. */
export const OTHER_ENGINE_REASON = "the flock is held by another window's engine"

/** Why this engine is idle, as a code rather than prose: `tool/flock.ts` prints
 *  both the reason and the one action that fixes it, and matching an action
 *  against a sentence would make the sentence load bearing. */
export type IdleCode = "disabled" | "no-contacts" | "no-model" | "no-flock-file" | "not-started"

/** `no-model` is NOT a start gate. It stays in the union, in {@link IDLE_TEXT}
 *  and in `tool/flock.ts`'s action table because it is still the sentence an
 *  owner needs when their desk refuses everything; nothing refuses to start. */

/** The sentence each code reads as, in the log and in a tool's output. */
export const IDLE_TEXT: Record<IdleCode, string> = {
  // Names the SETTING as well as the variable: `origamicoder.flock.enabled` is
  // the only thing that sets it for an editor window, and the bare env var name
  // sent owners looking for a shell they never opened.
  disabled: `Flock is switched off (${DISABLE_ENV}, the origamicoder.flock.enabled setting)`,
  "no-contacts": "no contacts in flock.json",
  "no-model": "no front desk model is set (flock.frontDesk.model)",
  "no-flock-file": "no flock.json on this box",
  "not-started": "the flock service never started in this engine",
}

/** The idles a file change can lift. A store-reason idle keeps the tick armed
 *  and re-reads `flock.json` each beat, so an engine that booted with an empty
 *  file comes up when another window accepts an invite. `disabled` is an env
 *  var no write can change; `no-flock-file` starts no service, so has no tick. */
export const RECHECKABLE: ReadonlySet<IdleCode> = new Set<IdleCode>(["no-contacts", "no-model"])

/** The module-level slots `acp/flock.ts` and `tool/flock.ts` read. They follow
 *  the SAME `publish` rule as the log ring, so two engines in one test process
 *  do not report each other's state. */
let currentKind: Kind = "none"
let currentCode: IdleCode | undefined = "not-started"
let currentPeer: FlockPeer.Peer | undefined
let currentLease: string | undefined
let currentRefresh: (() => void) | undefined
let currentTransport: FlockRelayTransport.RelayTransport | undefined
let currentRoutes: ReadonlyMap<string, { rid: string; role: FlockRelayTransport.RelayRole; relayUrl: string }> = new Map()

/** The last few lifecycle lines, for `diagnose.ts`. Kept in memory rather than
 *  read back out of a log file: "why is my flock not working" is asked of a
 *  RUNNING engine, and the useful lines are the ones it has just printed. */
export const LOG_KEEP = 5
const recent: string[] = []

/** The most recent lifecycle lines, newest LAST, at most `count` of them. */
export function recentLog(count = 3): readonly string[] {
  return recent.slice(-count)
}

/** What this engine's links are riding on, per contact, with the live socket
 *  state folded in. Empty in an engine that does not hold the flock. */
export function links(): ReadonlyMap<
  string,
  { rid: string; role: FlockRelayTransport.RelayRole; relayUrl: string; status: FlockRelayTransport.RelayStatus }
> {
  const out = new Map<
    string,
    { rid: string; role: FlockRelayTransport.RelayRole; relayUrl: string; status: FlockRelayTransport.RelayStatus }
  >()
  for (const [handle, route] of currentRoutes) {
    out.set(handle, { ...route, status: currentTransport?.status(route.rid) ?? "idle" })
  }
  return out
}

export function kind(): Kind {
  return currentKind
}

/** Why the flock is idle here, in words, or undefined when it is not idle. An
 *  engine that stood down for the lease and an engine with no contacts are
 *  different states with different fixes. */
export function reason(): string | undefined {
  return currentCode ? IDLE_TEXT[currentCode] : undefined
}

/** The same answer as {@link reason}, as the code a caller can branch on. */
export function reasonCode(): IdleCode | undefined {
  return currentCode
}

/** The OWNING engine's asking-side peer, for the HTTP routes a non-owner calls. */
export function peer(): FlockPeer.Peer | undefined {
  return currentPeer
}

/** Where this engine's `flock-owner.json` lives. `undefined` = the data directory. */
export function leaseDirectory(): string | undefined {
  return currentLease
}

/** Re-run the start gates and re-open the links against what `flock.json` says
 *  NOW; a no-op in a process with no published service. `acp/flock.ts` calls it
 *  after every write — routes are otherwise built once, inside `open()`. */
export function refresh(): void {
  currentRefresh?.()
}

/** Re-run the gates from DISK before a caller prints why the flock is idle.
 *  {@link reasonCode} is a module slot up to one heartbeat old; `flock_ask` and
 *  `flock_who` call this so their sentence is never older than the file. */
export function recheck(): void {
  // ONLY a store-reason idle. NOT `other-engine`: `restart()` would try to CLAIM
  // the lease, and a tool call is not the place to take the flock off another
  // window — the beat does that, one heartbeat after the holder goes away. NOT
  // while the flock runs here: a restart tears live relay links down.
  if (!currentCode || !RECHECKABLE.has(currentCode)) return
  currentRefresh?.()
}

/** An inert handle for a caller that decided not to start at all, published so
 *  `flock_state` and the tools can still say why. `boot.ts` uses it for a box
 *  with no `flock.json`. */
export function idleHandle(code: IdleCode, publish = true): Handle {
  if (publish) {
    currentKind = "none"
    currentCode = code
    currentPeer = undefined
    currentTransport = undefined
    currentRoutes = new Map()
    currentLease = undefined
    currentRefresh = undefined
  }
  return { active: false, reason: IDLE_TEXT[code], kind: "none", routes: new Map(), refresh: () => {}, stop: () => {} }
}

export interface Options {
  readonly store: Store
  /** `config.flock.frontDesk`. Absent means the owner never wrote the block. */
  readonly config?: FlockPolicy.FrontDeskConfig
  /** `config.flock.relayUrl`, the fallback for a friend whose invite carried no
   *  relay. NOT `origamicoder.remote.relayUrl`, which points the phone at a
   *  relay and has nothing to do with a friendship. */
  readonly relayUrl?: string
  /** The owner's worktree, threaded to the Front Desk's cage. An OPTION rather
   *  than an ambient lookup, so the relay end-to-end test can drive two whole
   *  engines with no provider. */
  readonly worktree?: string
  readonly runner: FlockFrontDesk.Runner
  readonly specialties?: readonly string[]
  /** Injected socket + timers. Production leaves it unset and gets `WebSocket`/`setTimeout`. */
  readonly deps?: FlockRelayTransport.RelayDeps
  readonly backoff?: readonly number[]
  /** One line per lifecycle event. Defaults to stderr, the way `agent-broker.ts` reports. */
  readonly log?: (line: string) => void
  /** Whether to publish the transport to the module-level slot `tool/flock.ts`
   *  reads. True in production; FALSE for a test running two engines in one
   *  process, where one global slot would have both asking through one of them. */
  readonly publish?: boolean
  readonly env?: Record<string, string | undefined>
  /** Where `flock-owner.json` lives. Production leaves it unset and gets the
   *  engine's data directory; a test always passes one. */
  readonly leaseDirectory?: string
  /** This engine's own loopback HTTP base. Written into the lease when this
   *  engine wins it, so a window that stood down can forward its questions here.
   *  `cli/cmd/acp.ts` is the only place that knows the port. */
  readonly httpBase?: string
  /** The arbiter itself, for a test that wants two engines with scripted pids
   *  and a scripted clock over one directory. */
  readonly owner?: FlockOwnerLease.Owner
  /** Where the "we are leaving, give the lease up" hooks are registered.
   *  Production leaves it unset and gets the real `process`; a test passes its
   *  own, or nothing — a hundred engines would trip Node's max-listeners. */
  readonly exit?: FlockExit.Target
}

export interface Handle {
  /** False when the service is deliberately idle. `reason` says which idle. */
  readonly active: boolean
  readonly reason?: string
  /** What the links are riding on. `other-engine` is not a failure — it is
   *  another window doing the job, and the pane says so. */
  readonly kind: Kind
  readonly transport?: FlockRelayTransport.RelayTransport
  readonly peer?: FlockPeer.Peer
  /** Which relay each friend is on, by handle. For the log and for a test's assertions. */
  readonly routes: ReadonlyMap<string, { rid: string; role: FlockRelayTransport.RelayRole; relayUrl: string }>
  /** Re-read `flock.json`, re-run the gates and re-open the links, KEEPING the
   *  lease this engine already holds. What makes a contact accepted after boot
   *  reachable without an engine restart. */
  refresh(): void
  stop(): void
}

/** Whether ANY friend could be answered — desk-wide model, or one on a friend. */
export function hasFrontDeskModel(store: Store, config?: FlockPolicy.FrontDeskConfig): boolean {
  if (config?.model) return true
  return store.friends().some((friend) => Boolean(friend.policy?.model))
}

/** Where this friendship's frames go. The invite's relay wins; then config; then the default. */
export function relayFor(friend: Friend, fallback?: string): string {
  return friend.relay ?? fallback ?? DEFAULT_RELAY_URL
}

/** The two ways a start is refused before the lease is ever looked at, in cost
 *  order — an env var, then one read of a file the store already holds. */
function gate(options: Options, env: Record<string, string | undefined>): IdleCode | undefined {
  if (env[DISABLE_ENV] === "1") return "disabled"
  if (options.store.friends().length === 0) return "no-contacts"
  // No model check here: asking needs contacts and a wire; only ANSWERING needs
  // a model, and gating the wire on it stopped the owner asking anybody at all.
  return undefined
}

/** Everything the OWNING engine does. Reached only with the lease in hand. */
function open(options: Options, log: (line: string) => void): Handle {
  const store = options.store
  const friends = store.friends()
  const identity = store.identity()
  const routes = new Map<string, { rid: string; role: FlockRelayTransport.RelayRole; relayUrl: string }>()
  const byRid = new Map<string, Friend>()

  // Declared before the transport because the status callback closes over it,
  // and assigned after because the peer needs the transport. A callback that
  // fires before `peer.start()` finds it undefined — there is nothing to flush.
  let peer: FlockPeer.Peer | undefined

  const transport = new FlockRelayTransport.RelayTransport({
    ...(options.deps ? { deps: options.deps } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
    onStatus: (rid, status, detail) => {
      const friend = byRid.get(rid)
      if (!friend) return
      if (status === "open") {
        // The only moment a resend can do anything: the relay ring covers ten
        // minutes, past which the question exists only in `flock.json`.
        void peer
          ?.flushPending(friend.handle)
          .then((sent) => {
            if (sent > 0) log(`[flock] re-sent ${sent} unanswered question(s) to ${friend.handle}`)
          })
          .catch(() => {})
        log(`[flock] connected to ${friend.handle}`)
        return
      }
      if (status === "waiting" || status === "stopped") {
        log(`[flock] ${status} on ${friend.handle}${detail ? ` — ${detail}` : ""}`)
      }
    },
  })

  for (const friend of friends) {
    const keys = FlockPeer.keysFor(identity, friend)
    const role = FlockRelayTransport.roleFor(identity.signPublicKey, friend.signPublicKey)
    const relayUrl = relayFor(friend, options.relayUrl)
    // `after` is a FUNCTION, read at connect time: a reconnect resumes from what
    // the store actually got to, not from what it held when the service booted.
    transport.register(keys.rid, { relayUrl, role, after: () => store.seq(friend.handle).recv })
    routes.set(friend.handle, { rid: keys.rid, role, relayUrl })
    byRid.set(keys.rid, friend)
  }

  const desk = FlockFrontDesk.make({
    store,
    // The worktree the desk's own reads are relative to. Without it an absolute
    // shared folder yields `read` rules in a form `tool/read.ts` never asks in.
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(options.config ? { config: options.config } : {}),
    ...(options.specialties ? { specialties: options.specialties } : { specialties: store.desk().specialties ?? [] }),
    runner: options.runner,
    notifyModelUnset: ({ friend }) =>
      log(`[flock] refused a question from ${friend.handle}: no front desk model is set`),
  })

  peer = new FlockPeer.Peer(store, transport, desk)
  peer.onLateAnswer = (answer) =>
    log(`[flock] a late answer arrived from ${answer.from} (${answer.tokens} tokens): ${answer.text.slice(0, 200)}`)
  // The reply goes back to the chat that asked, when that chat is still open.
  // Wired HERE rather than inside the peer because it leaves this process: the
  // origin session is usually a different engine of this workspace, reached by
  // an HTTP POST through the agent broker. Never awaited — the peer is mid-frame
  // and a closed chat must not hold it up; a failure is a log line and an unread row.
  peer.onReplyLanded = (thread) => {
    void FlockDeliver.land(store, thread)
      .then((outcome) => {
        if (!outcome.ok) log(`[flock] reply ${thread.id} stayed in the mailbox: ${outcome.reason}`)
        else log(`[flock] reply ${thread.id} delivered to the chat that asked (${outcome.sessionID})`)
      })
      .catch((error: unknown) => log(`[flock] delivering reply ${thread.id} failed: ${String(error)}`))
  }
  peer.start()

  if (options.publish !== false) FlockTransport.setTransport(transport)
  log(`[flock] holding ${friends.length} friendship(s) open`)
  // Said once, at the one moment it is actionable: the links are up, so the owner
  // can ask; what they cannot do is answer, and nothing else here would say so.
  if (!hasFrontDeskModel(store, options.config)) {
    log(`[flock] ${IDLE_TEXT["no-model"]} — this engine can ask, but every question sent TO it will be refused`)
  }

  return {
    active: true,
    kind: "relay",
    transport,
    peer,
    routes,
    // The OUTER handle owns re-opening: this one is torn down and replaced.
    refresh: () => {},
    stop: () => {
      peer.stop()
      transport.stop()
      if (options.publish !== false && FlockTransport.getTransport() === transport) {
        FlockTransport.setTransport(undefined)
      }
    },
  }
}

/** Start the flock for this engine, if this engine is the one that should hold
 *  it. The three idles are checked in cost order — env var, file read, lease.
 *  The handle's fields are GETTERS on purpose: a second engine that later takes
 *  over reports `active` and its routes through the handle `cli/cmd/acp.ts` holds. */
export function start(options: Options): Handle {
  const sink = options.log ?? ((line: string) => console.error(line))
  const publishLog = options.publish !== false
  /** Every lifecycle line goes to its sink AND, in the published engine, to the
   *  ring `diagnose.ts` reads. Two engines in one test must not share history. */
  const log = (line: string): void => {
    sink(line)
    if (!publishLog) return
    recent.push(line)
    while (recent.length > LOG_KEEP) recent.shift()
  }
  const env = options.env ?? process.env
  const deps = options.deps ?? FlockRelayTransport.defaultDeps
  const publish = options.publish !== false

  let inner: Handle | undefined
  /** Set when a gate refused this start. `undefined` with no `inner` means the
   *  gates passed and another engine holds the lease. */
  let refused: IdleCode | undefined
  /** BUILT LAZILY, and kept. A refused start must not touch the lease file, and
   *  a `refresh()` that finds the gates now passing must claim through the SAME
   *  arbiter — a second `Owner` would re-claim a lease this engine already holds. */
  let owner: FlockOwnerLease.Owner | undefined
  let timer: unknown = null
  let armed = false
  /** The idle reason already written to the log. See `take`. */
  let logged: IdleCode | undefined

  const publishState = (): void => {
    if (!publish) return
    currentKind = inner ? "relay" : refused ? "none" : "other-engine"
    currentCode = inner ? undefined : refused
    currentPeer = inner?.peer
    currentTransport = inner?.transport
    currentRoutes = inner?.routes ?? new Map()
    currentLease = options.leaseDirectory
    currentRefresh = restart
  }

  const take = (): void => {
    // From disk, every time: this runs on every beat while a store gate refuses,
    // and the point of that beat is a contact another engine just wrote.
    options.store.reload()
    refused = gate(options, env)
    if (refused) {
      // Once per CHANGE of reason, not once per beat: the same sentence every
      // thirty seconds is a log nobody reads.
      if (logged !== refused) log(`[flock] idle — ${IDLE_TEXT[refused]}`)
      logged = refused
      return
    }
    logged = undefined
    owner ??=
      options.owner ??
      new FlockOwnerLease.Owner({
        ...(options.leaseDirectory ? { directory: options.leaseDirectory } : {}),
        ...(options.httpBase ? { httpBase: options.httpBase } : {}),
      })
    // `holds` FIRST: a refresh must re-open the links without re-claiming, or
    // "the same lease" would get a new `startedAt` on every contact edit.
    if (!owner.holds && !owner.claim()) return
    inner = open(options, log)
  }

  /** origami_change (t-w2qlop): the holder beats every HEARTBEAT_MS whatever
   *  its class - a slower beat would let a sibling read the lease as stale
   *  (STALE_MS) and take the relay slots from a live engine. A NON-holder only
   *  retries, so it rests with the engine: every HEARTBEAT_MS while active, every
   *  ElasticState.REST_MIN_MS while background or idle. */
  const beatMs = (): number => (inner ? FlockOwnerLease.HEARTBEAT_MS : ElasticState.period(FlockOwnerLease.HEARTBEAT_MS))

  // ONE TIMER, TWO JOBS: while we own the flock it keeps the lease fresh; while
  // another engine owns it, it is the retry that takes over within one beat of
  // that engine going away. A gate refusal arms nothing — `refresh()` wakes it.
  const tick = (): void => {
    if (inner) {
      owner?.beat()
      // A BEAT THAT LOST THE LEASE. `beat()` drops the claim when the file names
      // somebody else; without standing down the two engines evict each other on
      // the relay (4001). The machine SLEEPS, so this is not theoretical: stale
      // heartbeat, another window claims on wake, and this one wakes as a holder
      // that is not the holder. `take()` re-claims if free, else `other-engine`.
      if (owner && !owner.holds) {
        inner.stop()
        inner = undefined
        log(`[flock] stood down — another engine took the lease while this one was not beating`)
        take()
      }
    }
    // A store gate that refused is re-run from the file, so a contact accepted
    // in another window brings this engine up within one beat.
    else if (!refused || RECHECKABLE.has(refused)) take()
    timer = deps.setTimer(tick, beatMs())
    publishState()
  }

  const arm = (): void => {
    if (armed) return
    armed = true
    timer = deps.setTimer(tick, beatMs())
  }

  // A class change re-arms a resting retry at the new period, so an engine
  // that becomes active is back on the short beat now, not after its rest.
  const unfollow = ElasticState.onChange(() => {
    if (!armed || inner) return
    deps.clearTimer(timer)
    timer = deps.setTimer(tick, beatMs())
  })

  function restart(): void {
    // The store object was loaded at boot and the pane and the CLI each write
    // through their OWN `Store.open()`, so the gates re-run against the FILE.
    inner?.stop()
    inner = undefined
    take()
    // A gate that now refuses gives the lease up, so another window can take the
    // flock rather than wait out a heartbeat this engine will never send. The
    // tick stays armed for a store reason, or nothing would notice a file change.
    if (refused) owner?.release()
    if (!refused || RECHECKABLE.has(refused)) arm()
    publishState()
  }

  take()
  if (!inner && !refused) {
    log(`[flock] idle — ${OTHER_ENGINE_REASON} (pid ${FlockOwnerLease.read(options.leaseDirectory)?.pid ?? "?"})`)
  }
  if (!refused || RECHECKABLE.has(refused)) arm()
  publishState()

  /** The lease goes back when this engine LEAVES, not STALE_MS later. Registered
   *  even by an engine the gates refused: it may claim later, on a beat that
   *  finds the file changed, and a hook installed at claim time would not be. */
  const unhook = options.exit ? FlockExit.onExit(() => owner?.release(), options.exit) : undefined

  return {
    get active() {
      return inner?.active ?? false
    },
    get reason() {
      return inner ? undefined : refused ? IDLE_TEXT[refused] : OTHER_ENGINE_REASON
    },
    get kind(): Kind {
      return inner ? "relay" : refused ? "none" : "other-engine"
    },
    get transport() {
      return inner?.transport
    },
    get peer() {
      return inner?.peer
    },
    get routes() {
      return inner?.routes ?? new Map()
    },
    refresh: restart,
    stop: () => {
      unhook?.()
      unfollow()
      deps.clearTimer(timer)
      timer = null
      armed = false
      inner?.stop()
      inner = undefined
      owner?.release()
      if (publish) {
        currentKind = "none"
        currentCode = "not-started"
        currentPeer = undefined
        currentTransport = undefined
        currentRoutes = new Map()
        currentLease = undefined
        currentRefresh = undefined
      }
    },
  }
}

export * as FlockService from "./service"

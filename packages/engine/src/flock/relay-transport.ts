import type { Transport } from "./transport"

/**
 * FLOCK OVER THE ORIGAMI REMOTE RELAY - the `Transport` a stranger's relay has to satisfy.
 *
 * The relay contract is `remote_wire_spec_v1.md` §Relay and nothing about it is
 * Flock-shaped: `WS /r/<rid>?role=desktop|phone&after=<seq>`, at most one socket per role
 * per rid, binary frames only, a 256-frame / 10-minute replay ring, and `?after=`
 * replaying only what the OTHER role sent past that seq. Both features can therefore
 * share one relay deployment without it knowing which is which.
 *
 * Three things the loopback never had to answer. WHICH SIDE IS "desktop": the party whose
 * SIGNING PUBLIC KEY sorts lexicographically smaller takes it, the other takes `phone` -
 * the only stable symmetric fact both ends hold with no round trip ({@link roleFor}).
 * WHAT `after=` IS: the highest sequence this side has already accepted from the friend,
 * read from `flock.json` at CONNECT time, which is why {@link Route.after} is a function.
 * WHEN A FRAME IS LOST: `send` on a dead wire queues rather than throwing; the ring covers
 * ten minutes, and `service.ts` covers the longer gap with its own 24-hour pending list.
 *
 * The socket and the timers are INJECTED, so a test can drive a whole disconnect/backoff/
 * resume cycle with no real clock and no real network.
 */

/** The relay's two slots. Nothing to do with `envelope.ts`'s ask/answer role byte. */
export type RelayRole = "desktop" | "phone"

/** Which slot a party takes, from the two signing public keys. Total, symmetric and
 *  derivable offline: `roleFor(a, b)` and `roleFor(b, a)` are always opposites. Two
 *  identical keys mean a friendship with oneself, refused. */
export function roleFor(ownSignPublicKey: string, friendSignPublicKey: string): RelayRole {
  return ownSignPublicKey < friendSignPublicKey ? "desktop" : "phone"
}

/** The minimum of `WebSocket` this transport uses. A fake in a test implements exactly this. */
export interface RelaySocket {
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  binaryType?: string
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface RelayDeps {
  connect(url: string): RelaySocket
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export const defaultDeps: RelayDeps = {
  connect: (url) => new WebSocket(url) as unknown as RelaySocket,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Backoff, one second doubling to a minute, the last entry repeating. A friend whose
 *  machine is off must not be retried all day, one whose relay blipped must be back fast. */
export const BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

/** The relay hands the OLD socket 4001 when a new one claims the same rid+role. */
export const CLOSE_SUPERSEDED = 4001

/** How to reach one friendship. */
export interface Route {
  /** Relay base, e.g. `wss://relay.origamilabs.nl` or `ws://127.0.0.1:8787`. */
  readonly relayUrl: string
  readonly role: RelayRole
  /** The highest seq already accepted from the friend. Read at connect time. */
  after(): number
}

export type RelayStatus = "idle" | "connecting" | "open" | "waiting" | "stopped"

/** Exported so a test can assert the exact query string the spec dictates. */
export function socketUrl(relayUrl: string, rid: string, role: RelayRole, after: number): string {
  const base = relayUrl.replace(/\/+$/, "")
  return `${base}/r/${encodeURIComponent(rid)}?role=${role}&after=${after}`
}

interface Connection {
  readonly rid: string
  route: Route
  socket: RelaySocket | null
  timer: unknown
  attempt: number
  stopped: boolean
  state: RelayStatus
  readonly queue: Uint8Array[]
  readonly handlers: Set<(frame: Uint8Array) => void | Promise<void>>
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

export interface RelayTransportOptions {
  deps?: RelayDeps
  backoff?: readonly number[]
  /** Frames held per rid while the wire is down. Bounded so a friend who never returns is not a leak. */
  queueLimit?: number
  /** Told on every state change. `service.ts` flushes its pending list on `open`. */
  onStatus?: (rid: string, status: RelayStatus, detail?: string) => void
}

export class RelayTransport implements Transport {
  private readonly connections = new Map<string, Connection>()
  private readonly deps: RelayDeps
  private readonly backoff: readonly number[]
  private readonly queueLimit: number
  private readonly onStatus?: (rid: string, status: RelayStatus, detail?: string) => void

  constructor(options: RelayTransportOptions = {}) {
    this.deps = options.deps ?? defaultDeps
    this.backoff = options.backoff ?? BACKOFF_MS
    this.queueLimit = options.queueLimit ?? 64
    this.onStatus = options.onStatus
  }

  /** Teach the transport how to reach one rid. `Transport.send`/`listen` carry a rid and
   *  nothing else, so the route arrives by this side door rather than widening an interface. */
  register(rid: string, route: Route): void {
    const existing = this.connections.get(rid)
    if (existing) {
      existing.route = route
      return
    }
    this.connections.set(rid, {
      rid,
      route,
      socket: null,
      timer: null,
      attempt: 0,
      stopped: false,
      state: "idle",
      queue: [],
      handlers: new Set(),
    })
  }

  /** Forget a rid entirely. What a revoke does. */
  unregister(rid: string): void {
    const connection = this.connections.get(rid)
    if (!connection) return
    this.connections.delete(rid)
    this.shutdown(connection)
  }

  status(rid: string): RelayStatus {
    return this.connections.get(rid)?.state ?? "idle"
  }

  queued(rid: string): number {
    return this.connections.get(rid)?.queue.length ?? 0
  }

  /** Close every socket and cancel every timer. Terminal. The records are KEPT rather than
   *  cleared, so `status` still says "stopped" afterwards - a transport that forgot its rids
   *  would answer "idle", which reads as something else entirely in a log. */
  stop(): void {
    for (const connection of this.connections.values()) this.shutdown(connection)
  }

  async send(rid: string, frame: Uint8Array): Promise<void> {
    const connection = this.connections.get(rid)
    // NAMES THE CURE: the only way here in production is adding a friend while the engine is
    // up - `service.ts` registers one route per friend at start and nothing re-scans.
    if (!connection) {
      throw new Error(
        `no relay route is registered for this friendship — restart Origami if this friend was added while it was running`,
      )
    }
    if (connection.stopped) throw new Error(`the relay connection for this friendship was stopped`)
    this.ensure(connection)
    if (connection.state === "open" && connection.socket) {
      connection.socket.send(frame)
      return
    }
    connection.queue.push(frame)
    while (connection.queue.length > this.queueLimit) connection.queue.shift()
  }

  listen(rid: string, handler: (frame: Uint8Array) => void | Promise<void>): () => void {
    const connection = this.connections.get(rid)
    if (!connection) {
      // A rid with no route is a friendship this transport was never told about.
      // A no-op unsubscribe keeps `Peer.start()` from knowing which are reachable.
      return () => {}
    }
    connection.handlers.add(handler)
    this.ensure(connection)
    return () => {
      connection.handlers.delete(handler)
    }
  }

  private ensure(connection: Connection): void {
    if (connection.stopped || connection.socket || connection.timer) return
    this.connect(connection)
  }

  private connect(connection: Connection): void {
    this.clearTimer(connection)
    this.setState(connection, "connecting")
    const url = socketUrl(connection.route.relayUrl, connection.rid, connection.route.role, connection.route.after())
    let socket: RelaySocket
    try {
      socket = this.deps.connect(url)
    } catch (error) {
      this.scheduleReconnect(connection, error instanceof Error ? error.message : String(error))
      return
    }
    connection.socket = socket
    // Bun's and the browser's WebSocket hand back a Blob by default; the frame
    // has to be bytes inside `onmessage` or the ordering guarantee is gone.
    try {
      socket.binaryType = "arraybuffer"
    } catch {
      // Read-only on some implementations. `toBytes` normalises what arrives.
    }
    socket.onopen = () => {
      if (connection.socket !== socket) return
      connection.attempt = 0
      this.setState(connection, "open")
      this.flush(connection)
    }
    socket.onmessage = (event) => {
      if (connection.socket !== socket) return
      const bytes = toBytes(event.data)
      if (bytes) this.deliver(connection, bytes)
    }
    socket.onerror = () => {
      // Every implementation follows an error with a close, and reacting here
      // as well would double-schedule the reconnect.
    }
    socket.onclose = (event) => {
      if (connection.socket !== socket) return
      connection.socket = null
      if (event?.code === CLOSE_SUPERSEDED) {
        // Another engine of OURS claimed this friendship's slot. Reconnecting
        // would make the two evict each other for ever; last one in wins.
        this.shutdown(connection, "another engine claimed this friendship")
        return
      }
      this.scheduleReconnect(connection, event?.reason || (event?.code === undefined ? undefined : `close ${event.code}`))
    }
  }

  private deliver(connection: Connection, frame: Uint8Array): void {
    for (const handler of [...connection.handlers]) {
      void (async () => {
        try {
          await handler(new Uint8Array(frame))
        } catch {
          // A handler that throws must not take the socket down, the same
          // contract `LoopbackTransport` documents.
        }
      })()
    }
  }

  private flush(connection: Connection): void {
    const socket = connection.socket
    if (!socket) return
    // Spliced out BEFORE the sends: a send that throws must not replay the
    // whole backlog on the next flush.
    for (const frame of connection.queue.splice(0, connection.queue.length)) socket.send(frame)
  }

  private scheduleReconnect(connection: Connection, detail?: string): void {
    if (connection.stopped) return
    const wait = this.backoff[Math.min(connection.attempt, this.backoff.length - 1)]!
    connection.attempt++
    this.setState(connection, "waiting", detail)
    connection.timer = this.deps.setTimer(() => {
      connection.timer = null
      if (!connection.stopped) this.connect(connection)
    }, wait)
  }

  private shutdown(connection: Connection, detail?: string): void {
    connection.stopped = true
    this.clearTimer(connection)
    connection.queue.length = 0
    const socket = connection.socket
    connection.socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      try {
        socket.close()
      } catch {
        // A socket that is already dead is what we were asking for.
      }
    }
    this.setState(connection, "stopped", detail)
  }

  private clearTimer(connection: Connection): void {
    if (connection.timer === null || connection.timer === undefined) return
    this.deps.clearTimer(connection.timer)
    connection.timer = null
  }

  private setState(connection: Connection, next: RelayStatus, detail?: string): void {
    connection.state = next
    this.onStatus?.(connection.rid, next, detail)
  }
}

export * as FlockRelayTransport from "./relay-transport"

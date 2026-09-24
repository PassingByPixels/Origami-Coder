// AN ORIGAMI RELAY, IN THIS PROCESS.
//
// `relay-e2e.test.ts` spawns the shipped `origami relay` and talks to it over a
// real socket, which is the right proof that a frame survives a process
// boundary — and the wrong tool for "the relay went away and came back", which
// needs the drop to be a thing the test DOES, at a moment it chooses, with no
// sleeping.
//
// So this is the same contract with the socket layer replaced: `WS /r/<rid>
// ?role=desktop|phone&after=<seq>`, at most one socket per role per rid (the
// older one gets 4001), and a replay ring of what the OTHER role sent past
// `after`. The ring is the SHIPPED `relay/ring.ts` rather than a second copy of
// its eviction rules — a fixture that re-implemented the thing under test would
// be proving itself.
//
// NO REAL NETWORK AND NO REAL CLOCK. Nothing here dials anything, and every
// wait (the connect edge, a backoff) is a timer the test fires by hand.
import { FrameRing, type RelayRole } from "@/relay/ring"
import type { FlockRelayTransport } from "@/flock/relay-transport"

/** What the relay hands the OLD socket when a new one claims the same slot. */
export const CLOSE_SUPERSEDED = 4001

/** What a relay restart looks like from a client: a plain abnormal close. */
export const CLOSE_GOING_AWAY = 1001

interface Endpoint {
  readonly rid: string
  readonly role: RelayRole
  readonly after: number
  readonly url: string
  readonly socket: FlockRelayTransport.RelaySocket
  /** Frames this endpoint PUT ON THE WIRE, for a test that wants to count. */
  readonly sent: Uint8Array[]
  open: boolean
  closed: boolean
}

function otherRole(role: RelayRole): RelayRole {
  return role === "desktop" ? "phone" : "desktop"
}

/** `/r/<rid>?role=…&after=…`, parsed the way the shipped server parses it. */
function parse(url: string): { rid: string; role: RelayRole; after: number } {
  const parsed = new URL(url.replace(/^ws/, "http"))
  const rid = decodeURIComponent(parsed.pathname.replace(/^\/r\//, ""))
  const role = parsed.searchParams.get("role") === "phone" ? "phone" : "desktop"
  const after = Number.parseInt(parsed.searchParams.get("after") ?? "0", 10)
  return { rid, role, after: Number.isFinite(after) && after > 0 ? after : 0 }
}

export interface Relay {
  /** Hand this to `FlockService.start({ deps })`, or to a `RelayTransport`. */
  readonly deps: FlockRelayTransport.RelayDeps
  /** Every URL dialled, in order. `?after=` is read off these. */
  readonly dials: string[]
  /** Fire every timer armed so far, once. Returns how many ran. */
  beat(): number
  /** Keep beating until nothing new is armed, or `rounds` is used up. */
  settle(rounds?: number): void
  /** How many sockets are attached right now. */
  live(): number
  /** Frames the ring holds for one rid. */
  ringSize(rid: string): number
  /**
   * CLOSE EVERY LIVE SOCKET — the relay was restarted, or the machine slept and
   * woke up with every connection dead. The rings are KEPT, which is what the
   * real relay does across a client reconnect and what makes `?after=` mean
   * anything; pass `forget` to lose them too, which is a relay that restarted.
   */
  dropAll(input?: { code?: number; reason?: string; forget?: boolean }): void
  /** Everything the fixture is holding, released. */
  stop(): void
}

export function startFixtureRelay(): Relay {
  const dials: string[] = []
  const timers: Array<() => void> = []
  const rings = new Map<string, FrameRing>()
  const slots = new Map<string, Endpoint>()
  const endpoints = new Set<Endpoint>()

  const key = (rid: string, role: RelayRole) => `${rid}|${role}`
  const ringFor = (rid: string) => {
    const existing = rings.get(rid)
    if (existing) return existing
    const made = new FrameRing()
    rings.set(rid, made)
    return made
  }

  const close = (endpoint: Endpoint, code?: number, reason?: string): void => {
    if (endpoint.closed) return
    endpoint.closed = true
    endpoint.open = false
    endpoints.delete(endpoint)
    if (slots.get(key(endpoint.rid, endpoint.role)) === endpoint) slots.delete(key(endpoint.rid, endpoint.role))
    endpoint.socket.onclose?.({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
  }

  const deliver = (endpoint: Endpoint, frame: Uint8Array): void => {
    // A copy, and an ArrayBuffer: it is what a real socket hands `onmessage`
    // once `binaryType` is set, and the transport's own normaliser is part of
    // what this fixture exists to exercise.
    const copy = new Uint8Array(frame)
    endpoint.socket.onmessage?.({ data: copy.buffer })
  }

  const deps: FlockRelayTransport.RelayDeps = {
    connect: (url) => {
      dials.push(url)
      const { rid, role, after } = parse(url)
      const endpoint: Endpoint = {
        rid,
        role,
        after,
        url,
        sent: [],
        open: false,
        closed: false,
        socket: {
          send: (data: Uint8Array) => {
            if (!endpoint.open) throw new Error("sent on a socket that is not open")
            endpoint.sent.push(new Uint8Array(data))
            ringFor(rid).push(role, new Uint8Array(data))
            const peer = slots.get(key(rid, otherRole(role)))
            if (peer?.open) deliver(peer, data)
          },
          close: () => close(endpoint),
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        },
      }
      // OPENED ON A TIMER, never inside `connect`. A real socket opens after the
      // caller has had a chance to install its handlers; opening synchronously
      // here would call an `onopen` that is still null and hide every bug that
      // depends on the ordering.
      timers.push(() => {
        if (endpoint.closed) return
        const previous = slots.get(key(rid, role))
        slots.set(key(rid, role), endpoint)
        endpoints.add(endpoint)
        // ONE SOCKET PER ROLE PER RID. The older one is evicted with 4001, which
        // is the rule two engines of the same owner collide on.
        if (previous && previous !== endpoint) close(previous, CLOSE_SUPERSEDED, "replaced")
        endpoint.open = true
        endpoint.socket.onopen?.()
        // The replay ring, oldest first — only what the OTHER role sent past
        // the seq this side says it already has.
        for (const entry of ringFor(rid).since(otherRole(role), after)) deliver(endpoint, entry.data)
      })
      return endpoint.socket
    },
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {},
  }

  const beat = (): number => {
    const due = timers.splice(0)
    for (const fn of due) fn()
    return due.length
  }

  return {
    deps,
    dials,
    beat,
    settle: (rounds = 12) => {
      for (let round = 0; round < rounds; round++) if (beat() === 0) return
    },
    live: () => [...endpoints].filter((endpoint) => endpoint.open).length,
    ringSize: (rid) => rings.get(rid)?.size ?? 0,
    dropAll: (input = {}) => {
      for (const endpoint of [...endpoints]) close(endpoint, input.code ?? CLOSE_GOING_AWAY, input.reason ?? "going away")
      if (input.forget) rings.clear()
    },
    stop: () => {
      for (const endpoint of [...endpoints]) close(endpoint)
      timers.length = 0
      rings.clear()
      slots.clear()
    },
  }
}

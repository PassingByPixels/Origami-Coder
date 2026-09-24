/**
 * Origami Remote relay — wire spec v1, "Relay" section.
 *
 * A blind WebSocket rendezvous. It pairs a desktop and a phone by rendezvous id,
 * forwards opaque binary frames between them, keeps a short replay ring, enforces
 * the caps, and optionally serves the phone shell's static files.
 *
 * It never logs a rid and never persists anything: state is rid -> sockets + ring,
 * in memory only, dropped when both peers are gone.
 */

import path from "node:path"
import { DailyBudget, DEFAULT_BULK_MB_PER_MINUTE, MAX_FRAME_BYTES, RateLimiter } from "./limits"
import { FrameRing, RING_MAX_AGE_MS, type RelayRole } from "./ring"

export const CLOSE_REPLACED = 4001
export const CLOSE_TOO_LARGE = 4002
export const CLOSE_RATE_LIMIT = 4003
export const CLOSE_TEXT_FRAME = 4004

/**
 * PRESENCE, the relay's only control frames (wire spec v1, "Presence").
 *
 * The relay is blind and stays blind: these carry no rid, no seq and no
 * payload — the token IS the whole message, and it is sent only to the socket
 * it is about. They are TEXT frames, which is what makes them unambiguous: a
 * client that sends text is closed with 4004, so nothing a client can produce
 * ever looks like one, and a client that does not know them ignores a
 * non-binary frame harmlessly.
 *
 * They exist because a desktop with no phone attached still posted the whole
 * dashboard fan-out — every streamed token, padded to 1,058 bytes — into a
 * socket the relay could only drop. Told "absent", the desktop stops sending;
 * told "present", it resumes and hydrates.
 */
export const PEER_PRESENT = "peer:present"
export const PEER_ABSENT = "peer:absent"

/** Global ceiling on live relay websockets. */
export const DEFAULT_MAX_CONNECTIONS = 2000

/**
 * What the loopback metrics surface reports.
 *
 * COUNTS AND RATES ONLY. The relay is blind and the metrics keep it blind:
 * there is no rid here, no frame byte, no pairing material, and no per-rid
 * breakdown of any kind - a per-rid map would name every live pairing, which is
 * precisely the thing the relay refuses to write down. Everything below is
 * either a global gauge or a global monotonic total, so the surface stays the
 * same size whether one pairing is running or a thousand.
 */
export interface RelayMetrics {
  /** Whole seconds since startRelay() returned. */
  uptime_s: number
  live_sockets: number
  peak_live_sockets: number
  /** Pairings held in memory: both attached, or one side waiting for the other. */
  rendezvous: number
  peak_rendezvous: number
  max_connections: number
  /** Configured replay-ring window, in seconds. No per-rid data — one global number. */
  ring_seconds: number
  budget: {
    used_bytes: number
    /** null when no budget was configured. */
    limit_bytes: number | null
    exhausted: boolean
  }
  totals: {
    sockets_opened: number
    frames_relayed: number
    bytes_relayed: number
    /** Frames that arrived with no peer attached: stored in the ring, never sent. */
    frames_no_peer: number
  }
  /** The bulk lane (`?lane=bulk`): own rid namespace, no ring, its own bucket. */
  bulk_frames: number
  bulk_bytes: number
  /** Bulk rendezvous currently held in memory — a gauge, like `rendezvous`. */
  bulk_rids_open: number
  /** Sockets the relay itself closed, by close code. */
  closes: {
    replaced_4001: number
    too_large_4002: number
    rate_limit_4003: number
    text_frame_4004: number
  }
  refused: {
    budget_503: number
    max_connections_503: number
    not_upgraded_426: number
  }
}

/** base64url of 16 bytes is exactly 22 characters from the base64url alphabet. */
const RID_PATTERN = /^[A-Za-z0-9_-]{22}$/

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
}

export interface RelayOptions {
  port?: number
  hostname?: string
  /** Directory served at /app/*. Absent means /app/* is 404. */
  appDir?: string
  tlsCert?: string
  tlsKey?: string
  /** Global budget in MB per UTC day. <= 0 or unset means unlimited. */
  dailyBudgetMb?: number
  /** Ceiling on live websockets across every rid. Must be a positive integer. */
  maxConnections?: number
  /**
   * How long the per-rid replay ring keeps a frame, in milliseconds. Must be a
   * non-negative integer. Default 90 seconds (`RING_MAX_AGE_MS`); 0 keeps no
   * ring at all, so a reconnecting socket is never replayed anything.
   */
  ringMaxAgeMs?: number
  /**
   * Serve RelayMetrics as JSON at /metrics on THIS port, bound to 127.0.0.1.
   * Undefined (the default) means no metrics listener at all. 0 picks a free
   * port, which is what the tests use.
   */
  metricsPort?: number
  /**
   * Token-bucket capacity for the bulk lane (`?lane=bulk`), in MB per rolling
   * 60 s, one bucket per bulk rid. Default `DEFAULT_BULK_MB_PER_MINUTE` (20).
   */
  bulkRidMbPerMinute?: number
}

export interface RelayHandle {
  readonly port: number
  readonly hostname: string
  /** The port the metrics listener bound, or undefined when it is off. */
  readonly metricsPort?: number
  stop(): Promise<void>
}

type RelayLane = "live" | "bulk"

interface SocketData {
  rid: string
  role: RelayRole
  after: number
  lane: RelayLane
}

interface Rendezvous {
  ring: FrameRing
  sockets: Map<RelayRole, ServerWebSocket<SocketData>>
}

/**
 * The bulk lane's own rid namespace (wire spec v1 addendum, cloud sessions):
 * a rid of `?lane=bulk` never touches — and can never collide with — the
 * SAME rid string on the live lane. No ring: bulk exists for a one-shot pull
 * of a compact journal, not a resumable interactive pairing, and `?after=`
 * is ignored for it. Resume, if any, is receiver-driven at the application
 * layer, not something the relay remembers.
 */
interface BulkRendezvous {
  sockets: Map<RelayRole, ServerWebSocket<SocketData>>
}

type ServerWebSocket<T> = import("bun").ServerWebSocket<T>

function otherRole(role: RelayRole): RelayRole {
  return role === "desktop" ? "phone" : "desktop"
}

/** `?after=` is a decimal uint32; anything else falls back to 0 (replay all). */
function parseAfter(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return 0
  const value = Number(raw)
  return value > 0xffff_ffff ? 0 : value
}

function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
}

/**
 * Maps a /app/... request onto a file inside `appDir`, or null when the path
 * escapes the directory.
 *
 * `new URL()` already strips plain dot segments ("/app/../x" arrives as "/x"),
 * so what actually reaches here are the encoded-separator forms — "..%2f",
 * "%2e%2e%2f", "..%5c" on Windows. Those are decoded first and then refused by
 * comparing the RESOLVED path against the resolved root, which covers every
 * spelling rather than blacklisting one. Exported for direct unit coverage of
 * this guard.
 */
export function resolveAppFile(appDir: string, pathname: string): string | null {
  const rest = pathname.slice("/app".length)
  const relative = rest === "" || rest === "/" ? "index.html" : decodeURIComponent(rest.slice(1))
  if (relative.includes("\0")) return null
  const root = path.resolve(appDir)
  const target = path.resolve(root, relative)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

export async function startRelay(options: RelayOptions = {}): Promise<RelayHandle> {
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new Error(`max-connections must be a positive integer, got ${maxConnections}`)
  }

  const metricsPort = options.metricsPort
  if (
    metricsPort !== undefined &&
    (!Number.isSafeInteger(metricsPort) || metricsPort < 0 || metricsPort > 65_535)
  ) {
    throw new Error(`metrics-port must be a port number, got ${metricsPort}`)
  }
  if (metricsPort !== undefined && metricsPort !== 0 && metricsPort === (options.port ?? 8787)) {
    throw new Error("metrics-port must differ from the relay port")
  }

  const ringMaxAgeMs = options.ringMaxAgeMs ?? RING_MAX_AGE_MS
  if (!Number.isSafeInteger(ringMaxAgeMs) || ringMaxAgeMs < 0) {
    throw new Error(`ring-seconds must be a non-negative integer, got ${ringMaxAgeMs / 1000}`)
  }

  // Live websockets across every rid. `open` fires synchronously INSIDE
  // server.upgrade() (Bun 1.3.14), and the /r/ branch of fetch has no `await`
  // between the cap check and that upgrade, so two requests can never pass the
  // same free slot. A refused request never upgrades, so it never opens and
  // never closes: the counter cannot be given back a slot it never took.
  let liveSockets = 0

  const startedAt = Date.now()
  const counters = {
    socketsOpened: 0,
    framesRelayed: 0,
    bytesRelayed: 0,
    framesNoPeer: 0,
    closesReplaced: 0,
    closesTooLarge: 0,
    closesRateLimit: 0,
    closesTextFrame: 0,
    refusedBudget: 0,
    refusedMaxConnections: 0,
    notUpgraded: 0,
    peakLiveSockets: 0,
    peakRendezvous: 0,
    bulkFramesRelayed: 0,
    bulkBytesRelayed: 0,
  }

  const rendezvous = new Map<string, Rendezvous>()
  const limiter = new RateLimiter()
  const budget = new DailyBudget({ limitMb: options.dailyBudgetMb })
  const appDir = options.appDir ? path.resolve(options.appDir) : undefined

  // The bulk lane's own namespace and its own bucket, sized independently of
  // the live per-rid limiter (2 MiB/min). Same DailyBudget instance: bulk
  // bytes still count against the shared daily cost cap.
  const bulkRendezvous = new Map<string, BulkRendezvous>()
  const bulkBytesPerMinute = (options.bulkRidMbPerMinute ?? DEFAULT_BULK_MB_PER_MINUTE) * 1024 * 1024
  const bulkLimiter = new RateLimiter({ capacity: bulkBytesPerMinute })

  const tls =
    options.tlsCert && options.tlsKey
      ? { cert: Bun.file(options.tlsCert), key: Bun.file(options.tlsKey) }
      : undefined

  // A rendezvous with no live socket is a dead pairing: dropping it here is what
  // keeps rid state bounded without a sweeper, and matches "never persists
  // anything". The replay window therefore covers a peer reconnecting while the
  // OTHER peer is still attached — which is the case `?after=` exists for.
  const forget = (rid: string) => {
    const entry = rendezvous.get(rid)
    if (!entry || entry.sockets.size > 0) return
    rendezvous.delete(rid)
    limiter.forget(rid)
  }

  const forgetBulk = (rid: string) => {
    const entry = bulkRendezvous.get(rid)
    if (!entry || entry.sockets.size > 0) return
    bulkRendezvous.delete(rid)
    bulkLimiter.forget(rid)
  }

  const server = Bun.serve<SocketData, string>({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    ...(tls ? { tls } : {}),
    async fetch(request, server) {
      const url = new URL(request.url)
      const pathname = url.pathname

      if (pathname === "/healthz") return new Response("ok")

      if (pathname === "/app" || pathname.startsWith("/app/")) {
        if (!appDir) return new Response("not found", { status: 404 })
        let target: string | null
        try {
          target = resolveAppFile(appDir, pathname)
        } catch {
          return new Response("bad request", { status: 400 })
        }
        if (!target) return new Response("forbidden", { status: 403 })
        const file = Bun.file(target)
        if (!(await file.exists())) return new Response("not found", { status: 404 })
        return new Response(file, { headers: { "content-type": contentType(target) } })
      }

      const rid = pathname.startsWith("/r/") ? pathname.slice(3) : null
      if (!rid || !RID_PATTERN.test(rid)) return new Response("not found", { status: 404 })

      const role = url.searchParams.get("role")
      if (role !== "desktop" && role !== "phone") return new Response("bad request", { status: 400 })

      const lane: RelayLane = url.searchParams.get("lane") === "bulk" ? "bulk" : "live"

      // The daily budget refuses NEW rids only; a pairing already in memory
      // keeps working. Priority rule (owner decision: cloud sessions over
      // remote control): a bulk rid is refused only once the day is fully
      // spent, so a live rid gives up its last 10% first.
      if (lane === "bulk") {
        if (budget.exhausted && !bulkRendezvous.has(rid)) {
          counters.refusedBudget++
          console.log("relay: refused a new bulk rendezvous, today's traffic budget is spent")
          return new Response("budget exhausted", { status: 503 })
        }
      } else {
        const known = rendezvous.has(rid)
        if (budget.exhausted && !known) {
          // SAY SO. The sibling cap below has always logged and this branch never
          // did, which cost the owner an afternoon: a Revoke mints a NEW rid, so a
          // re-pair is exactly what this refuses, and neither the desktop pane nor
          // the phone can read an HTTP status behind a failed upgrade. The line
          // carries no rid, like every other line this relay writes.
          counters.refusedBudget++
          console.log("relay: refused a new rendezvous, today's traffic budget is spent")
          return new Response("budget exhausted", { status: 503 })
        }
        if (!known && budget.nearExhausted) {
          counters.refusedBudget++
          console.log("relay: refused a new live rendezvous, today's traffic budget is nearly spent (bulk lane still open)")
          return new Response("budget exhausted", { status: 503 })
        }
      }

      // The last gate before the upgrade, so the log line only names connections
      // that every other rule would have let in. It carries no rid.
      if (liveSockets >= maxConnections) {
        counters.refusedMaxConnections++
        console.log(`relay: refused a connection, at the max-connections cap (${maxConnections})`)
        return new Response("too many connections", { status: 503 })
      }

      const data: SocketData = { rid, role, after: parseAfter(url.searchParams.get("after")), lane }
      if (server.upgrade(request, { data })) return undefined
      counters.notUpgraded++
      return new Response("expected websocket", { status: 426 })
    },
    websocket: {
      open(ws) {
        liveSockets++
        counters.socketsOpened++
        if (liveSockets > counters.peakLiveSockets) counters.peakLiveSockets = liveSockets
        const { rid, role, after, lane } = ws.data

        if (lane === "bulk") {
          let bulkEntry = bulkRendezvous.get(rid)
          if (!bulkEntry) {
            bulkEntry = { sockets: new Map() }
            bulkRendezvous.set(rid, bulkEntry)
          }
          const previousBulk = bulkEntry.sockets.get(role)
          bulkEntry.sockets.set(role, ws)
          if (previousBulk && previousBulk !== ws) {
            counters.closesReplaced++
            previousBulk.close(CLOSE_REPLACED, "replaced")
          }
          // Presence only — NO ring, so nothing is replayed here. `after` is
          // accepted on the wire (it is a shared query param) but ignored.
          const bulkPeer = bulkEntry.sockets.get(otherRole(role))
          ws.send(bulkPeer ? PEER_PRESENT : PEER_ABSENT)
          if (bulkPeer) bulkPeer.send(PEER_PRESENT)
          return
        }

        let entry = rendezvous.get(rid)
        if (!entry) {
          entry = { ring: new FrameRing({ maxAgeMs: ringMaxAgeMs }), sockets: new Map() }
          rendezvous.set(rid, entry)
          if (rendezvous.size > counters.peakRendezvous) counters.peakRendezvous = rendezvous.size
        }
        const previous = entry.sockets.get(role)
        // Register the replacement FIRST: closing `previous` re-enters the close
        // handler, which would otherwise see an empty role slot, drop the whole
        // rendezvous (and its ring), and orphan the socket being opened.
        entry.sockets.set(role, ws)
        if (previous && previous !== ws) {
          counters.closesReplaced++
          previous.close(CLOSE_REPLACED, "replaced")
        }
        // Presence BEFORE the ring: the first thing a desktop needs to know is
        // whether anything is listening, and a ring replay can be long. Neither
        // send is charged to the budget or the rate limiter — both are cost caps
        // on the FAN-OUT, and these two frames exist to make that fan-out
        // smaller; paying for the fix out of the budget it saves is circular.
        const peer = entry.sockets.get(otherRole(role))
        ws.send(peer ? PEER_PRESENT : PEER_ABSENT)
        if (peer) peer.send(PEER_PRESENT)
        for (const frame of entry.ring.since(otherRole(role), after)) ws.send(frame.data)
      },
      message(ws, message) {
        const { rid, role, lane } = ws.data
        if (typeof message === "string") {
          counters.closesTextFrame++
          ws.close(CLOSE_TEXT_FRAME, "binary frames only")
          return
        }
        if (message.byteLength > MAX_FRAME_BYTES) {
          counters.closesTooLarge++
          ws.close(CLOSE_TOO_LARGE, "frame too large")
          return
        }

        if (lane === "bulk") {
          if (!bulkLimiter.charge(rid, message.byteLength)) {
            counters.closesRateLimit++
            ws.close(CLOSE_RATE_LIMIT, "rate limit")
            return
          }
          const bulkEntry = bulkRendezvous.get(rid)
          if (!bulkEntry) return
          const bulkData = new Uint8Array(message)
          const bulkPeer = bulkEntry.sockets.get(otherRole(role))
          if (!bulkPeer) {
            counters.framesNoPeer++
            return
          }
          // Same rule as the live lane: budget-counted only when relayed.
          budget.record(message.byteLength)
          counters.bulkFramesRelayed++
          counters.bulkBytesRelayed += message.byteLength
          bulkPeer.send(bulkData)
          return
        }

        if (!limiter.charge(rid, message.byteLength)) {
          counters.closesRateLimit++
          ws.close(CLOSE_RATE_LIMIT, "rate limit")
          return
        }
        const entry = rendezvous.get(rid)
        if (!entry) return
        const data = new Uint8Array(message)
        entry.ring.push(role, data)
        const peer = entry.sockets.get(otherRole(role))
        if (!peer) {
          counters.framesNoPeer++
          return
        }
        // CHARGED ONLY WHEN IT IS RELAYED. The budget is a COST cap and the cost
        // is egress, which a frame with no peer never produces. A desktop whose
        // phone page is merely CLOSED still posts the whole dashboard fan-out —
        // every streamed token, padded to 1,058 bytes — and charging that spent
        // a 2 GiB day in an afternoon and then refused every new rid, so the
        // owner could not pair again after a Revoke and nothing said why.
        // Abuse is still capped by the per-rid rate limiter above, which counts
        // every frame whether or not anyone is listening.
        budget.record(message.byteLength)
        counters.framesRelayed++
        counters.bytesRelayed += message.byteLength
        peer.send(data)
      },
      close(ws) {
        // First, before any early return: stop() clears the rendezvous map and
        // then closes the sockets, so a decrement placed after the lookup below
        // would leak every slot the server itself tore down.
        liveSockets--
        const { rid, role, lane } = ws.data

        if (lane === "bulk") {
          const bulkEntry = bulkRendezvous.get(rid)
          if (!bulkEntry) return
          if (bulkEntry.sockets.get(role) !== ws) return
          bulkEntry.sockets.delete(role)
          bulkEntry.sockets.get(otherRole(role))?.send(PEER_ABSENT)
          forgetBulk(rid)
          return
        }

        const entry = rendezvous.get(rid)
        if (!entry) return
        // A socket that was REPLACED (close 4001, above) no longer holds the
        // role slot, and the newcomer has already told the peer we are present.
        // Announcing "absent" for it would pause a desktop whose phone is in
        // fact attached, so only a genuine removal speaks.
        if (entry.sockets.get(role) !== ws) return
        entry.sockets.delete(role)
        entry.sockets.get(otherRole(role))?.send(PEER_ABSENT)
        forget(rid)
      },
    },
  })

  const snapshot = (): RelayMetrics => ({
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    live_sockets: liveSockets,
    peak_live_sockets: counters.peakLiveSockets,
    rendezvous: rendezvous.size,
    peak_rendezvous: counters.peakRendezvous,
    max_connections: maxConnections,
    ring_seconds: ringMaxAgeMs / 1000,
    budget: {
      used_bytes: budget.usedBytes,
      limit_bytes: Number.isFinite(budget.limit) ? budget.limit : null,
      exhausted: budget.exhausted,
    },
    totals: {
      sockets_opened: counters.socketsOpened,
      frames_relayed: counters.framesRelayed,
      bytes_relayed: counters.bytesRelayed,
      frames_no_peer: counters.framesNoPeer,
    },
    closes: {
      replaced_4001: counters.closesReplaced,
      too_large_4002: counters.closesTooLarge,
      rate_limit_4003: counters.closesRateLimit,
      text_frame_4004: counters.closesTextFrame,
    },
    refused: {
      budget_503: counters.refusedBudget,
      max_connections_503: counters.refusedMaxConnections,
      not_upgraded_426: counters.notUpgraded,
    },
    bulk_frames: counters.bulkFramesRelayed,
    bulk_bytes: counters.bulkBytesRelayed,
    bulk_rids_open: bulkRendezvous.size,
  })

  // METRICS: ITS OWN SOCKET ON ITS OWN PORT, never a path on the relay port.
  // Caddy proxies 8787 and only 8787, so a counter surface on a different port
  // is unreachable from the internet by construction. A /metrics PATH on the
  // relay port would have been public the day it shipped, and would have stayed
  // private only for as long as a hand-written Caddy rule stayed correct.
  //
  // The hostname is hard-coded rather than inherited: --hostname exists to move
  // the RELAY (a self-hoster may bind it anywhere), and it must never be able to
  // drag this listener onto a public interface with it.
  const metrics =
    metricsPort === undefined
      ? undefined
      : Bun.serve({
          port: metricsPort,
          hostname: "127.0.0.1",
          fetch(request) {
            if (new URL(request.url).pathname !== "/metrics") {
              return new Response("not found", { status: 404 })
            }
            return Response.json(snapshot())
          },
        })

  return {
    port: server.port ?? 0,
    hostname: server.hostname ?? "127.0.0.1",
    metricsPort: metrics?.port,
    async stop() {
      rendezvous.clear()
      bulkRendezvous.clear()
      metrics?.stop(true)
      // Bun 1.3.14 on Windows never settles the promise from Server.stop() once
      // the server has itself closed a websocket (any close code) — reproduced
      // with a 20-line Bun.serve script. The listener is torn down synchronously
      // inside stop(), so bound the wait instead of hanging the caller forever.
      const stopped = server.stop(true)
      stopped.catch(() => {})
      await Promise.race([stopped, Bun.sleep(50)])
    },
  }
}

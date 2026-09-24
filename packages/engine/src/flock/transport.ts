/**
 * THE ONE THING A RELAY HAS TO IMPLEMENT: a byte pipe keyed by rendezvous id,
 * and nothing else. It never sees a plaintext, a handle, a public key or a token
 * count — `envelope.ts` has sealed everything by the time a frame reaches `send`,
 * and the AAD binds the frame to the rid, so a relay that misroutes one produces
 * an authentication failure rather than a leak.
 *
 * PROMISES, NOT EFFECT, DELIBERATELY: this one file is the boundary a stranger's
 * code implements, and a two-method async interface beats a Layer for a 40-line
 * relay client. Call sites bridge with `Effect.promise`.
 */
export interface Transport {
  /** Deliver one sealed frame to whoever else is on this rid. */
  send(rid: string, frame: Uint8Array): Promise<void>
  /** Receive frames on this rid until the returned function is called. A
   *  handler that throws must not take the transport down: an implementation
   *  catches and drops, the same way {@link LoopbackTransport} does. */
  listen(rid: string, handler: (frame: Uint8Array) => void | Promise<void>): () => void
}

/** Both ends in one process, sharing one map. What v1 proves the whole path on,
 *  and what every later transport is checked against — a relay that behaves
 *  differently from this is the relay that is wrong. Delivery is deferred to a
 *  microtask so `send` never re-enters the caller's own stack. */
export class LoopbackTransport implements Transport {
  private readonly handlers = new Map<string, Set<(frame: Uint8Array) => void | Promise<void>>>()

  async send(rid: string, frame: Uint8Array): Promise<void> {
    const listeners = this.handlers.get(rid)
    if (!listeners) return
    // A copy per listener: a receiver that keeps the buffer must not be able to
    // observe a later sender's edit, which is what a network would give it.
    for (const handler of [...listeners]) {
      queueMicrotask(() => {
        void (async () => {
          try {
            await handler(new Uint8Array(frame))
          } catch {
            // A relay drops a frame its peer could not handle. There is nobody
            // to report to and no plaintext to report about.
          }
        })()
      })
    }
  }

  listen(rid: string, handler: (frame: Uint8Array) => void | Promise<void>): () => void {
    let listeners = this.handlers.get(rid)
    if (!listeners) {
      listeners = new Set()
      this.handlers.set(rid, listeners)
    }
    listeners.add(handler)
    return () => {
      const set = this.handlers.get(rid)
      if (!set) return
      set.delete(handler)
      if (set.size === 0) this.handlers.delete(rid)
    }
  }
}

/** THE SEAM THE RELAY LANE PLUGS INTO. A module-level slot rather than an Effect
 *  service: the tools in `tool/flock.ts` are built inside `tool/registry.ts`'s
 *  layer, and a new service dependency would rewire the layer graph of every test
 *  that builds it, to thread a value that is a process-wide singleton either way.
 *  Unset means unset: `flock_ask` says so rather than pretending to send. */
let current: Transport | undefined

export function setTransport(transport: Transport | undefined): void {
  current = transport
}

export function getTransport(): Transport | undefined {
  return current
}

export * as FlockTransport from "./transport"

/**
 * GIVE THE FLOCK UP ON THE WAY OUT, however this engine is leaving. `stop()`
 * releases the lease, and `cli/cmd/acp.ts` calls it when stdin ends — the ONE
 * exit path that was covered. A window close, a machine shutdown or a crash left
 * the lease outliving the process holding it.
 *
 * THE SIGNAL HANDLERS RE-RAISE. Adding a `SIGINT` listener in Node REPLACES the
 * default action, so a naive handler would stop `Ctrl-C` killing `origami acp` at
 * all. Each handler removes itself, does its work and re-sends the same signal,
 * which now has no listener. `exit` is registered too: synchronous, and it fires
 * for `process.exit()`, which is how `index.ts` always ends.
 *
 * NOT A REPLACEMENT FOR THE STALE WINDOW — a `SIGKILL` or a power cut delivers
 * nothing, which is what `owner-lease.ts`'s liveness check and `STALE_MS` are for.
 */

/** The bit of `process` this needs. Injected so a test states the fact. */
export interface Target {
  readonly pid: number
  once(event: string, handler: () => void): unknown
  off(event: string, handler: () => void): unknown
  kill(pid: number, signal: string): unknown
}

/** The signals worth catching, each a real exit on some platform this ships to:
 *  `SIGINT` is Ctrl-C everywhere, `SIGTERM` is how a supervisor and the VS Code
 *  extension ask a POSIX engine to stop, `SIGHUP` is a closed terminal, `SIGBREAK`
 *  is Windows's Ctrl-Break. Registering one a platform never delivers costs 0. */
export const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const

/** `exit` and `beforeExit`, which are not signals and must not be re-raised. */
export const EVENTS = ["exit", "beforeExit"] as const

/** The signals worth catching, each a real exit on some platform this ships to:
 *  `SIGINT` is Ctrl-C, `SIGTERM` is how a supervisor or the VS Code extension asks
 *  a POSIX engine to stop, `SIGHUP` a closed terminal, `SIGBREAK` Ctrl-Break. */
export function onExit(release: () => void, target: Target = process as unknown as Target): () => void {
  let done = false
  const registered: Array<{ event: string; handler: () => void }> = []

  const run = (): void => {
    if (done) return
    done = true
    try {
      release()
    } catch {
      // An exit path is not a place to throw: a lease we could not delete is
      // aged out by the next engine, and a throw here would mask the real exit.
    }
  }

  for (const event of EVENTS) {
    const handler = () => run()
    target.once(event, handler)
    registered.push({ event, handler })
  }

  for (const signal of SIGNALS) {
    const handler = (): void => {
      run()
      // Off FIRST, then re-raise: with no listener left, the signal does what
      // it would have done had this module never existed.
      target.off(signal, handler)
      try {
        target.kill(target.pid, signal)
      } catch {
        // A platform that does not know this signal name. The process is on its
        // way out regardless; the lease is already gone, which was the job.
      }
    }
    target.once(signal, handler)
    registered.push({ event: signal, handler })
  }

  return () => {
    done = true
    for (const entry of registered.splice(0)) target.off(entry.event, entry.handler)
  }
}

export * as FlockExit from "./exit"

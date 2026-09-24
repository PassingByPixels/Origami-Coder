import { ProviderError } from "./error"
import type { ProviderV2 } from "@origami/core/provider"

/**
 * The per-provider concurrency cap, in one place because TWO runtimes need it.
 *
 * `max_concurrent` used to live entirely inside `provider.ts`, wrapping the
 * `fetch` on the SHALLOW COPY the AI SDK factory is built from. The native LLM
 * runtime never sees that copy: it reads the plugin signer straight off
 * `provider.options.fetch` (session/llm/native-runtime.ts), so every native
 * request went out ungated and a sub-agent fan-out on the ChatGPT OAuth route
 * ran unbounded (t-52cxcw). Both runtimes now acquire from the SAME
 * module-level semaphore table, so a cap counts a provider's generations once,
 * whichever runtime issued them.
 */

/**
 * Minimal Promise-based counting semaphore. The provider `fetch` wrapper runs
 * outside the Effect runtime (it's a plain async function handed to the AI SDK,
 * or to Effect's fetch client as a service), so the per-provider concurrency cap
 * can't use Effect's Semaphore there. A released permit is handed straight to
 * the next waiter (no re-increment) to keep the in-flight count exact.
 *
 * The queue is PRIORITY-ORDERED: a priority waiter is inserted behind the
 * priority waiters already queued and ahead of every ordinary one. That is what
 * stops a parent step being starved by its own children — see `limitFetch`.
 */
export class AsyncSemaphore {
  private permits: number
  private readonly waiters: Array<Waiter> = []
  constructor(permits: number) {
    this.permits = permits
  }
  /** Permits not currently held. 0 means the next acquire queues. */
  get free(): number {
    return this.permits
  }
  /**
   * How many queued waiters would be served before a NEW waiter of this
   * priority. An ordinary waiter goes to the back, so it waits for all of them;
   * a priority waiter only waits for the priority ones.
   */
  waitingAhead(priority = false): number {
    if (!priority) return this.waiters.length
    let count = 0
    for (const waiter of this.waiters) {
      if (!waiter.priority) break
      count++
    }
    return count
  }
  async acquire(priority = false): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    await new Promise<void>((resolve) => this.enqueue({ run: resolve, priority }))
  }
  /**
   * Bounded acquire: resolves true when a permit is granted, false after `ms`.
   * A timed-out waiter REMOVES itself from the queue — if it stayed, the next
   * release() would hand its permit to the dead resolver and the permit would
   * be lost (the same silent-block shape the bound exists to prevent).
   */
  acquireWithin(ms: number, priority = false): Promise<boolean> {
    if (this.permits > 0) {
      this.permits--
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        priority,
        run: () => {
          clearTimeout(timer)
          resolve(true)
        },
      }
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index < 0) return
        this.waiters.splice(index, 1)
        resolve(false)
      }, ms)
      this.enqueue(waiter)
    })
  }
  release(): void {
    const next = this.waiters.shift()
    if (next) next.run()
    else this.permits++
  }
  /** Priority waiters keep their arrival order among themselves; an ordinary
   *  waiter can never overtake anyone. */
  private enqueue(waiter: Waiter) {
    if (!waiter.priority) {
      this.waiters.push(waiter)
      return
    }
    const index = this.waiters.findIndex((item) => !item.priority)
    if (index < 0) this.waiters.push(waiter)
    else this.waiters.splice(index, 0, waiter)
  }
}

type Waiter = { readonly run: () => void; readonly priority: boolean }

// One semaphore per provider block id (the origami.json key), so two separate
// vLLM/LM-Studio servers get independent caps. Lazily created at the provider's
// configured max_concurrent; the cap only re-reads on engine reload.
const providerSemaphores = new Map<string, AsyncSemaphore>()
export function providerSemaphore(providerID: string, max: number): AsyncSemaphore {
  let sem = providerSemaphores.get(providerID)
  if (!sem) {
    sem = new AsyncSemaphore(max)
    providerSemaphores.set(providerID, sem)
  }
  return sem
}

/** Test seam: the table is process-wide, so a suite needs a way back to zero. */
export function resetProviderSemaphores(): void {
  providerSemaphores.clear()
}

// Grace window before an unconsumed response is declared abandoned and its
// permit reclaimed. A live consumer attaches its reader within milliseconds of
// the headers landing, so this only needs to be long enough to never misfire —
// it is NOT a generation timeout (a locked body is left alone forever).
const ABANDONED_RESPONSE_MS = 120_000

/**
 * Wrap a Response so `release` fires exactly once when the body stream ends, is
 * cancelled, or errors — i.e. when the provider has finished generating and the
 * server-side sequence slot frees. The per-provider cap holds a permit for the
 * whole generation (matching vLLM's max_num_seqs), not just until the response
 * headers arrive. Because the body ends BEFORE either runtime executes
 * client-side tools (task/subagents), a parent never holds a permit while
 * waiting on a child — so the cap can't deadlock a foreground subagent fan-out.
 *
 * Abandonment backstop: a runtime can drop a response it never reads and never
 * cancels, so no release path above fires and the permit would be held forever,
 * blocking every later request silently in acquire(). If the body is still
 * UNLOCKED after the grace window, nobody is coming: reclaim the permit and
 * cancel the upstream generation. A locked body means a live consumer owns the
 * stream, however slowly the provider feeds it.
 */
export function releaseOnBodyEnd(
  res: Response,
  release: () => void,
  abandonAfterMs: number = ABANDONED_RESPONSE_MS,
): Response {
  if (!res.body) {
    release()
    return res
  }
  const reader = res.body.getReader()
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    if (watchdog !== undefined) clearTimeout(watchdog)
    watchdog = undefined
    release()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          ctrl.close()
          settle()
          return
        }
        ctrl.enqueue(value)
      } catch (err) {
        settle()
        ctrl.error(err)
      }
    },
    async cancel(reason) {
      settle()
      await reader.cancel(reason)
    },
  })
  watchdog = setTimeout(() => {
    watchdog = undefined
    if (body.locked) return
    settle()
    void reader.cancel(new ProviderError.ResponseStreamError("response abandoned unread — provider permit reclaimed"))
  }, abandonAfterMs)
  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

// Ceiling on waiting for a provider permit. Queuing behind a long generation
// is the cap working as intended, so this is generous — but a wait this long
// means something upstream is wedged, and a visible error beats composing
// forever.
export const ACQUIRE_TIMEOUT_MS = 600_000

/**
 * Told when this request had to queue, and when it finally started. Used to put
 * a live "waiting for a provider slot" line on a queued sub-agent's drawer row
 * (session/provider-queue.ts); both calls are best-effort UI signals, never
 * part of the request's result.
 */
export type QueueNotice = {
  readonly onWait: (ahead: number) => void
  readonly onStart: () => void
}

export type LimitOptions = {
  /**
   * Jump the queue ahead of every ordinary waiter. Set for a PARENT step: with
   * a fan-out of N children against a cap of N, an ordinary parent would wait
   * behind every child that queued while it was running its tools, and a
   * continuous fan-out would never let it back in. With priority its wait is
   * bounded by the longest generation already in flight, which is the cap doing
   * its job rather than starvation.
   */
  readonly priority?: boolean
  readonly notice?: QueueNotice
  readonly acquireTimeoutMs?: number
}

type FetchLike = (input: any, init?: any) => Promise<Response>

/**
 * Gate `inner` on this provider's permit. `max` undefined or <= 0 = unlimited,
 * and the wrapper is then the identity function.
 *
 * The permit is acquired as late as possible — the caller composes timeouts and
 * abort signals BEFORE calling the returned function, so a queued request must
 * not be burning a header timeout while it waits.
 */
export function limitFetch(
  providerID: ProviderV2.ID | string,
  max: number | undefined,
  inner: FetchLike,
  opts: LimitOptions = {},
): FetchLike {
  if (max === undefined || max <= 0) return inner
  const timeout = opts.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS
  const priority = opts.priority === true
  return async (input: any, init?: any) => {
    const sem = providerSemaphore(providerID, max)
    // Read the queue depth BEFORE awaiting: nothing may run between the look and
    // the acquire, or the count reported to the user is of a different queue.
    const queued = sem.free <= 0
    if (queued) opts.notice?.onWait(sem.waitingAhead(priority))
    const granted = await sem.acquireWithin(timeout, priority)
    if (!granted) throw new ProviderError.ConcurrencyTimeoutError(providerID as ProviderV2.ID, max, timeout)
    // Only a GRANTED wait says so (t-fijeld): the drawer line is append-only, so
    // "provider slot granted" after a timeout would stand as the last word on a
    // request that was refused.
    if (queued) opts.notice?.onStart()

    let released = false
    const release = () => {
      if (released) return
      released = true
      sem.release()
    }
    // A permit must not outlive its request: if the caller aborts (turn cancel,
    // chunk/header timeout), free the slot even when the runtime never reads or
    // cancels the response body. Effect's fetch client puts the signal on a
    // Request object, the AI SDK puts it in `init` — take whichever is there.
    const signal: AbortSignal | undefined =
      init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined)
    if (signal) signal.addEventListener("abort", release, { once: true })

    try {
      return releaseOnBodyEnd(await inner(input, init), release)
    } catch (err) {
      release()
      throw err
    }
  }
}

export * as ProviderConcurrency from "./concurrency"

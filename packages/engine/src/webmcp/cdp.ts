/**
 * MINIMAL CHROME DEVTOOLS PROTOCOL CLIENT.
 *
 * WebMCP puts the tool registry on the PAGE, in the page's own JavaScript, so
 * the only way an out-of-process agent can read it is to speak to the browser
 * that is running the page. CDP is that channel and it is already in every
 * Chromium build — no driver, no automation dependency, one websocket.
 *
 * DELIBERATELY NOT A LIBRARY. Puppeteer/playwright/chrome-remote-interface all
 * solve this, and all three cost tens of megabytes in a bundle whose weight is
 * a stated product constraint. What is actually needed is three commands
 * (`Page.enable`, `Page.navigate`, `Runtime.evaluate`) over a socket that
 * correlates replies by id, so that is what this is.
 *
 * Promise-based, not Effect: the socket is a callback API with its own error
 * channel, and the wrapping belongs in ONE place (bridge.ts) rather than in
 * every send. `WebSocket` is a global in both runtimes the engine ships to
 * (Bun, and Node 22+), same as src/plugin/openai/ws.ts already relies on.
 */

const DEFAULT_TIMEOUT = 15_000

/** One page/tab as `/json/list` reports it. */
export type CdpTarget = {
  readonly id: string
  readonly type: string
  readonly url: string
  readonly title: string
  readonly webSocketDebuggerUrl: string
}

export class CdpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CdpError"
  }
}

/** GET a DevTools HTTP endpoint. 127.0.0.1 only — never a hostname, because
 *  `localhost` can resolve to ::1 while the browser listens on IPv4. */
async function httpJson(port: number, route: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new CdpError(`DevTools ${route} returned ${response.status}`)
  return response.json()
}

/** True once the browser answers on the debugging port. */
export async function isDebuggerUp(port: number, timeoutMs = 1_000): Promise<boolean> {
  try {
    await httpJson(port, "/json/version", timeoutMs)
    return true
  } catch {
    return false
  }
}

/** Every attachable page target, newest listing order the browser gives. */
export async function listPages(port: number, timeoutMs = DEFAULT_TIMEOUT): Promise<CdpTarget[]> {
  const data = await httpJson(port, "/json/list", timeoutMs)
  if (!Array.isArray(data)) return []
  return data.filter(
    (item): item is CdpTarget =>
      typeof item === "object" &&
      item !== null &&
      (item as CdpTarget).type === "page" &&
      typeof (item as CdpTarget).id === "string" &&
      typeof (item as CdpTarget).webSocketDebuggerUrl === "string",
  )
}

/** Open a new tab on `url` and return its target. */
export async function newPage(port: number, url: string, timeoutMs = DEFAULT_TIMEOUT): Promise<CdpTarget> {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new CdpError(`DevTools /json/new returned ${response.status}`)
  return (await response.json()) as CdpTarget
}

type Pending = {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** One attached page. */
export class CdpSession {
  #socket: WebSocket
  #pending = new Map<number, Pending>()
  #listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  #next = 1
  #timeout: number
  #closed: Error | undefined

  private constructor(socket: WebSocket, timeout: number) {
    this.#socket = socket
    this.#timeout = timeout
    socket.addEventListener("message", (event) => this.#receive(String(event.data)))
    socket.addEventListener("close", () => this.#fail(new CdpError("DevTools socket closed")))
    socket.addEventListener("error", () => this.#fail(new CdpError("DevTools socket error")))
  }

  static open(wsUrl: string, timeout = DEFAULT_TIMEOUT): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl)
      const timer = setTimeout(() => {
        socket.close()
        reject(new CdpError(`Timed out connecting to ${wsUrl}`))
      }, timeout)
      socket.addEventListener("open", () => {
        clearTimeout(timer)
        resolve(new CdpSession(socket, timeout))
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new CdpError(`Could not connect to ${wsUrl}`))
      })
    })
  }

  /** Send one command and resolve with its `result`. Correlated by `id`, which
   *  is why several evaluates can be in flight without crossing wires. */
  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(this.#closed)
    const id = this.#next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError(`${method} timed out after ${this.#timeout}ms`))
      }, this.#timeout)
      this.#pending.set(id, { resolve, reject, timer })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Resolve on the next occurrence of a CDP event. Undefined on timeout rather
   *  than a rejection: a load event that never lands is a slow page, not a
   *  broken session, and the caller can still evaluate against it. */
  once(event: string, timeoutMs = this.#timeout): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#listeners.get(event)?.delete(handler)
        resolve(undefined)
      }, timeoutMs)
      const handler = (params: Record<string, unknown>) => {
        clearTimeout(timer)
        this.#listeners.get(event)?.delete(handler)
        resolve(params)
      }
      const set = this.#listeners.get(event) ?? new Set()
      set.add(handler)
      this.#listeners.set(event, set)
    })
  }

  /**
   * Run an expression in the page and return its value.
   *
   * NO `contextId` IS PASSED, AND THAT IS THE WHOLE POINT. Blink keeps a
   * separate `ModelContext` registry per JavaScript world and per frame; an
   * isolated world (what an extension or a `contextId` from an unfiltered
   * execution-context list would give) sees an EMPTY registry and reports zero
   * tools with no error. Omitting the id targets the top frame's default
   * context, which is the main world — where the page registered its tools.
   *
   * `awaitPromise` because `getTools()` may return a promise; `returnByValue`
   * because a RemoteObject handle would need a second round trip per property.
   */
  async evaluate<T>(expression: string, timeoutMs = this.#timeout): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: timeoutMs,
    })
    const details = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
    if (details) throw new CdpError(details.exception?.description ?? details.text ?? "Page evaluation threw")
    return (result.result as { value?: T } | undefined)?.value as T
  }

  close(): void {
    this.#fail(new CdpError("DevTools session closed"))
    try {
      this.#socket.close()
    } catch {}
  }

  #receive(text: string): void {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown> }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new CdpError(message.error.message ?? "DevTools command failed"))
      else pending.resolve(message.result ?? {})
      return
    }
    if (!message.method) return
    const listeners = this.#listeners.get(message.method)
    if (!listeners) return
    // Snapshot before dispatch: a `once` handler removes itself as it runs, and
    // mutating the set mid-iteration would skip the next listener on it.
    for (const handler of Array.from(listeners)) handler(message.params ?? {})
  }

  /** Reject everything still in flight. Called once; later closes are no-ops so
   *  a socket error followed by a close cannot double-reject a caller. */
  #fail(error: Error): void {
    if (this.#closed) return
    this.#closed = error
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    this.#listeners.clear()
  }
}

export * as Cdp from "./cdp"

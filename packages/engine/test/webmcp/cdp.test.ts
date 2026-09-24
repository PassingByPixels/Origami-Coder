import { afterAll, describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { CdpError, CdpSession, isDebuggerUp, listPages, newPage } from "../../src/webmcp/cdp"

/**
 * The CDP client, against an IN-PROCESS FAKE BROWSER.
 *
 * No real Chromium: what is under test is the transport — that replies are
 * matched to the command that asked for them, that a silent browser becomes a
 * timeout rather than a hang, and that an evaluate carries the flags discovery
 * depends on. All three are things a real browser would hide (it answers fast,
 * in order, and would make a wrong `contextId` look like an empty page).
 */

/** Every command the fake browser received, for assertion. */
const seen: { method: string; params: Record<string, unknown> }[] = []

/** Filled in once the server is listening. The url builder is referenced from
 *  inside the fetch handler, so it cannot close over `server` itself. */
let listenPort = 0
const wsUrl = (id: string): string => `ws://127.0.0.1:${listenPort}/devtools/page/${id}`

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request: Request, server: { upgrade: (request: Request) => boolean }): Response | undefined {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/devtools/page/")) return server.upgrade(request) ? undefined : new Response("no", { status: 400 })
    if (url.pathname === "/json/version") return Response.json({ Browser: "FakeChrome/1" })
    if (url.pathname === "/json/list")
      return Response.json([
        { id: "P1", type: "page", url: "https://a.example/", title: "A", webSocketDebuggerUrl: wsUrl("P1") },
        // Filtered out: only pages can be attached to and evaluated in.
        { id: "W1", type: "service_worker", url: "https://a.example/sw.js", title: "", webSocketDebuggerUrl: wsUrl("W1") },
        // Filtered out: no socket to attach to.
        { id: "P2", type: "page", url: "https://b.example/", title: "B" },
      ])
    if (url.pathname === "/json/new")
      return Response.json({ id: "P9", type: "page", url: decodeURIComponent(url.search.slice(1)), title: "", webSocketDebuggerUrl: wsUrl("P9") })
    return new Response("nope", { status: 404 })
  },
  websocket: {
    message(socket: ServerWebSocket<unknown>, raw) {
      const message = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> }
      seen.push({ method: message.method, params: message.params })
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }))

      // Deliberately never answered, so the timeout path is reachable.
      if (message.method === "Never.reply") return

      if (message.method === "Fail.now") {
        socket.send(JSON.stringify({ id: message.id, error: { message: "the browser said no" } }))
        return
      }

      if (message.method === "Emit.event") {
        socket.send(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 42 } }))
        reply({})
        return
      }

      if (message.method === "Runtime.evaluate") {
        const expression = String(message.params.expression)
        if (expression === "throw") {
          reply({ exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } } })
          return
        }
        reply({ result: { type: "object", value: { echoed: expression } } })
        return
      }

      // Slow on purpose: replied LAST though it was sent FIRST, so a client that
      // matched replies by arrival order would hand this answer to the wrong
      // caller.
      if (message.method === "Slow.one") {
        setTimeout(() => reply({ which: "slow" }), 120)
        return
      }
      reply({ which: message.method })
    },
  },
})

const port: number = server.port ?? 0
listenPort = port

afterAll(() => server.stop(true))

/**
 * The rejection of `promise`, or undefined if it resolved.
 *
 * WHY NOT `expect(promise).rejects`: measured in this runner, awaiting a
 * promise through `.rejects` starves the websocket read while timers keep
 * firing, so a promise that is settled BY AN INCOMING FRAME never settles from
 * the frame — it settles from its own timeout, and the assertion then compares
 * the wrong error. Verified side by side: try/catch settles the same send in
 * 2ms, `.rejects` in 15006ms (the command timeout). The transport is fine; the
 * assertion style was not. `.rejects` is still used where the rejection comes
 * from a timer or from a synchronous close, which is unaffected.
 */
async function rejection(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error as Error
  }
}

describe("the DevTools HTTP endpoints", () => {
  test("reports the port as up, and a dead port as down", async () => {
    expect(await isDebuggerUp(port)).toBe(true)
    // A port nothing listens on. Refused, not hung, so the launch wait can poll.
    expect(await isDebuggerUp(1, 300)).toBe(false)
  })

  test("lists only attachable pages", async () => {
    const pages = await listPages(port)
    // The worker is not a page; the socket-less page cannot be attached to.
    expect(pages.map((page) => page.id)).toEqual(["P1"])
  })

  test("opens a new tab on the requested url", async () => {
    const page = await newPage(port, "https://c.example/x?y=1")
    expect(page.id).toBe("P9")
    expect(page.url).toBe("https://c.example/x?y=1")
  })
})

describe("CdpSession", () => {
  test("matches each reply to the command that asked for it", async () => {
    const session = await CdpSession.open(wsUrl("P1"))
    // Sent first, answered last. Both promises must resolve with their OWN
    // result — this is the whole reason messages carry an id.
    const slow = session.send("Slow.one")
    const fast = session.send("Fast.one")
    expect(await fast).toEqual({ which: "Fast.one" })
    expect(await slow).toEqual({ which: "slow" })
    session.close()
  })

  test("times out a command the browser never answers", async () => {
    const session = await CdpSession.open(wsUrl("P1"), 250)
    await expect(session.send("Never.reply")).rejects.toThrow(/timed out after 250ms/)
    session.close()
  })

  test("surfaces a protocol error as an error, not a silent empty result", async () => {
    const session = await CdpSession.open(wsUrl("P1"))
    // A CDP `error` reply carries no `result`; a client that only looked for
    // one would resolve with undefined and the caller would read "no tools"
    // where the browser actually said no.
    expect((await rejection(session.send("Fail.now")))?.message).toBe("the browser said no")
    session.close()
  })

  test("rejects everything in flight when the socket closes", async () => {
    const session = await CdpSession.open(wsUrl("P1"), 5_000)
    const pending = session.send("Never.reply")
    session.close()
    // Without this a closed browser would leave the caller hanging until the
    // command timeout, which for a call is a minute.
    await expect(pending).rejects.toThrow(/closed/)
  })

  test("delivers an event to `once`, and gives up quietly when none comes", async () => {
    const session = await CdpSession.open(wsUrl("P1"))
    const load = session.once("Page.loadEventFired")
    await session.send("Emit.event")
    expect(await load).toEqual({ timestamp: 42 })
    // A load event that never lands is a slow page, not a broken session, so it
    // resolves undefined rather than failing the launch.
    expect(await session.once("Page.loadEventFired", 100)).toBeUndefined()
    session.close()
  })
})

describe("evaluate", () => {
  test("targets the MAIN WORLD by sending no contextId", async () => {
    seen.length = 0
    const session = await CdpSession.open(wsUrl("P1"))
    await session.evaluate("1 + 1")
    const call = seen.find((entry) => entry.method === "Runtime.evaluate")!

    // THE LOAD-BEARING ASSERTION. Blink keeps a ModelContext registry per
    // JavaScript world; an isolated world has its own EMPTY one and reports
    // zero tools with no error. Omitting contextId targets the top frame's
    // default context — the main world, where the page registered its tools.
    expect("contextId" in call.params).toBe(false)
    expect("uniqueContextId" in call.params).toBe(false)
    // getTools() may return a promise, and a RemoteObject handle would cost a
    // round trip per property.
    expect(call.params.awaitPromise).toBe(true)
    expect(call.params.returnByValue).toBe(true)
    session.close()
  })

  test("returns the page's value", async () => {
    const session = await CdpSession.open(wsUrl("P1"))
    expect(await session.evaluate<{ echoed: string }>("hello")).toEqual({ echoed: "hello" })
    session.close()
  })

  test("throws what the page threw", async () => {
    const session = await CdpSession.open(wsUrl("P1"))
    // An exception inside the page comes back as a normal CDP result with
    // exceptionDetails set; a client that ignored it would report `undefined`
    // as the answer.
    expect((await rejection(session.evaluate("throw")))?.message).toBe("TypeError: boom")
    session.close()
  })

  test("cannot connect to a port nothing listens on", async () => {
    await expect(CdpSession.open("ws://127.0.0.1:1/devtools/page/X", 500)).rejects.toBeInstanceOf(CdpError)
  })
})

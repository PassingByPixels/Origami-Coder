import { afterAll, describe, expect, spyOn, test } from "bun:test"
import net from "node:net"
import yargs from "yargs"
import { DEFAULT_MAX_CONNECTIONS, startRelay, type RelayHandle } from "../../src/relay/server"
import { RelayCommand } from "../../src/cli/cmd/relay"
import { Peer, connect, makeRid } from "./harness"

const running: RelayHandle[] = []

afterAll(async () => {
  await Promise.all(running.map((relay) => relay.stop()))
})

async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const handle = await startRelay({ port: 0, hostname: "127.0.0.1", ...options })
  running.push(handle)
  return { handle, base: `127.0.0.1:${handle.port}`, url: `http://127.0.0.1:${handle.port}` }
}

/**
 * A plain GET on /r/<rid> carries no upgrade headers, so the server answers
 * 426 when the request is ALLOWED through and 503 when the cap refuses it.
 * The 426 path creates no websocket, so a probe must not move the counter.
 */
async function probe(url: string): Promise<number> {
  const response = await fetch(`${url}/r/${makeRid()}?role=desktop`)
  return response.status
}

async function waitForStatus(url: string, want: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() < deadline) {
    last = await probe(url)
    if (last === want) return last
    await Bun.sleep(20)
  }
  return last
}

/** Raw handshake, so the test can drop the TCP connection with no close frame. */
function rawUpgrade(port: number, rid: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64")
      socket.write(
        `GET /r/${rid}?role=desktop HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      )
    })
    const timer = setTimeout(() => reject(new Error("timed out waiting for 101")), 5000)
    socket.once("data", (chunk) => {
      clearTimeout(timer)
      if (chunk.toString("latin1").includes("101")) resolve(socket)
      else reject(new Error(`no 101: ${chunk.toString("latin1").slice(0, 40)}`))
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe("relay.maxConnections", () => {
  test("the cap defaults to 2000 and the CLI exposes it", async () => {
    expect(DEFAULT_MAX_CONNECTIONS).toBe(2000)
    const parsed = await (RelayCommand.builder as (y: unknown) => { parse: (a: string[]) => unknown })(
      yargs([]),
    ).parse([])
    expect((parsed as Record<string, unknown>)["max-connections"]).toBe(2000)
  })

  test("at the cap a new connection is refused with 503 and exactly one log line", async () => {
    const { base, url } = await relay({ maxConnections: 2 })
    const first = await connect(base, makeRid(), "desktop")
    const second = await connect(base, makeRid(), "desktop")

    const logs: string[] = []
    const spy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.join(" "))
    })
    try {
      const refused = await fetch(`${url}/r/${makeRid()}?role=desktop`)
      expect(refused.status).toBe(503)
      expect(await refused.text()).toContain("too many connections")
      expect(logs.filter((line) => line.includes("max-connections"))).toHaveLength(1)
      expect(logs).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }

    // A real websocket client sees the refusal as a failed handshake, never as
    // a socket that opens and is then closed.
    const stranger = new Peer(`ws://${base}/r/${makeRid()}?role=phone`)
    let opened = true
    await stranger.opened.catch(() => {
      opened = false
    })
    expect(opened).toBe(false)

    first.close()
    second.close()
  })

  test("a closed connection frees its slot", async () => {
    const { base, url } = await relay({ maxConnections: 2 })
    const first = await connect(base, makeRid(), "desktop")
    const second = await connect(base, makeRid(), "desktop")
    expect(await probe(url)).toBe(503)

    second.close()
    expect(await waitForStatus(url, 426)).toBe(426)

    const third = await connect(base, makeRid(), "desktop")
    expect(await probe(url)).toBe(503)

    first.close()
    third.close()
  })

  test("a refused connection never gives a slot back", async () => {
    const { base, url } = await relay({ maxConnections: 1 })
    const only = await connect(base, makeRid(), "desktop")

    // Five refusals. A counter that decremented on a refusal would now sit at
    // -4 and admit five more sockets.
    for (let i = 0; i < 5; i++) expect(await probe(url)).toBe(503)

    only.close()
    expect(await waitForStatus(url, 426)).toBe(426)

    const next = await connect(base, makeRid(), "desktop")
    expect(await probe(url)).toBe(503)
    next.close()
  })

  test("a request that is allowed through but never upgrades leaves the count alone", async () => {
    const { base, url } = await relay({ maxConnections: 2 })
    const first = await connect(base, makeRid(), "desktop")
    // Each probe is a 426: allowed by the cap, but no websocket is created.
    for (let i = 0; i < 5; i++) expect(await probe(url)).toBe(426)

    const second = await connect(base, makeRid(), "desktop")
    expect(await probe(url)).toBe(503)

    first.close()
    second.close()
  })

  test("a socket killed at the TCP level frees its slot", async () => {
    const { base, handle, url } = await relay({ maxConnections: 1 })
    const raw = await rawUpgrade(handle.port, makeRid())
    expect(await probe(url)).toBe(503)

    raw.destroy()
    expect(await waitForStatus(url, 426)).toBe(426)

    const after = await connect(base, makeRid(), "desktop")
    expect(await probe(url)).toBe(503)
    after.close()
  })

  test("below the cap the per-rid replacement rule still owns the outcome", async () => {
    const { base } = await relay({ maxConnections: 3 })
    const rid = makeRid()
    const first = await connect(base, rid, "desktop")
    const phone = await connect(base, rid, "phone")

    // Two live sockets, cap 3: the replacement is admitted and the per-rid rule
    // closes the socket it replaces with its own code, not with a 503.
    const second = await connect(base, rid, "desktop")
    expect((await first.closed()).code).toBe(4001)

    second.close()
    phone.close()
  })

  test("the cap is unconditional: at the cap even a known rid is refused", async () => {
    const { base, url } = await relay({ maxConnections: 2 })
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")
    const phone = await connect(base, rid, "phone")

    const refused = await fetch(`${url}/r/${rid}?role=desktop`)
    expect(refused.status).toBe(503)

    desktop.close()
    phone.close()
  })

  test("a cap that is not a positive integer is refused at startup", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(startRelay({ port: 0, hostname: "127.0.0.1", maxConnections: bad })).rejects.toThrow(
        /max-connections/,
      )
    }
  })
})

import { afterAll, describe, expect, test } from "bun:test"
import os from "node:os"
import yargs from "yargs"
import { MAX_FRAME_BYTES } from "../../src/relay/limits"
import { startRelay, type RelayHandle, type RelayMetrics } from "../../src/relay/server"
import { RelayCommand } from "../../src/cli/cmd/relay"
import { Peer, connect, frame, makeRid } from "./harness"

const running: RelayHandle[] = []

afterAll(async () => {
  await Promise.all(running.map((relay) => relay.stop()))
})

async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const handle = await startRelay({ port: 0, hostname: "127.0.0.1", metricsPort: 0, ...options })
  running.push(handle)
  return { handle, base: `127.0.0.1:${handle.port}`, url: `http://127.0.0.1:${handle.port}` }
}

async function metricsText(handle: RelayHandle): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${handle.metricsPort}/metrics`)
  expect(response.status).toBe(200)
  return await response.text()
}

async function read(handle: RelayHandle): Promise<RelayMetrics> {
  return JSON.parse(await metricsText(handle)) as RelayMetrics
}

/**
 * Counters that only move on a socket close are read AFTER the peer has seen
 * the close, so there is no race between the assertion and the close handler.
 */
async function closedWith(peer: Peer, code: number) {
  expect((await peer.closed()).code).toBe(code)
}

describe("relay.metrics", () => {
  test("off unless asked for: no listener, and /metrics on the relay port is not a thing", async () => {
    const handle = await startRelay({ port: 0, hostname: "127.0.0.1" })
    running.push(handle)
    expect(handle.metricsPort).toBeUndefined()

    // The relay port must not have grown a metrics path. /metrics is not a rid,
    // so it falls through to the same 404 any other stray path gets.
    const onRelayPort = await fetch(`http://127.0.0.1:${handle.port}/metrics`)
    expect(onRelayPort.status).toBe(404)
    expect(await onRelayPort.text()).not.toContain("live_sockets")
  })

  test("the CLI leaves it off by default", async () => {
    const parsed = await (
      RelayCommand.builder as (y: unknown) => { parse: (a: string[]) => unknown }
    )(yargs([])).parse([])
    expect((parsed as Record<string, unknown>)["metrics-port"]).toBeUndefined()
  })

  test("the metrics listener answers only /metrics", async () => {
    const { handle } = await relay()
    for (const path of ["/", "/healthz", "/metrics/", "/r/anything"]) {
      const response = await fetch(`http://127.0.0.1:${handle.metricsPort}${path}`)
      expect(response.status).toBe(404)
    }
  })

  test("gauges follow real sockets and pairings, and peaks keep the high-water mark", async () => {
    const { handle, base } = await relay()
    expect((await read(handle)).live_sockets).toBe(0)

    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")
    const phone = await connect(base, rid, "phone")
    const second = await connect(base, makeRid(), "desktop")

    const busy = await read(handle)
    expect(busy.live_sockets).toBe(3)
    expect(busy.rendezvous).toBe(2)
    expect(busy.totals.sockets_opened).toBe(3)
    expect(busy.peak_live_sockets).toBe(3)
    expect(busy.peak_rendezvous).toBe(2)

    desktop.close()
    phone.close()
    second.close()
    // The rendezvous is dropped when its last socket goes, so the gauge falls
    // back to zero while the peak stays where it was.
    await Bun.sleep(100)
    const idle = await read(handle)
    expect(idle.live_sockets).toBe(0)
    expect(idle.rendezvous).toBe(0)
    expect(idle.peak_live_sockets).toBe(3)
    expect(idle.peak_rendezvous).toBe(2)
  })

  test("relayed frames and bytes count only what actually reached a peer", async () => {
    const { handle, base } = await relay()
    const rid = makeRid()

    // No peer yet: the frame is ringed, never sent, and must not be billed as
    // relayed traffic — the same distinction the daily budget makes.
    const desktop = await connect(base, rid, "desktop")
    desktop.send(frame(1, 1, 100))
    await Bun.sleep(50)
    const alone = await read(handle)
    expect(alone.totals.frames_relayed).toBe(0)
    expect(alone.totals.bytes_relayed).toBe(0)
    expect(alone.totals.frames_no_peer).toBe(1)

    const phone = await connect(base, rid, "phone")
    desktop.send(frame(1, 2, 100))
    await phone.nextFrame()
    const paired = await read(handle)
    expect(paired.totals.frames_relayed).toBe(1)
    expect(paired.totals.bytes_relayed).toBe(118)
    expect(paired.totals.frames_no_peer).toBe(1)

    desktop.close()
    phone.close()
  })

  test("a frame over the cap is counted as a 4002 close", async () => {
    const { handle, base } = await relay()
    const peer = await connect(base, makeRid(), "desktop")
    peer.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    await closedWith(peer, 4002)

    const seen = await read(handle)
    expect(seen.closes.too_large_4002).toBe(1)
    expect(seen.totals.frames_relayed).toBe(0)
  })

  test("a text frame is counted as a 4004 close", async () => {
    const { handle, base } = await relay()
    const peer = await connect(base, makeRid(), "desktop")
    peer.send("not binary")
    await closedWith(peer, 4004)

    expect((await read(handle)).closes.text_frame_4004).toBe(1)
  })

  test("a replaced socket is counted as a 4001 close", async () => {
    const { handle, base } = await relay()
    const rid = makeRid()
    const first = await connect(base, rid, "desktop")
    const second = await connect(base, rid, "desktop")
    await closedWith(first, 4001)

    expect((await read(handle)).closes.replaced_4001).toBe(1)
    second.close()
  })

  test("the rate limiter's close is counted as 4003", async () => {
    const { handle, base } = await relay()
    const peer = await connect(base, makeRid(), "desktop")

    // The bucket holds 2 MiB and refills as we go, so the exact frame that
    // trips it is not fixed. Push until the relay closes the socket.
    let closed = false
    const watch = peer.closed(10_000).then(() => {
      closed = true
    })
    for (let i = 0; i < 64 && !closed; i++) {
      try {
        peer.send(new Uint8Array(MAX_FRAME_BYTES))
      } catch {
        break
      }
      await Bun.sleep(1)
    }
    await watch
    await closedWith(peer, 4003)

    expect((await read(handle)).closes.rate_limit_4003).toBe(1)
  })

  test("refusals are counted apart from closes", async () => {
    const { handle, base, url } = await relay({ maxConnections: 1 })
    const only = await connect(base, makeRid(), "desktop")

    const refused = await fetch(`${url}/r/${makeRid()}?role=desktop`)
    expect(refused.status).toBe(503)

    const seen = await read(handle)
    expect(seen.refused.max_connections_503).toBe(1)
    expect(seen.refused.budget_503).toBe(0)
    expect(seen.max_connections).toBe(1)
    // A refusal is not a close: nothing opened, so no close code was ever sent.
    expect(seen.closes.replaced_4001).toBe(0)

    only.close()
  })

  test("a request that never upgrades is counted as a 426", async () => {
    const { handle, url } = await relay()
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${url}/r/${makeRid()}?role=desktop`)).status).toBe(426)
    }
    const seen = await read(handle)
    expect(seen.refused.not_upgraded_426).toBe(3)
    expect(seen.totals.sockets_opened).toBe(0)
  })

  test("the budget reports what it is spending, and null when there is none", async () => {
    const unlimited = await relay()
    expect((await read(unlimited.handle)).budget.limit_bytes).toBeNull()
    expect((await read(unlimited.handle)).budget.exhausted).toBe(false)

    const capped = await relay({ dailyBudgetMb: 4 })
    const rid = makeRid()
    const desktop = await connect(capped.base, rid, "desktop")
    const phone = await connect(capped.base, rid, "phone")
    desktop.send(frame(1, 1, 982))
    await phone.nextFrame()

    const seen = await read(capped.handle)
    expect(seen.budget.limit_bytes).toBe(4 * 1024 * 1024)
    expect(seen.budget.used_bytes).toBe(1000)
    expect(seen.budget.exhausted).toBe(false)

    desktop.close()
    phone.close()
  })

  /**
   * THE BLINDNESS TEST. The whole point of the relay is that it cannot say who
   * is talking to it, and a metrics surface is the obvious place for that to
   * leak — one debugging convenience ("which rids are live?") would undo it.
   * A rid is high-entropy base64url, so its presence anywhere in the body is
   * proof of a leak, and its absence is proof there is none.
   */
  test("no rid, and no frame byte, ever appears in the body", async () => {
    const { handle, base } = await relay()
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")
    const phone = await connect(base, rid, "phone")

    const payload = "PAYLOAD-MARKER-SHOULD-NEVER-BE-LOGGED"
    const bytes = new Uint8Array(18 + payload.length)
    bytes[0] = 1
    bytes[1] = 1
    new DataView(bytes.buffer).setUint32(2, 1, false)
    bytes.set(new TextEncoder().encode(payload), 18)
    desktop.send(bytes)
    await phone.nextFrame()

    const body = await metricsText(handle)
    expect(body).not.toContain(rid)
    expect(body).not.toContain(payload)
    // The counters did move, so the assertions above are not passing on an
    // empty body that never saw the traffic.
    expect(JSON.parse(body).totals.frames_relayed).toBe(1)

    desktop.close()
    phone.close()
  })

  /**
   * --hostname moves the RELAY; a self-hoster may legitimately bind it to every
   * interface and put their own terminator in front. The metrics listener must
   * not follow it out onto the public internet.
   */
  test("the metrics listener stays on loopback even when the relay binds every interface", async () => {
    const handle = await startRelay({ port: 0, hostname: "0.0.0.0", metricsPort: 0 })
    running.push(handle)

    expect((await read(handle)).live_sockets).toBe(0)

    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((nic) => nic && nic.family === "IPv4" && !nic.internal)
    if (!external) return

    let reachable = true
    try {
      await fetch(`http://${external.address}:${handle.metricsPort}/metrics`, {
        signal: AbortSignal.timeout(2000),
      })
    } catch {
      reachable = false
    }
    expect(reachable).toBe(false)
  })

  test("a metrics port that is not a port, or collides with the relay, is refused at startup", async () => {
    for (const bad of [-1, 1.5, 70_000, Number.NaN]) {
      await expect(
        startRelay({ port: 0, hostname: "127.0.0.1", metricsPort: bad }),
      ).rejects.toThrow(/metrics-port/)
    }
    await expect(
      startRelay({ port: 8787, hostname: "127.0.0.1", metricsPort: 8787 }),
    ).rejects.toThrow(/must differ/)
  })

  test("stop() takes the metrics listener down with the relay", async () => {
    const handle = await startRelay({ port: 0, hostname: "127.0.0.1", metricsPort: 0 })
    const port = handle.metricsPort
    expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(200)

    await handle.stop()

    let reachable = true
    try {
      await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(2000) })
    } catch {
      reachable = false
    }
    expect(reachable).toBe(false)
  })
})

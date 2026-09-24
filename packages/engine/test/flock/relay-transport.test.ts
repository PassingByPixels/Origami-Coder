// THE RELAY TRANSPORT, WITHOUT A RELAY.
//
// Everything here is about the three things a byte pipe over a shared relay has
// to get right and a loopback never had to: which of the two relay slots each
// party takes, what `?after=` says at CONNECT time, and what happens to a frame
// written while the wire is down. The socket and the clock are injected, so a
// whole disconnect/backoff/resume cycle runs with no network and no waiting.
import { describe, expect, test } from "bun:test"
import { FlockRelayTransport } from "@/flock/relay-transport"

class FakeSocket implements FlockRelayTransport.RelaySocket {
  readonly sent: Uint8Array[] = []
  closedWith: { code?: number; reason?: string } | undefined
  binaryType = ""
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {}

  send(data: Uint8Array): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
  }

  /** The relay accepted us. */
  accept(): void {
    this.onopen?.()
  }

  /** A frame arrived from the other role. */
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  }

  /** The wire went away. */
  drop(code?: number, reason?: string): void {
    this.onclose?.({ code, reason })
  }
}

/** A scripted clock: timers are collected, never fired by time. */
function fakeClock() {
  const timers: Array<{ id: number; fn: () => void; ms: number }> = []
  let next = 1
  return {
    timers,
    setTimer(fn: () => void, ms: number) {
      const id = next++
      timers.push({ id, fn, ms })
      return id
    },
    clearTimer(handle: unknown) {
      const index = timers.findIndex((timer) => timer.id === handle)
      if (index >= 0) timers.splice(index, 1)
    },
    /** Fire the one armed timer. */
    tick() {
      const timer = timers.shift()
      if (!timer) throw new Error("no timer was armed")
      timer.fn()
      return timer.ms
    },
  }
}

function harness(options: { after?: () => number; backoff?: readonly number[] } = {}) {
  const sockets: FakeSocket[] = []
  const clock = fakeClock()
  const statuses: Array<{ rid: string; status: FlockRelayTransport.RelayStatus }> = []
  const transport = new FlockRelayTransport.RelayTransport({
    deps: {
      connect: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
    ...(options.backoff ? { backoff: options.backoff } : {}),
    onStatus: (rid, status) => statuses.push({ rid, status }),
  })
  const rid = "0123456789abcdefghijkl"
  transport.register(rid, {
    relayUrl: "ws://127.0.0.1:9/",
    role: "desktop",
    after: options.after ?? (() => 0),
  })
  return { transport, sockets, clock, statuses, rid }
}

const bytes = (...values: number[]) => new Uint8Array(values)

describe("which relay slot each party takes", () => {
  test("the smaller signing key is the desktop and the other is the phone", () => {
    expect(FlockRelayTransport.roleFor("aaa", "bbb")).toBe("desktop")
    expect(FlockRelayTransport.roleFor("bbb", "aaa")).toBe("phone")
  })

  test("both parties reach opposite answers from the same two keys", () => {
    // The whole point: neither side asks the other, and the relay has exactly
    // two slots. A rule that ever agreed with itself would put both parties in
    // one slot and each would evict the other for ever.
    const keys = [
      ["MCowBQYDK2VwAyEAaaaa", "MCowBQYDK2VwAyEAzzzz"],
      ["MCowBQYDK2VwAyEAzzzz", "MCowBQYDK2VwAyEAaaaa"],
      ["MCowBQYDK2VwAyEA0000", "MCowBQYDK2VwAyEA0001"],
      ["+/aZ", "aZ+/"],
    ] as const
    for (const [mine, theirs] of keys) {
      expect(FlockRelayTransport.roleFor(mine, theirs)).not.toBe(FlockRelayTransport.roleFor(theirs, mine))
    }
  })
})

describe("the URL the relay routes on", () => {
  test("is exactly the wire spec's /r/<rid>?role=&after=", () => {
    expect(FlockRelayTransport.socketUrl("wss://relay.example", "abc", "phone", 12)).toBe(
      "wss://relay.example/r/abc?role=phone&after=12",
    )
  })

  test("a trailing slash on the relay base does not double up", () => {
    expect(FlockRelayTransport.socketUrl("wss://relay.example//", "abc", "desktop", 0)).toBe(
      "wss://relay.example/r/abc?role=desktop&after=0",
    )
  })
})

describe("resuming with ?after=", () => {
  test("reads the counter at connect time, not at construction", () => {
    let recorded = 0
    const { transport, sockets, clock, rid } = harness({ after: () => recorded })
    transport.listen(rid, () => {})
    expect(sockets[0]!.url).toContain("after=0")

    // Frames were accepted while the socket was up, so the persisted counter
    // moved. The reconnect has to ask for what comes AFTER those.
    recorded = 7
    sockets[0]!.accept()
    sockets[0]!.drop(1006, "network")
    clock.tick()
    expect(sockets[1]!.url).toContain("after=7")
  })
})

describe("a frame written while the wire is down", () => {
  test("is queued and flushed in order when the socket opens", async () => {
    const { transport, sockets, rid } = harness()
    await transport.send(rid, bytes(1, 2, 3))
    await transport.send(rid, bytes(4, 5, 6))
    expect(sockets[0]!.sent).toHaveLength(0)

    sockets[0]!.accept()
    expect(sockets[0]!.sent.map((frame) => [...frame])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])
  })

  test("is refused outright when the friendship has no route at all", async () => {
    const { transport } = harness()
    await expect(transport.send("unregistered-rid-1234", bytes(1))).rejects.toThrow(/no relay route/)
  })
})

describe("reconnecting", () => {
  test("backs off along the schedule and resets after a successful open", () => {
    const { transport, sockets, clock, rid } = harness({ backoff: [10, 20, 30] })
    transport.listen(rid, () => {})
    sockets[0]!.drop(1006)
    expect(clock.tick()).toBe(10)
    sockets[1]!.drop(1006)
    expect(clock.tick()).toBe(20)

    sockets[2]!.accept()
    sockets[2]!.drop(1006)
    expect(clock.tick()).toBe(10)
  })

  test("stops for good on 4001 — the other engine claimed this friendship", () => {
    const { transport, sockets, clock, rid } = harness()
    transport.listen(rid, () => {})
    sockets[0]!.accept()
    sockets[0]!.drop(FlockRelayTransport.CLOSE_SUPERSEDED, "replaced")

    expect(clock.timers).toHaveLength(0)
    expect(transport.status(rid)).toBe("stopped")
  })
})

describe("delivery", () => {
  test("a handler that throws does not stop the next frame", async () => {
    const { transport, sockets, rid } = harness()
    const seen: number[] = []
    transport.listen(rid, (frame) => {
      if (frame[0] === 1) throw new Error("handler blew up")
      seen.push(frame[0]!)
    })
    sockets[0]!.accept()
    sockets[0]!.deliver(bytes(1))
    sockets[0]!.deliver(bytes(2))
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([2])
  })

  test("stop() closes the socket and cancels the pending retry", () => {
    const { transport, sockets, clock, rid } = harness()
    transport.listen(rid, () => {})
    sockets[0]!.drop(1006)
    expect(clock.timers).toHaveLength(1)
    transport.stop()
    expect(clock.timers).toHaveLength(0)
    // "stopped", not "idle": a log that said idle here would be saying the same
    // word it uses for a friendship nobody has ever dialled.
    expect(transport.status(rid)).toBe("stopped")
  })
})

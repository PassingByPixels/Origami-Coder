// THE BULK LANE (?lane=bulk): cloud sessions pulling a compact journal, not an
// interactive pairing. Its own rid namespace (never collides with a live rid
// of the same string), no ring (?after= is ignored), a separate token bucket
// sized by --bulk-rid-mb-per-minute, still capped at MAX_FRAME_BYTES per
// frame, still charged to the shared DailyBudget — and, on that budget, the
// priority rule the owner asked for: cloud sessions win. A NEW live rid is
// refused once the day is 90% spent; a NEW bulk rid keeps going until 100%.
import { afterAll, describe, expect, test } from "bun:test"
import { MAX_FRAME_BYTES } from "../../src/relay/limits"
import { startRelay, type RelayHandle, type RelayMetrics } from "../../src/relay/server"
import { Peer, connect, frame, makeRid } from "./harness"

const running: RelayHandle[] = []

afterAll(async () => {
  await Promise.all(running.map((relay) => relay.stop()))
})

async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const handle = await startRelay({ port: 0, hostname: "127.0.0.1", ...options })
  running.push(handle)
  return { handle, base: `127.0.0.1:${handle.port}`, url: `http://127.0.0.1:${handle.port}` }
}

async function read(handle: RelayHandle): Promise<RelayMetrics> {
  const response = await fetch(`http://127.0.0.1:${handle.metricsPort}/metrics`)
  return (await response.json()) as RelayMetrics
}

/** A frame of exactly `bytes` long, carrying `seq` in the header. */
function sized(bytes: number, seq: number): Uint8Array {
  const payload = new Uint8Array(bytes)
  payload[0] = 1
  payload[1] = 1
  new DataView(payload.buffer).setUint32(2, seq, false)
  return payload
}

describe("relay.bulk.namespace", () => {
  test("a bulk rid never reaches, or is reached by, a live rid of the same string", async () => {
    const { base } = await relay()
    const rid = makeRid()

    const liveDesktop = await connect(base, rid, "desktop")
    const liveWatcher = await connect(base, rid, "phone")
    const bulkDesktop = await connect(base, rid, "desktop", undefined, "bulk")
    const bulkWatcher = await connect(base, rid, "phone", undefined, "bulk")

    liveDesktop.send(frame(1, 1))
    expect(Array.from(await liveWatcher.nextFrame())).toEqual(Array.from(frame(1, 1)))
    expect(await bulkWatcher.silentFor(250)).toBe(true)

    bulkDesktop.send(frame(1, 2))
    expect(Array.from(await bulkWatcher.nextFrame())).toEqual(Array.from(frame(1, 2)))
    expect(await liveWatcher.silentFor(250)).toBe(true)

    liveDesktop.close()
    liveWatcher.close()
    bulkDesktop.close()
    bulkWatcher.close()
  })

  test("a bulk pairing still evicts a same-role bulk socket with 4001, independent of the live lane", async () => {
    const { base } = await relay()
    const rid = makeRid()

    const liveDesktop = await connect(base, rid, "desktop")
    const firstBulk = await connect(base, rid, "desktop", undefined, "bulk")
    const secondBulk = await connect(base, rid, "desktop", undefined, "bulk")

    expect((await firstBulk.closed()).code).toBe(4001)
    // The live socket for the same rid+role was never touched: the eviction
    // is scoped to the bulk map, so this socket stays open, not merely quiet.
    expect(liveDesktop.ws.readyState).toBe(WebSocket.OPEN)

    liveDesktop.close()
    secondBulk.close()
  })
})

describe("relay.bulk.no-ring", () => {
  test("?after= is ignored: a bulk socket that joins late replays nothing", async () => {
    const { base } = await relay()
    const rid = makeRid()

    const desktop = await connect(base, rid, "desktop", undefined, "bulk")
    desktop.send(frame(1, 1))
    desktop.send(frame(1, 2))
    await Bun.sleep(100)

    // Joins with after=0, which on the live lane would replay both frames.
    const phone = await connect(base, rid, "phone", 0, "bulk")
    expect(await phone.silentFor(250)).toBe(true)

    // The lane still forwards live traffic once both sides are attached.
    desktop.send(frame(1, 3))
    expect(Array.from(await phone.nextFrame())).toEqual(Array.from(frame(1, 3)))

    desktop.close()
    phone.close()
  })
})

describe("relay.bulk.bucket", () => {
  test("MAX_FRAME_BYTES still applies: an oversized bulk frame closes 4002", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop", undefined, "bulk")

    desktop.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    expect((await desktop.closed()).code).toBe(4002)
  })

  test("the bulk bucket is sized from --bulk-rid-mb-per-minute, independent of the live 2 MiB/min limiter", async () => {
    // 128 KiB capacity = exactly two 64 KiB frames; a charge that would take
    // the rolling total to capacity or more is refused (same ">=" rule as
    // the live limiter), so the SECOND frame trips 4003 here. The live
    // lane's fixed 2 MiB bucket needs 32 frames for the same close, so
    // tripping this early proves a separate, smaller bucket is wired in.
    const { base } = await relay({ bulkRidMbPerMinute: 128 / 1024 })
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop", undefined, "bulk")

    desktop.send(sized(MAX_FRAME_BYTES, 1))
    desktop.send(sized(MAX_FRAME_BYTES, 2))
    expect((await desktop.closed()).code).toBe(4003)
  })

  test("a live rid's traffic never draws down a bulk rid's bucket, even for the same rid string", async () => {
    const { base } = await relay({ bulkRidMbPerMinute: 128 / 1024 })
    const rid = makeRid()
    const liveDesktop = await connect(base, rid, "desktop")
    const livePhone = await connect(base, rid, "phone")

    // Well past the bulk lane's tiny 128 KiB bucket, on the LIVE rid.
    for (let seq = 1; seq <= 10; seq++) {
      liveDesktop.send(sized(MAX_FRAME_BYTES, seq))
      await livePhone.nextFrame()
    }

    // The bulk rid of the same string still has its full bucket.
    const bulkDesktop = await connect(base, rid, "desktop", undefined, "bulk")
    const bulkPhone = await connect(base, rid, "phone", undefined, "bulk")
    bulkDesktop.send(sized(MAX_FRAME_BYTES, 1))
    expect((await bulkPhone.nextFrame()).byteLength).toBe(MAX_FRAME_BYTES)

    liveDesktop.close()
    livePhone.close()
    bulkDesktop.close()
    bulkPhone.close()
  })
})

describe("relay.bulk.budget", () => {
  test("a relayed bulk frame is charged to the daily budget, same as a live one", async () => {
    const { base, url } = await relay({ dailyBudgetMb: 0.05 })
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop", undefined, "bulk")
    const phone = await connect(base, rid, "phone", undefined, "bulk")

    desktop.send(sized(MAX_FRAME_BYTES, 1))
    await phone.nextFrame()

    // 65,536 bytes charged against a 52,428-byte (0.05 MB) day: exhausted.
    const refused = await fetch(`${url}/r/${makeRid()}?role=desktop&lane=bulk`)
    expect(refused.status).toBe(503)

    desktop.close()
    phone.close()
  })

  test("a bulk frame with no peer to relay to does not spend the daily budget", async () => {
    const { base, url } = await relay({ dailyBudgetMb: 0.05 })
    const rid = makeRid()
    const lonely = await connect(base, rid, "desktop", undefined, "bulk")

    for (let seq = 1; seq <= 6; seq++) lonely.send(sized(MAX_FRAME_BYTES, seq))
    await Bun.sleep(100)

    expect((await fetch(`${url}/r/${makeRid()}?role=desktop&lane=bulk`)).status).toBe(426)

    lonely.close()
  })
})

describe("relay.bulk.priority", () => {
  test("sessions win: a NEW live rid is refused at 90% spent while a NEW bulk rid still gets in, until 100%", async () => {
    // limitBytes = 1,048,576. 15 x 64 KiB = 983,040 (~93.75%): past 90%,
    // short of 100%.
    const { base, url } = await relay({ dailyBudgetMb: 1 })
    const liveRid = makeRid()
    const liveDesktop = await connect(base, liveRid, "desktop")
    const livePhone = await connect(base, liveRid, "phone")

    for (let seq = 1; seq <= 15; seq++) {
      liveDesktop.send(sized(MAX_FRAME_BYTES, seq))
      await livePhone.nextFrame()
    }

    // A NEW live rid is refused: the last 10% is reserved for bulk.
    const refusedLive = await fetch(`${url}/r/${makeRid()}?role=desktop`)
    expect(refusedLive.status).toBe(503)

    // The EXISTING live pairing keeps working — the near-exhaustion rule
    // only refuses NEW rids, exactly like the 100% rule already does.
    liveDesktop.send(sized(1000, 16))
    expect((await livePhone.nextFrame()).byteLength).toBe(1000)

    // A NEW bulk rid is still accepted below 100%.
    const bulkRid = makeRid()
    const bulkDesktop = await connect(base, bulkRid, "desktop", undefined, "bulk")
    const bulkPhone = await connect(base, bulkRid, "phone", undefined, "bulk")
    bulkDesktop.send(sized(1000, 1))
    expect((await bulkPhone.nextFrame()).byteLength).toBe(1000)

    // Push the day past 100% (via the bulk pairing, which is already open).
    for (let seq = 2; seq <= 3; seq++) {
      bulkDesktop.send(sized(MAX_FRAME_BYTES, seq))
      await bulkPhone.nextFrame()
    }

    // Now even a NEW bulk rid is refused.
    const refusedBulk = await fetch(`${url}/r/${makeRid()}?role=desktop&lane=bulk`)
    expect(refusedBulk.status).toBe(503)
    // ...and live is still refused too.
    expect((await fetch(`${url}/r/${makeRid()}?role=desktop`)).status).toBe(503)

    liveDesktop.close()
    livePhone.close()
    bulkDesktop.close()
    bulkPhone.close()
  })
})

describe("relay.bulk.metrics", () => {
  test("/metrics reports bulk_frames, bulk_bytes and bulk_rids_open separately from the live totals", async () => {
    const { handle, base } = await relay({ metricsPort: 0 })
    const rid = makeRid()

    const before = await read(handle)
    expect(before.bulk_frames).toBe(0)
    expect(before.bulk_bytes).toBe(0)
    expect(before.bulk_rids_open).toBe(0)

    const desktop = await connect(base, rid, "desktop", undefined, "bulk")
    const phone = await connect(base, rid, "phone", undefined, "bulk")
    const opened = await read(handle)
    expect(opened.bulk_rids_open).toBe(1)

    desktop.send(frame(1, 1, 200))
    await phone.nextFrame()

    const after = await read(handle)
    expect(after.bulk_frames).toBe(1)
    expect(after.bulk_bytes).toBe(218) // 18-byte header + 200-byte payload
    // The live totals are untouched by bulk traffic.
    expect(after.totals.frames_relayed).toBe(0)
    expect(after.totals.bytes_relayed).toBe(0)

    desktop.close()
    phone.close()
    await Bun.sleep(100)
    expect((await read(handle)).bulk_rids_open).toBe(0)
  })
})

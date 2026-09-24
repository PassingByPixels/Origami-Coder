import { describe, expect, test } from "bun:test"
import { FrameRing, RING_MAX_AGE_MS, RING_MAX_FRAMES, frameSeq } from "../../src/relay/ring"
import { frame } from "./harness"

function fakeClock(start = 1_000_000) {
  let now = start
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

describe("relay.ring", () => {
  test("reads seq from bytes 2..5 as uint32 big-endian", () => {
    expect(frameSeq(frame(1, 1))).toBe(1)
    expect(frameSeq(frame(2, 0x0102_0304))).toBe(0x0102_0304)
    expect(frameSeq(frame(1, 0xffff_ffff))).toBe(0xffff_ffff)
    // A runt frame carries no header; it stays forwardable but always replays.
    expect(frameSeq(new Uint8Array([1, 1]))).toBe(0)
  })

  test("since() returns only the named role's frames above the after seq", () => {
    const ring = new FrameRing()
    ring.push("desktop", frame(1, 1))
    ring.push("desktop", frame(1, 2))
    ring.push("phone", frame(2, 1))
    ring.push("desktop", frame(1, 3))

    expect(ring.since("desktop", 0).map((entry) => entry.seq)).toEqual([1, 2, 3])
    expect(ring.since("desktop", 1).map((entry) => entry.seq)).toEqual([2, 3])
    expect(ring.since("desktop", 3)).toEqual([])
    expect(ring.since("phone", 0).map((entry) => entry.seq)).toEqual([1])
  })

  test("evicts by count: the 257th frame drops the first", () => {
    const ring = new FrameRing()
    for (let seq = 1; seq <= RING_MAX_FRAMES; seq++) ring.push("desktop", frame(1, seq))

    expect(ring.size).toBe(RING_MAX_FRAMES)
    expect(ring.since("desktop", 0)[0].seq).toBe(1)

    ring.push("desktop", frame(1, RING_MAX_FRAMES + 1))

    expect(ring.size).toBe(RING_MAX_FRAMES)
    const kept = ring.since("desktop", 0).map((entry) => entry.seq)
    expect(kept[0]).toBe(2)
    expect(kept.at(-1)).toBe(RING_MAX_FRAMES + 1)
    expect(kept).not.toContain(1)
  })

  test("evicts by age: frames older than the window are gone even under the count cap", () => {
    const clock = fakeClock()
    const ring = new FrameRing({ now: clock.now })

    ring.push("desktop", frame(1, 1))
    clock.advance(RING_MAX_AGE_MS - 1)
    ring.push("desktop", frame(1, 2))

    expect(ring.since("desktop", 0).map((entry) => entry.seq)).toEqual([1, 2])

    // One more millisecond puts frame 1 exactly on the 10-minute boundary.
    clock.advance(1)
    expect(ring.since("desktop", 0).map((entry) => entry.seq)).toEqual([2])
    expect(ring.size).toBe(1)

    clock.advance(RING_MAX_AGE_MS)
    expect(ring.since("desktop", 0)).toEqual([])
    expect(ring.size).toBe(0)
  })

  test("a configurable window: frames inside it replay, past it they do not", () => {
    const clock = fakeClock()
    const ring = new FrameRing({ maxAgeMs: 1_000, now: clock.now })

    ring.push("desktop", frame(1, 1))
    ring.push("desktop", frame(1, 2))

    // Half the window has passed: a phone asking for desktop frames with
    // after=0 still gets both.
    clock.advance(500)
    expect(ring.since("desktop", 0).map((entry) => entry.seq)).toEqual([1, 2])

    // The window has now been open 2 seconds total against a 1-second cap:
    // a phone connecting now with after=0 gets nothing.
    clock.advance(1_500)
    expect(ring.since("desktop", 0)).toEqual([])
  })

  test("maxAgeMs 0 disables the ring entirely: a frame is gone the instant it is read back", () => {
    const ring = new FrameRing({ maxAgeMs: 0 })
    ring.push("desktop", frame(1, 1))

    expect(ring.since("desktop", 0)).toEqual([])
    expect(ring.size).toBe(0)
  })
})

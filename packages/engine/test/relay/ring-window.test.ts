import { afterAll, describe, expect, test } from "bun:test"
import yargs from "yargs"
import { RelayCommand } from "../../src/cli/cmd/relay"
import { RING_MAX_AGE_MS } from "../../src/relay/ring"
import { startRelay, type RelayHandle } from "../../src/relay/server"
import { connect, frame, makeRid } from "./harness"

const running: RelayHandle[] = []

afterAll(async () => {
  await Promise.all(running.map((relay) => relay.stop()))
})

async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  const handle = await startRelay({ port: 0, hostname: "127.0.0.1", metricsPort: 0, ...options })
  running.push(handle)
  return { handle, base: `127.0.0.1:${handle.port}` }
}

async function metrics(handle: RelayHandle): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${handle.metricsPort}/metrics`)
  return (await response.json()) as Record<string, unknown>
}

describe("relay.ring-window", () => {
  test("the CLI default is 90 seconds, matching the ring's own default", async () => {
    const parsed = await (
      RelayCommand.builder as (y: unknown) => { parse: (a: string[]) => unknown }
    )(yargs([])).parse([])
    expect((parsed as Record<string, unknown>)["ring-seconds"]).toBe(90)
    expect(RING_MAX_AGE_MS).toBe(90_000)
  })

  test("metrics report the configured window in seconds, nothing per-rid", async () => {
    const { handle } = await relay({ ringMaxAgeMs: 42_000 })
    expect((await metrics(handle)).ring_seconds).toBe(42)
  })

  test("a non-negative integer is required", async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(
        startRelay({ port: 0, hostname: "127.0.0.1", ringMaxAgeMs: bad }),
      ).rejects.toThrow(/ring-seconds/)
    }
  })

  test(
    "decisive case: a 1s ring window replays a reconnecting phone's due frames and drops the rest, on a real socket",
    async () => {
      const { base } = await relay({ ringMaxAgeMs: 1_000 })
      const rid = makeRid()
      const desktop = await connect(base, rid, "desktop")
      desktop.send(frame(1, 1))
      desktop.send(frame(1, 2))

      // 500ms in: still inside the 1s window, a fresh phone with after=0 gets
      // both frames the desktop already sent.
      await Bun.sleep(500)
      const early = await connect(base, rid, "phone", 0)
      expect(await early.nextFrame(2_000)).toBeInstanceOf(Uint8Array)
      expect(await early.nextFrame(2_000)).toBeInstanceOf(Uint8Array)
      early.close()

      // A further 1.5s puts the desktop's frames 2s in the past against a 1s
      // window: a phone connecting now with after=0 gets nothing at all.
      await Bun.sleep(1_500)
      const late = await connect(base, rid, "phone", 0)
      expect(await late.silentFor(500)).toBe(true)

      late.close()
      desktop.close()
    },
    10_000,
  )

  test("ringMaxAgeMs 0 replays nothing, even to a socket that connects moments later", async () => {
    const { base } = await relay({ ringMaxAgeMs: 0 })
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")
    desktop.send(frame(1, 1))
    await Bun.sleep(20)

    const phone = await connect(base, rid, "phone", 0)
    expect(await phone.silentFor(200)).toBe(true)

    phone.close()
    desktop.close()
  })
})

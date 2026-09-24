import { afterAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PEER_ABSENT, PEER_PRESENT, resolveAppFile, startRelay, type RelayHandle } from "../../src/relay/server"
import { MAX_FRAME_BYTES } from "../../src/relay/limits"
import { RING_MAX_FRAMES } from "../../src/relay/ring"
import { Peer, connect, frame, makeRid } from "./harness"

const running: RelayHandle[] = []
const tempDirs: string[] = []

afterAll(async () => {
  await Promise.all(running.map((relay) => relay.stop()))
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function relay(options: Parameters<typeof startRelay>[0] = {}) {
  // Port 0 = ephemeral, bound to loopback only.
  const handle = await startRelay({ port: 0, hostname: "127.0.0.1", ...options })
  running.push(handle)
  return { handle, base: `127.0.0.1:${handle.port}`, url: `http://127.0.0.1:${handle.port}` }
}

async function appFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-relay-app-"))
  tempDirs.push(dir)
  const app = path.join(dir, "app")
  await fs.mkdir(app)
  await fs.writeFile(path.join(app, "index.html"), "<!doctype html><title>shell</title>")
  await fs.writeFile(path.join(app, "shell.js"), "export const shell = 1")
  await fs.writeFile(path.join(app, "shell.webmanifest"), JSON.stringify({ name: "shell" }))
  await fs.writeFile(path.join(dir, "secret.txt"), "do not serve me")
  return { root: dir, app }
}

function seqOf(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(2)
}

function sized(bytes: number, seq: number): Uint8Array {
  const payload = new Uint8Array(bytes)
  payload[0] = 1
  payload[1] = 1
  new DataView(payload.buffer).setUint32(2, seq, false)
  return payload
}

describe("relay.pairing", () => {
  test("forwards frames both ways between the two roles", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")
    const phone = await connect(base, rid, "phone")

    desktop.send(frame(1, 1))
    expect(Array.from(await phone.nextFrame())).toEqual(Array.from(frame(1, 1)))

    phone.send(frame(2, 1))
    expect(Array.from(await desktop.nextFrame())).toEqual(Array.from(frame(2, 1)))

    desktop.close()
    phone.close()
  })

  test("a rid pairs only its own sockets", async () => {
    const { base } = await relay()
    const ridA = makeRid()
    const ridB = makeRid()
    const desktopA = await connect(base, ridA, "desktop")
    const phoneA = await connect(base, ridA, "phone")
    const phoneB = await connect(base, ridB, "phone")

    desktopA.send(frame(1, 1))
    await phoneA.nextFrame()
    expect(await phoneB.silentFor(250)).toBe(true)

    desktopA.close()
    phoneA.close()
    phoneB.close()
  })

  test("a second socket for the same role replaces the first, which closes 4001", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const first = await connect(base, rid, "desktop")
    const phone = await connect(base, rid, "phone")

    const second = await connect(base, rid, "desktop")
    expect((await first.closed()).code).toBe(4001)

    // The replacement owns the pairing: its frames still reach the phone...
    second.send(frame(1, 7))
    expect(Array.from(await phone.nextFrame())).toEqual(Array.from(frame(1, 7)))
    // ...and the phone's frames go to the replacement, not the closed socket.
    phone.send(frame(2, 3))
    expect(Array.from(await second.nextFrame())).toEqual(Array.from(frame(2, 3)))
    expect(await first.silentFor(250)).toBe(true)

    second.close()
    phone.close()
  })
})

describe("relay.replay", () => {
  test("a joining role replays the other role's frames above ?after=", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")

    desktop.send(frame(1, 1))
    desktop.send(frame(1, 2))
    desktop.send(frame(1, 3))
    // The desktop's frames must be in the ring before the phone joins.
    await Bun.sleep(100)

    const phone = await connect(base, rid, "phone", 1)
    expect(seqOf(await phone.nextFrame())).toBe(2)
    expect(seqOf(await phone.nextFrame())).toBe(3)
    expect(await phone.silentFor(250)).toBe(true)

    desktop.close()
    phone.close()
  })

  test("replay never echoes a role its own frames", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const phone = await connect(base, rid, "phone")
    phone.send(frame(2, 1))
    phone.send(frame(2, 2))
    await Bun.sleep(100)

    const rejoined = await connect(base, rid, "phone", 0)
    expect(await rejoined.silentFor(300)).toBe(true)
    rejoined.close()
  })

  test("replacing a role while the peer is away keeps the ring", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const first = await connect(base, rid, "desktop")
    first.send(frame(1, 1))
    first.send(frame(1, 2))
    await Bun.sleep(100)

    // No phone is attached, so the replaced socket is the rendezvous' last one.
    const second = await connect(base, rid, "desktop")
    expect((await first.closed()).code).toBe(4001)
    second.send(frame(1, 3))
    await Bun.sleep(100)

    const phone = await connect(base, rid, "phone", 0)
    expect(seqOf(await phone.nextFrame())).toBe(1)
    expect(seqOf(await phone.nextFrame())).toBe(2)
    expect(seqOf(await phone.nextFrame())).toBe(3)

    second.close()
    phone.close()
  })

  test("an ?after= value that is not a decimal uint32 replays everything", async () => {
    const { base } = await relay()
    for (const after of ["abc", "-1", "1e3", "99999999999", ""]) {
      const rid = makeRid()
      const desktop = await connect(base, rid, "desktop")
      desktop.send(frame(1, 1))
      await Bun.sleep(80)

      const phone = new Peer(`ws://${base}/r/${rid}?role=phone&after=${after}`)
      await phone.opened
      expect(seqOf(await phone.nextFrame())).toBe(1)

      desktop.close()
      phone.close()
    }
  }, 20000)

  test("the ring caps at 256 frames, so the oldest is no longer replayed", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")

    for (let seq = 1; seq <= RING_MAX_FRAMES + 1; seq++) desktop.send(frame(1, seq))
    await Bun.sleep(300)

    const phone = await connect(base, rid, "phone", 0)
    const seqs: number[] = []
    for (let i = 0; i < RING_MAX_FRAMES; i++) seqs.push(seqOf(await phone.nextFrame()))
    expect(seqs.length).toBe(RING_MAX_FRAMES)
    expect(seqs[0]).toBe(2)
    expect(seqs.at(-1)).toBe(RING_MAX_FRAMES + 1)
    expect(seqs).not.toContain(1)
    expect(await phone.silentFor(250)).toBe(true)

    desktop.close()
    phone.close()
  })
})

describe("relay.caps", () => {
  test("a frame over 65,536 bytes closes 4002", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")

    desktop.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    expect((await desktop.closed()).code).toBe(4002)
  })

  test("a frame of exactly 65,536 bytes is allowed", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")
    const phone = await connect(base, rid, "phone")

    desktop.send(sized(MAX_FRAME_BYTES, 9))
    const forwarded = await phone.nextFrame()
    expect(forwarded.byteLength).toBe(MAX_FRAME_BYTES)
    expect(seqOf(forwarded)).toBe(9)

    desktop.close()
    phone.close()
  })

  test("passing 2 MiB in a minute closes 4003", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")

    // 40 x 64 KiB is 2.5 MiB; the close must land before all of them are accepted.
    for (let seq = 1; seq <= 40; seq++) desktop.send(sized(MAX_FRAME_BYTES, seq))
    expect((await desktop.closed()).code).toBe(4003)
  })

  test("a text frame closes 4004", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")

    desktop.send("hello")
    expect((await desktop.closed()).code).toBe(4004)
  })

  test("the daily budget refuses new rids with 503 while an existing rid keeps forwarding", async () => {
    // 0.05 MB = 52,428 bytes, so one 64 KiB frame exhausts the day.
    const { base, url } = await relay({ dailyBudgetMb: 0.05 })
    const rid = makeRid()
    const desktop = await connect(base, rid, "desktop")
    const phone = await connect(base, rid, "phone")

    desktop.send(sized(MAX_FRAME_BYTES, 1))
    await phone.nextFrame()

    const refused = await fetch(`${url}/r/${makeRid()}?role=desktop`)
    expect(refused.status).toBe(503)

    const stranger = new Peer(`ws://${base}/r/${makeRid()}?role=phone`)
    let strangerOpened = true
    await stranger.opened.catch(() => {
      strangerOpened = false
    })
    expect(strangerOpened).toBe(false)

    // The already-paired rid is unaffected.
    desktop.send(frame(1, 2))
    expect(Array.from(await phone.nextFrame())).toEqual(Array.from(frame(1, 2)))

    desktop.close()
    phone.close()
  })

  // THE OUTAGE THIS TEST EXISTS FOR.
  //
  // A desktop keeps its relay socket open for as long as the pairing lives, and
  // it posts the dashboard's whole fan-out down it — every streamed token,
  // padded to 1,058 bytes — whether or not the phone page is open. Those frames
  // have no peer: the relay drops them. Charging them anyway spent the hosted
  // relay's 2 GiB day in an afternoon of ordinary use, and the branch above then
  // refused every NEW rid — which is exactly what a Revoke mints. The owner
  // pressed Pair, scanned, and watched the phone cycle connecting/closed for
  // ever with nothing in any log to say why.
  test("frames with no peer to relay to do not spend the daily budget", async () => {
    const { base, url } = await relay({ dailyBudgetMb: 0.05 })
    const rid = makeRid()
    const lonely = await connect(base, rid, "desktop")

    // Six times the day's budget, into a room with no phone in it.
    for (let seq = 1; seq <= 6; seq++) lonely.send(sized(MAX_FRAME_BYTES, seq))
    await Bun.sleep(100)

    // A new pairing still gets in: 426 is "allowed through, but not a websocket".
    expect((await fetch(`${url}/r/${makeRid()}?role=desktop`)).status).toBe(426)

    // ...and the accounting is not merely switched off: one frame that IS
    // relayed still spends the day.
    const phone = await connect(base, rid, "phone")
    lonely.send(sized(MAX_FRAME_BYTES, 7))
    await phone.nextFrame()
    expect((await fetch(`${url}/r/${makeRid()}?role=desktop`)).status).toBe(503)

    lonely.close()
    phone.close()
  })

  test("a refused new rendezvous is logged, with no rid in the line", async () => {
    const logs: string[] = []
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "))
    })
    try {
      const { base, url } = await relay({ dailyBudgetMb: 0.05 })
      const rid = makeRid()
      const desktop = await connect(base, rid, "desktop")
      const phone = await connect(base, rid, "phone")
      desktop.send(sized(MAX_FRAME_BYTES, 1))
      await phone.nextFrame()

      const strangerRid = makeRid()
      expect((await fetch(`${url}/r/${strangerRid}?role=desktop`)).status).toBe(503)
      const refusals = logs.filter((line) => line.includes("traffic budget is spent"))
      expect(refusals).toHaveLength(1)
      expect(refusals[0]).not.toContain(strangerRid)

      desktop.close()
      phone.close()
    } finally {
      log.mockRestore()
    }
  })
})

describe("relay.http", () => {
  test("GET /healthz answers 200 ok", async () => {
    const { url } = await relay()
    const response = await fetch(`${url}/healthz`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })

  test("a rendezvous id that is not 22 base64url characters is 404", async () => {
    const { url } = await relay()
    for (const bad of ["short", "a".repeat(21), "a".repeat(23), "a".repeat(21) + "+", "a".repeat(21) + "/"]) {
      const response = await fetch(`${url}/r/${encodeURIComponent(bad)}?role=desktop`)
      expect(response.status).toBe(404)
    }
    expect((await fetch(`${url}/nope`)).status).toBe(404)
  })

  test("an unknown or missing role is a bad request", async () => {
    const { url } = await relay()
    expect((await fetch(`${url}/r/${makeRid()}?role=laptop`)).status).toBe(400)
    expect((await fetch(`${url}/r/${makeRid()}`)).status).toBe(400)
  })

  test("/app/* is 404 with no --app-dir", async () => {
    const { url } = await relay()
    expect((await fetch(`${url}/app/`)).status).toBe(404)
    expect((await fetch(`${url}/app/index.html`)).status).toBe(404)
  })

  test("/app serves the shell with the right content types", async () => {
    const fixture = await appFixture()
    const { url } = await relay({ appDir: fixture.app })

    const index = await fetch(`${url}/app/`)
    expect(index.status).toBe(200)
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(await index.text()).toContain("<title>shell</title>")

    expect((await fetch(`${url}/app`)).status).toBe(200)

    const js = await fetch(`${url}/app/shell.js`)
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    const manifest = await fetch(`${url}/app/shell.webmanifest`)
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json")

    expect((await fetch(`${url}/app/missing.js`)).status).toBe(404)
  })

  test("/app refuses traversal out of the app directory", async () => {
    const fixture = await appFixture()
    const { url } = await relay({ appDir: fixture.app })

    // Encoded separators survive URL normalisation, so these really reach the handler.
    for (const attempt of ["..%2fsecret.txt", "%2e%2e%2fsecret.txt", "sub%2f..%2f..%2fsecret.txt", "..%5csecret.txt"]) {
      const response = await fetch(`${url}/app/${attempt}`)
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain("do not serve me")
    }

    // Plain dot segments are collapsed before the request is even sent; the
    // secret must still never come back.
    const collapsed = await fetch(`${url}/app/../secret.txt`)
    expect(collapsed.status).toBe(404)
    expect(await collapsed.text()).not.toContain("do not serve me")

    // A malformed percent escape is a bad request, not a crash.
    expect((await fetch(`${url}/app/%zz`)).status).toBe(400)
  })

  test("resolveAppFile keeps every path inside the app directory", () => {
    const root = path.resolve(path.join(os.tmpdir(), "relay-app-root"))

    expect(resolveAppFile(root, "/app/")).toBe(path.join(root, "index.html"))
    expect(resolveAppFile(root, "/app")).toBe(path.join(root, "index.html"))
    expect(resolveAppFile(root, "/app/sub/deep.js")).toBe(path.join(root, "sub", "deep.js"))

    expect(resolveAppFile(root, "/app/..%2fsecret.txt")).toBeNull()
    expect(resolveAppFile(root, "/app/%2e%2e%2f%2e%2e%2fetc%2fpasswd")).toBeNull()
    expect(resolveAppFile(root, "/app/..%5csecret.txt")).toBeNull()
    expect(resolveAppFile(root, "/app/x%00.js")).toBeNull()
    // A sibling directory whose name merely starts with the root name is outside too.
    expect(resolveAppFile(root, "/app/..%2f" + path.basename(root) + "-evil%2fx.js")).toBeNull()
  })
})

// ---------------------------------------------------------------- presence --
//
// The relay's only control frames. They exist so a desktop with no phone
// attached stops posting the dashboard fan-out into a socket the relay can only
// drop. Everything asserted here is what keeps the relay BLIND: the token is
// the whole frame, it carries no rid, and it is sent only to the socket it is
// about.

describe("relay presence", () => {
  test("a lone desktop is told 'absent', and both are told 'present' when the phone arrives", async () => {
    const { base } = await relay()
    const rid = makeRid()

    const desktop = await connect(base, rid, "desktop")
    expect(await desktop.nextControl()).toBe(PEER_ABSENT)

    const phone = await connect(base, rid, "phone")
    // The newcomer learns the incumbent is there...
    expect(await phone.nextControl()).toBe(PEER_PRESENT)
    // ...and the incumbent learns about the newcomer.
    expect(await desktop.nextControl()).toBe(PEER_PRESENT)

    desktop.close()
    phone.close()
  })

  test("the survivor is told 'absent' the moment the other side goes", async () => {
    const { base } = await relay()
    const rid = makeRid()

    const desktop = await connect(base, rid, "desktop")
    const phone = await connect(base, rid, "phone")
    expect(await desktop.nextControl()).toBe(PEER_ABSENT)
    expect(await desktop.nextControl()).toBe(PEER_PRESENT)

    phone.close()
    expect(await desktop.nextControl()).toBe(PEER_ABSENT)

    desktop.close()
  })

  test("a REPLACED phone does not make the desktop think the phone left", async () => {
    // Rule 1 (one socket per role) evicts the incumbent with 4001. The
    // replacement is already in the slot, so the eviction must not be reported
    // as an absence — a desktop that paused there would go silent for a phone
    // that is attached.
    const { base } = await relay()
    const rid = makeRid()

    const desktop = await connect(base, rid, "desktop")
    const first = await connect(base, rid, "phone")
    expect(await desktop.nextControl()).toBe(PEER_ABSENT)
    expect(await desktop.nextControl()).toBe(PEER_PRESENT)
    expect(await first.nextControl()).toBe(PEER_PRESENT)

    const second = await connect(base, rid, "phone")
    expect((await first.closed()).code).toBe(4001)
    expect(await second.nextControl()).toBe(PEER_PRESENT)
    // The only thing the desktop hears about the swap is another "present".
    expect(await desktop.nextControl()).toBe(PEER_PRESENT)
    expect(desktop.seenControls).toEqual([])

    desktop.close()
    second.close()
  })

  test("a control frame carries no rid and no payload, and does not enter the ring", async () => {
    const { base } = await relay()
    const rid = makeRid()

    const desktop = await connect(base, rid, "desktop")
    const first = await desktop.nextControl()
    expect(first).toBe(PEER_ABSENT)
    expect(first).not.toContain(rid)
    expect(first.length).toBeLessThan(32)

    desktop.send(frame(1, 1))
    const phone = await connect(base, rid, "phone")
    // The ring replays the desktop's binary frame and nothing else: a presence
    // frame is never appended to it, so a reconnect cannot be told about a
    // presence that has since changed.
    expect(seqOf(await phone.nextFrame())).toBe(1)
    expect(await phone.silentFor(120)).toBe(true)

    desktop.close()
    phone.close()
  })

  test("presence does not change the 4004 rule for a client that sends text", async () => {
    const { base } = await relay()
    const rid = makeRid()
    const peer = await connect(base, rid, "desktop")

    peer.send(PEER_PRESENT)
    expect((await peer.closed()).code).toBe(4004)
  })
})

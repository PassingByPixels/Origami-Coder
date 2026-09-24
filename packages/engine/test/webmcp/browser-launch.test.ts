import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { ensureBrowser, findBrowser, forgetBrowser, freePort, waitForDebugger, type BrowserProbe } from "../../src/webmcp/browser-launch"

/**
 * Finding a browser, WITHOUT TOUCHING THIS MACHINE.
 *
 * Every candidate path is checked through the injected probe, so these tests
 * pass identically on a laptop with no Chromium and on a CI box with three —
 * and they never read the developer's real Program Files or PATH. That is the
 * point of the seam: the probe order is the thing worth pinning, and it cannot
 * be pinned by a test whose answer depends on what happens to be installed.
 */

const probeFor = (platform: string, present: string[], env: Record<string, string | undefined> = {}): BrowserProbe => ({
  platform,
  env,
  exists: (file) => present.includes(file),
  onPath: (command) => (present.includes(command) ? `/usr/bin/${command}` : undefined),
})

describe("findBrowser", () => {
  test("an explicit override wins outright, and is not second-guessed", () => {
    const probe = probeFor("win32", ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"], {
      ORIGAMI_WEBMCP_BROWSER: "D:\\custom\\brave.exe",
      PROGRAMFILES: "C:\\Program Files",
    })
    // NOT existence-checked on purpose: an override that is wrong must fail
    // loudly at spawn, not quietly fall back to a browser nobody named.
    expect(findBrowser(probe)).toBe("D:\\custom\\brave.exe")
  })

  test("ignores a blank override rather than trying to spawn an empty string", () => {
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    expect(findBrowser(probeFor("win32", [chrome], { ORIGAMI_WEBMCP_BROWSER: "   ", PROGRAMFILES: "C:\\Program Files" }))).toBe(chrome)
  })

  test("prefers Brave, then Chrome, then Edge", () => {
    const env = { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }
    const brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    const edge = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    expect(findBrowser(probeFor("win32", [brave, chrome, edge], env))).toBe(brave)
    expect(findBrowser(probeFor("win32", [chrome, edge], env))).toBe(chrome)
    expect(findBrowser(probeFor("win32", [edge], env))).toBe(edge)
  })

  test("finds a per-user install, and still prefers it over another browser in Program Files", () => {
    const env = { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }
    const braveLocal = "C:\\Users\\x\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
    const chromeGlobal = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    // The ORDER is the browser preference; the roots are only where the same
    // browser might happen to live. A user-installed Brave still beats Chrome.
    expect(findBrowser(probeFor("win32", [braveLocal, chromeGlobal], env))).toBe(braveLocal)
  })

  test("uses the app bundle paths on macOS", () => {
    const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    expect(findBrowser(probeFor("darwin", [brave]))).toBe(brave)
    expect(findBrowser(probeFor("darwin", ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]))).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    )
  })

  test("resolves a bare command on PATH on Linux", () => {
    // Linux ships browsers on PATH under several names, and the resolved
    // ABSOLUTE path is what gets spawned.
    expect(findBrowser(probeFor("linux", ["chromium"]))).toBe("/usr/bin/chromium")
    expect(findBrowser(probeFor("linux", ["brave-browser", "google-chrome"]))).toBe("/usr/bin/brave-browser")
  })

  test("returns undefined when nothing is installed", () => {
    // The caller turns this into a stated "discovery is unavailable, and why",
    // so it must be a value rather than a throw.
    expect(findBrowser(probeFor("win32", [], { PROGRAMFILES: "C:\\Program Files" }))).toBeUndefined()
    expect(findBrowser(probeFor("linux", []))).toBeUndefined()
  })
})

describe("waitForDebugger", () => {
  test("returns once the browser answers, without waiting out the timeout", async () => {
    let calls = 0
    const started = Date.now()
    // A browser takes a moment to open its port; the wait has to poll, not
    // give up on the first refused connection.
    const up = await waitForDebugger(1234, { timeoutMs: 5_000, probe: async () => ++calls >= 3 })
    expect(up).toBe(true)
    expect(calls).toBe(3)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  test("gives up and reports false when the port never opens", async () => {
    let calls = 0
    const up = await waitForDebugger(1234, {
      timeoutMs: 400,
      probe: async () => {
        calls++
        return false
      },
    })
    // False, not a throw: the launch turns it into a message naming the
    // executable that failed to open a port.
    expect(up).toBe(false)
    expect(calls).toBeGreaterThan(1)
  })
})

describe("freePort", () => {
  test("hands out a usable, distinct port", async () => {
    const first = await freePort()
    const second = await freePort()
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(0)
    // Nothing is listening on it yet, so it is genuinely free for the browser.
    expect(await waitForDebugger(first, { timeoutMs: 150 })).toBe(false)
  })
})

describe("ensureBrowser", () => {
  /** A scratch dir, never the engine's real data dir. */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "webmcp-launch-test-"))
  const record = path.join(scratch, "devtools-port.json")
  const profile = path.join(scratch, "profile")

  test("adopts a browser an EARLIER PROCESS left running, instead of spawning", async () => {
    // THE REGRESSION THIS EXISTS FOR, found by running the probe twice: Chromium
    // allows one process per user-data-dir, so a second engine process that
    // spawns its own browser gets nothing — the running one takes the command
    // line and exits, and the requested port never opens. The recorded port is
    // how the second process finds the browser that already exists.
    forgetBrowser(profile)
    fs.writeFileSync(record, JSON.stringify({ port: 51234, executable: "brave" }))
    const handle = await ensureBrowser({
      profile,
      portFilePath: record,
      // No spawn can happen: an unfound browser would throw before any launch.
      probe: probeFor("win32", []),
      isUp: async (port) => port === 51234,
    })
    expect(handle).toEqual({ port: 51234, executable: "brave", reused: true })
  })

  test("ignores a recorded port that no longer answers", async () => {
    forgetBrowser(profile)
    fs.writeFileSync(record, JSON.stringify({ port: 51234, executable: "brave" }))
    // The user closed the browser. Adopting a dead port would hang every later
    // call on a socket nothing is listening to, so it must fall through to a
    // launch — which here has no browser to launch and says so.
    await expect(
      ensureBrowser({ profile, portFilePath: record, probe: probeFor("win32", []), isUp: async () => false }),
    ).rejects.toThrow(/No Chromium-based browser was found/)
  })

  test("ignores an unreadable or nonsense record", async () => {
    forgetBrowser(profile)
    for (const junk of ["{not json", "{}", JSON.stringify({ port: "51234" }), JSON.stringify({ port: -1 })]) {
      fs.writeFileSync(record, junk)
      await expect(
        ensureBrowser({ profile, portFilePath: record, probe: probeFor("win32", []), isUp: async () => true }),
      ).rejects.toThrow(/No Chromium-based browser was found/)
    }
  })

  test("says nothing is installed rather than throwing something opaque", async () => {
    forgetBrowser(profile)
    fs.rmSync(record, { force: true })
    await expect(
      ensureBrowser({ profile, portFilePath: record, probe: probeFor("linux", []), isUp: async () => false }),
    ).rejects.toThrow(/ORIGAMI_WEBMCP_BROWSER/)
  })
})

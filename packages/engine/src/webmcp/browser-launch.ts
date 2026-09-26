import path from "path"
import fs from "fs"
import net from "net"
import { spawn } from "child_process"
import { Global } from "@origami/core/global"
import { isDebuggerUp } from "./cdp"
import { ElasticOs } from "@/elastic/os"

/**
 * FINDING AND STARTING A DEBUGGABLE CHROMIUM.
 *
 * WHY A DEDICATED PROFILE, AND WHY IT CANNOT BE THE USER'S BROWSER: Chromium
 * opens the DevTools port ONCE, at process start. A Brave that is already
 * running with the user's profile has no port and cannot be given one — passing
 * `--remote-debugging-port` to a second invocation just hands the URL to the
 * running instance and exits. So the choice is between "no discovery" and "a
 * second browser instance on its own profile", and this takes the second. The
 * cost is real and is stated to the model in the launch result: the page opens
 * signed out, with none of the user's extensions.
 *
 * The instance is REUSED across launches in one engine process (see the cache
 * below), so a session that opens three sites gets one window with three tabs,
 * not three browsers.
 */

/** Where the dedicated profile lives. Under the engine's data dir, so it is the
 *  same thing to clean up as any other engine cache. */
export function profileDir(): string {
  return path.join(Global.Path.data, "webmcp", "profile")
}

/**
 * Where the running instance's DevTools port is recorded.
 *
 * IN-MEMORY REUSE IS NOT ENOUGH, and this was found by running the probe twice
 * rather than by reasoning: Chromium allows ONE process per user-data-dir, so a
 * second engine process that spawns its own browser on this profile does not
 * get a second browser — the running one takes the command line, opens the URL
 * and the new process exits, leaving the requested port closed forever. The
 * recorded port is how a later process finds the browser that already exists.
 *
 * Chromium's own `DevToolsActivePort` file would be the obvious source and is
 * not written on this build, so the port is recorded here instead.
 */
export function portFile(): string {
  return path.join(Global.Path.data, "webmcp", "devtools-port.json")
}

type Recorded = { readonly port: number; readonly executable: string }

function readRecorded(file: string): Recorded | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    const { port, executable } = parsed as { port?: unknown; executable?: unknown }
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return undefined
    return { port, executable: typeof executable === "string" ? executable : "" }
  } catch {
    return undefined
  }
}

function writeRecorded(file: string, recorded: Recorded): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(recorded)}\n`, "utf8")
  } catch {
    // Best effort. A profile whose port cannot be recorded still works for this
    // process; only the NEXT process pays, and it pays with a clear error.
  }
}

/** Injection seam: everything about the host this module would otherwise read
 *  straight from the process. Tests supply a fake and never touch a real path. */
export type BrowserProbe = {
  readonly platform: string
  readonly env: Record<string, string | undefined>
  readonly exists: (file: string) => boolean
  /** Resolve a bare command on PATH. Linux only — win32/darwin use full paths. */
  readonly onPath?: (command: string) => string | undefined
}

export const defaultProbe: BrowserProbe = {
  platform: process.platform,
  env: process.env,
  exists: (file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  },
  onPath: (command) => {
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
    for (const dir of dirs) {
      const candidate = path.join(dir, command)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {}
    }
    return undefined
  },
}

/**
 * Candidate executables, in preference order: Brave, then Chrome, then Edge.
 *
 * Brave leads because it is the browser WebMCP was verified against on this
 * product's own site, and because Edge last — it is the one most likely to be
 * merely present rather than chosen.
 */
function candidates(probe: BrowserProbe): string[] {
  const env = probe.env
  if (probe.platform === "win32") {
    const roots = [
      env.PROGRAMFILES ?? "C:\\Program Files",
      env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
      env.LOCALAPPDATA ?? "",
    ].filter(Boolean)
    const relative = [
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
    ]
    // Browser-major, not root-major: a Brave in LocalAppData should still beat
    // a Chrome in Program Files, because the ORDER above is the preference and
    // the roots are only where the same browser might happen to live.
    return relative.flatMap((tail) => roots.map((root) => path.join(root, tail)))
  }
  if (probe.platform === "darwin")
    return [
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
  return ["brave-browser", "google-chrome", "chromium", "chromium-browser"]
}

/**
 * The browser to drive, or undefined if none is installed.
 *
 * `ORIGAMI_WEBMCP_BROWSER` wins outright and is NOT existence-checked against
 * the probe list — an explicit override that is wrong should fail loudly at
 * spawn, not fall back to a browser the user did not name.
 */
export function findBrowser(probe: BrowserProbe = defaultProbe): string | undefined {
  const override = probe.env.ORIGAMI_WEBMCP_BROWSER?.trim()
  if (override) return override
  const bare = probe.platform !== "win32" && probe.platform !== "darwin"
  for (const candidate of candidates(probe)) {
    if (bare) {
      const resolved = probe.onPath?.(candidate)
      if (resolved) return resolved
    } else if (probe.exists(candidate)) return candidate
  }
  return undefined
}

/** An ephemeral port the OS has just confirmed is free. Racy in principle —
 *  something could take it in the gap — but the browser claims it milliseconds
 *  later and a collision surfaces as a failed launch, not a silent wrong tab. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error("Could not reserve a port"))))
    })
  })
}

/** Poll `/json/version` until the browser answers. */
export async function waitForDebugger(
  port: number,
  options: { readonly timeoutMs?: number; readonly probe?: (port: number) => Promise<boolean> } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const up = options.probe ?? ((p: number) => isDebuggerUp(p))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await up(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return up(port)
}

export type BrowserHandle = {
  readonly port: number
  readonly executable: string
  /** True when an instance from an earlier launch in this process was reused. */
  readonly reused: boolean
}

/** The running instance, keyed by profile directory. In-memory only: a new
 *  engine process re-probes, and a browser the user closed fails `isDebuggerUp`
 *  and is relaunched rather than attached to. */
const running = new Map<string, { port: number; executable: string }>()

/** Drop the cached instance. Test seam, and the recovery path when a port dies. */
export function forgetBrowser(profile = profileDir()): void {
  running.delete(profile)
}

export class BrowserLaunchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrowserLaunchError"
  }
}

/**
 * Ensure a debuggable browser is up, and return how to reach it.
 *
 * Reuse first: if this process already started one and its port still answers,
 * that is the instance. A port that has stopped answering means the user closed
 * the window, so the cache entry is dropped and a fresh browser is started.
 */
export async function ensureBrowser(
  options: {
    readonly probe?: BrowserProbe
    readonly profile?: string
    readonly timeoutMs?: number
    readonly startUrl?: string
    /** Test seam for the port file and the liveness check. */
    readonly portFilePath?: string
    readonly isUp?: (port: number) => Promise<boolean>
  } = {},
): Promise<BrowserHandle> {
  const probe = options.probe ?? defaultProbe
  const profile = options.profile ?? profileDir()
  const record = options.portFilePath ?? portFile()
  const isUp = options.isUp ?? ((port: number) => isDebuggerUp(port))

  const cached = running.get(profile)
  if (cached) {
    if (await isUp(cached.port)) return { ...cached, reused: true }
    running.delete(profile)
  }

  // A browser this profile started in an EARLIER process. Adopted rather than
  // relaunched, because relaunching is not possible: see portFile().
  const recorded = readRecorded(record)
  if (recorded && (await isUp(recorded.port))) {
    const handle = { port: recorded.port, executable: recorded.executable || (findBrowser(probe) ?? "") }
    running.set(profile, handle)
    return { ...handle, reused: true }
  }

  const executable = findBrowser(probe)
  if (!executable)
    throw new BrowserLaunchError(
      "No Chromium-based browser was found. WebMCP discovery needs Brave, Chrome, Chromium or Edge;" +
        " set ORIGAMI_WEBMCP_BROWSER to the executable to point at one explicitly.",
    )

  const port = await freePort()
  const args = [
    `--remote-debugging-port=${port}`,
    "--enable-features=WebMCP",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(options.startUrl ? [options.startUrl] : ["about:blank"]),
  ]
  const child = spawn(executable, args, { detached: true, stdio: "ignore" })
  // Detached and unref'd on purpose: the browser has to outlive the tool call
  // that opened it, or the page would close before the model could call it.
  child.unref()
  // origami_change (t-w2qlop): still a child in the OS process tree, but a window
  // the owner may be using - the engine's elastic class and trim leave it alone.
  ElasticOs.excludeTree(child.pid)
  let spawnError: Error | undefined
  child.on("error", (error) => (spawnError = error))

  const up = await waitForDebugger(port, { timeoutMs: options.timeoutMs, probe: isUp })
  if (!up)
    throw new BrowserLaunchError(
      spawnError
        ? `Could not start ${executable}: ${spawnError.message}`
        : `${executable} did not open a DevTools port on ${port} in time.` +
          ` If a browser is already running on ${profile}, close it and retry —` +
          ` Chromium allows one process per profile, and that one took the launch instead.`,
    )

  running.set(profile, { port, executable })
  writeRecorded(record, { port, executable })
  return { port, executable, reused: false }
}

export * as BrowserLaunch from "./browser-launch"

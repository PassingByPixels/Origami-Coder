import { LayerNode } from "@origami/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { CdpSession, listPages, newPage, type CdpTarget } from "./cdp"
import { ensureBrowser, forgetBrowser, profileDir } from "./browser-launch"

/**
 * THE WEB MCP BRIDGE: what turns "the page is the server" from a slogan into a
 * callable surface.
 *
 * Before this, `webmcp_launch` opened a URL and returned prose claiming the
 * tools were "discovered on join" — nothing discovered anything. The bridge is
 * the missing half: it attaches to the tab over CDP, reads the registry the
 * page published on `document.modelContext`, and executes a tool by handing the
 * page back the descriptor it gave us.
 *
 * THREE FACTS ABOUT THE REAL SURFACE, all verified against a live WebMCP page
 * rather than read off the spec, because all three are places a reasonable
 * implementation goes silently wrong:
 *
 *  1. The registry is PER JAVASCRIPT WORLD and per frame. Evaluating with any
 *     `contextId` risks an isolated world, which has its own empty registry and
 *     reports ZERO TOOLS WITH NO ERROR. cdp.ts therefore passes no contextId.
 *  2. `inputSchema` arrives as a JSON STRING, not an object, and a tool
 *     descriptor also carries a live `window` reference — so a descriptor can
 *     never be returned by value (Chrome throws a cross-origin SecurityError
 *     trying to serialise it). Everything is projected to primitives in-page.
 *  3. `executeTool` takes the DESCRIPTOR OBJECT and a JSON STRING of arguments —
 *     `executeTool(name, obj)` fails with "not of type 'RegisteredTool'", and
 *     `executeTool(tool, obj)` fails with "Failed to parse input arguments".
 *     The tool object cannot leave the page, so the call is resolved in-page by
 *     name and executed there.
 *
 * ADDRESSED BY URL, NOT BY PAGE ID (a deviation from the sketch, deliberately):
 * a CDP page id dies with its tab, and threading one through a model-facing
 * tool parameter would hand the model a browser-internal handle it cannot
 * recover when the user closes a window. The site's URL is the identity the
 * registry already uses, so `attach` resolves it to a live tab every time and
 * opens one when there is none.
 */

/** One tool as the page publishes it, projected to something serialisable. */
export type WebMcpTool = {
  readonly name: string
  readonly description: string
  readonly title?: string
  /** Parsed from the page's JSON string. Undefined when absent or unparseable —
   *  a tool with an unreadable schema is still callable, just less documented. */
  readonly inputSchema?: Record<string, unknown>
}

export type Discovery = {
  /** Which global carried the registry, or "none" when the page published no
   *  WebMCP surface at all. Chrome 152 dropped the `navigator` alias, so both
   *  are read and which one answered is worth logging. */
  readonly surface: "document.modelContext" | "navigator.modelContext" | "none"
  readonly tools: readonly WebMcpTool[]
  /** The page's own status pill text, when it publishes one. */
  readonly pill?: string
  /** Tool count parsed out of the pill — the independent cross-check. */
  readonly pillCount?: number
  /** Bumped by the in-page `toolchange` listener. Compare across reads to know
   *  whether the page re-registered since last time. */
  readonly version: number
  readonly pageUrl: string
  readonly pageId: string
  readonly port: number
  /** A `getTools()` that threw, reported rather than raised. */
  readonly error?: string
}

export type CallOutcome = {
  readonly ok: boolean
  /** The page's result, always as text: WebMCP returns a JSON string of an MCP
   *  result, but an implementation returning an object is normalised in-page. */
  readonly result?: string
  readonly error?: string
  readonly known?: readonly string[]
}

export type PageRef = {
  readonly pageId: string
  readonly port: number
  readonly pageUrl: string
  readonly executable: string
  readonly reusedBrowser: boolean
  readonly reusedTab: boolean
}

export class WebMcpBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebMcpBridgeError"
  }
}

/**
 * Read the registry, and install the change counter once.
 *
 * The listener is the cheap half of a `toolchange` push: nothing wakes the
 * engine, but a later read can SAY whether the page re-registered, which is the
 * part a model actually needs before trusting a cached catalog.
 */
const DISCOVER = `(async () => {
  const c = document.modelContext ?? navigator.modelContext;
  const el = document.querySelector('[data-testid="mcp-status"]');
  const pill = el ? String(el.textContent || "") : undefined;
  if (!c) return { surface: "none", tools: [], pill, version: 0 };
  const surface = document.modelContext ? "document.modelContext" : "navigator.modelContext";
  if (!window.__origamiWebMcpHooked) {
    window.__origamiWebMcpHooked = true;
    window.__origamiWebMcpVersion = 0;
    try { c.addEventListener("toolchange", () => { window.__origamiWebMcpVersion = (window.__origamiWebMcpVersion | 0) + 1; }); } catch (e) {}
  }
  const version = window.__origamiWebMcpVersion | 0;
  let raw;
  try { raw = await c.getTools(); } catch (e) { return { surface, tools: [], pill, version, error: String(e) }; }
  const list = Array.isArray(raw) ? raw : [];
  const tools = list.map((t) => ({
    name: String(t.name == null ? "" : t.name),
    description: String(t.description == null ? "" : t.description),
    title: t.title == null ? undefined : String(t.title),
    inputSchema: typeof t.inputSchema === "string" ? t.inputSchema : (t.inputSchema ? JSON.stringify(t.inputSchema) : undefined),
  }));
  return { surface, tools, pill, version };
})()`

/** Resolve the descriptor in-page by name and execute it there. */
function callExpression(name: string, args: Record<string, unknown>): string {
  return `(async () => {
  const c = document.modelContext ?? navigator.modelContext;
  if (!c) return { ok: false, error: "This page publishes no WebMCP tools." };
  let list;
  try { list = await c.getTools(); } catch (e) { return { ok: false, error: "getTools() failed: " + String(e) }; }
  const tools = Array.isArray(list) ? list : [];
  const tool = tools.find((t) => String(t.name) === ${JSON.stringify(name)});
  if (!tool) return { ok: false, error: "no tool named " + ${JSON.stringify(name)}, known: tools.map((t) => String(t.name)) };
  try {
    const r = await c.executeTool(tool, ${JSON.stringify(JSON.stringify(args))});
    return { ok: true, result: typeof r === "string" ? r : JSON.stringify(r) };
  } catch (e) { return { ok: false, error: String(e) }; }
})()`
}

/** `"WebMCP: connected via document.modelContext — 29 tools"` -> 29. */
export function pillCount(pill: string | undefined): number | undefined {
  const match = /(\d+)\s+tools?\b/i.exec(pill ?? "")
  return match?.[1] ? Number(match[1]) : undefined
}

/** Two addresses that name the same page. A trailing slash is noise; a hash
 *  route is not, so a page whose href only EXTENDS the target still matches. */
export function samePage(target: string, href: string): boolean {
  const trim = (value: string) => value.replace(/\/+$/, "")
  const a = trim(target)
  const b = trim(href)
  return a === b || b.startsWith(a + "/") || b.startsWith(a + "#") || b.startsWith(a + "?")
}

/** JSON string -> object, or undefined. Never throws: an unparseable schema
 *  costs documentation, not the tool. */
function parseSchema(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw !== "string" || !raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

type RawDiscovery = {
  surface?: string
  tools?: { name?: string; description?: string; title?: string; inputSchema?: unknown }[]
  pill?: string
  version?: number
  error?: string
}

/** Shape the page's reply into a Discovery. Exported for the unit tests, which
 *  is also where the string-schema parse is pinned. */
export function shapeDiscovery(raw: RawDiscovery | undefined, page: { pageId: string; port: number; pageUrl: string }): Discovery {
  const surface =
    raw?.surface === "document.modelContext" || raw?.surface === "navigator.modelContext" ? raw.surface : "none"
  const tools = (raw?.tools ?? []).map((tool) => {
    const schema = parseSchema(tool.inputSchema)
    return {
      name: tool.name ?? "",
      description: tool.description ?? "",
      ...(tool.title ? { title: tool.title } : {}),
      ...(schema ? { inputSchema: schema } : {}),
    }
  })
  return {
    surface,
    tools,
    ...(raw?.pill ? { pill: raw.pill } : {}),
    ...(pillCount(raw?.pill) === undefined ? {} : { pillCount: pillCount(raw?.pill) }),
    version: raw?.version ?? 0,
    ...(raw?.error ? { error: raw.error } : {}),
    ...page,
  }
}

/**
 * The page's own count against ours, when they disagree.
 *
 * The pill is the page rendering what IT thinks it registered, so a mismatch is
 * the one cheap signal that a read went to the wrong world or caught the
 * registry mid-change. Returned rather than logged in place so the check is a
 * fact that can be asserted, and so the catalog can tell the model too.
 */
export function pillMismatch(discovery: Discovery): { readonly pillCount: number; readonly discovered: number } | undefined {
  if (discovery.pillCount === undefined || discovery.pillCount === discovery.tools.length) return undefined
  return { pillCount: discovery.pillCount, discovered: discovery.tools.length }
}

export interface Interface {
  /** Open (or find) the site's tab in a debuggable browser and wait for load. */
  readonly launch: (url: string) => Effect.Effect<PageRef, WebMcpBridgeError>
  /** Re-read the page's registry. Picks up tools registered after load. */
  readonly discover: (url: string) => Effect.Effect<Discovery, WebMcpBridgeError>
  readonly call: (
    url: string,
    tool: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<CallOutcome, WebMcpBridgeError>
}

export class Service extends Context.Service<Service, Interface>()("@origami/WebMcpBridge") {}

const fail = (error: unknown) =>
  new WebMcpBridgeError(error instanceof Error ? error.message : String(error))

const layer = Layer.succeed(
  Service,
  Service.of({
    launch: Effect.fn("WebMcpBridge.launch")(function* (url: string) {
      return yield* Effect.tryPromise({ try: () => attach(url, true), catch: fail }).pipe(
        Effect.tap((page) =>
          Effect.logInfo("webmcp launch", {
            url,
            pageId: page.pageId,
            port: page.port,
            executable: page.executable,
            reusedBrowser: page.reusedBrowser,
            reusedTab: page.reusedTab,
            profile: profileDir(),
          }),
        ),
      )
    }),

    discover: Effect.fn("WebMcpBridge.discover")(function* (url: string) {
      const result = yield* Effect.tryPromise({ try: () => runDiscovery(url), catch: fail })
      yield* Effect.logInfo("webmcp discovery", {
        url,
        surface: result.surface,
        pageId: result.pageId,
        port: result.port,
        discovered: result.tools.length,
        pill: result.pill,
        pillCount: result.pillCount,
        version: result.version,
      })
      // The pill is the page's OWN count, so a disagreement means one of the two
      // reads is looking at the wrong world or a stale registry. Warned, never
      // thrown: the discovered list is still the more useful of the two.
      const mismatch = pillMismatch(result)
      if (mismatch) yield* Effect.logWarning("webmcp pill/discovery mismatch", { url, ...mismatch })
      return result
    }),

    call: Effect.fn("WebMcpBridge.call")(function* (url: string, tool: string, args: Record<string, unknown>) {
      const outcome = yield* Effect.tryPromise({ try: () => runCall(url, tool, args), catch: fail })
      yield* Effect.logInfo("webmcp call", { url, tool, ok: outcome.ok, error: outcome.error })
      return outcome
    }),
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

// ------------------------------- plumbing --------------------------------
// Promise-side, below the Effect surface: one place that owns the socket, so
// every command above is a single tryPromise.

/** Find the site's tab, opening one when it is missing. */
async function attach(url: string, waitForLoad: boolean): Promise<PageRef> {
  let browser = await ensureBrowser({ startUrl: url })
  let pages: CdpTarget[]
  try {
    pages = await listPages(browser.port)
  } catch {
    // The cached instance answered `/json/version` and then went away between
    // the two calls. Drop it and start clean rather than reporting a dead port.
    forgetBrowser()
    browser = await ensureBrowser({ startUrl: url })
    pages = await listPages(browser.port)
  }

  const existing = pages.find((page) => samePage(url, page.url))
  if (existing)
    return {
      pageId: existing.id,
      port: browser.port,
      pageUrl: existing.url,
      executable: browser.executable,
      reusedBrowser: browser.reused,
      reusedTab: true,
    }

  const opened = await newPage(browser.port, url)
  const page: PageRef = {
    pageId: opened.id,
    port: browser.port,
    pageUrl: opened.url || url,
    executable: browser.executable,
    reusedBrowser: browser.reused,
    reusedTab: false,
  }
  if (waitForLoad && opened.webSocketDebuggerUrl) {
    const session = await CdpSession.open(opened.webSocketDebuggerUrl)
    try {
      await session.send("Page.enable")
      await session.once("Page.loadEventFired", 20_000)
    } finally {
      session.close()
    }
  }
  return page
}

/**
 * Resolve the site to a live tab, attach ONCE, and hand the session to `run`.
 *
 * Attaching once per operation rather than once per evaluate is not a tidy-up:
 * `attach` OPENS A TAB when it cannot find one, so a retry loop that re-attached
 * would open a fresh tab on every attempt against any page whose address moves
 * under it — a redirect, or an app that rewrites its own URL on boot. Eight
 * retries would have meant eight tabs.
 */
async function withPage<T>(
  url: string,
  timeoutMs: number,
  run: (session: CdpSession, page: PageRef) => Promise<T>,
): Promise<T> {
  const page = await attach(url, false)
  const targets = await listPages(page.port)
  const target = targets.find((item) => item.id === page.pageId)
  if (!target) throw new WebMcpBridgeError(`The tab for ${url} is no longer open.`)
  const session = await CdpSession.open(target.webSocketDebuggerUrl, timeoutMs)
  try {
    return await run(session, page)
  } finally {
    session.close()
  }
}

/**
 * Discover, with a settle window.
 *
 * A page registers its tools in its own script, which can land after the load
 * event, so a single read right after navigation legitimately sees zero. This
 * re-reads for a few seconds before believing an empty registry — and returns
 * immediately once anything is there, so the common case pays nothing.
 */
async function runDiscovery(url: string, attempts = 8, gapMs = 500): Promise<Discovery> {
  return withPage(url, 30_000, async (session, page) => {
    let last = shapeDiscovery(undefined, page)
    for (let attempt = 0; attempt < attempts; attempt++) {
      last = shapeDiscovery(await session.evaluate<RawDiscovery>(DISCOVER, 30_000), page)
      if (last.tools.length > 0) return last
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, gapMs))
    }
    return last
  })
}

async function runCall(url: string, tool: string, args: Record<string, unknown>): Promise<CallOutcome> {
  return withPage(url, 60_000, async (session) => {
    const value = await session.evaluate<CallOutcome | undefined>(callExpression(tool, args), 60_000)
    return value ?? { ok: false, error: "The page returned nothing." }
  })
}

export * as WebMcpBridge from "./bridge"

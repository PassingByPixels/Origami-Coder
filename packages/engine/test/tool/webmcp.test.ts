import { describe, expect } from "bun:test"
import path from "path"
import fsp from "fs/promises"
import { Effect, Layer } from "effect"
import { PermissionV1 } from "@origami/core/v1/permission"
import { FSUtil } from "@origami/core/fs-util"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { McpBrowser } from "@/mcp/browser"
import { WebMcpBridge } from "@/webmcp/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import {
  catalogText,
  WebmcpCallTool,
  WebmcpLaunchTool,
  WebmcpListTool,
  WebmcpNoteTool,
  WebmcpToolsTool,
} from "../../src/tool/webmcp"
import { mergeSitesText, normalizeUrl, parseSites, resolveSite, writeSites } from "../../src/tool/webmcp-store"
import { RegistryReadFailedError } from "../../src/tool/board-store"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The webmcp tools capture FSUtil (and, for launch, McpBrowser) at define time
// and never touch the instance, so the stack is smaller than the board's: no
// Git, no InstanceState. McpBrowser is the one service that MUST be faked — the
// real layer shells out to `open`, and a green suite that launched a browser
// window per test would be its own bug report.

const FOLIO_URL = "https://folio.example/mcp"

const browser = { opened: [] as string[], fail: undefined as string | undefined }

const browserLayer = Layer.succeed(
  McpBrowser.Service,
  McpBrowser.Service.of({
    open: (url: string) =>
      Effect.gen(function* () {
        browser.opened.push(url)
        if (browser.fail) return yield* Effect.fail(new Error(browser.fail))
      }),
  }),
)

/** The two tools a fake site publishes. `create_deck` carries a schema so the
 *  catalog's schema block is exercised; `save_deck` carries none, which is the
 *  case that must not print an empty `{}`. */
const FAKE_TOOLS: WebMcpBridge.WebMcpTool[] = [
  {
    name: "create_deck",
    description: "Start a new deck",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
  { name: "save_deck", description: "Write the deck to disk" },
]

const fakeDiscovery = (tools: WebMcpBridge.WebMcpTool[], pill?: string): WebMcpBridge.Discovery => ({
  surface: "document.modelContext",
  tools,
  ...(pill ? { pill, pillCount: WebMcpBridge.pillCount(pill) } : {}),
  version: 0,
  pageUrl: FOLIO_URL,
  pageId: "PAGE1",
  port: 9222,
})

/**
 * The CDP bridge, faked. It MUST be: the real one starts a browser, and a suite
 * that opened a window per test would be its own bug report — the same reason
 * McpBrowser is faked above.
 */
const bridge = {
  launched: [] as string[],
  discovered: [] as string[],
  calls: [] as { url: string; tool: string; args: Record<string, unknown> }[],
  launchError: undefined as string | undefined,
  discoverError: undefined as string | undefined,
  callError: undefined as string | undefined,
  discovery: undefined as WebMcpBridge.Discovery | undefined,
  outcome: undefined as WebMcpBridge.CallOutcome | undefined,
}

const bridgeLayer = Layer.succeed(
  WebMcpBridge.Service,
  WebMcpBridge.Service.of({
    launch: (url: string) =>
      Effect.gen(function* () {
        bridge.launched.push(url)
        if (bridge.launchError) return yield* Effect.fail(new WebMcpBridge.WebMcpBridgeError(bridge.launchError))
        return {
          pageId: "PAGE1",
          port: 9222,
          pageUrl: url,
          executable: "brave",
          reusedBrowser: false,
          reusedTab: false,
        }
      }),
    discover: (url: string) =>
      Effect.gen(function* () {
        bridge.discovered.push(url)
        if (bridge.discoverError) return yield* Effect.fail(new WebMcpBridge.WebMcpBridgeError(bridge.discoverError))
        return bridge.discovery ?? fakeDiscovery(FAKE_TOOLS)
      }),
    call: (url: string, tool: string, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        bridge.calls.push({ url, tool, args })
        if (bridge.callError) return yield* Effect.fail(new WebMcpBridge.WebMcpBridgeError(bridge.callError))
        return bridge.outcome ?? { ok: true, result: '{"content":[{"type":"text","text":"done"}]}' }
      }),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([FSUtil.node, Truncate.node, Agent.node, InstanceStore.node, McpBrowser.node, WebMcpBridge.node]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
      [McpBrowser.node, browserLayer],
      [WebMcpBridge.node, bridgeLayer],
    ],
  ),
)

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

/** A literal tool context that RECORDS every permission ask for assertion. */
function makeCtx() {
  const asks: Ask[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_webmcp-test"),
    messageID: MessageID.make("msg_webmcp-test"),
    callID: "webmcp-call",
    agent: "heron",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        asks.push(request)
      }),
  }
  return { ctx, asks }
}

const tools = Effect.gen(function* () {
  return {
    list: yield* (yield* WebmcpListTool).init(),
    launch: yield* (yield* WebmcpLaunchTool).init(),
    tools: yield* (yield* WebmcpToolsTool).init(),
    call: yield* (yield* WebmcpCallTool).init(),
    note: yield* (yield* WebmcpNoteTool).init(),
  }
})

/**
 * Point `~` at a subdirectory of the test instance for the duration of the
 * test, so `Global.Path.origami` (a getter) resolves webmcp.json inside the
 * scratch tree instead of the shared preload home. The real
 * `~/.origami/webmcp.json` is never read and never written by this suite.
 * Also resets the fake browser, so one test's opens cannot be seen by the next.
 */
const useHome = (dir: string) =>
  Effect.gen(function* () {
    const home = path.join(dir, "home")
    const previous = process.env.ORIGAMI_TEST_HOME
    process.env.ORIGAMI_TEST_HOME = home
    browser.opened = []
    browser.fail = undefined
    bridge.launched = []
    bridge.discovered = []
    bridge.calls = []
    bridge.launchError = undefined
    bridge.discoverError = undefined
    bridge.callError = undefined
    bridge.discovery = undefined
    bridge.outcome = undefined
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.env.ORIGAMI_TEST_HOME = previous
      }),
    )
    return path.join(home, ".origami", "webmcp.json")
  })

/** Write the registry document verbatim — including any field the engine has
 *  never heard of, which is what the preservation tests are about. */
async function writeRegistry(file: string, doc: unknown) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8")
  return file
}

const readRegistry = async (file: string) => JSON.parse(await fsp.readFile(file, "utf8"))

const FOLIO = { url: FOLIO_URL, name: "folio", purpose: "Origami Folio blocks", addedAt: 1 }
const NOTES = { url: "https://notes.example/app", name: "notes", purpose: "Scratch notes", addedAt: 2 }

// ============================== the store ================================

describe("normalizeUrl — one address, one entry", () => {
  it.effect(
    "folds the ways of writing the same address together",
    Effect.sync(() => {
      // A bare origin with and without its trailing slash is ONE site; keying
      // by raw text would draw two rows for it.
      expect(normalizeUrl("https://Example.com/")).toBe("https://example.com")
      expect(normalizeUrl("https://example.com")).toBe("https://example.com")
      expect(normalizeUrl("  https://example.com/mcp/  ")).toBe("https://example.com/mcp/")
      // A hash route names a genuinely different page — merging them would
      // hide one site behind another.
      expect(normalizeUrl("https://example.com/#/mcp")).toBe("https://example.com/#/mcp")
      expect(normalizeUrl("https://example.com/#/mcp")).not.toBe(normalizeUrl("https://example.com"))
      expect(normalizeUrl("https://example.com/?q=1")).toBe("https://example.com/?q=1")
    }),
  )

  it.effect(
    "refuses anything a browser cannot join",
    Effect.sync(() => {
      for (const bad of ["", "   ", undefined, "folio", "file:///c:/tmp/page.html", "ftp://example.com", "javascript:alert(1)"])
        expect(normalizeUrl(bad)).toBeUndefined()
    }),
  )
})

describe("parseSites — an unusable file is an empty address book, never an error", () => {
  it.effect(
    "reads absent, blank and broken input as no sites",
    Effect.sync(() => {
      for (const text of [undefined, "", "   ", "{not json", "[]", '{"version":1}', '{"sites":"nope"}'])
        expect(parseSites(text)).toEqual([])
    }),
  )

  it.effect(
    "drops an entry no browser could open, and names a nameless one by its host",
    Effect.sync(() => {
      const sites = parseSites(
        JSON.stringify({
          version: 1,
          sites: [FOLIO, { url: "file:///c:/tmp/x.html", name: "local" }, { url: "https://bare.example/" }],
        }),
      )
      expect(sites.map((site) => site.name)).toEqual(["folio", "bare.example"])
    }),
  )
})

describe("mergeSitesText — the rule both writers follow", () => {
  // THE LOAD-BEARING TEST. The extension writes this file too and carries keys
  // this module has never heard of; a merge that projected and re-emitted would
  // delete every one of them, which is the exact bug class repos.json's merge
  // rule exists for.
  it.effect(
    "preserves unknown fields, on the entry and at the top level",
    Effect.sync(() => {
      const before = JSON.stringify({
        version: 1,
        theme: "dark",
        sites: [{ ...FOLIO, favourite: true, tags: ["blocks"] }],
      })
      const after = JSON.parse(mergeSitesText(before, [{ url: FOLIO.url, notes: "exposes block_insert" }]))
      expect(after.theme).toBe("dark")
      expect(after.sites[0].favourite).toBe(true)
      expect(after.sites[0].tags).toEqual(["blocks"])
      expect(after.sites[0].notes).toBe("exposes block_insert")
    }),
  )

  it.effect(
    "an omitted field keeps the value already on disk",
    Effect.sync(() => {
      const before = JSON.stringify({ version: 1, sites: [{ ...FOLIO, notes: "kept" }] })
      // A launch patch names lastLaunched and nothing else. Purpose and notes
      // must survive it — dropping undefined is what stops a patch nulling them.
      const after = JSON.parse(mergeSitesText(before, [{ url: FOLIO.url, lastLaunched: 999 }]))
      expect(after.sites[0]).toMatchObject({ purpose: "Origami Folio blocks", notes: "kept", lastLaunched: 999 })
    }),
  )

  it.effect(
    "matches an entry however its address was written, and appends a new one",
    Effect.sync(() => {
      const before = JSON.stringify({ version: 1, sites: [{ url: "https://Example.com/", name: "ex" }] })
      const same = JSON.parse(mergeSitesText(before, [{ url: "https://example.com", notes: "n" }]))
      expect(same.sites).toHaveLength(1)
      expect(same.sites[0].notes).toBe("n")

      const added = JSON.parse(mergeSitesText(before, [{ url: NOTES.url, name: "notes" }]))
      expect(added.sites).toHaveLength(2)
    }),
  )

  it.effect(
    "stamps version on a file that has none, and keeps one already there",
    Effect.sync(() => {
      expect(JSON.parse(mergeSitesText(undefined, [])).version).toBe(1)
      expect(JSON.parse(mergeSitesText("{not json", [])).version).toBe(1)
      expect(JSON.parse(mergeSitesText(JSON.stringify({ version: 7, sites: [] }), [])).version).toBe(7)
    }),
  )

  it.effect(
    "ignores a patch whose address is not one a browser could join",
    Effect.sync(() => {
      const after = JSON.parse(mergeSitesText(JSON.stringify({ version: 1, sites: [] }), [{ url: "nonsense" }]))
      expect(after.sites).toEqual([])
    }),
  )
})

describe("writeSites (finding 17: never merge {} over a file that failed to read)", () => {
  it.instance(
    "refuses to overwrite webmcp.json when it exists but cannot be read as a file",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const file = yield* useHome(directory)
        yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))

        // Corrupt the registry to something that EXISTS but cannot be read as a
        // file (EISDIR, not "not found") -- the same shape as a Windows
        // EBUSY/EPERM read failure. Before the fix, writeSites treated that the
        // same as "no file yet" and replaced it with `{ sites: [only the patch] }`.
        yield* Effect.promise(async () => {
          await fsp.rm(file, { force: true })
          await fsp.mkdir(file)
        })

        const fs = yield* FSUtil.Service
        const failure = yield* Effect.flip(writeSites(fs, [{ url: NOTES.url, name: "other" }]))

        expect(failure).toBeInstanceOf(RegistryReadFailedError)
        const stat = yield* Effect.promise(() => fsp.stat(file))
        expect(stat.isDirectory()).toBe(true)
      }),
  )
})

describe("resolveSite", () => {
  it.effect(
    "resolves by name, case-folded name, and address",
    Effect.sync(() => {
      const sites = parseSites(JSON.stringify({ version: 1, sites: [FOLIO, NOTES] }))
      expect(resolveSite(sites, "folio")?.name).toBe("folio")
      expect(resolveSite(sites, "FOLIO")?.name).toBe("folio")
      expect(resolveSite(sites, "https://folio.example/mcp")?.name).toBe("folio")
      expect(resolveSite(sites, "missing")).toBeUndefined()
      expect(resolveSite(sites, "")).toBeUndefined()
    }),
  )

  // The file is hand-editable, so two entries CAN share a name. Resolution is
  // first-match rather than a refusal: a launch that worked yesterday must not
  // start failing because the user added an unrelated second site and reused a
  // label. Deterministic, and the refusal text lists the names either way.
  it.effect(
    "takes the first of two entries sharing a name rather than refusing both",
    Effect.sync(() => {
      const twin = { ...NOTES, name: "folio" }
      const sites = parseSites(JSON.stringify({ version: 1, sites: [FOLIO, twin] }))
      expect(resolveSite(sites, "folio")?.url).toBe(FOLIO.url)
      // The second is still reachable by its own address.
      expect(resolveSite(sites, NOTES.url)?.url).toBe(NOTES.url)
    }),
  )
})

// ============================== the tools ================================

// `it.instance`, not `it.effect`: these run the tool through `Tool.define`'s
// wrapper, whose output truncation resolves the turn's agent — and that needs
// an instance in context, even though nothing in these tools reads the worktree.
describe("webmcp_list", () => {
  it.instance("says the address book is empty rather than failing", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).list.execute({}, ctx)
      expect(result.output).toContain("No WebMCP sites are registered")
      expect(result.output).toContain(file)
      expect(result.metadata.sites).toBe(0)
      expect(asks).toEqual([])
    }),
  )

  // READ-ONLY MEANS NO PROMPT. Asking the user before telling the model which
  // sites exist would put a permission dialog in front of every session that
  // merely wondered whether a capability was available.
  it.instance("lists every site, tells the model what a WebMCP site IS, and never asks", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() =>
        writeRegistry(file, {
          version: 1,
          sites: [{ ...FOLIO, notes: "block_insert(text)", lastLaunched: 1756600000000 }, NOTES],
        }),
      )
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).list.execute({}, ctx)

      expect(asks).toEqual([])
      expect(result.metadata.sites).toBe(2)
      for (const shown of ["folio", "https://folio.example/mcp", "Origami Folio blocks", "block_insert(text)", "notes"])
        expect(result.output).toContain(shown)
      // The three facts the header exists to state.
      expect(result.output).toContain("the PAGE ITSELF is the server")
      expect(result.output).toContain("RE-RUNS on every read")
      expect(result.output).toContain("advisory")
    }),
  )
})

// THE PANE'S EDIT BUTTON, FROM THIS SIDE. The user rewrites a site's name and
// description in the MCP pane's Web MCP section; the extension writes them into
// `name` and `purpose` (packages/vscode/src/dashboard/webmcpPane.ts). What the
// engine owes back is that those two fields are exactly what the MODEL reads —
// and that `notes`, the memory `webmcp_note` banks, is not disturbed by them.
describe("a site edited in the pane — what the model then reads", () => {
  it.effect(
    "round-trips a rewritten name and purpose through the registry text",
    Effect.sync(() => {
      const before = JSON.stringify({
        version: 1,
        theme: "dark",
        sites: [{ ...FOLIO, notes: "block_insert(text)", lastLaunched: 1756600000000, favourite: true }, NOTES],
      })
      // The patch the pane's Edit produces: the two fields, keyed by address.
      const after = mergeSitesText(before, [
        { url: FOLIO_URL, name: "folio-deck", purpose: "Build and save Origami decks from the browser" },
      ])
      const [edited, untouched] = parseSites(after)
      expect(edited.name).toBe("folio-deck")
      expect(edited.purpose).toBe("Build and save Origami decks from the browser")
      // Not the user's to overwrite: the engine's own advisory memory and its
      // launch bookkeeping survive a rename.
      expect(edited.notes).toBe("block_insert(text)")
      expect(edited.lastLaunched).toBe(1756600000000)
      expect(edited.addedAt).toBe(FOLIO.addedAt)
      // ORDER IS STABLE — an edit replaces in place, it does not re-append.
      expect(untouched.name).toBe(NOTES.name)
      expect(JSON.parse(after).theme).toBe("dark")
      expect(JSON.parse(after).sites[0].favourite).toBe(true)
    }),
  )

  it.instance("webmcp_list prints the edited description, not the one it replaced", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO, NOTES] }))

      const before = yield* (yield* tools).list.execute({}, makeCtx().ctx)
      expect(before.output).toContain("purpose: Origami Folio blocks")

      // The pane saves. Same merge rule, same file.
      const text = yield* Effect.promise(() => fsp.readFile(file, "utf8"))
      yield* Effect.promise(() =>
        fsp.writeFile(
          file,
          mergeSitesText(text, [
            { url: FOLIO_URL, name: "folio-deck", purpose: "Build and save Origami decks from the browser" },
          ]),
          "utf8",
        ),
      )

      const after = yield* (yield* tools).list.execute({}, makeCtx().ctx)
      expect(after.output).toContain("- folio-deck  https://folio.example/mcp")
      expect(after.output).toContain("purpose: Build and save Origami decks from the browser")
      expect(after.output).not.toContain("Origami Folio blocks")
      // The other row is untouched and still listed in its original position.
      expect(after.output.indexOf(FOLIO_URL)).toBeLessThan(after.output.indexOf(NOTES.url))
      expect(after.metadata.sites).toBe(2)
    }),
  )
})

describe("webmcp_launch", () => {
  it.instance("refuses an unregistered site without asking, and opens nothing", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).launch.execute({ site: "ghost" }, ctx)

      expect(result.output).toContain('Refused: no WebMCP site "ghost" is registered')
      // The refusal NAMES what is registered — a model that cannot see the
      // alternatives just calls the same wrong name again.
      expect(result.output).toContain("folio")
      // A cheap refusal comes before the gate: no prompt for a site that does
      // not exist, and no browser window either.
      expect(asks).toEqual([])
      expect(browser.opened).toEqual([])
    }),
  )

  // THE GATE. Opening a browser window on the user's desktop is an act they
  // have to be able to refuse, and it is gated under `webmcp`, scoped to the
  // site's own name so an allow for one site is not an allow for all of them.
  it.instance("asks under `webmcp` for that site, then opens it and stamps lastLaunched", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [{ ...FOLIO, favourite: true }, NOTES] }))
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).launch.execute({ site: "folio" }, ctx)

      expect(asks).toHaveLength(1)
      expect(asks[0].permission).toBe("webmcp")
      expect(asks[0].patterns).toEqual(["folio"])
      expect(asks[0].metadata).toMatchObject({ url: FOLIO.url })

      // The BRIDGE opened it, not the plain `open` fallback — and the catalog
      // came back with it, which is the whole point of the tool now.
      expect(bridge.launched).toEqual([FOLIO.url])
      expect(bridge.discovered).toEqual([FOLIO.url])
      expect(browser.opened).toEqual([])
      expect(result.output).toContain("Opened folio")
      expect(result.metadata.tools).toBe(2)
      expect(result.metadata.surface).toBe("document.modelContext")
      expect(result.output).toContain("create_deck")
      expect(result.output).toContain("Start a new deck")
      expect(result.output).toContain("Input schemas (JSON):")
      // The user has to be able to find the tab, so where it opened is stated.
      expect(result.output).toContain("not the user's main profile")

      const doc = yield* Effect.promise(() => readRegistry(file))
      expect(typeof doc.sites[0].lastLaunched).toBe("number")
      // The stamp went through the merge, so the entry's other fields — and the
      // second site — are still there.
      expect(doc.sites[0].favourite).toBe(true)
      expect(doc.sites[0].purpose).toBe("Origami Folio blocks")
      expect(doc.sites).toHaveLength(2)
    }),
  )

  it.instance("reports a browser that will not start, and does NOT date the entry", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      bridge.launchError = "no Chromium"
      browser.fail = "spawn xdg-open ENOENT"
      const { ctx } = makeCtx()
      const result = yield* (yield* tools).launch.execute({ site: "folio" }, ctx)

      expect(result.output).toContain("Could not open https://folio.example/mcp")
      expect(result.output).toContain("spawn xdg-open ENOENT")
      // A lastLaunched written on a failed open would make the list claim the
      // session had been somewhere it never reached.
      const doc = yield* Effect.promise(() => readRegistry(file))
      expect(doc.sites[0].lastLaunched).toBeUndefined()
    }),
  )

  it.instance("accepts the address as well as the name", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      const { ctx, asks } = makeCtx()
      yield* (yield* tools).launch.execute({ site: "https://folio.example/mcp" }, ctx)
      // Resolved by address, but the GATE still names the site, never the raw
      // parameter — an allow rule has to mean the same thing either way it was
      // called.
      expect(asks[0].patterns).toEqual(["folio"])
      expect(bridge.launched).toEqual([FOLIO.url])
    }),
  )

  // THE DEGRADED PATH, and the reason it is a test rather than a comment: the
  // tool used to claim tools were "discovered on join" while nothing discovered
  // anything. A machine with no Chromium must SAY discovery is unavailable, not
  // imply a catalog it never read.
  it.instance("falls back to a plain open when the bridge cannot run, and says discovery is unavailable", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      bridge.launchError = "No Chromium-based browser was found."
      const { ctx } = makeCtx()
      const result = yield* (yield* tools).launch.execute({ site: "folio" }, ctx)

      expect(browser.opened).toEqual([FOLIO.url])
      expect(result.output).toContain("could NOT be discovered")
      expect(result.output).toContain("No Chromium-based browser was found.")
      expect(result.output).toContain("webmcp_call will not work")
      expect(result.metadata.surface).toBe("unavailable")
      // The page DID open, so the stamp is honest.
      const doc = yield* Effect.promise(() => readRegistry(file))
      expect(typeof doc.sites[0].lastLaunched).toBe("number")
    }),
  )
})

describe("webmcp_tools", () => {
  it.instance("re-reads the registry behind the same gate as launch", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).tools.execute({ site: "folio" }, ctx)

      // One gate key for the whole feature, so an `always` granted at launch
      // already covers this — the board's treatment, for the board's reason.
      expect(asks).toHaveLength(1)
      expect(asks[0].permission).toBe("webmcp")
      expect(asks[0].patterns).toEqual(["folio"])
      expect(bridge.discovered).toEqual([FOLIO.url])
      expect(result.metadata.tools).toBe(2)
      expect(result.output).toContain("create_deck")
    }),
  )

  it.instance("refuses an unregistered site without asking or opening anything", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).tools.execute({ site: "ghost" }, ctx)
      expect(result.output).toContain("Refused: no WebMCP site")
      expect(asks).toEqual([])
      expect(bridge.discovered).toEqual([])
    }),
  )

  it.instance("reports an unreachable page instead of pretending it has no tools", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      bridge.discoverError = "The tab for https://folio.example/mcp is no longer open."
      const { ctx } = makeCtx()
      const result = yield* (yield* tools).tools.execute({ site: "folio" }, ctx)
      // "no tools" and "could not look" are different facts, and a model told
      // the first would go and tell the user the site is empty.
      expect(result.output).toContain("Could not read the tools")
      expect(result.output).toContain("no longer open")
    }),
  )
})

describe("webmcp_call", () => {
  it.instance("runs the named tool with its arguments, behind the gate", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).call.execute(
        { site: "folio", tool: "create_deck", args: { title: "Q3" } },
        ctx,
      )

      expect(asks).toHaveLength(1)
      expect(asks[0].permission).toBe("webmcp")
      expect(bridge.calls).toEqual([{ url: FOLIO.url, tool: "create_deck", args: { title: "Q3" } }])
      expect(result.output).toContain('"text":"done"')
    }),
  )

  it.instance("passes an empty argument object when args are omitted", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      const { ctx } = makeCtx()
      yield* (yield* tools).call.execute({ site: "folio", tool: "save_deck" }, ctx)
      // `undefined` would reach the page as the string "undefined" once it is
      // JSON-encoded for executeTool, which the page then refuses to parse.
      expect(bridge.calls[0].args).toEqual({})
    }),
  )

  // A REFUSAL FROM THE PAGE IS AN ANSWER, not a transport failure: the page is
  // the server, so the model has to read it and pick a real tool.
  it.instance("relays the page's refusal and the names it does publish", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      bridge.outcome = { ok: false, error: "no tool named add_slide", known: ["create_deck", "save_deck"] }
      const { ctx } = makeCtx()
      const result = yield* (yield* tools).call.execute({ site: "folio", tool: "add_slide" }, ctx)
      expect(result.output).toContain("refused add_slide")
      expect(result.output).toContain("create_deck, save_deck")
    }),
  )

  it.instance("refuses an unregistered site without asking or calling anything", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).call.execute({ site: "ghost", tool: "create_deck" }, ctx)
      expect(result.output).toContain("Refused: no WebMCP site")
      expect(asks).toEqual([])
      expect(bridge.calls).toEqual([])
    }),
  )
})

describe("catalogText — what the model actually reads", () => {
  it.effect(
    "names the tools, then their schemas",
    Effect.sync(() => {
      const text = catalogText(FOLIO, fakeDiscovery(FAKE_TOOLS), false)
      expect(text).toContain("2 tools published by folio")
      expect(text).toContain("- create_deck — Start a new deck")
      expect(text).toContain("Input schemas (JSON):")
      expect(text).toContain('create_deck: {"type":"object"')
      // save_deck has no schema, so it must not appear in the schema block at
      // all — an empty `{}` would read as "takes an empty object", which is a
      // different claim from "publishes no schema".
      expect(text).not.toContain("save_deck: ")
    }),
  )

  // THE REGRESSION GUARD. The page's own pill is an independent count, so a
  // disagreement means one of the two reads is wrong — most likely a discovery
  // that landed in the wrong JavaScript world and saw an empty registry. The
  // model is told rather than left to trust a silently short list.
  it.effect(
    "surfaces a pill/discovery disagreement to the model",
    Effect.sync(() => {
      const text = catalogText(
        FOLIO,
        fakeDiscovery(FAKE_TOOLS, "WebMCP: connected via document.modelContext — 29 tools"),
        false,
      )
      expect(text).toContain("the page's own status says 29")
      expect(text).toContain("it disagrees")
    }),
  )

  it.effect(
    "agrees quietly when the pill matches",
    Effect.sync(() => {
      const text = catalogText(FOLIO, fakeDiscovery(FAKE_TOOLS, "WebMCP: connected — 2 tools"), false)
      expect(text).not.toContain("disagrees")
    }),
  )

  it.effect(
    "drops to names only past the cap, and points at the way back",
    Effect.sync(() => {
      const many = Array.from({ length: 41 }, (_, index) => ({
        name: `tool_${index}`,
        description: "x".repeat(500),
        inputSchema: { type: "object" },
      }))
      const summary = catalogText(FOLIO, fakeDiscovery(many), false)
      expect(summary).toContain("Names only")
      expect(summary).toContain('detail: true')
      expect(summary).not.toContain("Input schemas (JSON):")
      // detail:true is the way back to the full text.
      const full = catalogText(FOLIO, fakeDiscovery(many), true)
      expect(full).toContain("Input schemas (JSON):")
      expect(full).toContain("x".repeat(500))
    }),
  )

  it.effect(
    "distinguishes an open page with no tools from a page with no WebMCP at all",
    Effect.sync(() => {
      const none = catalogText(FOLIO, { ...fakeDiscovery([]), surface: "none" }, false)
      expect(none).toContain("no modelContext at all")
      const empty = catalogText(FOLIO, fakeDiscovery([]), false)
      expect(empty).toContain("publishes NO WebMCP tools right now")
      expect(empty).toContain("surface: document.modelContext")
    }),
  )
})

describe("webmcp_note", () => {
  it.instance("banks a note behind the same gate, preserving every other field", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() =>
        writeRegistry(file, { version: 1, theme: "dark", sites: [{ ...FOLIO, favourite: true }] }),
      )
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).note.execute(
        { site: "folio", notes: "  block_insert(text)\n  block_move(id, to)  " },
        ctx,
      )

      expect(asks).toHaveLength(1)
      expect(asks[0].permission).toBe("webmcp")
      expect(asks[0].patterns).toEqual(["folio"])

      const doc = yield* Effect.promise(() => readRegistry(file))
      // Collapsed to one line so a pasted transcript cannot push the rest of
      // the address book out of the model's context.
      expect(doc.sites[0].notes).toBe("block_insert(text) block_move(id, to)")
      expect(doc.sites[0].favourite).toBe(true)
      expect(doc.theme).toBe("dark")
      expect(result.output).toContain("Noted against folio")
    }),
  )

  it.instance("clears the note when given an empty one", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [{ ...FOLIO, notes: "stale" }] }))
      const { ctx } = makeCtx()
      const result = yield* (yield* tools).note.execute({ site: "folio", notes: "   " }, ctx)
      expect((yield* Effect.promise(() => readRegistry(file))).sites[0].notes).toBe("")
      expect(result.output).toContain("Cleared the note on folio")
    }),
  )

  it.instance("refuses an unregistered site without asking", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const file = yield* useHome(directory)
      yield* Effect.promise(() => writeRegistry(file, { version: 1, sites: [FOLIO] }))
      const { ctx, asks } = makeCtx()
      const result = yield* (yield* tools).note.execute({ site: "ghost", notes: "x" }, ctx)
      expect(result.output).toContain("Refused: no WebMCP site")
      expect(asks).toEqual([])
    }),
  )
})

/**
 * LIVE WEB MCP PROBE — the end-to-end check the unit tests cannot be.
 *
 * NOT A TEST, on purpose. Everything in `test/webmcp/` runs against fakes so the
 * suite stays hermetic; this drives a REAL browser against a REAL page, which is
 * the only thing that can catch the failures that matter here — a discovery
 * that lands in the wrong JavaScript world (zero tools, no error), a page whose
 * status pill disagrees with what was read, an `executeTool` call shape that the
 * spec permits and the implementation refuses.
 *
 *   bun run script/webmcp-probe.ts
 *   bun run script/webmcp-probe.ts --url https://example.com/app --browser "C:/.../brave.exe"
 *
 * `--calls` runs the four-tool sequence against Origami Folio. Point `--url`
 * somewhere else and pass `--no-calls` to probe discovery alone.
 */

import { ensureBrowser, profileDir } from "../src/webmcp/browser-launch"
import { CdpSession, listPages, newPage } from "../src/webmcp/cdp"
import { pillMismatch, shapeDiscovery, samePage } from "../src/webmcp/bridge"

const DEFAULT_URL = "https://origami.gratis/folio/"

/** The sequence that proves the model-facing path, not just discovery: a read,
 *  a create, a change with a real argument, and a save. */
const SEQUENCE: { tool: string; args: Record<string, unknown> }[] = [
  { tool: "origami_guide", args: {} },
  // `discard` so the probe is IDEMPOTENT: a second run would otherwise be
  // refused because the deck the first run left open has unsaved changes.
  { tool: "create_deck", args: { title: "WebMCP bridge probe", discard: true } },
  { tool: "add_chunk", args: { starter: "venn" } },
  { tool: "save_deck", args: {} },
]

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const url = arg("url") ?? DEFAULT_URL
const browserOverride = arg("browser")
const withCalls = !process.argv.includes("--no-calls")

if (browserOverride) process.env.ORIGAMI_WEBMCP_BROWSER = browserOverride

// Copied from bridge.ts rather than imported: the bridge's expressions are not
// exported, and a probe that ran a DIFFERENT expression from the product would
// be proving the wrong thing. Kept identical on purpose — if these drift, the
// probe stops being evidence.
const DISCOVER = `(async () => {
  const c = document.modelContext ?? navigator.modelContext;
  const el = document.querySelector('[data-testid="mcp-status"]');
  const pill = el ? String(el.textContent || "") : undefined;
  if (!c) return { surface: "none", tools: [], pill, version: 0 };
  const surface = document.modelContext ? "document.modelContext" : "navigator.modelContext";
  const raw = await c.getTools();
  const list = Array.isArray(raw) ? raw : [];
  return {
    surface, pill, version: 0,
    tools: list.map((t) => ({
      name: String(t.name), description: String(t.description == null ? "" : t.description),
      inputSchema: typeof t.inputSchema === "string" ? t.inputSchema : (t.inputSchema ? JSON.stringify(t.inputSchema) : undefined),
    })),
  };
})()`

const callExpression = (name: string, args: Record<string, unknown>) => `(async () => {
  const c = document.modelContext ?? navigator.modelContext;
  const tools = await c.getTools();
  const tool = (Array.isArray(tools) ? tools : []).find((t) => String(t.name) === ${JSON.stringify(name)});
  if (!tool) return { ok: false, error: "no tool named " + ${JSON.stringify(name)} };
  try {
    const r = await c.executeTool(tool, ${JSON.stringify(JSON.stringify(args))});
    return { ok: true, result: typeof r === "string" ? r : JSON.stringify(r) };
  } catch (e) { return { ok: false, error: String(e) }; }
})()`

const browser = await ensureBrowser({ startUrl: url })
console.log(`browser:   ${browser.executable}`)
console.log(`profile:   ${profileDir()}`)
console.log(`port:      ${browser.port} (reused: ${browser.reused})`)

let pages = await listPages(browser.port)
let target = pages.find((page) => samePage(url, page.url))
if (!target) {
  await newPage(browser.port, url)
  await new Promise((resolve) => setTimeout(resolve, 4_000))
  pages = await listPages(browser.port)
  target = pages.find((page) => samePage(url, page.url))
}
if (!target) {
  console.error(`FAILED: no tab on ${url}. Open tabs: ${pages.map((page) => page.url).join(", ") || "(none)"}`)
  process.exit(1)
}

const session = await CdpSession.open(target.webSocketDebuggerUrl, 60_000)
await session.send("Page.enable")

// The settle window the bridge uses: a page can register its tools after load.
let discovery = shapeDiscovery(undefined, { pageId: target.id, port: browser.port, pageUrl: target.url })
for (let attempt = 0; attempt < 8; attempt++) {
  discovery = shapeDiscovery(await session.evaluate(DISCOVER, 30_000), {
    pageId: target.id,
    port: browser.port,
    pageUrl: target.url,
  })
  if (discovery.tools.length) break
  await new Promise((resolve) => setTimeout(resolve, 500))
}

console.log(`page:      ${discovery.pageUrl} (${discovery.pageId})`)
console.log(`surface:   ${discovery.surface}`)
console.log(`pill:      ${discovery.pill ?? "(none)"}`)
console.log(`pillCount: ${discovery.pillCount ?? "(none)"}`)
console.log(`discovered: ${discovery.tools.length}`)
console.log(`first 5:   ${discovery.tools.slice(0, 5).map((tool) => tool.name).join(", ")}`)
console.log(`schemas parsed: ${discovery.tools.filter((tool) => tool.inputSchema).length}/${discovery.tools.length}`)

const mismatch = pillMismatch(discovery)
if (mismatch) console.log(`WARN: pill says ${mismatch.pillCount}, discovery read ${mismatch.discovered}`)
else if (discovery.pillCount !== undefined) console.log("pill agrees with discovery")

let failures = mismatch ? 1 : 0

if (withCalls) {
  for (const step of SEQUENCE) {
    const outcome = await session.evaluate<{ ok: boolean; result?: string; error?: string }>(
      callExpression(step.tool, step.args),
      60_000,
    )
    const body = outcome.ok ? (outcome.result ?? "") : (outcome.error ?? "")
    // An MCP result can carry `isError` and still arrive WITHOUT THROWING — that
    // is the page refusing the call. Counted as a failure, because a probe that
    // prints OK over a refusal is evidence of the wrong thing; this was caught
    // by a second run being refused for unsaved changes and still saying OK.
    let refused = false
    if (outcome.ok) {
      try {
        refused = (JSON.parse(body) as { isError?: boolean }).isError === true
      } catch {}
    }
    const ok = outcome.ok && !refused
    const verdict = ok ? "OK" : refused ? "REFUSED BY PAGE" : "FAILED"
    console.log(`\ncall ${step.tool} ${JSON.stringify(step.args)} -> ${verdict}`)
    console.log(`  ${body.replace(/\s+/g, " ").slice(0, 300)}`)
    if (!ok) failures++
  }
}

session.close()
console.log(`\n${failures ? `PROBE FAILED (${failures} problem${failures === 1 ? "" : "s"})` : "PROBE OK"}`)
process.exit(failures ? 1 : 0)

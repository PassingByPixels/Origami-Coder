import { Effect, Schema } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { McpBrowser } from "@/mcp/browser"
import { WebMcpBridge } from "@/webmcp/bridge"
import {
  readSites,
  resolveSite,
  unknownSite,
  webmcpPath,
  writeSites,
  type WebMcpEntry,
} from "./webmcp-store"
import * as Tool from "./tool"

/**
 * The WebMCP tools: the agent's half of the curated address book. The registry
 * model, the merge rule and the file itself live in webmcp-store.ts.
 *
 * Five verbs, because a browser-native MCP site needs things a config-declared
 * server does not: know it exists (`webmcp_list`), open it before its tools
 * exist at all (`webmcp_launch`), re-read a registry the page may change under
 * you (`webmcp_tools`), call what you found (`webmcp_call`), and bank what you
 * learned (`webmcp_note`).
 *
 * The launch/tools/call trio is served by `WebMcpBridge` over CDP. Where that
 * bridge cannot run — no Chromium on the machine — the launch degrades to
 * opening the URL and saying so rather than failing.
 *
 * Permission: the gate key is `webmcp`, not the tool id, so the user makes one
 * decision rather than one per verb — the same treatment the board tools take.
 * Consequence: `Permission.disabled` maps a tool to its own id, so a
 * deny-by-default agent naming `webmcp_launch: allow` still hits `"*": deny`
 * when the ask resolves `webmcp`; such an agent needs an explicit
 * `webmcp: allow` line, exactly as it needs `board: allow`.
 */

/** One metadata shape for all three tools, declared rather than inferred: each
 *  execute returns several result shapes (found / refused / empty) and inference
 *  would pin the type to whichever branch came first. */
type WebMcpMetadata = {
  registry?: string
  sites?: number
  site?: string
  url?: string
  /** Tools the page published on the read this result came from. */
  tools?: number
  /** Which global carried the registry, or "none"/"unavailable". */
  surface?: string
}

/**
 * The line every `webmcp_list` opens with. A model that has only seen
 * config-declared MCP servers would read these rows as endpoints it can already
 * call; the three facts here stop it — the page is the server, the tool list is
 * whatever the page publishes today, and `notes` is stale-able memory.
 */
export const LIST_HEADER = [
  "These are WebMCP sites: browser-native MCP servers where the PAGE ITSELF is the server.",
  "You cannot call one until it is open — webmcp_launch opens it and returns the tools it publishes,",
  "webmcp_tools re-reads them, and webmcp_call runs one. Discovery RE-RUNS on every read, so the notes below are advisory memory",
  "banked by earlier sessions, never a contract: trust what the site publishes today over what a note says.",
].join(" ")

const SITE_PARAM = Schema.String.annotate({
  description: "Registered site name (or its address), as listed by webmcp_list.",
})

/** One row of the list. Absent optional fields are omitted rather than shown
 *  empty — a "notes: " with nothing after it reads as "there are no tools". */
function siteLines(site: WebMcpEntry): string[] {
  const lines = [`- ${site.name}  ${site.url}`]
  if (site.purpose) lines.push(`  purpose: ${site.purpose}`)
  if (site.lastLaunched) lines.push(`  last opened: ${new Date(site.lastLaunched).toISOString().slice(0, 19)}Z`)
  if (site.notes) lines.push(`  notes (advisory): ${site.notes}`)
  return lines
}

// ============================== webmcp_list ==============================

export const ListParameters = Schema.Struct({})

const LIST_DESCRIPTION = [
  "List the WebMCP sites the user has registered: name, address, what each is for, and any notes",
  "an earlier session banked about it. WebMCP sites are web pages that ARE MCP servers, so a site",
  "has to be opened with webmcp_launch before its tools can be used.",
  "Read this before assuming a capability is unavailable — the site that provides it may just be closed.",
].join(" ")

export const WebmcpListTool = Tool.define<typeof ListParameters, WebMcpMetadata, FSUtil.Service>(
  "webmcp_list",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description: LIST_DESCRIPTION,
      parameters: ListParameters,
      // Read-only, so no ctx.ask: the gate belongs on opening a browser, not on
      // knowing what could be opened. Same treatment as board_repos.
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sites = yield* readSites(fs)
          if (!sites.length) {
            return {
              title: "webmcp_list: none",
              metadata: { registry: webmcpPath(), sites: 0 },
              output:
                `No WebMCP sites are registered (${webmcpPath()}).` +
                ` The user adds one in the MCP pane's Web MCP section.`,
            }
          }
          return {
            title: `webmcp_list: ${sites.length}`,
            metadata: { registry: webmcpPath(), sites: sites.length },
            output: [LIST_HEADER, "", ...sites.flatMap(siteLines)].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ========================= the discovered catalog =========================

/** Above this many tools the catalog lists names only, or a page publishing
 *  sixty schemas spends more context on one tool result than on the task.
 *  `webmcp_tools {detail:true}` is the deliberate way back to the full text. */
const NAMES_ONLY_ABOVE = 40

/** Per-tool caps for the summary form. Generous enough to be useful, small
 *  enough that thirty of them stay readable. */
const DESCRIPTION_CAP = 240
const SCHEMA_CAP = 400

function clip(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat
}

/**
 * The block the model reads after a launch or a tools call. Names and
 * descriptions first, schemas after: a model choosing a tool reads the list,
 * and only then needs the arguments for the one it picked.
 */
export function catalogText(site: WebMcpEntry, discovery: WebMcpBridge.Discovery, detail: boolean): string {
  const tools = discovery.tools
  if (!tools.length)
    return (
      `${site.name} (${site.url}) is open but publishes NO WebMCP tools right now` +
      (discovery.surface === "none"
        ? " — the page exposes no modelContext at all."
        : ` (surface: ${discovery.surface}).`) +
      (discovery.error ? ` The page's getTools() failed: ${discovery.error}` : "") +
      " Some pages register their tools after a user action; webmcp_tools re-reads them."
    )

  const head = [
    `${tools.length} tool${tools.length === 1 ? "" : "s"} published by ${site.name} (${discovery.pageUrl}),`,
    `read from ${discovery.surface}.`,
    discovery.pillCount !== undefined && discovery.pillCount !== tools.length
      ? `NOTE: the page's own status says ${discovery.pillCount} — it disagrees with what was read.`
      : "",
    "Call one with webmcp_call.",
  ]
    .filter(Boolean)
    .join(" ")

  if (!detail && tools.length > NAMES_ONLY_ABOVE)
    return [
      head,
      "",
      `Too many to describe here. Names only — call webmcp_tools {site: "${site.name}", detail: true} for descriptions and schemas.`,
      "",
      tools.map((tool) => tool.name).join(", "),
    ].join("\n")

  const lines = tools.map(
    (tool) =>
      `- ${tool.name} — ${detail ? tool.description.replace(/\s+/g, " ").trim() : clip(tool.description, DESCRIPTION_CAP)}`,
  )
  const schemas = tools
    .filter((tool) => tool.inputSchema)
    .map((tool) => {
      const json = JSON.stringify(tool.inputSchema)
      return `${tool.name}: ${detail ? json : clip(json, SCHEMA_CAP)}`
    })
  return [head, "", ...lines, ...(schemas.length ? ["", "Input schemas (JSON):", ...schemas] : [])].join("\n")
}

/** Where the page opened. Said once per launch, because a user told "it opened"
 *  who cannot find the tab in their own window has been told something untrue. */
const PROFILE_NOTE =
  "Opened in Origami's own WebMCP browser profile, not the user's main profile" +
  " — the tab is signed out and has none of their extensions."

// ============================= webmcp_launch =============================

export const LaunchParameters = Schema.Struct({ site: SITE_PARAM })

const LAUNCH_DESCRIPTION = [
  "Open a registered WebMCP site and read the tools it publishes.",
  "The page IS the MCP server: until it is open there is nothing to call. This returns the site's tool",
  "catalog — names, descriptions and input schemas — which you then call with webmcp_call.",
  "Use webmcp_list first to see which sites exist.",
].join(" ")

export const WebmcpLaunchTool = Tool.define<
  typeof LaunchParameters,
  WebMcpMetadata,
  FSUtil.Service | McpBrowser.Service | WebMcpBridge.Service
>(
  "webmcp_launch",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const browser = yield* McpBrowser.Service
    const bridge = yield* WebMcpBridge.Service
    return {
      description: LAUNCH_DESCRIPTION,
      parameters: LaunchParameters,
      execute: (params: Schema.Schema.Type<typeof LaunchParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sites = yield* readSites(fs)
          const site = resolveSite(sites, params.site)
          // The cheap refusal comes first, before the ask: prompting the user to
          // approve opening a site that does not exist has no right answer.
          if (!site) {
            return {
              title: "webmcp_launch: unknown site",
              metadata: { registry: webmcpPath(), site: params.site },
              output: unknownSite(params.site, sites),
            }
          }

          yield* ctx.ask({
            permission: "webmcp",
            patterns: [site.name],
            always: ["*"],
            metadata: { url: site.url },
          })

          // The bridge first, a plain open as the fallback. A machine with no
          // Chromium still gets its page but no discovery, and the result must
          // say so rather than claim tools were discovered.
          const opened = yield* bridge
            .launch(site.url)
            .pipe(Effect.catch((error) => Effect.succeed(error)))
          if (opened instanceof Error) {
            const failure = yield* browser.open(site.url).pipe(Effect.catch((error) => Effect.succeed(error)))
            if (failure) {
              return {
                title: "webmcp_launch: failed",
                metadata: { registry: webmcpPath(), site: site.name, url: site.url },
                output: `Could not open ${site.url}: ${failure.message}`,
              }
            }
            yield* writeSites(fs, [{ url: site.url, lastLaunched: Date.now() }]).pipe(Effect.ignore)
            return {
              title: `webmcp_launch: ${site.name} (no discovery)`,
              metadata: { registry: webmcpPath(), site: site.name, url: site.url, surface: "unavailable" },
              output:
                `Opened ${site.name} (${site.url}) in the default browser, but its tools could NOT be discovered` +
                ` and webmcp_call will not work on it: ${opened.message}` +
                `\nThe page is usable by the human; you cannot drive it. Say so rather than guessing what it offers.` +
                (site.purpose ? `\npurpose: ${site.purpose}` : "") +
                (site.notes ? `\nnotes (advisory, may be stale): ${site.notes}` : ""),
            }
          }

          const discovery = yield* bridge
            .discover(site.url)
            .pipe(Effect.catch((error) => Effect.succeed(error)))

          // Best effort, unlike every other write here: by this line the page is
          // open and the stamp is bookkeeping, so an unwritable home must not
          // fail a tool call that plainly succeeded.
          yield* writeSites(fs, [{ url: site.url, lastLaunched: Date.now() }]).pipe(Effect.ignore)

          if (discovery instanceof Error) {
            return {
              title: `webmcp_launch: ${site.name} (no catalog)`,
              metadata: { registry: webmcpPath(), site: site.name, url: site.url, surface: "unavailable" },
              output:
                `Opened ${site.name} (${site.url}). ${PROFILE_NOTE}` +
                `\nIts tool catalog could not be read: ${discovery.message}. Retry with webmcp_tools.`,
            }
          }

          return {
            title: `webmcp_launch: ${site.name} (${discovery.tools.length} tools)`,
            metadata: {
              registry: webmcpPath(),
              site: site.name,
              url: site.url,
              tools: discovery.tools.length,
              surface: discovery.surface,
            },
            output: [
              `Opened ${site.name} (${site.url}). ${PROFILE_NOTE}`,
              catalogText(site, discovery, false),
              site.purpose ? `purpose: ${site.purpose}` : "",
              site.notes ? `notes (advisory, may be stale): ${site.notes}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ============================== webmcp_tools ==============================

export const ToolsParameters = Schema.Struct({
  site: SITE_PARAM,
  detail: Schema.optional(Schema.Boolean).annotate({
    description:
      "Return full descriptions and full input schemas instead of the clipped summary." +
      " Needed when a site publishes more tools than the summary will describe.",
  }),
})

const TOOLS_DESCRIPTION = [
  "Re-read the tools a WebMCP site publishes RIGHT NOW, opening it if it is not already open.",
  "A page can register tools after it loads and can change them while you work, so read again",
  "rather than trusting a catalog from earlier in the session. Use detail:true for full schemas.",
].join(" ")

export const WebmcpToolsTool = Tool.define<typeof ToolsParameters, WebMcpMetadata, FSUtil.Service | WebMcpBridge.Service>(
  "webmcp_tools",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const bridge = yield* WebMcpBridge.Service
    return {
      description: TOOLS_DESCRIPTION,
      parameters: ToolsParameters,
      execute: (params: Schema.Schema.Type<typeof ToolsParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sites = yield* readSites(fs)
          const site = resolveSite(sites, params.site)
          if (!site) {
            return {
              title: "webmcp_tools: unknown site",
              metadata: { registry: webmcpPath(), site: params.site },
              output: unknownSite(params.site, sites),
            }
          }

          // Gated like launch, because it can have the effect of one: a site
          // that is not open gets opened to be read. Asking under the same
          // `webmcp` key means an `always` granted at launch already covers it.
          yield* ctx.ask({
            permission: "webmcp",
            patterns: [site.name],
            always: ["*"],
            metadata: { url: site.url },
          })

          const discovery = yield* bridge
            .discover(site.url)
            .pipe(Effect.catch((error) => Effect.succeed(error)))
          if (discovery instanceof Error) {
            return {
              title: `webmcp_tools: ${site.name} (unavailable)`,
              metadata: { registry: webmcpPath(), site: site.name, url: site.url, surface: "unavailable" },
              output: `Could not read the tools of ${site.name} (${site.url}): ${discovery.message}`,
            }
          }
          return {
            title: `webmcp_tools: ${site.name} (${discovery.tools.length})`,
            metadata: {
              registry: webmcpPath(),
              site: site.name,
              url: site.url,
              tools: discovery.tools.length,
              surface: discovery.surface,
            },
            output: catalogText(site, discovery, params.detail === true),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ============================== webmcp_call ==============================

export const CallParameters = Schema.Struct({
  site: SITE_PARAM,
  tool: Schema.String.annotate({
    description: "Name of one of the tools the site publishes, exactly as webmcp_launch or webmcp_tools listed it.",
  }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Arguments object matching that tool's input schema. Omit for a tool that takes none.",
  }),
})

const CALL_DESCRIPTION = [
  "Run one of a WebMCP site's tools in the open page and return its result.",
  "The site must be one webmcp_launch or webmcp_tools has listed — call the tool by the exact name",
  "it published, with arguments matching the input schema shown there.",
].join(" ")

export const WebmcpCallTool = Tool.define<typeof CallParameters, WebMcpMetadata, FSUtil.Service | WebMcpBridge.Service>(
  "webmcp_call",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const bridge = yield* WebMcpBridge.Service
    return {
      description: CALL_DESCRIPTION,
      parameters: CallParameters,
      execute: (params: Schema.Schema.Type<typeof CallParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sites = yield* readSites(fs)
          const site = resolveSite(sites, params.site)
          if (!site) {
            return {
              title: "webmcp_call: unknown site",
              metadata: { registry: webmcpPath(), site: params.site },
              output: unknownSite(params.site, sites),
            }
          }

          yield* ctx.ask({
            permission: "webmcp",
            patterns: [site.name],
            always: ["*"],
            metadata: { url: site.url },
          })

          const outcome = yield* bridge
            .call(site.url, params.tool, params.args ?? {})
            .pipe(Effect.catch((error) => Effect.succeed(error)))
          if (outcome instanceof Error) {
            return {
              title: `webmcp_call: ${params.tool} (unavailable)`,
              metadata: { registry: webmcpPath(), site: site.name, url: site.url },
              output: `Could not reach ${site.name} (${site.url}) to call ${params.tool}: ${outcome.message}`,
            }
          }
          if (!outcome.ok) {
            // A refusal from the page, reported as text: the page is the server,
            // so its "no such tool" is an answer, not a transport failure.
            return {
              title: `webmcp_call: ${params.tool} refused`,
              metadata: { registry: webmcpPath(), site: site.name, url: site.url },
              output:
                `${site.name} refused ${params.tool}: ${outcome.error ?? "no reason given"}` +
                (outcome.known?.length ? `\nTools it publishes: ${outcome.known.join(", ")}` : ""),
            }
          }
          return {
            title: `webmcp_call: ${params.tool}`,
            metadata: { registry: webmcpPath(), site: site.name, url: site.url },
            output: outcome.result?.trim() ? outcome.result : `${params.tool} returned no content.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ============================== webmcp_note ==============================

export const NoteParameters = Schema.Struct({
  site: SITE_PARAM,
  notes: Schema.String.annotate({
    description:
      "What a later session should know about this site: the tools it exposed, how they wanted to be called," +
      " what did not work. REPLACES the stored note, so restate anything still true. Empty clears it.",
  }),
})

const NOTE_DESCRIPTION = [
  "Bank what you learned about a WebMCP site so a later session starts informed:",
  "which tools it exposed, how to call them, what failed.",
  "This REPLACES the site's stored note. Notes are advisory memory, not a contract —",
  "the site is still re-discovered on every join.",
].join(" ")

export const WebmcpNoteTool = Tool.define<typeof NoteParameters, WebMcpMetadata, FSUtil.Service>(
  "webmcp_note",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description: NOTE_DESCRIPTION,
      parameters: NoteParameters,
      execute: (params: Schema.Schema.Type<typeof NoteParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sites = yield* readSites(fs)
          const site = resolveSite(sites, params.site)
          if (!site) {
            return {
              title: "webmcp_note: unknown site",
              metadata: { registry: webmcpPath(), site: params.site },
              output: unknownSite(params.site, sites),
            }
          }

          yield* ctx.ask({
            permission: "webmcp",
            patterns: [site.name],
            always: ["*"],
            metadata: { url: site.url },
          })

          // Collapsed to one line: the note is read back inside a list where
          // every other field is one line.
          const notes = params.notes.replace(/\s+/g, " ").trim()
          yield* writeSites(fs, [{ url: site.url, notes }])
          return {
            title: `webmcp_note: ${site.name}`,
            metadata: { registry: webmcpPath(), site: site.name, url: site.url },
            output: notes
              ? `Noted against ${site.name} (${site.url}): ${notes}`
              : `Cleared the note on ${site.name} (${site.url}).`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

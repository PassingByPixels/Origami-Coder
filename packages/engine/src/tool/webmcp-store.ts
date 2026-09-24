import path from "path"
import { Effect, Semaphore } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { registryTextForWrite } from "./board-store"

/**
 * WebMCP registry — the curated address book of browser-native MCP sites, where
 * the page itself is the server so nothing can be discovered from a config file.
 *
 * The notes are advisory, never a contract: a page can change its tools between
 * two visits, so discovery re-runs on every join and `notes` is only memory.
 *
 * `~/.origami/webmcp.json` is shared with the VS Code MCP pane
 * (src/dashboard/webmcpFile.ts), so both sides write it under one rule, the
 * same one repos.json follows: read the current text -> merge onto the RAW
 * parsed JSON -> change only the fields the patch names -> write atomically
 * (tmp + rename). Merging on the raw JSON rather than a projected
 * `WebMcpEntry` list is the point: each writer carries keys the other has never
 * heard of, and projecting and re-emitting would delete every one of them.
 */

/** Registry of WebMCP sites the user has curated. Shared with the extension. */
export const WEBMCP_FILE = "webmcp.json"

/** `~/.origami/webmcp.json`. A getter, so it honours ORIGAMI_TEST_HOME. */
export function webmcpPath(): string {
  return path.join(Global.Path.origami, WEBMCP_FILE)
}

export type WebMcpEntry = {
  /** Normalised address — the entry's identity. See {@link normalizeUrl}. */
  readonly url: string
  /** Short handle the tools resolve by, and what the ask gate names. */
  readonly name: string
  /** What the site is for, in one line. */
  readonly purpose: string
  readonly addedAt: number
  /** Advisory memory banked by `webmcp_note`. Never a contract — see the header. */
  readonly notes?: string
  /** Epoch ms of the last `webmcp_launch`. Absent = never opened from here. */
  readonly lastLaunched?: number
}

/**
 * Comparable form of an address, and the entry's identity. `new URL` already
 * lowercases the scheme and host and drops a default port, so only the empty
 * path a bare origin grows is left to settle: `https://a.com` and
 * `https://a.com/` are one site. A query or a fragment is kept — a hash route
 * (`#/mcp`) names a different page. `undefined` for anything that is not an
 * http(s) URL, since a `file:` or a bare word gives a row that can never open.
 */
export function normalizeUrl(raw: string | undefined): string | undefined {
  const text = (raw ?? "").trim()
  if (!text) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  const bare = url.pathname === "/" && !url.search && !url.hash
  return bare ? `${url.protocol}//${url.host}` : `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`
}

/**
 * Parse `webmcp.json`. Anything unreadable reads as no sites rather than an
 * error, so a tool does not die because the user never opened the MCP pane. An
 * entry whose `url` is not an http(s) address is dropped: it cannot be launched.
 */
export function parseSites(text: string | undefined): WebMcpEntry[] {
  if (!text?.trim()) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof data !== "object" || data === null || !("sites" in data)) return []
  const list = data.sites
  if (!Array.isArray(list)) return []
  const out: WebMcpEntry[] = []
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue
    const url = normalizeUrl("url" in item && typeof item.url === "string" ? item.url : undefined)
    if (!url) continue
    const name = "name" in item && typeof item.name === "string" ? item.name.trim() : ""
    const purpose = "purpose" in item && typeof item.purpose === "string" ? item.purpose.trim() : ""
    const notes = "notes" in item && typeof item.notes === "string" ? item.notes.trim() : ""
    const addedAt = "addedAt" in item && typeof item.addedAt === "number" ? item.addedAt : 0
    const lastLaunched = "lastLaunched" in item && typeof item.lastLaunched === "number" ? item.lastLaunched : 0
    out.push({
      url,
      // A nameless entry still has to be addressable; the host always exists.
      name: name || new URL(url).host,
      purpose,
      addedAt,
      ...(notes ? { notes } : {}),
      ...(lastLaunched ? { lastLaunched } : {}),
    })
  }
  return out
}

/** Read and parse the registry. */
export function readSites(fs: FSUtil.Interface) {
  return Effect.gen(function* () {
    const text = yield* fs.readFileStringSafe(webmcpPath()).pipe(Effect.catch(() => Effect.succeed(undefined)))
    return parseSites(text)
  })
}

/** One registry change: the `url` that identifies the entry, plus the fields to
 *  set. Anything the patch does not name keeps the value it already had. */
export type WebMcpPatch = { readonly url: string } & Partial<Omit<WebMcpEntry, "url">>

/**
 * Merge patches into the text of webmcp.json. Works on the raw parsed JSON,
 * never on the projected `WebMcpEntry` list, for the reason the header gives.
 * A readable object whose `sites` is unusable keeps every other top-level key.
 */
export function mergeSitesText(text: string | undefined, patches: readonly WebMcpPatch[]): string {
  let parsed: unknown
  try {
    parsed = text?.trim() ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  const doc: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {}
  const list = Array.isArray(doc.sites) ? [...doc.sites] : []

  for (const patch of patches) {
    const url = normalizeUrl(patch.url)
    if (!url) continue
    const { url: _raw, ...fields } = patch
    // Drop undefined so a patch that simply omits a field cannot write a null
    // over the value already on disk.
    const set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
    const at = list.findIndex((item) => {
      if (typeof item !== "object" || item === null) return false
      const other = (item as { url?: unknown }).url
      return typeof other === "string" && normalizeUrl(other) === url
    })
    if (at === -1) list.push({ url, ...set })
    else list[at] = { ...(list[at] as Record<string, unknown>), ...set }
  }

  // `version` is what the extension's reader gates on: a file without it reads
  // as "no prior file" over there, and every addedAt gets re-dated on its next
  // rewrite. Stamp it when it is missing, never overwrite one already there.
  if (typeof doc.version !== "number") doc.version = 1
  doc.sites = list
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * The registry's write mutex: one file, one semaphore, in-process only. It
 * serialises the read-modify-write inside one engine, where the lost-update risk
 * is; cross-process safety is the atomic rename plus the shared merge rule.
 */
const lock = Semaphore.makeUnsafe(1)

/** Merge patches into `~/.origami/webmcp.json` — the engine's only write path
 *  to the registry: atomic (tmp + rename, so a reader mid-write never sees half
 *  a file) and serialised on the lock above. */
export function writeSites(fs: FSUtil.Interface, patches: readonly WebMcpPatch[]) {
  const file = webmcpPath()
  return lock.withPermits(1)(
    Effect.gen(function* () {
      const existed = yield* fs.existsSafe(file)
      const read = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      // Same guard as repos.json (board-store.ts): a file that exists but could
      // not be read must refuse the write, not merge from `undefined` and wipe
      // every other registered site down to just this patch.
      const text = yield* registryTextForWrite(file, existed, read)
      const next = mergeSitesText(text, patches)
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(temp, next).pipe(
        Effect.andThen(fs.rename(temp, file)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(temp, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      return parseSites(next)
    }),
  )
}

/** Resolve a tool's `site` parameter: by name first (what the list shows and the
 *  ask gate names), then case-folded, then by address. There is no "." form — a
 *  WebMCP site is never implied by the session's own checkout. */
export function resolveSite(sites: readonly WebMcpEntry[], param: string | undefined): WebMcpEntry | undefined {
  const raw = (param ?? "").trim()
  if (!raw) return undefined
  const exact = sites.find((site) => site.name === raw)
  if (exact) return exact
  const folded = sites.find((site) => site.name.toLowerCase() === raw.toLowerCase())
  if (folded) return folded
  const url = normalizeUrl(raw)
  return url ? sites.find((site) => site.url === url) : undefined
}

/** The refusal for a site nobody has registered. A refusal string, not an error:
 *  the model has to read which sites it may open and pick one, and a thrown
 *  error reads as a broken tool. */
export function unknownSite(raw: string, sites: readonly WebMcpEntry[]): string {
  const known = sites.length ? sites.map((site) => site.name).join(", ") : "(none)"
  return (
    `Refused: no WebMCP site "${raw}" is registered. Registered: ${known}.` +
    ` Call webmcp_list to see them. A new site is added by the user, in the MCP pane's Web MCP section.`
  )
}

export * as WebMcpStore from "./webmcp-store"

// THE WHOLE ARTIFACT ROUTE, as one pure function: a pathname and a Host in,
// a status, headers and bytes out. Same shape as `flock/owner-http.ts` and for
// the same reason — the Effect wiring on the engine's server (server.ts) then
// has nothing in it to get wrong, and this file is testable without a router.
//
// `GET /artifact/<contentToken>/<path>`
//
// THE TOKEN IS THE ONLY ADDRESS. This route is deliberately NOT behind the
// server's authorization middleware: the page is opened by the VS Code
// integrated browser, which sends no Basic credentials and cannot be told to,
// so a route behind the auth layer would 401 every artifact the moment the
// owner set a server password. What stands in its place is the per-VERSION
// random token the store mints (24 base64url characters, `mintToken` in
// store.ts) — unguessable, published to nobody, and dead the moment a new
// version lands.
//
// AND THE REQUEST MUST STILL BE LOCAL. `--hostname` (and mDNS, which defaults
// it to 0.0.0.0 — cli/network.ts) can bind this server to a LAN address, and
// on such a server an unauthenticated route would be reachable from the
// network. So the request has to pass TWO checks, and each answers a different
// attack:
//
//   * the SOCKET's remote address must be loopback. It cannot be spoofed by
//     the client, so it is what stops a LAN caller — including one that sends
//     HTTP/1.0 with no Host header at all, which a Host-only check would wave
//     through.
//   * the HOST header, when there is one, must be a loopback name. That is
//     what stops DNS rebinding: a page on evil.com whose name resolves to
//     127.0.0.1 arrives over a loopback socket and is refused on its Host.
//
// Either one ABSENT is the in-process case (`Server.Default().app`, which has
// no socket and no Host), and that caller is this machine by construction.
// Anything that fails a check it can be held to is a 404: off this machine,
// the route does not exist.
//
// NOTHING HERE TOUCHES THE FILESYSTEM BY PATH. The path in the URL is only
// ever a manifest LOOKUP key (`store.resolveToken`, which re-validates it);
// the file that is read is `blobs/<sha256>`, a name the store computed. A
// traversal cannot express itself in that pipeline — there is no `path.join`
// with anything the caller sent.

import fs from "node:fs/promises"
import { AgentBroker } from "@/origami/agent-broker"
import { artifactStore } from "./instance"

export const PREFIX = "/artifact/"

/** A year, which is what "forever" is spelled as on the wire. Safe at any
 *  length because the token changes with the version: the bytes behind one
 *  token can never change, so a cached copy can never be stale. */
export const CACHE_CONTROL = "public, max-age=31536000, immutable"

/**
 * THE PAGE IS NOT THIS ORIGIN'S. An artifact is agent-written HTML served from
 * `http://127.0.0.1:<port>`, which is ALSO the engine's API and its web UI — so
 * without this header a script in an artifact could `fetch` the engine's own
 * routes as a same-origin caller, and on a server with no password set that is
 * the whole API. `sandbox` drops the page into an OPAQUE origin: same-origin
 * requests, cookies, `localStorage`/`sessionStorage`, form submission and
 * top-level navigation all stop being available to it.
 *
 * `allow-scripts` and NOTHING ELSE. An artifact is a page with charts and
 * interactions, so scripts have to run; `allow-same-origin` would hand the
 * origin straight back and undo the whole header, so it is the one token that
 * must never appear here.
 */
export const SANDBOX = "sandbox allow-scripts"

/** No MIME sniffing. The manifest's media type is the only answer; a browser
 *  that sniffed a `.txt` artifact into HTML would run it as a page. */
export const NO_SNIFF = "nosniff"

/** On EVERY answer, 200 and 404 alike: a 404 body is JSON this origin wrote,
 *  and it is cheaper to have one header set than to reason about which
 *  responses need it. */
const guardHeaders = {
  "content-security-policy": SANDBOX,
  "x-content-type-options": NO_SNIFF,
} as const

export interface Served {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body?: Uint8Array
}

const notFound: Served = {
  status: 404,
  headers: { "content-type": "application/json", ...guardHeaders },
  body: new TextEncoder().encode(JSON.stringify({ error: "Not Found" })),
}

/** `127.0.0.1:53124` -> loopback. A LAN address, or a name that is not one of
 *  the four loopback spellings -> not. */
export function isLocalHost(host: string): boolean {
  return AgentBroker.isLoopback(`http://${host}`)
}

/** A SOCKET address, which is a bare IP and not a URL host: `127.0.0.1`,
 *  `::1`, or the IPv4-mapped `::ffff:127.0.0.1` a dual-stack listener reports.
 *  The whole of `127.0.0.0/8` is loopback, not just `.0.1`. */
export function isLocalAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase()
  return /^127\./.test(bare) || bare === "::1" || /^::ffff:127\./.test(bare)
}

/** Both checks, each skipped only when the request carries nothing to check. */
export function isLocalRequest(input: { host?: string; remoteAddress?: string }): boolean {
  if (input.remoteAddress !== undefined && !isLocalAddress(input.remoteAddress)) return false
  if (input.host !== undefined && !isLocalHost(input.host)) return false
  return true
}

/** `/artifact/<token>/<path>` split into its two halves, or `undefined` when
 *  the URL is not one of ours. Each segment is percent-decoded (a page with a
 *  space in a filename asks for `my%20page.html`); a decode that throws is not
 *  a path this store could hold, so it is simply not found. */
export function parse(pathname: string): { token: string; filePath: string } | undefined {
  if (!pathname.startsWith(PREFIX)) return undefined
  const rest = pathname.slice(PREFIX.length)
  const slash = rest.indexOf("/")
  if (slash <= 0 || slash === rest.length - 1) return undefined
  try {
    const token = decodeURIComponent(rest.slice(0, slash))
    const filePath = rest
      .slice(slash + 1)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/")
    if (!token || !filePath) return undefined
    return { token, filePath }
  } catch {
    return undefined
  }
}

export async function serve(input: { pathname: string; host?: string; remoteAddress?: string }): Promise<Served> {
  if (!isLocalRequest(input)) return notFound
  const parsed = parse(input.pathname)
  if (!parsed) return notFound
  const found = (await artifactStore()).resolveToken(parsed.token, parsed.filePath)
  if (!found) return notFound
  const body = await fs.readFile(found.blobPath).catch(() => undefined)
  // A row whose blob was pruned (or never arrived from another device) is a
  // 404 rather than a 500: the version exists, this body does not — and the
  // viewer's answer to both is the same page that says so.
  if (!body) return notFound
  return {
    status: 200,
    headers: {
      "content-type": found.entry.mediaType,
      "content-length": String(body.byteLength),
      // The manifest's sha256 IS the entity tag. Strong, quoted, and equal
      // across devices, because it is the content.
      etag: `"${found.entry.sha256}"`,
      "cache-control": CACHE_CONTROL,
      ...guardHeaders,
    },
    body: new Uint8Array(body),
  }
}

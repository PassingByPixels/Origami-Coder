// THE ARTIFACT ROUTE IS ACTUALLY ON THE ENGINE'S SERVER — and is reachable
// with no credentials, which is the whole point of it.
//
// `store.test.ts` proves the store. This boots the REAL route tree
// (`Server.Default().app`, the same entry `flock/owner-route.test.ts` uses)
// and asks it for a token minted by a real publish, because that is where the
// wiring can silently be wrong in three ways that all look like "the page did
// not load":
//
//   1. a raw `HttpRouter.use` route registered AFTER the `*` `/*` UI fallback
//      never runs — the fallback answers first;
//   2. a route registered WITH the authorization layer 401s the integrated
//      browser, which sends no Basic credentials and cannot be told to. The
//      `app({ password })` handler below configures a password and proves the
//      artifact still answers while `/doc` does not;
//   3. a Host check that reads a header the router does not thread would 404
//      every artifact on a correctly-bound server.
//
// The bodies asserted here are the bytes a publish wrote, read back through
// the route, so a wrong blob or a lost content-type is a failure and not a
// detail.
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { artifactStore, resetArtifactStore } from "@/artifact/instance"
import * as ArtifactServe from "@/artifact/serve"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { Server } from "@/server/server"

const PAGE = "<!doctype html><title>lane 2</title>"
const STYLE = "body { color: rebeccapurple }"

const bytes = (text: string) => new TextEncoder().encode(text)
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-serve-"))
resetArtifactStore()
const store = await artifactStore(root)

const published = store.publish({
  title: "Lane 2",
  files: [
    { path: "index.html", bytes: bytes(PAGE) },
    { path: "style.css", bytes: bytes(STYLE) },
  ],
  baseVersion: "absent",
  idempotencyKey: "serve-test-1",
})
if (published.kind !== "published") throw new Error("fixture publish did not publish")
const TOKEN = published.contentToken

// Same GC-and-retry shape as store.test.ts: Windows holds the WAL handle until
// the driver's finalizer runs.
afterAll(async () => {
  resetArtifactStore()
  try {
    store.close()
  } catch {}
  Bun.gc(true)
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EBUSY" && code !== "EPERM") throw error
      Bun.gc(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})

const get = (pathname: string) => Server.Default().app.request(pathname)

test("GET /artifact/<token>/<path> answers with the blob, its media type, the sha256 ETag and an immutable cache", async () => {
  const response = await get(`/artifact/${TOKEN}/index.html`)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(PAGE)
  expect(response.headers.get("content-type")).toBe("text/html")
  expect(response.headers.get("etag")).toBe(`"${sha256(PAGE)}"`)
  expect(response.headers.get("cache-control")).toBe(ArtifactServe.CACHE_CONTROL)
})

test("a second file of the same version is served under its own media type", async () => {
  const response = await get(`/artifact/${TOKEN}/style.css`)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(STYLE)
  expect(response.headers.get("content-type")).toBe("text/css")
  expect(response.headers.get("etag")).toBe(`"${sha256(STYLE)}"`)
})

test("a wrong token is 404, and says nothing about whether the artifact exists", async () => {
  const response = await get(`/artifact/${"x".repeat(TOKEN.length)}/index.html`)
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: "Not Found" })
})

test("a path this version does not contain is 404", async () => {
  const response = await get(`/artifact/${TOKEN}/nothing-here.html`)
  expect(response.status).toBe(404)
})

test("a traversal is 404 and the file it points at is never read", async () => {
  // Percent-encoded, so the URL parser cannot collapse it before the route
  // sees it: this is the shape a traversal has to take to reach the handler.
  const response = await get(`/artifact/${TOKEN}/%2e%2e%2f%2e%2e%2fartifacts.db`)
  expect(response.status).toBe(404)
  const body = await response.text()
  expect(body).toBe(JSON.stringify({ error: "Not Found" }))
  expect(body).not.toContain("SQLite")
})

test("an absolute path and a bare token with no file are 404", async () => {
  expect((await get(`/artifact/${TOKEN}//etc/passwd`)).status).toBe(404)
  expect((await get(`/artifact/${TOKEN}`)).status).toBe(404)
  expect((await get(`/artifact/${TOKEN}/`)).status).toBe(404)
})

// ------------------------------------------------------------- sandbox

test("every answer carries the sandbox CSP and nosniff — html, css and the 404 alike", async () => {
  // The page is agent-written HTML on the SAME ORIGIN as the engine's API, so
  // without `sandbox` a script in it could call that API as a same-origin
  // caller. Asserted on all three because the header is set in one place and a
  // future branch that builds its own response is exactly how one of them
  // silently loses it.
  for (const pathname of [`/artifact/${TOKEN}/index.html`, `/artifact/${TOKEN}/style.css`, `/artifact/${TOKEN}/gone`]) {
    const response = await get(pathname)
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  }
})

test("the sandbox never hands the origin back", () => {
  // `allow-same-origin` is the ONE token that would undo the header entirely:
  // a sandboxed page that keeps its origin can fetch the engine's API, read
  // its cookies and write its localStorage. Asserted on the exact value, not
  // by a substring search, so a rewrite has to be read by a person.
  expect(ArtifactServe.SANDBOX).toBe("sandbox allow-scripts")
  expect(ArtifactServe.SANDBOX).not.toContain("allow-same-origin")
  expect(ArtifactServe.NO_SNIFF).toBe("nosniff")
})

// ---------------------------------------------------------------- auth

/** The `httpapi-ui.test.ts` handler shape: the real route tree with a server
 *  password configured, so "does this route sit behind the auth layer" has an
 *  observable answer. */
function app(password: string) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ORIGAMI_SERVER_PASSWORD: password })),
      ),
    ),
    { disableLogger: true },
  ).handler
  return (pathname: string) =>
    Effect.runPromise(
      Effect.promise(() =>
        Promise.resolve(handler(new Request(new URL(pathname, "http://localhost")), HttpApiApp.context)),
      ),
    )
}

test("the artifact route answers WITHOUT credentials on a password-protected server, where /doc does not", async () => {
  const request = app("hunter2")
  // The control: an authenticated raw route on the same tree, same call, no headers.
  expect((await request("/doc")).status).toBe(401)
  const response = await request(`/artifact/${TOKEN}/index.html`)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(PAGE)
})

// ------------------------------------------------------------- loopback

test("the route refuses a request that did not come from this machine", async () => {
  // `--hostname` (and mDNS, which defaults it to 0.0.0.0) can bind this server
  // to a LAN address. On such a server the token would otherwise be the only
  // thing between the network and the artifact.
  const entry = `/artifact/${TOKEN}/index.html`
  const lanSocket = await ArtifactServe.serve({ pathname: entry, host: "127.0.0.1:4096", remoteAddress: "192.168.1.20" })
  expect(lanSocket.status).toBe(404)
  expect(lanSocket.body && new TextDecoder().decode(lanSocket.body)).toBe(JSON.stringify({ error: "Not Found" }))
  // DNS rebinding: the socket IS loopback and the Host is not this machine.
  const rebound = await ArtifactServe.serve({ pathname: entry, host: "evil.example.com", remoteAddress: "127.0.0.1" })
  expect(rebound.status).toBe(404)
  // A LAN caller that sends no Host at all (HTTP/1.0) is still refused, which
  // a Host-only check would have waved through.
  expect((await ArtifactServe.serve({ pathname: entry, remoteAddress: "10.0.0.5" })).status).toBe(404)
  // The same call from this machine is the 200 the route returns, which is
  // what makes the three 404s above about the caller and nothing else.
  const local = await ArtifactServe.serve({ pathname: entry, host: "127.0.0.1:4096", remoteAddress: "::ffff:127.0.0.1" })
  expect(local.status).toBe(200)
})

test("every loopback spelling is local and nothing else is", () => {
  for (const host of ["127.0.0.1:4096", "localhost:1", "[::1]:7", "localhost"]) {
    expect(ArtifactServe.isLocalHost(host)).toBe(true)
  }
  for (const host of ["", "10.0.0.5:4096", "origami.local:4096", "127.0.0.1.evil.com"]) {
    expect(ArtifactServe.isLocalHost(host)).toBe(false)
  }
  for (const address of ["127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1"]) {
    expect(ArtifactServe.isLocalAddress(address)).toBe(true)
  }
  for (const address of ["10.0.0.5", "192.168.1.20", "::ffff:10.0.0.5", "1.127.0.0"]) {
    expect(ArtifactServe.isLocalAddress(address)).toBe(false)
  }
  // Nothing to check is the in-process caller, which is this machine.
  expect(ArtifactServe.isLocalRequest({})).toBe(true)
})

test("the url shape parses into a token and a store path, or into nothing", () => {
  expect(ArtifactServe.parse("/artifact/abc/index.html")).toEqual({ token: "abc", filePath: "index.html" })
  expect(ArtifactServe.parse("/artifact/abc/assets/app%20one.js")).toEqual({
    token: "abc",
    filePath: "assets/app one.js",
  })
  expect(ArtifactServe.parse("/artifact/abc")).toBeUndefined()
  expect(ArtifactServe.parse("/artifacts/abc/x")).toBeUndefined()
  expect(ArtifactServe.parse("/artifact//x")).toBeUndefined()
})

import { describe, expect } from "bun:test"
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  Server,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
} from "@modelcontextprotocol/server"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"

const it = testEffect(LayerNode.compile(MCP.node))

interface Recorded {
  readonly headers: Headers
  readonly body: unknown
}

/**
 * A 2025-era STATEFUL server: `initialize` handshake plus an `Mcp-Session-Id`
 * on every subsequent request. This is the shape the retired session-recovery
 * patch existed for, and the shape `versionNegotiation: { mode: 'auto' }` has to
 * keep reaching by falling back after the `server/discover` probe is refused.
 */
const legacyServer = Effect.acquireRelease(
  Effect.promise(async () => {
    const seen: Recorded[] = []
    const protocol = new Server({ name: "legacy-stateful", version: "1.0.0" }, { capabilities: { tools: {} } })
    protocol.setRequestHandler("tools/list", () => Promise.resolve({ tools: [] }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      // A session id generator is what makes this server stateful, i.e. 2025.
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const http = Bun.serve({
      port: 0,
      async fetch(request) {
        const clone = request.clone()
        seen.push({ headers: new Headers(request.headers), body: await clone.json().catch(() => undefined) })
        return transport.handleRequest(request)
      },
    })
    return {
      seen,
      url: http.url.toString(),
      close: async () => {
        await http.stop(true)
        await protocol.close()
      },
    }
  }),
  (server) => Effect.promise(server.close),
)

/**
 * A 2026-07-28 STATELESS server, built by the SDK's own `createMcpHandler` so
 * the wire traffic is whatever the spec actually produces rather than whatever
 * this test imagines it produces.
 */
const modernServer = Effect.acquireRelease(
  Effect.promise(async () => {
    const seen: Recorded[] = []
    const handler = createMcpHandler(() => {
      const protocol = new Server({ name: "modern-stateless", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler("tools/list", () => Promise.resolve({ tools: [] }))
      return protocol
    })
    const http = Bun.serve({
      port: 0,
      async fetch(request) {
        const clone = request.clone()
        seen.push({ headers: new Headers(request.headers), body: await clone.json().catch(() => undefined) })
        return handler.fetch(request)
      },
    })
    return {
      seen,
      url: http.url.toString(),
      close: async () => {
        await http.stop(true)
        await handler.close()
      },
    }
  }),
  (server) => Effect.promise(server.close),
)

const meta = (entry: Recorded) =>
  (entry.body as { params?: { _meta?: Record<string, unknown> } } | undefined)?.params?._meta

describe("mcp protocol era", () => {
  it.instance("a 2025 stateful server still connects, on the legacy era", () =>
    Effect.gen(function* () {
      const server = yield* legacyServer
      const mcp = yield* MCP.Service

      const result = yield* mcp.add("legacy", { type: "remote", url: server.url })

      // The whole point of the fallback: connected, and connected as legacy.
      expect(result.status).toMatchObject({ legacy: { status: "connected", era: "legacy" } })
      // The legacy handshake ran: an `initialize` reached the server and it
      // handed back the session id that identifies a stateful 2025 connection.
      const bodies = server.seen.map((entry) => (entry.body as { method?: string } | undefined)?.method)
      expect(bodies).toContain("initialize")
      expect(server.seen.some((entry) => entry.headers.has("mcp-session-id"))).toBe(true)
    }),
  )

  it.instance("a 2026-07-28 stateless server connects on the modern era", () =>
    Effect.gen(function* () {
      const server = yield* modernServer
      const mcp = yield* MCP.Service

      const result = yield* mcp.add("modern", { type: "remote", url: server.url })

      expect(result.status).toMatchObject({ modern: { status: "connected", era: "modern" } })
      // Stateless: no session handshake at all.
      const methods = server.seen.map((entry) => (entry.body as { method?: string } | undefined)?.method)
      expect(methods).toContain("server/discover")
      expect(methods).not.toContain("initialize")
      expect(server.seen.every((entry) => !entry.headers.has("mcp-session-id"))).toBe(true)
    }),
  )

  it.instance("the SDK attaches the routing headers and the _meta envelope on the modern era", () =>
    Effect.gen(function* () {
      const server = yield* modernServer
      const mcp = yield* MCP.Service

      yield* mcp.add("modern-headers", { type: "remote", url: server.url })

      // Header-based routing (Mcp-Method / Mcp-Name) is SDK-managed: assert it
      // ARRIVES, not that we built it. Constructing it here would only prove
      // this test can concatenate strings.
      const routed = server.seen.filter((entry) => entry.headers.has("mcp-method"))
      expect(routed.length).toBeGreaterThan(0)
      expect(routed.map((entry) => entry.headers.get("mcp-method"))).toContain("tools/list")

      // Same for the per-request `_meta` envelope that replaced the handshake:
      // protocol version, client identity and client capabilities now ride on
      // every request instead of being negotiated once.
      const enveloped = server.seen.filter((entry) => meta(entry) !== undefined)
      expect(enveloped.length).toBeGreaterThan(0)
      for (const entry of enveloped) {
        const envelope = meta(entry)!
        expect(envelope[PROTOCOL_VERSION_META_KEY]).toBeDefined()
        expect(envelope[CLIENT_INFO_META_KEY]).toBeDefined()
        expect(envelope[CLIENT_CAPABILITIES_META_KEY]).toBeDefined()
      }
    }),
  )
})

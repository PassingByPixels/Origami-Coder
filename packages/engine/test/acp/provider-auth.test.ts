import { afterEach, describe, expect, test } from "bun:test"
import { AgentSideConnection, type AnyMessage, type Stream } from "@agentclientprotocol/sdk"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import type { Hooks } from "@origami/plugin"
import { ACP } from "@/acp/agent"
import type * as ACPService from "@/acp/service"
import { ACPProviderAuth } from "@/acp/provider-auth"
import { Auth } from "@/auth"
import { Plugin } from "../../src/plugin/index"
import { ProviderAuth } from "@/provider/auth"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * The three provider-OAuth ACP ext methods. They are thin proxies over
 * `ProviderAuth.Service`, so what is worth testing is exactly the part they
 * ADD over it:
 *
 *   - `list` reports credential TYPES and never a token
 *   - `authorize` returns while the plugin is still waiting for the browser
 *   - `authorize` refuses a SECOND flow for the same provider (both real
 *     plugins bind a fixed loopback port and keep module-level pending state,
 *     so a second flow supersedes the first instead of running beside it)
 *   - the guard is released whether the flow succeeds or fails, or a failed
 *     sign-in would lock the provider out until the engine restarted
 *   - a "code" method's pasted code reaches the plugin's own callback
 *
 * No network, no browser, no real sign-in: the plugin here is a stub with the
 * same `Hooks["auth"]` shape codex.ts / xai.ts implement, and its promises are
 * resolved by the test.
 */

type Resolve = (value: unknown) => void

interface StubFlow {
  /** Resolve the plugin's `callback()` — stands in for the browser redirect. */
  finish: Resolve
  /** The code the "code" method's callback was handed, if any. */
  codeSeen: string[]
  authorizeCalls: number
}

/** A plugin auth hook shaped exactly like the shipped ones: browser (auto),
 *  paste-a-code, then a plain API-key entry. */
function stubPlugin(flow: StubFlow, options: { authorizeThrows?: string } = {}): Hooks {
  const pending = () =>
    new Promise((resolve) => {
      flow.finish = resolve as Resolve
    })
  return {
    auth: {
      provider: "stubprov",
      methods: [
        {
          label: "Stub browser sign-in",
          type: "oauth",
          authorize: async () => {
            flow.authorizeCalls++
            if (options.authorizeThrows) throw new Error(options.authorizeThrows)
            const wait = pending()
            return {
              url: "https://auth.stub.test/authorize?code_challenge=x",
              instructions: "Complete authorization in your browser.",
              method: "auto" as const,
              callback: async () => (await wait) as { type: "success" },
            }
          },
        },
        {
          label: "Stub paste-a-code sign-in",
          type: "oauth",
          authorize: async () => {
            flow.authorizeCalls++
            return {
              url: "https://auth.stub.test/device",
              instructions: "Enter code: ABCD-1234",
              method: "code" as const,
              callback: async (code?: string) => {
                flow.codeSeen.push(code ?? "")
                return {
                  type: "success" as const,
                  refresh: "r-code",
                  access: "a-code",
                  expires: 4_000,
                }
              },
            }
          },
        },
        { label: "Manually enter API Key", type: "api" },
      ],
    },
  } as unknown as Hooks
}

/** A writable in-memory credential store, so a callback's PERSISTENCE is observable. */
function authStore(initial: Record<string, Auth.Info> = {}) {
  const data: Record<string, Auth.Info> = { ...initial }
  const layer = Layer.mock(Auth.Service)({
    all: () => Effect.succeed(data),
    get: (providerID: string) => Effect.succeed(data[providerID]),
    set: (key: string, info: Auth.Info) =>
      Effect.sync(() => {
        data[key] = info
      }),
    remove: (key: string) =>
      Effect.sync(() => {
        delete data[key]
      }),
  })
  return { data, layer }
}

function harness(options: { authorizeThrows?: string; credentials?: Record<string, Auth.Info> } = {}) {
  const flow: StubFlow = { finish: () => {}, codeSeen: [], authorizeCalls: 0 }
  const store = authStore(options.credentials)
  const layer = LayerNode.compile(LayerNode.group([ProviderAuth.node, Auth.node, Plugin.node]), [
    [Auth.node, store.layer],
    [Plugin.node, Layer.mock(Plugin.Service)({ list: () => Effect.succeed([stubPlugin(flow, options)]) })],
  ])
  return { flow, store, it: testEffect(layer) }
}

afterEach(async () => {
  ACPProviderAuth.resetInflight()
  await disposeAllInstances()
})

describe("ACPProviderAuth.list", () => {
  const { it } = harness({
    credentials: {
      stubprov: { type: "oauth", access: "SECRET-ACCESS", refresh: "SECRET-REFRESH", expires: 1_700_000 },
      other: { type: "api", key: "SECRET-KEY" },
    },
  })

  it.instance("reports each provider's methods and the credential TYPES on file", () =>
    Effect.gen(function* () {
      const result = yield* ACPProviderAuth.list(process.cwd())
      expect(result.methods["stubprov"]).toEqual([
        { type: "oauth", label: "Stub browser sign-in" },
        { type: "oauth", label: "Stub paste-a-code sign-in" },
        { type: "api", label: "Manually enter API Key" },
      ])
      expect(result.connected).toEqual({
        stubprov: { type: "oauth", expires: 1_700_000 },
        other: { type: "api" },
      })
    }),
  )

  it.instance("never puts an access or refresh token on the wire", () =>
    Effect.gen(function* () {
      const result = yield* ACPProviderAuth.list(process.cwd())
      const wire = JSON.stringify(result)
      expect(wire).not.toContain("SECRET-ACCESS")
      expect(wire).not.toContain("SECRET-REFRESH")
      expect(wire).not.toContain("SECRET-KEY")
    }),
  )
})

describe("ACPProviderAuth.authorize", () => {
  const { it, flow } = harness()

  it.instance("answers with the plugin's URL WITHOUT waiting for the browser callback", () =>
    Effect.gen(function* () {
      const result = yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 0)
      // The stub's `callback()` promise is still unresolved at this point — the
      // browser has not redirected — and authorize has already answered. That
      // is the property the pane depends on to show its "waiting" state.
      expect(result).toEqual({
        ok: true,
        url: "https://auth.stub.test/authorize?code_challenge=x",
        method: "auto",
        instructions: "Complete authorization in your browser.",
      })
      expect(flow.authorizeCalls).toBe(1)
    }),
  )

  it.instance("refuses a SECOND concurrent sign-in for the same provider", () =>
    Effect.gen(function* () {
      const first = yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 0)
      expect(first.ok).toBe(true)
      const before = flow.authorizeCalls
      const second = yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 0)
      expect(second.ok).toBe(false)
      expect(second.ok === false && second.message).toContain("already in progress")
      // The plugin was never asked a second time — the fixed loopback port and
      // its module-level pending state were left alone.
      expect(flow.authorizeCalls).toBe(before)
    }),
  )

  it.instance("refuses a method that is not an OAuth one, rather than hanging", () =>
    Effect.gen(function* () {
      const result = yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 2)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toContain("not an OAuth method")
      // ...and the guard is released, so the API-key misclick does not lock the
      // provider out of a real sign-in.
      const retry = yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 0)
      expect(retry.ok).toBe(true)
    }),
  )
})

describe("ACPProviderAuth.authorize — a plugin that throws", () => {
  const { it } = harness({ authorizeThrows: "xAI device code request failed (403)" })

  it.instance("returns the provider's own wording and releases the guard for a retry", () =>
    Effect.gen(function* () {
      const first = yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 0)
      expect(first.ok).toBe(false)
      expect(first.ok === false && first.message).toContain("403")
      // A second attempt must reach the plugin, not the "already in progress"
      // refusal — otherwise one 403 would need an engine restart to clear.
      const second = yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 0)
      expect(second.ok).toBe(false)
      expect(second.ok === false && second.message).toContain("403")
    }),
  )
})

describe("ACPProviderAuth.callback", () => {
  const { it, flow, store } = harness()

  it.instance("persists the credential the browser flow returned and reports its type", () =>
    Effect.gen(function* () {
      yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 0)
      const done = ACPProviderAuth.callback(process.cwd(), "stubprov", 0, undefined)
      // Now the "browser" redirects.
      flow.finish({ type: "success", refresh: "r-live", access: "a-live", expires: 9_000 })
      const result = yield* done
      expect(result).toEqual({ ok: true, credential: { type: "oauth", expires: 9_000 } })
      expect(store.data["stubprov"]).toEqual({ type: "oauth", access: "a-live", refresh: "r-live", expires: 9_000 })
    }),
  )

  it.instance("hands a pasted code to the plugin's own callback, and frees the guard afterwards", () =>
    Effect.gen(function* () {
      yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 1)
      const result = yield* ACPProviderAuth.callback(process.cwd(), "stubprov", 1, "PASTED-CODE")
      expect(flow.codeSeen).toEqual(["PASTED-CODE"])
      expect(result.ok).toBe(true)
      // Guard released: a re-authorize is accepted rather than refused.
      const again = yield* ACPProviderAuth.authorize(process.cwd(), "stubprov", 1)
      expect(again.ok).toBe(true)
    }),
  )

  it.instance("reports a failure instead of throwing when no flow is pending", () =>
    Effect.gen(function* () {
      const result = yield* ACPProviderAuth.callback(process.cwd(), "stubprov", 0, undefined)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message.length).toBeGreaterThan(0)
    }),
  )
})

/**
 * The architectural assumption `callback` rests on: it may sit for minutes
 * waiting for a browser, and that must not stall every other ACP request on
 * the same stdio connection. The SDK's read loop calls `processMessage`
 * WITHOUT awaiting it, so handlers overlap — but that is a third-party
 * behaviour, and if a future SDK bump serialised it, the whole pane would
 * freeze the editor's engine connection with nothing else failing. This test
 * drives our real `Agent` through the real `AgentSideConnection` transport.
 */
describe("a slow ext method does not stall the ACP channel", () => {
  test("a pending provider_auth_callback still lets provider_auth_list answer", async () => {
    const service = {
      providerAuthCallback: () => Effect.promise(() => new Promise<never>(() => {})),
      providerAuthList: () => Effect.succeed({ methods: {}, connected: {} }),
    } as unknown as ACPService.Interface

    const toAgent = new TransformStream<AnyMessage, AnyMessage>()
    const toClient = new TransformStream<AnyMessage, AnyMessage>()
    const agentStream: Stream = { readable: toAgent.readable, writable: toClient.writable }
    new AgentSideConnection(() => new ACP.Agent(service), agentStream)

    const writer = toAgent.writable.getWriter()
    const reader = toClient.readable.getReader()
    await writer.write({
      jsonrpc: "2.0",
      id: 1,
      method: "_provider_auth_callback",
      params: { providerID: "stubprov", methodIndex: 0 },
    } as unknown as AnyMessage)
    await writer.write({
      jsonrpc: "2.0",
      id: 2,
      method: "_provider_auth_list",
      params: {},
    } as unknown as AnyMessage)

    const answered = (await reader.read()).value as { id: number; result: unknown }
    // id 2 answering FIRST is the whole point: request 1 is still parked on a
    // promise that never settles.
    expect(answered.id).toBe(2)
    expect(answered.result).toEqual({ methods: {}, connected: {} })

    reader.releaseLock()
    writer.releaseLock()
  })
})

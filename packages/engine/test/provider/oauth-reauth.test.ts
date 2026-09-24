import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import type { Hooks } from "@origami/plugin"
import { ACPProviderAuth } from "@/acp/provider-auth"
import { Auth } from "@/auth"
import { Plugin } from "../../src/plugin/index"
import { ProviderAuth } from "@/provider/auth"
import { ProviderReauth } from "@/provider/reauth"
import { XaiAuthPlugin } from "@/plugin/xai"
import { ProviderV2 } from "@origami/core/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * A stored OAuth credential the provider will no longer refresh.
 *
 * THE FAILURE THIS PINS. `auth.json` still holds a complete, well-formed `oauth`
 * entry after the provider rotates or revokes the refresh_token elsewhere —
 * nothing deletes it and nothing rewrites it, because the refresh never gets far
 * enough to persist anything. Before provider/reauth.ts every reader of that
 * entry therefore reported a healthy connection while every turn failed, and the
 * one recovery (sign in again) was the only thing nothing offered.
 *
 * The refresh endpoint is a local Bun server answering the real xAI shape; the
 * credential store is in-memory. No network, no browser, and the real
 * `~/.local/share/origami/auth.json` is never opened.
 */

const STORED: Auth.Info = { type: "oauth", access: "stale-access", refresh: "rotated-refresh", expires: 0 }

function makeInput() {
  const setCalls: Array<Record<string, unknown>> = []
  return {
    input: {
      client: { auth: { set: async (req: Record<string, unknown>) => { setCalls.push(req) } } },
    } as any,
    setCalls,
  }
}

/** A token endpoint whose answer the test picks per call. */
function tokenServer(answer: () => Response) {
  return Bun.serve({
    port: 0,
    fetch: (req) => (new URL(req.url).pathname === "/oauth2/token" ? answer() : new Response("{}")),
  })
}

const invalidGrant = () =>
  Response.json({ error: "invalid_grant", error_description: "refresh token is invalid" }, { status: 400 })

async function xaiFetchWith(input: ReturnType<typeof makeInput>["input"], server: ReturnType<typeof tokenServer>) {
  const hooks = await XaiAuthPlugin(input, { tokenUrl: new URL("/oauth2/token", server.url).toString() })
  const opts = await hooks.auth!.loader!(async () => STORED, {} as any)
  return () => opts.fetch!(new URL("/v1/chat/completions", server.url), { headers: {} })
}

beforeEach(() => ProviderReauth.reset())

describe("a refused refresh is recorded, not swallowed", () => {
  test("a 400 invalid_grant marks the credential and keeps the provider's own words", async () => {
    const { input, setCalls } = makeInput()
    using server = tokenServer(invalidGrant)
    const call = await xaiFetchWith(input, server)

    await expect(call()).rejects.toThrow(/xAI token refresh failed \(400\)/)
    expect(ProviderReauth.reason("xai")).toContain("invalid_grant")
    // The credential is a STATUS away from working, not gone: nothing was
    // written, and nothing was deleted.
    expect(setCalls).toEqual([])
  })

  test("a 503 does NOT mark — a provider outage says nothing about the credential", async () => {
    const { input } = makeInput()
    using server = tokenServer(() => new Response("temporarily unavailable", { status: 503 }))
    const call = await xaiFetchWith(input, server)

    await expect(call()).rejects.toThrow(/xAI token refresh failed \(503\)/)
    expect(ProviderReauth.reason("xai")).toBeUndefined()
  })

  test("a refresh that works again clears an earlier refusal", async () => {
    const { input } = makeInput()
    let refused = true
    using server = tokenServer(() =>
      refused
        ? invalidGrant()
        : Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
    )
    const call = await xaiFetchWith(input, server)

    await expect(call()).rejects.toThrow()
    expect(ProviderReauth.reason("xai")).toBeDefined()
    refused = false
    await call()
    expect(ProviderReauth.reason("xai")).toBeUndefined()
  })

  test("a very long provider body is trimmed to one UI line", () => {
    ProviderReauth.markIfRefused("xai", 400, "x".repeat(5_000))
    expect(ProviderReauth.reason("xai")!.length).toBeLessThanOrEqual(301)
  })
})

/** The ACP read the extension's connections UI renders from. */

function authStore(initial: Record<string, Auth.Info>) {
  const data: Record<string, Auth.Info> = { ...initial }
  return {
    data,
    layer: Layer.mock(Auth.Service)({
      all: () => Effect.succeed(data),
      get: (id: string) => Effect.succeed(data[id]),
      set: (k: string, v: Auth.Info) => Effect.sync(() => { data[k] = v }),
      remove: (k: string) => Effect.sync(() => { delete data[k] }),
    }),
  }
}

/** Shaped like the shipped plugins' auth hook: a browser flow, then an API key. */
const xaiHooks = {
  auth: {
    provider: "xai",
    methods: [
      {
        label: "xAI Grok OAuth (SuperGrok Subscription)",
        type: "oauth",
        authorize: async () => ({
          url: "https://auth.x.ai/oauth2/authorize",
          instructions: "Complete authorization in your browser.",
          method: "auto" as const,
          callback: async () => ({
            type: "success" as const,
            refresh: "signed-in-refresh",
            access: "signed-in-access",
            expires: 9_000,
          }),
        }),
      },
      { label: "Manually enter API Key", type: "api" },
    ],
  },
} as unknown as Hooks

const store = authStore({ xai: STORED })
const it = testEffect(
  LayerNode.compile(LayerNode.group([ProviderAuth.node, Auth.node, Plugin.node]), [
    [Auth.node, store.layer],
    [Plugin.node, Layer.mock(Plugin.Service)({ list: () => Effect.succeed([xaiHooks]) })],
  ]),
)

afterEach(async () => {
  ACPProviderAuth.resetInflight()
  await disposeAllInstances()
})

describe("provider_auth_list reports the refusal", () => {
  it.instance("a refused credential stays listed, flagged with the reason", () =>
    Effect.gen(function* () {
      ProviderReauth.markIfRefused("xai", 400, 'xAI token refresh failed (400): {"error":"invalid_grant"}')
      const result = yield* ACPProviderAuth.list(process.cwd())
      // Still connected — the picker keeps the provider and its models.
      expect(result.connected["xai"]?.type).toBe("oauth")
      expect(result.connected["xai"]?.needsReauth).toContain("invalid_grant")
      // …and the sign-in method is still offered, which is what the card's
      // Reauthorize action drives.
      expect(result.methods["xai"]?.[0]).toEqual({ type: "oauth", label: "xAI Grok OAuth (SuperGrok Subscription)" })
    }),
  )

  it.instance("an untroubled credential carries no flag at all", () =>
    Effect.gen(function* () {
      const result = yield* ACPProviderAuth.list(process.cwd())
      expect(result.connected["xai"]).toEqual({ type: "oauth", expires: 0 })
    }),
  )

  it.instance("never puts the refused credential's tokens on the wire", () =>
    Effect.gen(function* () {
      ProviderReauth.markIfRefused("xai", 400, "invalid_grant")
      const wire = JSON.stringify(yield* ACPProviderAuth.list(process.cwd()))
      expect(wire).not.toContain("rotated-refresh")
      expect(wire).not.toContain("stale-access")
    }),
  )

  it.instance("completing a sign-in clears the flag", () =>
    Effect.gen(function* () {
      ProviderReauth.markIfRefused("xai", 400, "invalid_grant")
      const providerAuth = yield* ProviderAuth.Service
      yield* providerAuth.authorize({ providerID: ProviderV2.ID.make("xai"), method: 0 })
      yield* providerAuth.callback({ providerID: ProviderV2.ID.make("xai"), method: 0 })
      expect(ProviderReauth.reason("xai")).toBeUndefined()
      const result = yield* ACPProviderAuth.list(process.cwd())
      expect(result.connected["xai"]?.needsReauth).toBeUndefined()
    }),
  )
})

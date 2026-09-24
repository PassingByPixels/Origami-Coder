import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CopilotAuthPlugin, resetSessionTokensForTests } from "@/plugin/github-copilot/copilot"
import { ProviderReauth } from "@/provider/reauth"

/**
 * A revoked/expired GitHub Copilot token must surface as "needs sign-in"
 * instead of the engine failing every turn while still reporting "signed in".
 *
 * Copilot has no separate token-refresh call the way plugin/xai.ts and
 * plugin/openai/codex.ts do — the device-flow token is used directly as the
 * bearer on every inference call (see copilot.ts: "tokens non-expiring") — so
 * the inference call itself is the only place GitHub ever says the grant is
 * bad. These tests drive the real loader's wrapped `fetch` against a local
 * Bun.serve fake standing in for api.githubcopilot.com.
 *
 * The wrapped fetch also runs the session-token exchange on every call now
 * (copilot.ts no longer gates it on the request host), so `makeServer` fakes
 * `/copilot_internal/v2/token` on the SAME fixture server and `copilotFetch`
 * points `ORIGAMI_COPILOT_TOKEN_URL` at it — otherwise the exchange would
 * reach the real api.github.com, which this suite must never do.
 */

const SESSION_TOKEN = "gho_session_reauth_fixture"

function makeServer(handler: (request: Request, url: URL) => Response | Promise<Response>) {
  return Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/copilot_internal/v2/token") {
        return new Response(
          JSON.stringify({ token: SESSION_TOKEN, expires_at: Math.floor(Date.now() / 1000) + 1800 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return handler(request, url)
    },
  })
}

const STORED = { type: "oauth" as const, refresh: "gh-token", access: "gh-token", expires: 0 }

async function copilotFetch(server: ReturnType<typeof Bun.serve>) {
  const hooks = await CopilotAuthPlugin({} as any)
  const opts = await hooks.auth!.loader!(async () => STORED, {} as any)
  const tokenUrl = new URL("/copilot_internal/v2/token", server.url).href
  return async () => {
    const previous = process.env["ORIGAMI_COPILOT_TOKEN_URL"]
    process.env["ORIGAMI_COPILOT_TOKEN_URL"] = tokenUrl
    try {
      return await opts.fetch!(new URL("/chat/completions", server.url), { headers: {} })
    } finally {
      if (previous === undefined) delete process.env["ORIGAMI_COPILOT_TOKEN_URL"]
      else process.env["ORIGAMI_COPILOT_TOKEN_URL"] = previous
    }
  }
}

beforeEach(() => ProviderReauth.reset())
afterEach(() => resetSessionTokensForTests())

describe("plugin.github-copilot reauth", () => {
  test("a 401 from the inference call marks github-copilot for reauth", async () => {
    using server = makeServer(() => new Response("Bad credentials", { status: 401 }))
    const call = await copilotFetch(server)

    const response = await call()

    expect(response.status).toBe(401)
    expect(ProviderReauth.reason("github-copilot")).toBeDefined()
    expect(ProviderReauth.reason("github-copilot")).toContain("401")
  })

  test("a 403 also marks it", async () => {
    using server = makeServer(() => new Response("Forbidden", { status: 403 }))
    const call = await copilotFetch(server)

    await call()

    expect(ProviderReauth.reason("github-copilot")).toBeDefined()
  })

  test("a 200 does not mark, and a later success clears an earlier refusal", async () => {
    let fail = true
    using server = makeServer(() =>
      fail ? new Response("nope", { status: 401 }) : new Response("{}", { status: 200 }),
    )
    const call = await copilotFetch(server)

    await call()
    expect(ProviderReauth.reason("github-copilot")).toBeDefined()

    fail = false
    await call()
    expect(ProviderReauth.reason("github-copilot")).toBeUndefined()
  })

  test("a 500 does NOT mark — a provider outage says nothing about the credential", async () => {
    using server = makeServer(() => new Response("boom", { status: 500 }))
    const call = await copilotFetch(server)

    await call()

    expect(ProviderReauth.reason("github-copilot")).toBeUndefined()
  })

  test("a 400 does NOT mark — on the inference endpoint that is a bad request, not a bad grant", async () => {
    // `ProviderReauth.markIfRefused` counts 400 as a refusal, and that is right
    // where xai.ts and codex.ts call it: on a token-REFRESH response, 400 is
    // OAuth's `invalid_grant`. This wrapper sits on the INFERENCE endpoint,
    // where 400 means the request body was malformed. Forwarding it would put
    // "Needs sign-in" on a working Copilot account after one bad request, and
    // the only cure a user is offered is to sign in again — which would not
    // help.
    using server = makeServer(() => new Response('{"error":"invalid model"}', { status: 400 }))
    const call = await copilotFetch(server)

    await call()

    expect(ProviderReauth.reason("github-copilot")).toBeUndefined()
  })

  test("a 429 does NOT mark — rate limiting is not a refusal", async () => {
    using server = makeServer(() => new Response("slow down", { status: 429 }))
    const call = await copilotFetch(server)

    await call()

    expect(ProviderReauth.reason("github-copilot")).toBeUndefined()
  })

  test("marking a refusal does not consume the response body the AI SDK still needs to read", async () => {
    using server = makeServer(() => new Response(JSON.stringify({ error: "bad_credentials" }), { status: 401 }))
    const call = await copilotFetch(server)

    const response = await call()

    expect(ProviderReauth.reason("github-copilot")).toBeDefined()
    expect(await response.json()).toEqual({ error: "bad_credentials" })
  })

  test("does not retry: exactly one request reaches the upstream on a 401", async () => {
    let calls = 0
    using server = makeServer(() => {
      calls++
      return new Response("nope", { status: 401 })
    })
    const call = await copilotFetch(server)

    await call()

    expect(calls).toBe(1)
  })

  test("non-oauth stored auth never reaches the wrapped fetch, so reauth is untouched", async () => {
    const hooks = await CopilotAuthPlugin({} as any)

    const opts = await hooks.auth!.loader!(async () => ({ type: "api" as const, key: "sk-new" }), {} as any)

    expect(opts).toEqual({})
    expect(ProviderReauth.reason("github-copilot")).toBeUndefined()
  })
})

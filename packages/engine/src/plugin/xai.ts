import type { Hooks, PluginInput } from "@origami/plugin"
import { OAUTH_DUMMY_KEY } from "../auth"
import { ProviderReauth } from "../provider/reauth"
import { createServer } from "http"
import { InstallationVersion } from "@origami/core/installation/version"
import { OauthCallbackPage } from "@origami/core/oauth/page"
import { applyCapabilityDefaults } from "./capabilityDefaults"
import { fetchXaiCatalog } from "./xai-catalog"

// Public Grok-CLI OAuth client. xAI's auth server rejects loopback OAuth from
// non-allowlisted clients, so we reuse the Grok-CLI client_id xAI ships for desktop OAuth.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
// RFC 8628 device authorization grant, exposed by xAI's
// /.well-known/openid-configuration. This is the headless path: no loopback
// server — the user types the short user_code elsewhere and the CLI long-polls.
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code"
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"

// Bounds for the device-code poll loop. xAI returns `interval` (seconds); it is
// floored to avoid hammering, and the spec's slow_down increment is added on request.
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

// xAI rejects redirect_uris that do not match the Grok-CLI client registration. The host:port pair
// is part of that registration, so the loopback server must bind this exact port.
const OAUTH_HOST = "127.0.0.1"
const OAUTH_PORT = 56121
const OAUTH_REDIRECT_PATH = "/callback"
const REDIRECT_URI = `http://${OAUTH_HOST}:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`

// Refresh the access token a little before it actually expires so a single
// long-running tool call doesn't have to recover from a mid-flight 401.
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000

interface XaiAuthPluginOptions {
  authorizeUrl?: string
  tokenUrl?: string
  deviceAuthorizationUrl?: string
}

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(64)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(hash) }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

function authHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": `origami/${InstallationVersion}`,
  }
}

// Parse the `exp` claim out of a JWT access_token WITHOUT verifying the
// signature. Used only to decide whether to refresh proactively, never to make
// a trust decision. Opaque tokens return false and fall back to the 401 path.
export function accessTokenIsExpiring(
  token: string | undefined,
  skewMs: number = ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean {
  if (!token || typeof token !== "string") return false
  const parts = token.split(".")
  if (parts.length < 2) return false
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    while (payload.length % 4 !== 0) payload += "="
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"))
    if (typeof claims?.exp !== "number") return false
    return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs)
  } catch {
    return false
  }
}

export function buildAuthorizeUrl(
  pkce: PkceCodes,
  state: string,
  nonce: string,
  options: XaiAuthPluginOptions = {},
): string {
  // `plan=generic` opts the consent screen into xAI's generic OAuth plan tier;
  // without it, accounts.x.ai rejects loopback OAuth from non-allowlisted clients.
  // `referrer=origami` lets xAI attribute origami-originated logins.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    plan: "generic",
    referrer: "origami",
  })
  return `${options.authorizeUrl ?? AUTHORIZE_URL}?${params.toString()}`
}

async function exchangeCodeForTokens(
  code: string,
  pkce: PkceCodes,
  options: XaiAuthPluginOptions = {},
): Promise<TokenResponse> {
  const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return response.json() as Promise<TokenResponse>
}

async function refreshAccessToken(refreshToken: string, options: XaiAuthPluginOptions = {}): Promise<TokenResponse> {
  const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    const message = `xAI token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`
    // A refused grant (refresh_token rotated elsewhere, revoked, or expired) leaves
    // auth.json otherwise valid, so record it and the connection can say "reauthorize".
    ProviderReauth.markIfRefused("xai", response.status, message)
    throw new Error(message)
  }
  ProviderReauth.clear("xai")
  return response.json() as Promise<TokenResponse>
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

interface DeviceTokenErrorBody {
  error?: string
  error_description?: string
}

export async function requestDeviceCode(options: XaiAuthPluginOptions = {}): Promise<DeviceCodeResponse> {
  const response = await fetch(options.deviceAuthorizationUrl ?? DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI device code request failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  const json = (await response.json()) as DeviceCodeResponse
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("xAI device code response is missing device_code / user_code / verification_uri")
  }
  return json
}

// Default sleep used between device-code polls. Test-injectable so we can
// exercise authorization_pending / slow_down branches without real waits.
async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Normalize a server-supplied seconds value to milliseconds, falling back when it
// is missing, non-positive or not finite. Without this a NaN interval slips past
// `?? default` (NaN is typeof number), reaches `setTimeout(_, NaN)` = 0, and busy-loops.
function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs
}

export async function pollDeviceCodeToken(
  device: DeviceCodeResponse,
  options: XaiAuthPluginOptions & { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<TokenResponse> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS)
  const deadline = now() + expiresInMs
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS,
  )

  while (now() < deadline) {
    const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.device_code,
      }).toString(),
    })
    if (response.ok) return (await response.json()) as TokenResponse

    const body = (await response.json().catch(() => ({}))) as DeviceTokenErrorBody
    const remaining = Math.max(0, deadline - now())
    // RFC 8628 §3.5: authorization_pending = keep polling at the same interval;
    // slow_down = bump the interval by ≥5s and keep polling. Anything else is terminal.
    if (body.error === "authorization_pending") {
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "access_denied" || body.error === "authorization_denied") {
      throw new Error("xAI device authorization was denied")
    }
    if (body.error === "expired_token") {
      throw new Error("xAI device code expired - please re-run login")
    }
    const detail = body.error_description ?? body.error ?? ""
    throw new Error(`xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  throw new Error("xAI device authorization timed out")
}

// CORS allowlist for the loopback callback. The redirect_uri is already bound to
// 127.0.0.1 and gated by PKCE+state, so only xAI's own auth origins are accepted,
// as defence-in-depth on the OPTIONS preflight.
const CORS_ALLOWED_ORIGINS = new Set(["https://accounts.x.ai", "https://auth.x.ai"])

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) return { port: OAUTH_PORT, redirectUri: REDIRECT_URI }

  const server = createServer((req, res) => {
    const reqUrl = req.url || "/"
    const url = new URL(reqUrl, `http://${OAUTH_HOST}:${OAUTH_PORT}`)

    const origin = req.headers["origin"]
    const allowOrigin = typeof origin === "string" && CORS_ALLOWED_ORIGINS.has(origin) ? origin : ""
    if (allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowOrigin)
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type")
      res.setHeader("Access-Control-Allow-Private-Network", "true")
      res.setHeader("Vary", "Origin")
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === OAUTH_REDIRECT_PATH) {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error) {
        const errorMsg = errorDescription || error
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(OauthCallbackPage.error(errorMsg, { provider: "xAI" }))
        return
      }

      if (!code) {
        const errorMsg = "Missing authorization code"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(OauthCallbackPage.error(errorMsg, { provider: "xAI" }))
        return
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        const errorMsg = "Invalid state - potential CSRF attack"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(OauthCallbackPage.error(errorMsg, { provider: "xAI" }))
        return
      }

      const current = pendingOAuth
      pendingOAuth = undefined

      exchangeCodeForTokens(code, current.pkce)
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(OauthCallbackPage.success({ provider: "xAI" }))
      return
    }

    if (url.pathname === "/cancel") {
      pendingOAuth?.reject(new Error("Login cancelled"))
      pendingOAuth = undefined
      res.writeHead(200)
      res.end("Login cancelled")
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  // listen() failures (EADDRINUSE, e.g. Grok-CLI on the same pinned port) must
  // clear `oauthServer` and remove our error listener, or the next
  // startOAuthServer() short-circuits and returns a redirect_uri pointing at nothing.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      oauthServer = undefined
      reject(err)
    }
    server.once("error", onError)
    server.listen(OAUTH_PORT, OAUTH_HOST, () => {
      server.removeListener("error", onError)
      // After listen() succeeds, install a permanent log-only listener so later
      // server errors (accept() or socket-level) do not trip Node's default
      // "unhandled error event = throw" and crash the whole origami process.
      resolve()
    })
    oauthServer = server
  })

  return { port: OAUTH_PORT, redirectUri: REDIRECT_URI }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close()
    oauthServer = undefined
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  // A previous in-flight authorize() the user abandoned still owns `pendingOAuth`.
  // Reject it eagerly so its caller stops waiting on a state that can never match.
  if (pendingOAuth) {
    pendingOAuth.reject(new Error("Superseded by a newer xAI authorize request"))
    pendingOAuth = undefined
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      },
      5 * 60 * 1000,
    )

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

interface RefreshResult {
  access: string
  refresh: string
  expires: number
}

export async function XaiAuthPlugin(input: PluginInput, options: XaiAuthPluginOptions = {}): Promise<Hooks> {
  return {
    /** Grok ids typed into origami.json by hand — or written there by picking a
     *  DISCOVERED row — resolve every capability to `false` without this, which is
     *  how an image reaches "Cannot read image" before it reaches xAI. A declaration still wins. */
    async config(cfg) {
      applyCapabilityDefaults(cfg, "xai")
    },
    provider: {
      id: "xai",
      /** Ask xAI what this credential is served. Only ADDS rows — a seed id keeps
       *  its declared limits and prices. An api-key credential is asked too:
       *  unlike the ChatGPT backend, the same list endpoint answers for both. */
      async discoverModels(ctx) {
        const auth = ctx.auth
        const token = auth?.type === "oauth" ? auth.access : auth?.type === "api" ? auth.key : undefined
        if (!token) return {}
        return fetchXaiCatalog({ accessToken: token })
      },
      // A SuperGrok subscription turn costs nothing per token, but the shipped
      // catalogue is models.dev's public price list and knows nothing about the
      // credential — so OAuth turns are zeroed. An API key stays priced; it is billed.
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models

        return Object.fromEntries(
          Object.entries(provider.models).map(([modelID, model]) => [
            modelID,
            {
              ...model,
              cost: {
                input: 0,
                output: 0,
                cache: { read: 0, write: 0 },
              },
            },
          ]),
        )
      },
    },
    auth: {
      provider: "xai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Single-flight refresh: collapse concurrent fetches from this loaded
        // provider onto one HTTP call so we don't replay a rotating refresh_token.
        let refreshPromise: Promise<RefreshResult> | undefined

        return {
          // Dummy bearer keeps the AI SDK from bailing on "missing apiKey"; the real
          // OAuth token is injected by the fetch override below. Deliberately NO
          // baseURL — overriding would silently route around a user-configured gateway.
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            let currentAuth = await getAuth()
            // Auth can flip from oauth to api mid-session (a pasted key). Pass the
            // request through untouched so the SDK's own apiKey header reaches xAI.
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // Refresh when the stored expires timestamp is within the skew window,
            // or — for JWT access tokens — when the JWT exp claim itself is. The
            // stored field is best-effort, so the JWT check is the load-bearing one.
            const expiresSoon =
              !currentAuth.expires ||
              currentAuth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS ||
              accessTokenIsExpiring(currentAuth.access)
            if (expiresSoon) {
              if (!refreshPromise) {
                const refreshToken = currentAuth.refresh
                refreshPromise = refreshAccessToken(refreshToken, options)
                  .then(async (tokens) => {
                    const refreshedExpires = Date.now() + (tokens.expires_in ?? 3600) * 1000
                    const refreshedRefresh = tokens.refresh_token || refreshToken
                    // Persist the rotated pair best-effort. xAI has already consumed the old
                    // refresh_token, so an auth.set failure leaves disk stale while this turn
                    // stays valid; the next refresh against stale disk 4xx's and forces re-login.
                    await input.client.auth
                      .set({
                        path: { id: "xai" },
                        body: {
                          type: "oauth",
                          access: tokens.access_token,
                          refresh: refreshedRefresh,
                          expires: refreshedExpires,
                        },
                      })
                      .catch(() => {})
                    return { access: tokens.access_token, refresh: refreshedRefresh, expires: refreshedExpires }
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }
              const refreshed = await refreshPromise
              currentAuth = { ...currentAuth, ...refreshed }
            }

            // Copy the caller's headers into a fresh Headers so we never mutate the
            // RequestInit the AI SDK may reuse on retry. Headers.set overwrites
            // case-insensitively, which kills the dummy bearer in a single line.
            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
            if (init?.headers) {
              const entries =
                init.headers instanceof Headers
                  ? init.headers.entries()
                  : Array.isArray(init.headers)
                    ? init.headers
                    : Object.entries(init.headers as Record<string, string | undefined>)
              for (const [key, value] of entries) {
                if (value !== undefined) headers.set(key, String(value))
              }
            }
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            headers.set("User-Agent", `origami/${InstallationVersion}`)

            return fetch(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          label: "xAI Grok OAuth (SuperGrok Subscription)",
          type: "oauth",
          authorize: async () => {
            await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const nonce = generateState()
            const authUrl = buildAuthorizeUrl(pkce, state, nonce, options)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const tokens = await callbackPromise
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                } catch (err) {
                  return { type: "failed" as const }
                } finally {
                  stopOAuthServer()
                }
              },
            }
          },
        },
        {
          // RFC 8628 device-code flow: the CLI prints a verification URL and a short
          // user_code entered in a browser on any device. No loopback server runs, so
          // it works wherever 127.0.0.1:56121 is unreachable from the user's browser.
          label: "xAI Grok OAuth (Headless / Remote / VPS)",
          type: "oauth",
          authorize: async () => {
            const device = await requestDeviceCode(options)
            const browserUrl = device.verification_uri_complete ?? device.verification_uri
            return {
              url: browserUrl,
              instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
              method: "auto" as const,
              callback: async () => {
                try {
                  const tokens = await pollDeviceCodeToken(device, options)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                } catch (err) {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}

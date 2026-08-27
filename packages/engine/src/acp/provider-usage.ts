import { Effect } from "effect"
import { Auth } from "@/auth"

/**
 * Subscription usage for an OAuth provider connection, over ACP.
 *
 * WHY THIS IS NOT IN A PLUGIN. `plugin/openai/codex.ts` and `plugin/xai.ts` own
 * the sign-in flow and inject the bearer into CHAT requests through an anonymous
 * `fetch` override inside their `auth.loader` closure. Neither exports that
 * override, and neither reads a usage or quota surface at all. This module
 * therefore reads the stored credential through `Auth.Service` — the same store
 * the plugins write — and makes its own single GET. No plugin file changes.
 *
 * NEVER RETURNS A TOKEN, same rule as `provider-auth.ts`. The access token is
 * read here, put on one outbound Authorization header, and dropped. Only
 * percentages and reset timestamps cross back to the webview.
 *
 * COVERAGE IS HONEST, NOT UNIFORM:
 *
 *   openai -> GET https://chatgpt.com/backend-api/wham/usage. Documented shape
 *             (see the PARSER CONTRACT above parseChatgptUsage). This is a
 *             PRIVATE endpoint OpenAI's own Codex CLI polls; it carries no
 *             compatibility promise, so every field is optional here and an
 *             unrecognised body degrades to `unavailable` rather than to a
 *             wrong number.
 *   xai    -> GET https://cli-chat-proxy.grok.com/v1/billing?format=credits,
 *             the token-authenticated proxy the Grok CLI itself polls (see the
 *             PARSER CONTRACT above parseGrokUsage — read verbatim from
 *             steipete/CodexBar's shipped Swift source, which already ships
 *             this exact call). The OTHER xAI path — a gRPC-web call to
 *             grok.com's `grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` —
 *             remains DELIBERATELY NOT IMPLEMENTED: it now requires a
 *             browser-held Web Key Exchange keypair this engine has no way to
 *             hold, and a guessed protobuf schema would produce confident
 *             wrong percentages. The CLI-proxy path needs only a bearer token,
 *             which is why it, and only it, is implemented here.
 *
 * LAZY BY CONTRACT. The caller asks when a fold opens. There is no timer here
 * and there must not be one: openai/codex#10869 is exactly the complaint that a
 * 60-second background poll of this endpoint is user-hostile.
 */

/** Where the ChatGPT subscription reports its own quota. Private, unversioned. */
const CHATGPT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"

/**
 * Where the Grok CLI's own billing proxy reports credit usage. Token-
 * authenticated, not cookie-based — see the PARSER CONTRACT above
 * parseGrokUsage for the source.
 */
const GROK_USAGE_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"

/** One quota lane — a rolling window with a percentage spent against it. */
export type UsageWindow = {
  /** Human label, derived from the window length ("5-hour", "Weekly"). */
  readonly label: string
  /**
   * Percent of the lane consumed, 0-100.
   *
   * DELIBERATELY NOT used/limit: the endpoint reports only a percentage. There
   * is no token or message count to render, and synthesising a denominator
   * would invent precision the source does not have.
   */
  readonly usedPercent: number
  /** Epoch MILLIS when the lane resets. Absent when the body carried neither
   *  `reset_at` nor `reset_after_seconds`. */
  readonly resetsAt?: number
}

export type UsageResult =
  | {
      readonly ok: true
      readonly providerID: string
      /** The subscription tier the endpoint names, when it names one. */
      readonly plan?: string
      readonly windows: readonly UsageWindow[]
    }
  | {
      readonly ok: false
      readonly providerID: string
      /** One sentence, safe to render verbatim. Never contains credential data. */
      readonly unavailable: string
    }

/** The fetch seam. Tests pass a stub; nothing here ever calls the network live. */
export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  readonly ok: boolean
  readonly status: number
  json: () => Promise<unknown>
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/**
 * Epoch millis from a field that may be seconds or millis.
 *
 * Every source describes `reset_at` as Unix SECONDS, but the endpoint is
 * private and unversioned — a switch to millis would silently push every reset
 * ~50 000 years out. Anything below this threshold is seconds; the boundary is
 * ~2001 in millis and ~year 33 658 in seconds, so no real timestamp is
 * ambiguous.
 */
const SECONDS_MILLIS_BOUNDARY = 1e12

const epochMillis = (value: unknown): number | undefined => {
  const raw = finiteNumber(value)
  if (raw === undefined || raw <= 0) return undefined
  return raw < SECONDS_MILLIS_BOUNDARY ? Math.round(raw * 1000) : Math.round(raw)
}

/**
 * A window label from its length in seconds.
 *
 * The endpoint names its lanes only positionally (primary/secondary), which
 * means nothing to a user. The length does: a Plus account's lanes are 5 hours
 * and 7 days. Falls back to the positional name when the length is missing.
 */
const windowLabel = (limitWindowSeconds: number | undefined, fallback: string): string => {
  if (limitWindowSeconds === undefined || limitWindowSeconds <= 0) return fallback
  const hours = limitWindowSeconds / 3600
  if (hours < 1) return `${Math.round(limitWindowSeconds / 60)}-minute`
  if (hours < 24) return `${Math.round(hours)}-hour`
  const days = Math.round(hours / 24)
  return days === 7 ? "Weekly" : days === 1 ? "Daily" : `${days}-day`
}

const parseWindow = (raw: unknown, fallbackLabel: string, now: number): UsageWindow | undefined => {
  if (!isRecord(raw)) return undefined
  const usedPercent = finiteNumber(raw["used_percent"])
  // A lane with no percentage is not a lane worth a row — rendering "0%" for a
  // body that simply omitted the field would read as "plenty left".
  if (usedPercent === undefined) return undefined
  const resetAfter = finiteNumber(raw["reset_after_seconds"])
  const resetsAt = epochMillis(raw["reset_at"]) ?? (resetAfter !== undefined && resetAfter >= 0 ? now + resetAfter * 1000 : undefined)
  return {
    label: windowLabel(finiteNumber(raw["limit_window_seconds"]), fallbackLabel),
    // Clamp: a body reporting 103% would push a progress bar out of its track.
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}

/**
 * PARSER CONTRACT — the ChatGPT `wham/usage` body, as four independent sources
 * agree it is shaped:
 *
 *   { plan_type: string,
 *     rate_limit: {
 *       primary_window:   { used_percent, limit_window_seconds, reset_after_seconds, reset_at },
 *       secondary_window: { ...same... } },
 *     credits: { has_credits, unlimited, balance } }
 *
 * `additional_rate_limits[]` (per-model lanes) is DELIBERATELY NOT PARSED. The
 * sources agree it exists and disagree on its element shape, and a guessed
 * parser is exactly the failure this module refuses. Same for `credits`: the
 * balance is a spend figure, not a subscription window, and belongs to a
 * different question than "how much of my plan is left".
 *
 * Exported for tests: this is the whole risk surface of the feature.
 */
export function parseChatgptUsage(body: unknown, now: number): UsageResult {
  const providerID = "openai"
  if (!isRecord(body)) return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  const rateLimit = isRecord(body["rate_limit"]) ? body["rate_limit"] : undefined
  const windows = [
    parseWindow(rateLimit?.["primary_window"], "Session", now),
    parseWindow(rateLimit?.["secondary_window"], "Weekly", now),
  ].filter((w): w is UsageWindow => w !== undefined)
  if (windows.length === 0) {
    return { ok: false, providerID, unavailable: "The usage endpoint reported no quota window for this account." }
  }
  const plan = typeof body["plan_type"] === "string" && body["plan_type"].length > 0 ? body["plan_type"] : undefined
  return { ok: true, providerID, windows, ...(plan !== undefined ? { plan } : {}) }
}

/**
 * Epoch millis from an ISO 8601 string, or `undefined` when it does not parse.
 *
 * The source's own parser (`GrokCreditsProxyFetcher.parseISO8601`) tries
 * `ISO8601DateFormatter` with fractional seconds first, then without.
 * `Date.parse` accepts both forms directly, so one call covers both passes.
 */
const parseIso8601Millis = (value: unknown): number | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * PARSER CONTRACT — the Grok CLI-proxy `billing?format=credits` body, read
 * verbatim from steipete/CodexBar's shipped Swift source
 * (Sources/CodexBarCore/Providers/Grok/GrokCreditsProxyFetcher.swift, main
 * branch, read 2026-08-15 — xAI publishes no schema of its own for this
 * endpoint):
 *
 *   { config: {
 *       creditUsagePercent?: number,
 *       currentPeriod?: { end?: string (ISO 8601) },
 *       billingPeriodEnd?: string (ISO 8601),
 *       onDemandCap?:  { val?: number },
 *       onDemandUsed?: { val?: number } } }
 *
 * Precedence, in the exact order `parseSnapshot` applies it:
 *   1. `config.creditUsagePercent`, when finite — the plan's own percentage.
 *   2. `onDemandUsed.val / onDemandCap.val * 100`, when the cap is > 0 — the
 *      pay-as-you-go ratio, used only when the plan percentage is absent.
 *   3. Neither value present but a period end DID parse: reported as 0% used
 *      (a current period where nothing has been spent yet), not as
 *      unavailable — this is the one branch that is not an error path.
 *   4. Nothing above parses: `unavailable`, mirroring the source's own
 *      `GrokWebBillingError.parseFailed`.
 *
 * Reset time is `config.currentPeriod.end`, falling back to
 * `config.billingPeriodEnd` — same fallback order as the source.
 *
 * Exported for tests: this is the whole risk surface of the feature.
 */
export function parseGrokUsage(body: unknown, now: number): UsageResult {
  const providerID = "xai"
  if (!isRecord(body)) return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  const config = isRecord(body["config"]) ? body["config"] : undefined
  if (!config) return { ok: false, providerID, unavailable: "The usage endpoint reported no credits configuration for this account." }

  const currentPeriod = isRecord(config["currentPeriod"]) ? config["currentPeriod"] : undefined
  const resetsAt = parseIso8601Millis(currentPeriod?.["end"]) ?? parseIso8601Millis(config["billingPeriodEnd"])

  const creditUsagePercent = finiteNumber(config["creditUsagePercent"])
  const onDemandCap = isRecord(config["onDemandCap"]) ? finiteNumber(config["onDemandCap"]["val"]) : undefined
  const onDemandUsed = isRecord(config["onDemandUsed"]) ? finiteNumber(config["onDemandUsed"]["val"]) : undefined
  const onDemandRatio =
    onDemandCap !== undefined && onDemandCap > 0 && onDemandUsed !== undefined
      ? Math.max(0, Math.min(100, (onDemandUsed / onDemandCap) * 100))
      : undefined

  let primaryPercent: number | undefined
  if (creditUsagePercent !== undefined) {
    primaryPercent = Math.max(0, Math.min(100, creditUsagePercent))
  } else if (onDemandRatio !== undefined) {
    primaryPercent = onDemandRatio
  } else if (resetsAt !== undefined) {
    primaryPercent = 0
  }
  if (primaryPercent === undefined) {
    return { ok: false, providerID, unavailable: "The usage endpoint reported no credits figure for this account." }
  }

  const windows: UsageWindow[] = [{ label: "Credits", usedPercent: primaryPercent, ...(resetsAt !== undefined ? { resetsAt } : {}) }]
  // A second, "On-demand" row only when that ratio was NOT already the source of
  // the primary percentage above — otherwise this would repeat the same number
  // under a second label.
  if (creditUsagePercent !== undefined && onDemandRatio !== undefined) {
    windows.push({ label: "On-demand", usedPercent: onDemandRatio, ...(resetsAt !== undefined ? { resetsAt } : {}) })
  }
  return { ok: true, providerID, windows }
}

/**
 * The one HTTP call, with the credential already resolved.
 *
 * Headers mirror what `plugin/openai/codex.ts` puts on a chat request (its
 * lines 445-448): the bearer, plus `ChatGPT-Account-Id` when the credential
 * carries one. Exported so a test can drive it with a stub fetch.
 *
 * NO REFRESH. `refreshAccessToken` is private to codex.ts and this pass does
 * not change plugin files, so an expired credential is reported as expired
 * rather than silently renewed. A chat turn refreshes it as a side effect; the
 * message says so.
 */
export async function fetchChatgptUsage(
  credential: Auth.Oauth,
  now: number,
  fetchImpl: FetchLike,
): Promise<UsageResult> {
  const providerID = "openai"
  if (credential.expires > 0 && credential.expires <= now) {
    return { ok: false, providerID, unavailable: "Sign-in has expired. Send a message, or re-authorize, then reopen this." }
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${credential.access}`, Accept: "application/json" }
  if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(CHATGPT_USAGE_ENDPOINT, { headers })
  } catch (cause) {
    // Offline, DNS, TLS. The fold hides the line; it does not show a stack.
    return { ok: false, providerID, unavailable: "Could not reach the usage endpoint." }
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, providerID, unavailable: "Sign-in was rejected by the usage endpoint. Re-authorize to refresh it." }
    }
    return { ok: false, providerID, unavailable: `The usage endpoint answered ${response.status}.` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  }
  return parseChatgptUsage(body, now)
}

/**
 * The one HTTP call for Grok, with the credential already resolved.
 *
 * Headers mirror the Grok CLI's own proxy request
 * (GrokCreditsProxyFetcher.swift lines 21-27): the bearer, plus
 * `x-xai-token-auth: xai-grok-cli` — the header name that marks the request as
 * coming from the CLI's token-auth path rather than a browser cookie session.
 *
 * NO REFRESH, same rule as fetchChatgptUsage: this pass does not touch
 * `plugin/xai.ts`, so an expired credential is reported as expired rather than
 * silently renewed.
 */
export async function fetchGrokUsage(credential: Auth.Oauth, now: number, fetchImpl: FetchLike): Promise<UsageResult> {
  const providerID = "xai"
  if (credential.expires > 0 && credential.expires <= now) {
    return { ok: false, providerID, unavailable: "Sign-in has expired. Send a message, or re-authorize, then reopen this." }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.access}`,
    "x-xai-token-auth": "xai-grok-cli",
    Accept: "application/json",
  }
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(GROK_USAGE_ENDPOINT, { headers })
  } catch (cause) {
    // Offline, DNS, TLS, or a client-side timeout — all surface as a thrown
    // fetch. The fold hides the line; it does not show a stack.
    return { ok: false, providerID, unavailable: "Could not reach the usage endpoint." }
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, providerID, unavailable: "Sign-in was rejected by the usage endpoint. Re-authorize to refresh it." }
    }
    return { ok: false, providerID, unavailable: `The usage endpoint answered ${response.status}.` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  }
  return parseGrokUsage(body, now)
}

/** Human-facing account name for each provider this module can read usage from. */
const OAUTH_PROVIDER_NAME: Record<string, string> = {
  openai: "ChatGPT",
  xai: "Grok",
}

/**
 * Everything that decides "no" BEFORE a request is considered.
 *
 * Pure, and separate from the Effect below, so each refusal can be checked
 * without standing up an `Auth.Service` layer. Answers `undefined` to mean "this
 * connection has a usage source and a usable credential — go ahead".
 */
export function usageGate(providerID: string, stored: Auth.Info | undefined): UsageResult | undefined {
  const displayName = OAUTH_PROVIDER_NAME[providerID]
  if (!displayName) {
    return { ok: false, providerID, unavailable: `No usage source is known for ${providerID}.` }
  }
  if (!stored) return { ok: false, providerID, unavailable: `Not signed in to ${displayName}.` }
  if (stored.type !== "oauth") {
    // An API-key credential on the same provider id is a DIFFERENT, metered
    // account with no subscription window — saying "not signed in" would be a lie
    // to someone who is, so name the connection type instead.
    return {
      ok: false,
      providerID,
      unavailable: `Subscription usage needs a ${displayName} sign-in. An API key is metered per token and has no plan window.`,
    }
  }
  return undefined
}

/**
 * The ACP-facing entry point.
 *
 * Reads `Auth.Service` directly rather than going through `ProviderAuth` — this
 * is not part of a sign-in flow and needs the credential itself, not the list of
 * ways to obtain one. Unlike `provider-auth.ts` it takes no directory: no
 * instance state is involved.
 */
export const usage = Effect.fn("ACPProviderUsage.usage")(function* (
  providerID: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  now: number = Date.now(),
) {
  // Read the credential BEFORE gating so an unsupported provider and a missing
  // sign-in are answered by the same table rather than by two orders of checks.
  const auth = yield* Auth.Service
  const stored = yield* auth.get(providerID).pipe(Effect.orElseSucceed(() => undefined))
  const refused = usageGate(providerID, stored)
  if (refused) return refused
  const credential = stored as Auth.Oauth
  const fetchUsage = providerID === "xai" ? fetchGrokUsage : fetchChatgptUsage
  return yield* Effect.promise(() => fetchUsage(credential, now, fetchImpl))
})

export * as ACPProviderUsage from "./provider-usage"

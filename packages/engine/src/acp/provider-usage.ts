import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"

/**
 * Subscription usage for a provider connection, over ACP.
 *
 * WHY THIS IS NOT IN A PLUGIN. `plugin/openai/codex.ts` and `plugin/xai.ts` own the
 * sign-in flow and inject the bearer into CHAT requests inside their `auth.loader`
 * closure; neither exports that override or reads a usage surface. This module reads the
 * stored credential through `Auth.Service` - the same store the plugins write - and makes
 * its own single GET.
 *
 * NEVER RETURNS A TOKEN, same rule as `provider-auth.ts`. The access token is read here,
 * put on one outbound Authorization header, and dropped. Only percentages and reset
 * timestamps cross back to the webview.
 *
 * COVERAGE IS HONEST, NOT UNIFORM. Every endpoint below is PRIVATE and unversioned, so
 * each parser treats every field as optional and degrades an unrecognised body to
 * `unavailable` rather than to a wrong number:
 *
 *   openai         -> GET chatgpt.com/backend-api/wham/usage, the endpoint OpenAI's own
 *                     Codex CLI polls.
 *   xai            -> GET cli-chat-proxy.grok.com/v1/billing?format=credits, the
 *                     token-authenticated proxy the Grok CLI polls. The gRPC-web path is
 *                     DELIBERATELY NOT IMPLEMENTED: it needs a browser-held Web Key
 *                     Exchange keypair this engine cannot hold.
 *   opencode-go    -> GET opencode.ai/zen/go/v1/usage. The ONE provider whose
 *                     subscription is bought with an API KEY, so its credential is read
 *                     from `provider["opencode-go"].options.apiKey`, not `Auth.Service`.
 *                     OpenCode ZEN (`opencode`) is a different id, metered per token,
 *                     with no usage endpoint - deliberately absent.
 *   github-copilot -> GET api.github.com/copilot_internal/user, the same host and bearer
 *                     `plugin/github-copilot/copilot.ts` already sends.
 *   anthropic      -> GET api.anthropic.com/api/oauth/usage, the endpoint the Claude Code
 *                     CLI's own `/usage` reads. The ONE provider whose credential is
 *                     written by ANOTHER PROGRAM - see `readClaudeCodeCredential` for the
 *                     trust boundary that read is held to.
 *
 * LAZY BY CONTRACT. The caller asks when a fold opens. There is no timer here and there
 * must not be one: openai/codex#10869 is the complaint that a 60-second background poll
 * of this endpoint is user-hostile.
 */

/** Where the ChatGPT subscription reports its own quota. Private, unversioned. */
const CHATGPT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"

/** Where the Grok CLI's own billing proxy reports credit usage. Token-authenticated, not
 *  cookie-based - see the PARSER CONTRACT above parseGrokUsage. */
const GROK_USAGE_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"

/** Where an OpenCode GO subscription reports its own consumption. */
const GO_USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage"

/** The one provider whose usage credential is an API KEY in the config file
 *  rather than an OAuth credential in the store. */
const GO_PROVIDER_ID = "opencode-go"

/** Where the Copilot user's own quota reports, on github.com — NOT
 *  `api.githubcopilot.com`, the host `models()`/inference use. */
const COPILOT_USAGE_ENDPOINT = "https://api.github.com/copilot_internal/user"

/** Where the Claude subscription reports its own quota — the endpoint the Claude
 *  Code CLI's `/usage` reads. Private, unversioned. */
const ANTHROPIC_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"

/** The provider id a Claude subscription reports under. */
const ANTHROPIC_PROVIDER_ID = "anthropic"

/** The CLI's own User-Agent. The endpoint is the CLI's; presenting as it is what
 *  makes this the SAME read rather than a new client of an unpublished API.
 *  `packages/vscode/src/claudeCode/planUsage.ts` sends the same string. */
const ANTHROPIC_USER_AGENT = "claude-code/2.1.198"

/** Where the Claude Code CLI keeps its OAuth credential on win32 and linux. macOS may use
 *  the keychain instead, in which case the file is absent - the correct degradation. */
const CLAUDE_CREDENTIALS_RELATIVE = [".claude", ".credentials.json"] as const

/** One quota lane — a rolling window with a percentage spent against it. */
export type UsageWindow = {
  /** Human label, derived from the window length ("5-hour", "Weekly"). */
  readonly label: string
  /** Percent of the lane consumed, 0-100. DELIBERATELY NOT used/limit: the endpoint reports
   *  only a percentage, and synthesising a denominator would invent precision. */
  readonly usedPercent: number
  /** Epoch MILLIS when the lane resets. Absent when the body carried neither
   *  `reset_at` nor `reset_after_seconds`. */
  readonly resetsAt?: number
  /** Epoch MILLIS when this window OPENED, when the body states it. */
  readonly startsAt?: number
  /** How long this window is in ms, when the body states or implies it. */
  readonly lengthMs?: number
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

/** The Claude Code CLI's OAuth credential, reduced to the two fields this module
 *  uses. Read out of a file ANOTHER PROGRAM owns — see `readClaudeCodeCredential`. */
export type ClaudeCredential = {
  readonly token: string
  /** Epoch MILLIS, or 0 when the store stated none. */
  readonly expiresAt: number
}

/** The credential seam. Tests pass a stub; nothing here reads a real one. */
export type ClaudeCredentialReader = () => ClaudeCredential | undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Epoch millis from a field that may be seconds or millis. Every source describes
 *  `reset_at` as Unix SECONDS, but the endpoint is private and unversioned - a switch to
 *  millis would silently push every reset ~50 000 years out. The boundary is ~2001 in
 *  millis and ~year 33 658 in seconds, so no real timestamp is ambiguous. */
const SECONDS_MILLIS_BOUNDARY = 1e12

const epochMillis = (value: unknown): number | undefined => {
  const raw = finiteNumber(value)
  if (raw === undefined || raw <= 0) return undefined
  return raw < SECONDS_MILLIS_BOUNDARY ? Math.round(raw * 1000) : Math.round(raw)
}

/** A window label from its length in seconds. The endpoint names its lanes only
 *  positionally (primary/secondary), which means nothing to a user; the length does.
 *  Falls back to the positional name when the length is missing. */
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
  const limitWindowSeconds = finiteNumber(raw["limit_window_seconds"])
  const lengthMs = limitWindowSeconds !== undefined && limitWindowSeconds > 0 ? limitWindowSeconds * 1000 : undefined
  return {
    label: windowLabel(limitWindowSeconds, fallbackLabel),
    // Clamp: a body reporting 103% would push a progress bar out of its track.
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(lengthMs !== undefined ? { lengthMs } : {}),
  }
}

/**
 * One `additional_rate_limits[]` entry, e.g. a monthly cap alongside the primary/secondary
 * pair. NOT CONFIRMED against a live body - OpenAI publishes no schema for it, and the
 * four sources this module's other contracts cite do not agree on its element shape
 * either (that disagreement is why this array was refused outright until t-d942yi). Read
 * defensively instead of guessing one shape: try the label under `limit_name`,
 * `window_type` or `name` (first one present wins), the percentage under `used_percent`
 * or `utilization`, and the reset under `reset_at`/`resets_at` (absolute) or
 * `reset_after_seconds`/`resets_in_seconds` (relative to `now`) - the same two-field
 * reset rule `parseWindow` applies to the documented windows. An entry with no readable
 * percentage is DROPPED, never rendered as 0%, same rule as every other parser here.
 */
function parseAdditionalRateLimit(raw: unknown, now: number): UsageWindow | undefined {
  if (!isRecord(raw)) return undefined
  const usedPercent = finiteNumber(raw["used_percent"]) ?? finiteNumber(raw["utilization"])
  if (usedPercent === undefined) return undefined
  const label =
    (typeof raw["limit_name"] === "string" && raw["limit_name"]) ||
    (typeof raw["window_type"] === "string" && raw["window_type"]) ||
    (typeof raw["name"] === "string" && raw["name"]) ||
    "Other"
  const limitWindowSeconds = finiteNumber(raw["limit_window_seconds"])
  const resetAfter = finiteNumber(raw["reset_after_seconds"]) ?? finiteNumber(raw["resets_in_seconds"])
  const resetsAt =
    epochMillis(raw["reset_at"]) ??
    epochMillis(raw["resets_at"]) ??
    (resetAfter !== undefined && resetAfter >= 0 ? now + resetAfter * 1000 : undefined)
  const lengthMs = limitWindowSeconds !== undefined && limitWindowSeconds > 0 ? limitWindowSeconds * 1000 : undefined
  return {
    // A stated length still wins over the entry's own name — same precedence
    // `windowLabel` gives `limit_window_seconds` for the documented windows.
    label: windowLabel(limitWindowSeconds, label),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(lengthMs !== undefined ? { lengthMs } : {}),
  }
}

/**
 * PARSER CONTRACT - the ChatGPT `wham/usage` body, as four independent sources agree it
 * is shaped:
 *
 *   { plan_type: string,
 *     rate_limit: {
 *       primary_window:   { used_percent, limit_window_seconds, reset_after_seconds, reset_at },
 *       secondary_window: { ...same... },
 *       additional_rate_limits: [ { used_percent | utilization, limit_name | window_type | name,
 *                                   reset_at | resets_at | reset_after_seconds | resets_in_seconds }, ... ] },
 *     credits: { has_credits, unlimited, balance } }
 * `additional_rate_limits[]` is where a monthly cap lives when the account has one (t-d942yi:
 * the owner's pill read 73% while a monthly cap on this array was already hit). Each entry is
 * read DEFENSIVELY by `parseAdditionalRateLimit` above rather than against one assumed shape,
 * and an entry that fits none of the field spellings tried is dropped, not guessed at. `credits`
 * is still not parsed - a spend figure is not a subscription window.
 *
 * Exported for tests: this is the whole risk surface of the feature.
 */
export function parseChatgptUsage(body: unknown, now: number): UsageResult {
  const providerID = "openai"
  if (!isRecord(body)) return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  const rateLimit = isRecord(body["rate_limit"]) ? body["rate_limit"] : undefined
  // WEEKLY then SESSION, the same rule GO_LANES states below: `secondary_window` is the
  // weekly lane in every documented body. The frontend picks the TIGHTEST window for the
  // pill's own number (not windows[0]) - see ModelPicker.svelte - so this order is no
  // longer load-bearing for what the pill shows, only for a consumer that reads windows[0]
  // directly (the JSONL export, an older client).
  const additional = Array.isArray(rateLimit?.["additional_rate_limits"])
    ? rateLimit["additional_rate_limits"]
        .map((entry) => parseAdditionalRateLimit(entry, now))
        .filter((w): w is UsageWindow => w !== undefined)
    : []
  const windows = [
    parseWindow(rateLimit?.["secondary_window"], "Weekly", now),
    parseWindow(rateLimit?.["primary_window"], "Session", now),
    ...additional,
  ].filter((w): w is UsageWindow => w !== undefined)
  if (windows.length === 0) {
    return { ok: false, providerID, unavailable: "The usage endpoint reported no quota window for this account." }
  }
  const plan = typeof body["plan_type"] === "string" && body["plan_type"].length > 0 ? body["plan_type"] : undefined
  return { ok: true, providerID, windows, ...(plan !== undefined ? { plan } : {}) }
}

/** Epoch millis from an ISO 8601 string, or `undefined` when it does not parse. The
 *  source's own parser tries fractional seconds first, then without; `Date.parse` accepts
 *  both forms directly. */
const parseIso8601Millis = (value: unknown): number | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** One hour and one day in millis, for providers that state a window's length
 *  only as a nominal period TYPE ("weekly"/"monthly") or a lane KEY, never as
 *  a number of seconds. */
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * PARSER CONTRACT - the Grok CLI-proxy `billing?format=credits` body, read verbatim from
 * steipete/CodexBar's shipped Swift source (xAI publishes no schema of its own):
 *
 *   { config: { creditUsagePercent?: number,
 *               currentPeriod?: { start?, end?, type? } (ISO 8601 / period type),
 *               billingPeriodStart?, billingPeriodEnd?: string (ISO 8601),
 *               onDemandCap?: { val? }, onDemandUsed?: { val? } } }
 *
 * Percentage precedence: `creditUsagePercent` when finite; else
 * `onDemandUsed/onDemandCap * 100` when the cap is > 0; else 0% when a period end DID
 * parse (a period nothing has been spent in yet); else `unavailable`.
 *
 * Reset is `currentPeriod.end` falling back to `billingPeriodEnd`, and `startsAt` is the
 * same one field over. `lengthMs` is derived ONLY when no start resolved - a stated start
 * is exact, a period `type` is nominal - by matching the TAIL of `currentPeriod.type`
 * case-insensitively, so a future prefix change does not silently drop it.
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
  const startsAt = parseIso8601Millis(currentPeriod?.["start"]) ?? parseIso8601Millis(config["billingPeriodStart"])
  // lengthMs is a fallback ONLY: a stated start is exact, a period `type` is
  // nominal (a real "weekly" period need not be exactly 7 days).
  let lengthMs: number | undefined
  if (startsAt === undefined) {
    const periodType = currentPeriod?.["type"]
    if (typeof periodType === "string") {
      if (/weekly$/i.test(periodType)) lengthMs = 7 * DAY_MS
      else if (/monthly$/i.test(periodType)) lengthMs = 30 * DAY_MS
    }
  }

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

  // Both windows share one billing period, so both carry the same resetsAt /
  // startsAt / lengthMs — spread once, reused on both pushes below.
  const period = {
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(startsAt !== undefined ? { startsAt } : {}),
    ...(lengthMs !== undefined ? { lengthMs } : {}),
  }
  const windows: UsageWindow[] = [{ label: "Credits", usedPercent: primaryPercent, ...period }]
  // A second, "On-demand" row only when that ratio was NOT already the source of
  // the primary percentage above — otherwise this would repeat the same number
  // under a second label.
  if (creditUsagePercent !== undefined && onDemandRatio !== undefined) {
    windows.push({ label: "On-demand", usedPercent: onDemandRatio, ...period })
  }
  return { ok: true, providerID, windows }
}

/**
 * The one HTTP call, with the credential already resolved.
 *
 * Headers mirror what `plugin/openai/codex.ts` puts on a chat request: the bearer, plus
 * `ChatGPT-Account-Id` when the credential carries one. NO REFRESH - `refreshAccessToken`
 * is private to codex.ts, so an expired credential is reported as expired rather than
 * silently renewed; a chat turn refreshes it as a side effect.
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
 * Headers mirror the Grok CLI's own proxy request: the bearer, plus `x-xai-token-auth:
 * xai-grok-cli`, the header that marks the request as the CLI's token-auth path rather
 * than a browser cookie session. NO REFRESH, same rule as fetchChatgptUsage.
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

/** One OpenCode GO lane. A lane whose `percent` is not a finite number is DROPPED rather
 *  than shown as 0% - the same rule parseWindow applies, because "0% used" reads as
 *  "plenty left" to someone about to be cut off. */
const goWindow = (raw: unknown, label: string, lengthMs: number): UsageWindow | undefined => {
  if (!isRecord(raw)) return undefined
  const percent = finiteNumber(raw["percent"])
  if (percent === undefined) return undefined
  const resetsAt = parseIso8601Millis(raw["resetsAt"])
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, percent)),
    lengthMs,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}

/** The three GO lanes, in the order the pill wants them, with each lane's length. The body
 *  carries no length field, so the length is stated here rather than inside `goWindow`. */
const GO_LANES: ReadonlyArray<readonly [string, string, number]> = [
  ["weekly", "Weekly", 7 * DAY_MS],
  ["rolling", "5-hour", 5 * HOUR_MS],
  ["monthly", "Monthly", 30 * DAY_MS],
]

/**
 * PARSER CONTRACT - the OpenCode GO `zen/go/v1/usage` body, read from the upstream route
 * that serves it and confirmed against one live 200:
 *
 *   { usage: { rolling: { status: "ok" | "rate-limited", percent: number,
 *                         resetsAt: string (ISO 8601) },
 *              weekly: { ...same... }, monthly: { ...same... } } }
 *
 * THREE FIXED LANES, AND THE ORDER IS LOAD-BEARING. There is no window LENGTH in the
 * body, so the labels are the docs' own. The pill renders only the FIRST line and the
 * WEEKLY cap is the budget a user manages, so it leads; the 5-hour lane is line 2.
 *
 * `resetsAt` IS ABSOLUTE, not a duration: adding `now` to it would push every reset a
 * further half-century out. `percent` arrives floored and clamped upstream and is clamped
 * again here. `status` is not rendered - "rate-limited" is what 100% already says.
 *
 * Exported for tests: this is the whole risk surface of the feature.
 */
export function parseGoUsage(body: unknown): UsageResult {
  const providerID = GO_PROVIDER_ID
  if (!isRecord(body)) return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  const usage = isRecord(body["usage"]) ? body["usage"] : undefined
  const windows = GO_LANES.map(([key, label, lengthMs]) => goWindow(usage?.[key], label, lengthMs)).filter(
    (w): w is UsageWindow => w !== undefined,
  )
  if (windows.length === 0) {
    return { ok: false, providerID, unavailable: "The usage endpoint reported no quota window for this subscription." }
  }
  // The plan name is fixed: this endpoint exists only for GO, and a key without
  // the subscription never gets a 200 out of it (403 below).
  return { ok: true, providerID, plan: "go", windows }
}

/**
 * The one HTTP call for OpenCode GO.
 *
 * BEARER ONLY: the chat path sends this same key as `x-api-key`, and the usage endpoint
 * answers 401 to that header and 200 to `Authorization: Bearer`. NO EXPIRY CHECK - an API
 * key does not expire on a clock this module can read.
 *
 * 401 AND 403 ARE DIFFERENT ANSWERS and are worded apart: 401 is an unrecognised key, 403
 * is a valid key whose account has no GO subscription. The status is checked BEFORE the
 * body is read, because a 404 on this host answers HTML and `json()` throws on it.
 */
export async function fetchGoUsage(apiKey: string, fetchImpl: FetchLike): Promise<UsageResult> {
  const providerID = GO_PROVIDER_ID
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(GO_USAGE_ENDPOINT, { headers })
  } catch (cause) {
    // Offline, DNS, TLS. The pill hides the line; it does not show a stack.
    return { ok: false, providerID, unavailable: "Could not reach the usage endpoint." }
  }
  if (!response.ok) {
    if (response.status === 403) {
      return { ok: false, providerID, unavailable: "This key has no OpenCode Go subscription." }
    }
    if (response.status === 401) {
      return { ok: false, providerID, unavailable: "The OpenCode Go key was rejected. Check the key in your config." }
    }
    return { ok: false, providerID, unavailable: `The usage endpoint answered ${response.status}.` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  }
  return parseGoUsage(body)
}

/** Human names for the values `copilot_plan` reports. An unrecognised plan still renders -
 *  as "Copilot <Name>", title-cased on its underscores - rather than the whole result
 *  losing its plan label to one renamed field. */
const COPILOT_PLAN_NAMES: Record<string, string> = {
  individual: "Copilot Individual",
  individual_pro: "Copilot Pro",
  pro: "Copilot Pro",
  pro_plus: "Copilot Pro+",
  business: "Copilot Business",
  enterprise: "Copilot Enterprise",
}

const copilotPlanName = (plan: string): string =>
  COPILOT_PLAN_NAMES[plan] ??
  `Copilot ${plan
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ")}`

/** The start of the quota month, one calendar month before `resetsAt`, same UTC
 *  time-of-day. Built with `Date.UTC(y, m - 1, d, ...)` and NOT `resetsAt - 30 * DAY_MS`:
 *  months are not a fixed number of days. `Date.UTC` NORMALISES an overflowing
 *  day-of-month (a reset on 31 March rolls forward into March itself); that is accepted
 *  here, not corrected. */
const monthBefore = (resetsAt: number): number => {
  const d = new Date(resetsAt)
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() - 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  )
}

/** One `quota_snapshots.<lane>` entry becomes a window, or `"unlimited"` when
 *  the lane carries no percentage worth rendering at all. */
const copilotLane = (
  raw: unknown,
  label: string,
  resetsAt: number | undefined,
  startsAt: number | undefined,
): UsageWindow | "unlimited" | undefined => {
  if (!isRecord(raw)) return undefined
  // Checked BEFORE percent_remaining: the live account this was verified against reports
  // `unlimited: true` ALONGSIDE `percent_remaining: 100` on its unmetered lanes.
  if (raw["unlimited"] === true) return "unlimited"
  const percentRemaining = finiteNumber(raw["percent_remaining"])
  if (percentRemaining === undefined) return undefined
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, 100 - percentRemaining)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(startsAt !== undefined ? { startsAt } : {}),
  }
}

/** The two lanes rendered ONLY when metered — see parseCopilotUsage. */
const COPILOT_METERED_LANES: ReadonlyArray<readonly [string, string]> = [
  ["chat", "Chat"],
  ["completions", "Completions"],
]

/**
 * PARSER CONTRACT - the `copilot_internal/user` body, confirmed against a live 200 on an
 * individual-plan account:
 *
 *   { copilot_plan: string,
 *     quota_reset_date: string ("YYYY-MM-DD", monthly, no time component),
 *     quota_snapshots: { premium_interactions, chat, completions:
 *       { entitlement, remaining, percent_remaining, unlimited, overage_permitted } } }
 *
 * PREMIUM REQUESTS LEADS, the only lane the pill renders first: it is the quota every
 * paid plan meters. chat/completions render ONLY when a plan meters them - an
 * `unlimited: true` lane is no row at all. Premium requests unlimited is the WHOLE
 * result's answer: it degrades to `unavailable` with a sentence that says so.
 *
 * `quota_reset_date` HAS NO TIME COMPONENT and is read as 00:00 UTC of that date; all
 * lanes roll over together. The body states no start, so `startsAt` is DERIVED - see
 * `monthBefore`.
 *
 * Exported for tests: this is the whole risk surface of the feature.
 */
export function parseCopilotUsage(body: unknown, now: number): UsageResult {
  const providerID = "github-copilot"
  if (!isRecord(body)) return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  const snapshots = isRecord(body["quota_snapshots"]) ? body["quota_snapshots"] : undefined
  if (!snapshots) return { ok: false, providerID, unavailable: "The usage endpoint reported no quota snapshot for this account." }

  const resetDate = body["quota_reset_date"]
  const resetsAt = typeof resetDate === "string" && resetDate.length > 0 ? parseIso8601Millis(`${resetDate}T00:00:00Z`) : undefined
  // Every lane in the response shares one reset, so every lane shares one
  // start — computed once here rather than per lane.
  const startsAt = resetsAt !== undefined ? monthBefore(resetsAt) : undefined

  const premium = copilotLane(snapshots["premium_interactions"], "Premium requests", resetsAt, startsAt)
  if (premium === "unlimited") {
    return { ok: false, providerID, unavailable: "Unlimited on this plan." }
  }
  if (premium === undefined) {
    return { ok: false, providerID, unavailable: "The usage endpoint reported no premium-request quota for this account." }
  }

  const windows: UsageWindow[] = [premium]
  for (const [key, label] of COPILOT_METERED_LANES) {
    const lane = copilotLane(snapshots[key], label, resetsAt, startsAt)
    if (lane !== undefined && lane !== "unlimited") windows.push(lane)
  }

  const plan = typeof body["copilot_plan"] === "string" && body["copilot_plan"].length > 0 ? copilotPlanName(body["copilot_plan"]) : undefined
  return { ok: true, providerID, windows, ...(plan !== undefined ? { plan } : {}) }
}

/**
 * The one HTTP call for GitHub Copilot, with the credential already resolved.
 *
 * `credential.refresh` is the raw GitHub OAuth token, not a misnamed field:
 * `plugin/github-copilot/copilot.ts` sends this exact value as the bearer on its
 * `/models` call and every inference request.
 *
 * ENTERPRISE SWAPS THE DOMAIN the way `base()` in copilot.ts does, but onto `api.<domain>`
 * rather than `copilot-api.<domain>`: `copilot_internal/user` is a github.com API route.
 * UNTESTED against a live enterprise tenant. NO REFRESH, same rule as the fetchers above.
 */
export async function fetchCopilotUsage(credential: Auth.Oauth, now: number, fetchImpl: FetchLike): Promise<UsageResult> {
  const providerID = "github-copilot"
  if (credential.expires > 0 && credential.expires <= now) {
    return { ok: false, providerID, unavailable: "Sign-in has expired. Send a message, or re-authorize, then reopen this." }
  }
  const endpoint = credential.enterpriseUrl
    ? `https://api.${credential.enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/copilot_internal/user`
    : COPILOT_USAGE_ENDPOINT
  const headers: Record<string, string> = { Authorization: `Bearer ${credential.refresh}`, Accept: "application/vnd.github+json" }
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(endpoint, { headers })
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
  return parseCopilotUsage(body, now)
}

/**
 * The two lanes this parser reads, with the length each lane's KEY states.
 *
 * WEEKLY LEADS, the rule the ChatGPT and GO parsers already state: the pill renders only
 * the first window. THE MODEL-SCOPED LANES ARE DELIBERATELY NOT HERE - `seven_day_opus`,
 * `seven_day_sonnet` and the rest are all seven days long, so every one would derive the
 * SAME "Weekly" label and collide on one key in the caller's per-label history. A lane
 * this module cannot label honestly is no lane at all.
 */
const ANTHROPIC_LANES: ReadonlyArray<readonly [string, string, number]> = [
  ["seven_day", "Weekly", 7 * DAY_MS],
  ["five_hour", "5-hour", 5 * HOUR_MS],
]

/** One Claude lane. A lane with no FUTURE reset is dropped: without a window end there is
 *  nothing to plot the percentage against, and a reset in the past is a stale reading. A
 *  lane with no `utilization` is dropped for the reason `parseWindow` drops one. */
const anthropicLane = (raw: unknown, label: string, lengthMs: number, now: number): UsageWindow | undefined => {
  if (!isRecord(raw)) return undefined
  const utilization = finiteNumber(raw["utilization"])
  if (utilization === undefined) return undefined
  const resetsAt = parseIso8601Millis(raw["resets_at"])
  if (resetsAt === undefined || resetsAt <= now) return undefined
  return { label, usedPercent: Math.max(0, Math.min(100, utilization)), resetsAt, lengthMs }
}

/**
 * PARSER CONTRACT - the `api/oauth/usage` body. The lane KEYS are read verbatim from the
 * shipped Claude Code CLI bundle; the lane SHAPE is what
 * `packages/vscode/src/claudeCode/planUsage.ts` records against a live 200:
 *
 *   { five_hour: { utilization: number, resets_at: string (ISO 8601), limit_dollars,
 *                  used_dollars, remaining_dollars, locked_reason },
 *     seven_day: { ...same... },
 *     seven_day_opus / _sonnet / _oauth_apps: same shape or null, NOT read,
 *     limits, extra_usage, spend, plus a rotating set of UNNAMED lane keys }
 *
 * THE KEY SET IS NOT FIXED, which is why the lanes are a TABLE rather than a scan: one
 * live body carried nine keys absent from the CLI bundle's own list, one of them
 * reporting `utilization: 0` against `resets_at: null`. A parser that read every numeric
 * key would have rendered that as a window with no name a user could act on.
 *
 * `utilization` IS ALREADY A PERCENTAGE on this body, 0-100, and is clamped again here.
 * `resets_at` IS ABSOLUTE, an ISO 8601 instant: adding `now` to it would push every reset
 * a half-century out. WINDOW LENGTH IS STATED BY THE KEY, which is why it lives in
 * ANTHROPIC_LANES rather than being derived from a field.
 *
 * NO PLAN NAME: the body carries none, and the CLI store's `subscriptionType` is
 * deliberately not read - the trust boundary below is "two fields". A 200 CAN CARRY AN
 * IN-BAND ERROR envelope, which has no lane and degrades to `unavailable`, never a number.
 *
 * Exported for tests: this is the whole risk surface of the feature.
 */
export function parseAnthropicUsage(body: unknown, now: number): UsageResult {
  const providerID = ANTHROPIC_PROVIDER_ID
  if (!isRecord(body)) return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  const windows = ANTHROPIC_LANES.map(([key, label, lengthMs]) => anthropicLane(body[key], label, lengthMs, now)).filter(
    (w): w is UsageWindow => w !== undefined,
  )
  if (windows.length === 0) {
    return { ok: false, providerID, unavailable: "The usage endpoint reported no quota window for this subscription." }
  }
  return { ok: true, providerID, windows }
}

/**
 * The Claude Code CLI's stored OAuth token - the ONE credential this module reads out of
 * a file this program did not write.
 *
 * TRUST BOUNDARY. `~/.claude/.credentials.json` is written by the Claude Code CLI, so:
 *   - it is a READ, never a write - this module must not renew or reshape another
 *     program's credential store,
 *   - only `accessToken` and `expiresAt` are taken; `refreshToken`, `organizationUuid`,
 *     `scopes` and `subscriptionType` are left where they are,
 *   - a missing, unreadable or unrecognised file is `undefined` and NOT an error: on
 *     macOS the CLI may hold this in the keychain, and no Claude Code install at all is
 *     the common case,
 *   - the token goes onto one outbound Authorization header and is dropped.
 *
 * WHY IT IS READ AT ALL: `plugin/anthropic.ts` is an API-KEY provider with no `auth`
 * block, so there is no anthropic OAuth credential in `auth.json` to read. SYNCHRONOUS,
 * like the ext-host reader it mirrors: one small JSON file per usage request.
 */
export const readClaudeCodeCredential: ClaudeCredentialReader = () => {
  try {
    const file = path.join(os.homedir(), ...CLAUDE_CREDENTIALS_RELATIVE)
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    const oauth = isRecord(parsed) ? parsed["claudeAiOauth"] : undefined
    if (!isRecord(oauth)) return undefined
    const token = oauth["accessToken"]
    if (typeof token !== "string" || token.length === 0) return undefined
    return { token, expiresAt: finiteNumber(oauth["expiresAt"]) ?? 0 }
  } catch {
    // No home directory, no file, no read permission, not JSON. One answer to
    // all of them: this machine has no Claude Code sign-in this module can use.
    return undefined
  }
}

/**
 * The one HTTP call for the Claude subscription. Headers mirror the CLI's own request:
 * the bearer, plus its User-Agent, which is what makes this the same read rather than a
 * new client of an unpublished API.
 *
 * NO REFRESH, and here the rule is stronger than for the OAuth providers above: the CLI
 * refreshes on a 401, but refreshing would mean WRITING another program's credential
 * store, which `readClaudeCodeCredential`'s trust boundary forbids. An expired token is
 * reported as expired, and running `claude` once renews it. `expiresAt` OF 0 MEANS
 * UNKNOWN, NOT EXPIRED.
 */
export async function fetchAnthropicUsage(
  credential: ClaudeCredential,
  now: number,
  fetchImpl: FetchLike,
): Promise<UsageResult> {
  const providerID = ANTHROPIC_PROVIDER_ID
  if (credential.expiresAt > 0 && credential.expiresAt <= now) {
    return { ok: false, providerID, unavailable: "The Claude Code sign-in has expired. Run `claude` once to refresh it, then reopen this." }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.token}`,
    "User-Agent": ANTHROPIC_USER_AGENT,
    Accept: "application/json",
  }
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(ANTHROPIC_USAGE_ENDPOINT, { headers })
  } catch (cause) {
    // Offline, DNS, TLS. The fold hides the line; it does not show a stack.
    return { ok: false, providerID, unavailable: "Could not reach the usage endpoint." }
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, providerID, unavailable: "The Claude Code sign-in was rejected by the usage endpoint. Run `claude` once to refresh it." }
    }
    return { ok: false, providerID, unavailable: `The usage endpoint answered ${response.status}.` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    return { ok: false, providerID, unavailable: "The usage endpoint answered something this build cannot read." }
  }
  return parseAnthropicUsage(body, now)
}

/** Human-facing account name for each provider this module can read usage from. */
const USAGE_PROVIDER_NAME: Record<string, string> = {
  openai: "ChatGPT",
  xai: "Grok",
  [GO_PROVIDER_ID]: "OpenCode Go",
  "github-copilot": "GitHub Copilot",
  [ANTHROPIC_PROVIDER_ID]: "Claude",
}

/**
 * Everything that decides "no" BEFORE a request is considered.
 *
 * Pure, and separate from the Effect below, so each refusal can be checked without an
 * `Auth.Service` layer. `undefined` means "this connection has a usage source and a
 * usable credential". `goApiKey` and `claudeCredential` are parameters rather than second
 * lookups so this stays pure.
 */
export function usageGate(
  providerID: string,
  stored: Auth.Info | undefined,
  goApiKey?: string,
  claudeCredential?: ClaudeCredential,
): UsageResult | undefined {
  const displayName = USAGE_PROVIDER_NAME[providerID]
  if (!displayName) {
    return { ok: false, providerID, unavailable: `No usage source is known for ${providerID}.` }
  }
  // GO IS THE ONE SUBSCRIPTION SOLD BEHIND AN API KEY, so it takes its own branch BEFORE
  // the two rules below: "metered per token" is factually wrong for it, and the key is not
  // in the credential store at all, which would make "not signed in" wrong too.
  if (providerID === GO_PROVIDER_ID) {
    if (!goApiKey) return { ok: false, providerID, unavailable: `No ${displayName} API key is configured.` }
    return undefined
  }
  // ANTHROPIC IS THE ONE SUBSCRIPTION SIGNED IN TO BY ANOTHER PROGRAM, so it takes its own
  // branch for the same reason GO does: its credential is not in the store, and an `api`
  // credential on this id is a SEPARATE metered account that neither proves nor disproves
  // a subscription.
  if (providerID === ANTHROPIC_PROVIDER_ID) {
    if (!claudeCredential) {
      return { ok: false, providerID, unavailable: "No Claude Code sign-in was found on this machine." }
    }
    return undefined
  }
  if (!stored) return { ok: false, providerID, unavailable: `Not signed in to ${displayName}.` }
  if (stored.type !== "oauth") {
    // An API-key credential on the same provider id is a DIFFERENT, metered account with no
    // subscription window - saying "not signed in" would be a lie, so name the type instead.
    return {
      ok: false,
      providerID,
      unavailable: `Subscription usage needs a ${displayName} sign-in. An API key is metered per token and has no plan window.`,
    }
  }
  return undefined
}

/**
 * OpenCode GO's key, config FIRST.
 *
 * `getGlobal()` and not `get()`: this runs on the bare fiber `acp/agent.ts` starts every
 * ext request on, `provider_auth_usage` carries no `cwd`, and `Config.get()` reads through
 * `InstanceState`, which DIES without an instance reference. The global file is where the
 * shell writes the key anyway. An `api` credential on the same id is honoured as a
 * FALLBACK, so a key added with `origami providers login` reads the same subscription.
 */
const goApiKeyOf = Effect.fn("ACPProviderUsage.goApiKey")(function* (stored: Auth.Info | undefined) {
  const config = yield* Config.Service
  const cfg = yield* config.getGlobal()
  const fromConfig = cfg.provider?.[GO_PROVIDER_ID]?.options?.apiKey
  if (typeof fromConfig === "string" && fromConfig.length > 0) return fromConfig
  if (stored?.type === "api" && stored.key.length > 0) return stored.key
  return undefined
})

/** The ACP-facing entry point. Reads `Auth.Service` directly rather than going through
 *  `ProviderAuth`: this is not part of a sign-in flow and needs the credential itself, not
 *  the list of ways to obtain one. Takes no directory - no instance state is involved. */
export const usage = Effect.fn("ACPProviderUsage.usage")(function* (
  providerID: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  now: number = Date.now(),
  readClaude: ClaudeCredentialReader = readClaudeCodeCredential,
) {
  // Read the credential BEFORE gating so an unsupported provider and a missing
  // sign-in are answered by the same table rather than by two orders of checks.
  const auth = yield* Auth.Service
  const stored = yield* auth.get(providerID).pipe(Effect.orElseSucceed(() => undefined))
  // Only GO pays for a config read, so every other provider's refusal costs
  // exactly what it did before this lane existed.
  const goApiKey = providerID === GO_PROVIDER_ID ? yield* goApiKeyOf(stored) : undefined
  // Only anthropic pays for the disk read, the same rule the GO config read
  // follows: every other provider's refusal costs what it did before.
  const claudeCredential = providerID === ANTHROPIC_PROVIDER_ID ? readClaude() : undefined
  const refused = usageGate(providerID, stored, goApiKey, claudeCredential)
  if (refused) return refused
  if (goApiKey !== undefined) return yield* Effect.promise(() => fetchGoUsage(goApiKey, fetchImpl))
  if (claudeCredential !== undefined)
    return yield* Effect.promise(() => fetchAnthropicUsage(claudeCredential, now, fetchImpl))
  const credential = stored as Auth.Oauth
  const fetchUsage =
    providerID === "xai" ? fetchGrokUsage : providerID === "github-copilot" ? fetchCopilotUsage : fetchChatgptUsage
  return yield* Effect.promise(() => fetchUsage(credential, now, fetchImpl))
})

export * as ACPProviderUsage from "./provider-usage"

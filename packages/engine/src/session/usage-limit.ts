import { SessionV1 } from "@origami/core/v1/session"
import type { Err } from "./retry"

/**
 * A subscription's usage window is spent.
 *
 * The ChatGPT backend answers a Plus/Pro account that has used its window with
 * HTTP 429 and a body that says so by name:
 *   {"error":{"type":"usage_limit_reached","plan_type":"plus","resets_at":…,"resets_in_seconds":5196}}
 * It is a 429, so the SDK marks it retryable and the ladder in retry.ts would
 * spend all eight attempts before telling the user the one thing that matters:
 * WHEN the window resets. No repeat changes the answer inside the window, so
 * this class is let out on the FIRST attempt with a line naming the reset. Read
 * from the response body, never guessed from the status.
 */
export type Limit = {
  plan?: string
  resetsInSeconds?: number
  /** The provider's own words, set only by the Claude subscription route (`upstream_message`, packages/llm claude-cli.ts). */
  upstream?: string
}

function parse(value: unknown): Record<string, any> | undefined {
  if (typeof value !== "string") return undefined
  try {
    const json = JSON.parse(value)
    return json && typeof json === "object" ? json : undefined
  } catch {
    return undefined
  }
}

/** The limit this error reports, or undefined when the error is anything else. */
export function detect(error: Err): Limit | undefined {
  if (!SessionV1.APIError.isInstance(error)) return undefined
  const body = parse(error.data.responseBody) ?? parse(error.data.message)
  const inner = body?.error
  if (!inner || typeof inner !== "object" || inner.type !== "usage_limit_reached") return undefined
  const seconds = Number(inner.resets_in_seconds)
  return {
    plan: typeof inner.plan_type === "string" ? inner.plan_type : undefined,
    resetsInSeconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined,
    ...(typeof inner.upstream_message === "string" && inner.upstream_message.trim() !== ""
      ? { upstream: inner.upstream_message.trim() }
      : {}),
  }
}

/** What the user calls the connection; the provider id is what the engine calls it. */
const NAMES: Record<string, string> = {
  openai: "ChatGPT",
  anthropic: "Claude",
  xai: "SuperGrok",
  "claude-subscription": "Claude subscription",
}

function wait(seconds: number): string {
  if (seconds < 90) return "about a minute"
  const minutes = Math.round(seconds / 60)
  if (minutes < 120) return `about ${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return `about ${hours} hours`
}

/** The one line the user sees. Plain words: what stopped, when it comes back, what to do. */
export function notice(limit: Limit, provider: string): string {
  const name = NAMES[provider] ?? provider
  const plan = limit.plan ? ` on the ${limit.plan} plan` : ""
  const reset = limit.resetsInSeconds === undefined ? "" : ` It resets in ${wait(limit.resetsInSeconds)}.`
  const said = limit.upstream ? ` ${name} said: "${limit.upstream.slice(0, 500)}"` : ""
  return `${name} usage limit reached${plan}.${reset} The message was not sent — try again after the reset, or pick another connection.${said}`
}

export * as SessionUsageLimit from "./usage-limit"

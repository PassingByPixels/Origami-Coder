/**
 * How each provider caches a prompt prefix, and what that makes a cache miss
 * mean (t-rylleg).
 *
 * ONE table, engine-side. The webview carried its own copy
 * (`dashboard/components/labyrinthCachePolicy.ts`) and derived a cause from it
 * by guessing at four rules; the engine can measure what those rules infer, so
 * the window lives here, beside the derivation that uses it, and the step
 * carries the answer to the client.
 *
 * The table carries no dates and fetches NOTHING. A window is recorded only
 * where the provider PUBLISHES one: everywhere else `windowSeconds` answers
 * undefined, no `ttlSeconds` is written, and `idle` is never claimed. That is
 * the safe direction - a provider with no published window that dropped the
 * prefix falls to `provider`, which says what happened without inventing a
 * clock the engine cannot keep.
 *
 * Pure: no Effect, no services, no clock. The one import is the provider
 * layer's OpenAI family table, which is data of the same kind.
 */
import { ProviderTransform } from "@/provider/transform"

/** One cause per miss. Order of this list is NOT the precedence - see `cause`. */
export type Cause =
  | "cold"
  | "model"
  | "compaction"
  | "stopped"
  | "idle"
  | "system"
  | "tools"
  | "history"
  | "provider"
  | "small"

/**
 * A provider family and what it publishes about its prefix cache. `ttlSeconds`
 * is the GENEROUS end of the published range on purpose: `idle` is claimed only
 * when the gap exceeded it, so the claim errs towards saying nothing. The one
 * exception is OpenAI, whose window is per model family: there `ttlSeconds` is
 * the shortest family's window, used only when the caller has no model id.
 *
 * `minimumTokens` is the smallest prefix the provider will cache at all. Below
 * it a miss is the documented behaviour rather than a fault.
 */
export type Policy = {
  readonly providers: readonly string[]
  readonly ttlSeconds?: number
  readonly minimumTokens?: number
  /** Haiku-class models need a larger prefix before Anthropic caches anything. */
  readonly minimumTokensByModel?: readonly (readonly [RegExp, number])[]
}

export const POLICIES: readonly Policy[] = [
  // Anthropic: 5 minutes sliding, 1 hour on the opt-in `ttl: "1h"` form, which
  // `windowSeconds` takes from the request's own cache hint rather than
  // guessing. 1024 tokens minimum, 2048 on Haiku.
  {
    providers: ["anthropic", "google-vertex-anthropic"],
    ttlSeconds: 300,
    minimumTokens: 1024,
    minimumTokensByModel: [[/haiku/i, 2048]],
  },
  // OpenAI and Azure: automatic on a matching prefix, an idle window that is
  // best effort AND published per model family, not per provider (t-rz0amv) -
  // 30 minutes on gpt-5.6+ and on the extended-retention families the engine
  // asks `prompt_cache_retention: "24h"` for, 5 minutes on the rest. So the
  // window comes from `ProviderTransform.openaiCacheWindowSeconds(modelID)`
  // and `ttlSeconds` here is only the floor for a caller that has no model id.
  { providers: ["openai", "azure"], ttlSeconds: 300, minimumTokens: 1024 },
  // Named so the table says these were CONSIDERED and publish no window, rather
  // than falling through as unknown providers: Google implicit caching,
  // OpenRouter (whatever the upstream does, and it may route elsewhere), the
  // local servers (KV reuse until the server evicts), and the gateways whose
  // model catalogs in this repo carry no cache TTL at all.
  {
    providers: [
      "google",
      "vertex",
      "openrouter",
      "vllm",
      "lmstudio",
      "ollama",
      "llamacpp",
      "sglang",
      "local",
      "opencode-go",
      "opencode-zen",
      "deepseek",
      "xai",
      "github-copilot",
    ],
  },
]

/** The Anthropic 1-hour opt-in, as `SessionCacheWarm.ttlSeconds` reports it. */
const TTL_1H_SECONDS = 3600

function policyFor(providerID: string): Policy | undefined {
  const id = providerID.toLowerCase()
  // `spark*` is a family of local lanes (spark, spark2, ...), matched by prefix
  // the way the shell's table matches `spark`.
  if (id.startsWith("spark")) return POLICIES.find((item) => item.providers.includes("local"))
  return POLICIES.find((item) => item.providers.includes(id))
}

/**
 * The window this provider publishes for a cached prefix, in seconds, or
 * undefined where it publishes none. `hintTtlSeconds` is the TTL the request's
 * own inline cache hint carried (`SessionCacheWarm.ttlSeconds`), which is the
 * only thing that can tell the Anthropic 1-hour form from the 5-minute one.
 *
 * `modelID` is the provider's own model id (`model.api.id`). OpenAI publishes
 * its window per model FAMILY, so a caller that has the id gets the family's
 * window; one that has none keeps the floor in the table, which is the shortest
 * window any OpenAI model publishes. Nothing else reads the model id.
 */
export function windowSeconds(input: {
  readonly providerID: string
  readonly modelID?: string | undefined
  readonly hintTtlSeconds?: number | undefined
}): number | undefined {
  const policy = policyFor(input.providerID)
  if (!policy?.ttlSeconds) return undefined
  if (input.hintTtlSeconds === TTL_1H_SECONDS) return TTL_1H_SECONDS
  if (input.modelID !== undefined && policy.providers.includes("openai"))
    return ProviderTransform.openaiCacheWindowSeconds(input.modelID) ?? policy.ttlSeconds
  return policy.ttlSeconds
}

/**
 * The smallest prefix this provider caches, in tokens, or undefined where it
 * publishes no minimum - `small` is then never claimed.
 */
export function minimumTokens(input: {
  readonly providerID: string
  readonly modelID: string
}): number | undefined {
  const policy = policyFor(input.providerID)
  if (!policy?.minimumTokens) return undefined
  const override = policy.minimumTokensByModel?.find(([match]) => match.test(input.modelID))
  return override?.[1] ?? policy.minimumTokens
}

/**
 * What the request layer measured about one prepared request, against the
 * previous one of the same session. Every member is a MEASUREMENT: an absent
 * one means the fact was not measured, never that it was false.
 */
export type Facts = {
  /** No previous request of this session was measured in this process. */
  readonly first: boolean
  /** A compaction ran since the previous request. */
  readonly compacted: boolean
  readonly modelChanged: boolean
  readonly systemChanged: boolean
  readonly toolsChanged: boolean
  /**
   * The halves of the prefix that changed while the engine was stopped: the
   * previous request is the last one PERSISTED before a restart, and these
   * moved against it. Absent when the previous request was in this process,
   * or when nothing moved. A history rewrite an engine rewriter named is not
   * here: it is the ordinary `history` cause.
   */
  readonly stopped?: readonly StoppedHalf[] | undefined
  /** The previous request's whole array survived as a byte-identical prefix. */
  readonly preserved?: boolean | undefined
  readonly idleMs?: number | undefined
  readonly ttlSeconds?: number | undefined
}

/** A half of the cached prefix that can change while the engine is stopped. */
export type StoppedHalf = "system" | "tools" | "history"

/**
 * The one cause of a miss. Precedence is fixed and ordered by how far upstream
 * the fault is: a cold session cannot also have aged out, and a changed system
 * prompt explains a miss whether or not the gap was long. The facts on the part
 * carry the rest, so a reader still sees "idle 7 min AND tools changed".
 */
export function cause(
  input: Facts & {
    /** Tokens the provider was asked to read: the whole prompt, cache included. */
    readonly prefillTokens?: number | undefined
    readonly minimumTokens?: number | undefined
  },
): Cause {
  if (input.first) return "cold"
  if (input.compacted) return "compaction"
  if (input.modelChanged) return "model"
  if (input.stopped !== undefined && input.stopped.length > 0) return "stopped"
  if (input.systemChanged) return "system"
  if (input.toolsChanged) return "tools"
  if (input.preserved === false) return "history"
  // Only ever against a window the provider publishes. Without one the gap is
  // recorded and no claim is made about it.
  if (input.ttlSeconds !== undefined && input.idleMs !== undefined && input.idleMs > input.ttlSeconds * 1000)
    return "idle"
  if (
    input.minimumTokens !== undefined &&
    input.prefillTokens !== undefined &&
    input.prefillTokens < input.minimumTokens
  )
    return "small"
  return "provider"
}

/**
 * Does this step's usage report cache tokens at all? A provider that never
 * sends the field (LM Studio, sglang, most vLLM builds) is cache-BLIND, and
 * `Session.getUsage` cannot say so: it folds an absent field to 0, which reads
 * as a measured miss. So the question is asked one layer up, of the raw usage,
 * and a blind step carries no `cache` block rather than a fabricated cause.
 */
export function reportsCache(input: {
  readonly cacheReadInputTokens?: number | undefined
  readonly cacheWriteInputTokens?: number | undefined
}): boolean {
  return input.cacheReadInputTokens !== undefined || input.cacheWriteInputTokens !== undefined
}

export * as SessionCachePolicy from "./cache-policy"

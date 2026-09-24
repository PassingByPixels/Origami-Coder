import type { RuntimeFlags } from "@/effect/runtime-flags"
import type { Provider } from "@/provider/provider"

/**
 * Which provider families run on the native `@origami/llm` runtime.
 *
 * The family is the wire protocol the model speaks, read off the AI SDK package
 * id the provider registry resolved for it. A family is switched on only once
 * the cassette parity harness (`test/session/llm-parity.test.ts`) is green for
 * it; everything else keeps the AI SDK path.
 * `ORIGAMI_EXPERIMENTAL_NATIVE_LLM=true` forces every family on for testing.
 *
 * `xai` speaks the OpenAI Responses protocol but stays its own family: the
 * engine keys its provider options under a different name and its auth is
 * OAuth-first.
 */
export type Family =
  | "openai-compatible"
  | "openai"
  | "azure"
  | "anthropic"
  | "google"
  | "bedrock"
  | "openrouter"
  | "xai"
  | "copilot"
  | "mistral"
  | "groq"
  | "cerebras"
  | "deepinfra"
  | "togetherai"
  | "perplexity"
  | "alibaba"
  | "venice"
  | "v0"
  | "claude-subscription"
  | "other"

const FAMILY_BY_NPM: Record<string, Family> = {
  "@ai-sdk/openai-compatible": "openai-compatible",
  "@ai-sdk/openai": "openai",
  "@ai-sdk/azure": "azure",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "google",
  "@ai-sdk/amazon-bedrock": "bedrock",
  "@openrouter/ai-sdk-provider": "openrouter",
  "@ai-sdk/xai": "xai",
  // GitHub Copilot speaks OpenAI Chat and Responses but stays its own family:
  // plugin-signed OAuth bearer, options keyed "copilot". Its Claude rows are not
  // here — models.ts declares those `@ai-sdk/anthropic`, so they ride the
  // anthropic family and its flag.
  "@ai-sdk/github-copilot": "copilot",
  // Each small-provider facade is its own family (one npm package, one wire
  // dialect, one flag) so a cassette run can flip one without the others.
  "@ai-sdk/mistral": "mistral",
  "@ai-sdk/groq": "groq",
  "@ai-sdk/cerebras": "cerebras",
  "@ai-sdk/deepinfra": "deepinfra",
  "@ai-sdk/togetherai": "togetherai",
  "@ai-sdk/perplexity": "perplexity",
  "@ai-sdk/alibaba": "alibaba",
  "venice-ai-sdk-provider": "venice",
  "@ai-sdk/vercel": "v0",
  // Not an npm package: the owner's Claude subscription through the installed
  // `claude` CLI (provider/claude-subscription.ts). Its own family, never the
  // anthropic one: it must not share the API-key family's auth or flag.
  "origami-claude-subscription": "claude-subscription",
}

export const family = (npm: string): Family => FAMILY_BY_NPM[npm] ?? "other"

/**
 * A model served by GitHub Copilot, whatever wire it speaks.
 *
 * Copilot's Claude rows are declared `@ai-sdk/anthropic`, so the family cannot
 * identify them — only the provider id can. Two things key on this: the OAuth
 * signer bridge (the Claude Pro/Max subscription installs the same signer shape
 * on the anthropic family and must not be bridged), and the Anthropic route's
 * auth (Copilot stores no key, so `x-api-key` resolution has to be skipped).
 */
export const isCopilotProvider = (model: Pick<Provider.Model, "providerID">) =>
  String(model.providerID).includes("github-copilot")

/**
 * A family is `true` only once its own cassettes replay with equal event streams
 * and byte-equal request bodies on both runtimes; everything else stays off
 * until its cassettes do. OpenRouter is its own family on purpose: the
 * `openai-compatible/openrouter-*.json` cassettes reach the same endpoint as a
 * plain OpenAI-compatible one, which is a different wire body.
 */
export const DEFAULTS: Readonly<Record<Family, boolean>> = {
  "openai-compatible": true,
  openai: true,
  azure: false,
  anthropic: true,
  google: false,
  bedrock: false,
  openrouter: true,
  xai: true,
  copilot: true,
  // Off until each provider's own cassette parity run is green — one line to
  // flip per family once its cassettes exist.
  mistral: false,
  groq: false,
  cerebras: false,
  deepinfra: false,
  togetherai: false,
  perplexity: false,
  alibaba: false,
  venice: false,
  v0: false,
  // Off, and not reachable through the lists below either: only its own flag turns it on.
  "claude-subscription": false,
  other: false,
}

type Flags = Pick<RuntimeFlags.Info, "experimentalNativeLlm" | "nativeLlmFamilies"> &
  Partial<Pick<RuntimeFlags.Info, "experimentalClaudeSubscription">>

/**
 * Resolution order: the legacy all-on flag, then an explicit family list
 * (`all`, `none`, or `openai-compatible,anthropic`), then the defaults. The
 * parity harness runs the AI SDK side with `none` so a family that is on by
 * default can still be compared against the path it replaced.
 */
export const enabled = (model: Pick<Provider.Model, "api">, flags: Flags) => {
  const current = family(model.api.npm)
  // The subscription family has no AI SDK path to compare against and an
  // account-risk disclosure in front of it, so the parity switches ("all", the
  // legacy all-on flag) never turn it on. Its own flag is the only switch.
  if (current === "claude-subscription") return flags.experimentalClaudeSubscription === true
  if (flags.experimentalNativeLlm) return true
  // A test layer may build the flags from a literal that predates this key.
  const listed = (flags.nativeLlmFamilies ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  if (listed.length === 0) return DEFAULTS[current]
  if (listed.includes("none")) return false
  return listed.includes("all") || listed.includes(current)
}

export * as LLMNativeRoute from "./native-route"

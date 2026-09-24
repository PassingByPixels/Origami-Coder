/**
 * Providers and scenarios the parity harness records and replays.
 *
 * Provider entries carry everything a run needs that is not the scenario: the
 * wire family (which is also the cassette folder), the real upstream, how the
 * endpoint is authenticated, and — for the ChatGPT backend — the body
 * transform its own fetch override would have applied. Model entries mirror
 * the real `origami.json` entries so capability derivation (reasoning field,
 * modalities, context limit) is production-faithful rather than invented for
 * the test.
 */

import type { ConfigV1 } from "@origami/core/v1/config/config"
import type { SessionV1 } from "@origami/core/v1/session"
import { LLMEvent } from "@origami/llm"
import { tool, type JSONValue, type ModelMessage, type Tool } from "ai"
import { Effect, Option, Schema } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import z from "zod"
import type { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { withoutSampling } from "@/plugin/openai/codex"
import type { Provider } from "@/provider/provider"
import type { LLM } from "@/session/llm"
import type { LLMNativeRoute } from "@/session/llm/native-route"
import { MessageID, SessionID } from "@/session/schema"

type ConfigModel = NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]

/**
 * Cassette folder for a provider: the native route family, so a cassette sits
 * under the family whose runtime it gates (`native-route.ts`).
 */
export type ParityFamily = LLMNativeRoute.Family

/** How the real endpoint authenticates. `none` = keyless local server. */
export type ParityAuth = "key" | "oauth" | "none"

export type ParityProvider = {
  readonly id: string
  /**
   * The provider id the CONFIG and `auth.json` use, when it differs from the
   * harness entry id. A plugin auth loader only runs for the provider id it
   * declares (`plugin.auth.provider`), and Copilot's hooks key on
   * "github-copilot" — so its two entries, which differ only in which endpoint
   * the model lands on, share one config id and keep separate cassettes.
   */
  readonly providerID?: string
  readonly npm: string
  readonly family: ParityFamily
  readonly realBaseURL: string
  readonly modelID: string
  readonly model: ConfigModel
  /** Defaults to `none`. */
  readonly auth?: ParityAuth
  /**
   * The Copilot endpoint this entry's model is served on, stamped onto the
   * RESOLVED model as `api.endpoint`.
   *
   * In production that field is written by the plugin's models hook from
   * GitHub's own `supported_endpoints` (`plugin/github-copilot/models.ts`
   * `build`), and BOTH runtimes read it: the AI SDK path in `provider.ts`
   * ("github-copilot" `getModel`, `"endpoint" in model.api`) and the native
   * path in `session/llm/native-request.ts` (`copilotEndpoint`). A
   * CONFIG-declared model cannot carry it — the config branch of `provider.ts`
   * builds `api` as `{ id, npm, url }` and `ProviderApiInfo` has no such
   * field — so without this the harness can only reach the fallback rule,
   * which sends every `gpt-5*` id to `/responses`.
   *
   * `stampEndpoint` applies it, so a gpt-5 model can be recorded on
   * `/chat/completions` — the endpoint the vendored chat model's `verbosity`
   * and `reasoning_opaque` handling lives on, and the one a production row
   * lands on whenever GitHub's `supported_endpoints` names it. Whether
   * GitHub serves THIS id there is what the record run finds out.
   */
  readonly apiEndpoint?: "chat" | "responses"
  /**
   * Set `false` to drive this entry with an agent that declares NO temperature.
   *
   * Every cassette before this field recorded with the harness agent's
   * `temperature: 0`, and `request.ts` sends an explicit agent temperature
   * unconditionally — `input.agent.temperature ?? (capabilities.temperature ?
   * ...)`, so `0` wins even over a model whose `capabilities.temperature` is
   * `false`. GitHub refuses it on a gpt-5 row served over
   * `/chat/completions`: "Unsupported value: 'temperature' does not support 0
   * with this model. Only the default (1) value is supported." (measured
   * 2026-09-04, record run). The responses lane never hit it because the
   * vendored responses model drops temperature for a reasoning model before
   * the body is built — `copilot-responses-text.json` has no `temperature`
   * key, `copilot-text.json` (gpt-4.1, chat) has `temperature: 0`.
   *
   * Dropping the agent knob is not a special case for the test: an agent with
   * no temperature is the ordinary production shape (`Agent.Info.temperature`
   * is optional), and the capability gate then decides. Only the AGENT knob
   * goes — `frequency_penalty` still rides along, because
   * `ProviderTransform.frequencyPenalty` returns 0 for every model and the
   * cassette has to be the request production makes.
   */
  readonly sampling?: false
  /** Env var holding the API key in record mode. Required when `auth` is `key`. */
  readonly keyEnv?: string
  /** Scenario ids this provider runs. Every scenario when absent. */
  readonly scenarios?: ReadonlyArray<string>
  /**
   * Model VARIANT to select per scenario id, e.g. `{ reasoning: "high" }`.
   * A variant is how the engine turns a reasoning control on (`request.ts`
   * reads `input.user.model.variant` and merges `model.variants[name]` over
   * the options), so a scenario that means to exercise extended thinking has
   * to name one. No entry means no variant, which is what every cassette
   * recorded before this field did.
   */
  readonly variants?: Readonly<Record<string, string>>
  /** Record-mode transform applied to the body forwarded upstream, not to the cassette. */
  readonly forwardBody?: (body: string) => string
}

/** Config `options.apiKey` on a replay run. Headers are not diffed; only the body is. */
export const REPLAY_API_KEY = "parity-replay"

/**
 * The sampling strip the codex OAuth override applies when it rewrites a URL
 * to `chatgpt.com/backend-api/codex/responses`. Here the URL is already that
 * path (the proxy's base is `/backend-api/codex`), so the override leaves it
 * alone and skips its own strip — the proxy has to do it instead, with the
 * same function so the two can never drift.
 */
const stripSampling = (body: string): string => {
  const stripped = withoutSampling(body)
  return typeof stripped === "string" ? stripped : body
}

/**
 * Output cap for every hosted provider, in tokens. The scenarios want a
 * sentence, a tool call and a short sum — nothing needs more — and the cap is
 * the cost knob on a metered lane. It is expressed as `limit.output` because
 * `LLM.StreamInput` carries no per-call field: `ProviderTransform.maxOutputTokens`
 * reads `Math.min(model.limit.output, 32_000) || 32_000` off the MODEL.
 */
const HOSTED_OUTPUT_LIMIT = 256

/**
 * Output cap for the ONE scenario that needs a long answer: a reasoning
 * summary with more than one part. Everything else keeps
 * `HOSTED_OUTPUT_LIMIT`; this is the smallest cap that leaves room for two
 * summary parts plus a short answer, and still small enough that a record
 * run of the one scenario stays cheap.
 */
const SUMMARY_OUTPUT_LIMIT = 4000

/**
 * `limit.context` is required by the config schema, so a provider whose real
 * window this harness does not know declares 0 — the same value the config
 * parser fills in when the field is absent, and the sentinel
 * `session/overflow.ts` reads as "no window, do nothing" (`limit.context === 0`
 * returns empty). It is NOT a claim that the window is zero.
 */
const CONTEXT_UNDECLARED = 0

const OPENROUTER_MODEL = "nvidia/nemotron-3.5-lightning:free"
const OPENCODE_GO_MODEL = "deepseek-v4-flash"
// `gpt-5.3-codex-spark` is NOT usable here: the ChatGPT backend refuses it by
// name (see the note at the top of src/plugin/openai/codex.ts). `gpt-5.4-mini`
// is in that plugin's ALLOWED_MODELS and is the cheapest of them.
const OPENAI_MODEL = "gpt-5.4-mini"
// grok-4.6-fast is refused for Passing's team ("does not exist or your team does
// not have access"); grok-4.5 is his catalog entry and the one he picked.
const XAI_MODEL = "grok-4.5"
// The Haiku id the shipped catalog declares (test/tool/fixtures/models-api.json,
// provider "anthropic"). Haiku is the only paid model this harness may call.
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"

// Copilot's chat lane and its responses lane. `gpt-4.1` has no `/responses`
// entry in GitHub's catalog, so the facade's gpt-5 rule puts it on
// `/chat/completions`; `gpt-5.4` goes to `/responses` by the same rule. Both
// are in UTILITY_MODELS territory rather than premium Claude rows, so a record
// run is cheap.
const COPILOT_CHAT_MODEL = "gpt-4.1"
const COPILOT_RESPONSES_MODEL = "gpt-5.4"

export const PROVIDERS: ReadonlyArray<ParityProvider> = [
  {
    id: "vllm",
    npm: "@ai-sdk/openai-compatible",
    family: "openai-compatible",
    realBaseURL: "http://192.0.2.10:8000/v1",
    modelID: "deepseek-v4-flash-vision-exp-ablit",
    model: {
      name: "deepseek-v4-flash-vision-exp-ablit",
      limit: { context: 1048576, output: 0 },
      attachment: true,
      modalities: { input: ["text", "image"] },
    },
  },
  // Not recorded: the LM Studio host was ejected. The entry stays so a later
  // run can record it with `PARITY_PROVIDER=lmstudio`; until a cassette exists
  // its cases skip, and recording is never implicit.
  {
    id: "lmstudio",
    npm: "@ai-sdk/openai-compatible",
    family: "openai-compatible",
    realBaseURL: "http://127.0.0.1:1234/v1",
    modelID: "qwen3.8-27b",
    model: {
      attachment: true,
      modalities: { input: ["text", "image"] },
    },
  },
  // A free OpenRouter lane, so a record run costs nothing. The model id is
  // written once and reused for the config `name`.
  {
    id: "openrouter",
    npm: "@ai-sdk/openai-compatible",
    family: "openai-compatible",
    realBaseURL: "https://openrouter.ai/api/v1",
    auth: "key",
    keyEnv: "PARITY_KEY_OPENROUTER",
    modelID: OPENROUTER_MODEL,
    model: {
      name: OPENROUTER_MODEL,
      limit: { context: CONTEXT_UNDECLARED, output: HOSTED_OUTPUT_LIMIT },
      attachment: false,
    },
  },
  // The SAME free OpenRouter lane reached through OpenRouter's OWN AI SDK
  // package, which is a different wire body from the openai-compatible entry
  // above: `ProviderTransform.options` adds `usage: { include: true }` for this
  // npm id, and the native side lowers it through
  // packages/llm/src/providers/openrouter.ts, not the openai-compatible route.
  // Its cassettes therefore live under `openrouter/`, not `openai-compatible/`,
  // and the id has to differ so a record run can select one without the other.
  {
    id: "openrouter-native",
    npm: "@openrouter/ai-sdk-provider",
    family: "openrouter",
    realBaseURL: "https://openrouter.ai/api/v1",
    auth: "key",
    keyEnv: "PARITY_KEY_OPENROUTER",
    // One real OpenRouter account serves two harness entries: this one dials it
    // through @openrouter/ai-sdk-provider, `openrouter` through the plain
    // OpenAI-compatible package. The config/auth id is the real one.
    providerID: "openrouter",
    modelID: OPENROUTER_MODEL,
    model: {
      name: OPENROUTER_MODEL,
      limit: { context: CONTEXT_UNDECLARED, output: HOSTED_OUTPUT_LIMIT },
      attachment: false,
    },
  },
  {
    id: "opencode-go",
    npm: "@ai-sdk/openai-compatible",
    family: "openai-compatible",
    realBaseURL: "https://opencode.ai/zen/go/v1",
    auth: "key",
    keyEnv: "PARITY_KEY_OPENCODE_GO",
    modelID: OPENCODE_GO_MODEL,
    model: { name: OPENCODE_GO_MODEL, limit: { context: CONTEXT_UNDECLARED, output: HOSTED_OUTPUT_LIMIT } },
  },
  // The ChatGPT OAuth backend. `realBaseURL` deliberately stops at
  // `/backend-api/codex`: the request path is then
  // `/backend-api/codex/responses`, which contains neither `/v1/responses` nor
  // `/chat/completions`, so the codex fetch override does NOT rewrite the URL
  // and the request reaches the proxy. The strip the override would have done
  // on a rewrite is `forwardBody` below.
  {
    id: "openai",
    npm: "@ai-sdk/openai",
    family: "openai",
    realBaseURL: "https://chatgpt.com/backend-api/codex",
    auth: "oauth",
    modelID: OPENAI_MODEL,
    model: {
      name: "GPT-5.4 mini",
      limit: { context: 400000, output: HOSTED_OUTPUT_LIMIT },
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: false,
      modalities: { input: ["text", "image"], output: ["text"] },
    },
    forwardBody: stripSampling,
  },
  // The xAI OAuth override sets the bearer and a User-Agent but never rewrites
  // the URL, so the proxy needs no body transform here.
  {
    id: "xai",
    npm: "@ai-sdk/xai",
    family: "xai",
    realBaseURL: "https://api.x.ai/v1",
    auth: "oauth",
    modelID: XAI_MODEL,
    model: {
      name: XAI_MODEL,
      limit: { context: 500000, output: HOSTED_OUTPUT_LIMIT },
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  },
  // GitHub Copilot, OAuth through VS Code's public app id. Both entries name
  // the SAME config provider ("github-copilot"): that is the id the plugin's
  // auth loader, `chat.headers` and `chat.params` hooks all key on, and the id
  // an auth.json entry must use. They differ only in the model, which is what
  // decides chat vs responses. The signer forwards exactly as the openai entry
  // does — it sets the bearer and Copilot's own headers and never rewrites the
  // URL, so the proxy needs no body transform.
  //
  // NOT YET RECORDED: the catalog these ids come from is only served to the new
  // app id, so the owner must sign in again first.
  {
    id: "copilot",
    providerID: "github-copilot",
    npm: "@ai-sdk/github-copilot",
    family: "copilot",
    realBaseURL: "https://api.githubcopilot.com",
    auth: "oauth",
    modelID: COPILOT_CHAT_MODEL,
    model: {
      name: COPILOT_CHAT_MODEL,
      limit: { context: 128000, output: HOSTED_OUTPUT_LIMIT },
      tool_call: true,
      attachment: true,
      temperature: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  },
  {
    id: "copilot-responses",
    providerID: "github-copilot",
    npm: "@ai-sdk/github-copilot",
    family: "copilot",
    realBaseURL: "https://api.githubcopilot.com",
    auth: "oauth",
    modelID: COPILOT_RESPONSES_MODEL,
    model: {
      name: COPILOT_RESPONSES_MODEL,
      limit: { context: 400000, output: HOSTED_OUTPUT_LIMIT },
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: false,
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  },
  // The SAME gpt-5.4 row, forced onto `/chat/completions` with `apiEndpoint`.
  // This is the third Copilot path and the one neither cassette above covers:
  // the vendored CHAT model writes `verbosity` from `textVerbosity`
  // (`github-copilot/chat/openai-compatible-chat-language-model.ts` line 176)
  // and round-trips Copilot's `reasoning_opaque`
  // (`convert-to-openai-compatible-chat-messages.ts` lines 86-121), and
  // `ProviderTransform.options` sets `textVerbosity: "low"` +
  // `reasoningEffort: "medium"` for any `gpt-5.` id, so no variant is needed
  // to put both on the wire — the model id alone does it. `tool-loop` is what
  // exercises the `reasoning_opaque` REPLAY: `toolRoundtrip` carries turn 1's
  // `providerMetadata` back as `providerOptions` on turn 2's assistant part.
  //
  // gpt-4.1 above cannot serve this: it is not a gpt-5 id, so the transform
  // sets neither field. `gpt-5.4-mini` would be cheaper still if GitHub's
  // catalog holds it; `gpt-5.4` is the id the responses entry already proved
  // is served to this account.
  {
    id: "copilot-chat-gpt5",
    providerID: "github-copilot",
    npm: "@ai-sdk/github-copilot",
    family: "copilot",
    realBaseURL: "https://api.githubcopilot.com",
    auth: "oauth",
    apiEndpoint: "chat",
    sampling: false,
    scenarios: ["text", "tool-loop", "reasoning"],
    modelID: COPILOT_RESPONSES_MODEL,
    model: {
      name: COPILOT_RESPONSES_MODEL,
      limit: { context: 400000, output: HOSTED_OUTPUT_LIMIT },
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: false,
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  },
  // The responses lane again, with ONE scenario whose answer has to carry more
  // than one reasoning SUMMARY part. The two runtimes end a summary part at
  // different frames — native on `part.done` when `store === false`, the
  // vendored model on `output_item.done` — so a single-part answer cannot tell
  // them apart and the existing `copilot-responses-reasoning` cassette does
  // not. `reasoningSummary: "detailed"` is what asks for the longer summary;
  // it rides in on the `detailed` VARIANT because `ProviderTransform.options`
  // would otherwise force "auto" for every Copilot gpt-5 row, and a variant is
  // the one thing `request.ts` merges LAST (`mergeOptions(..., variant)`).
  {
    id: "copilot-responses-long",
    providerID: "github-copilot",
    npm: "@ai-sdk/github-copilot",
    family: "copilot",
    realBaseURL: "https://api.githubcopilot.com",
    auth: "oauth",
    scenarios: ["reasoning-long"],
    variants: { "reasoning-long": "detailed" },
    modelID: COPILOT_RESPONSES_MODEL,
    model: {
      name: COPILOT_RESPONSES_MODEL,
      // NOT `HOSTED_OUTPUT_LIMIT`. The cap bounds the reasoning summary as
      // well as the answer (`ProviderTransform.maxOutputTokens` reads
      // `limit.output`), and 256 tokens is not room for two summary parts —
      // the cassette this entry exists to record would come back with one.
      limit: { context: 400000, output: SUMMARY_OUTPUT_LIMIT },
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: false,
      modalities: { input: ["text", "image"], output: ["text"] },
      // Merged OVER whatever variants the reasoning heuristic derives
      // (`provider.ts`: `mergeDeep(variants, model.variants ?? {})`), so this
      // adds a name rather than replacing the generated set.
      variants: { detailed: { reasoningSummary: "detailed", reasoningEffort: "high" } },
    },
  },
  // REPLAY ONLY. Its cassette is a May 2026 native recording under
  // test/fixtures/recordings/session/, copied with harness metadata: the
  // responses are real, but the recorded REQUEST bodies were built by the
  // native runtime of that day, not by the AI SDK, so the recorded-vs-sent
  // request diff is not a baseline for it — the native-vs-ai-sdk request diff
  // is. It cannot record: the api.openai.com key path is not what Passing uses.
  {
    id: "openai-api",
    npm: "@ai-sdk/openai",
    family: "openai",
    realBaseURL: "https://api.openai.com/v1",
    auth: "key",
    keyEnv: "PARITY_KEY_OPENAI",
    scenarios: ["tool-loop"],
    modelID: "gpt-5.5",
    model: {
      name: "GPT-5.5",
      limit: { context: 1050000, output: 128000 },
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: false,
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    },
  },
  // Haiku is the cheapest Anthropic lane and the only paid model this harness
  // is allowed to call. `limit.output` is the catalog's 64000 rather than
  // HOSTED_OUTPUT_LIMIT because the thinking budget is derived FROM it:
  // `budgetVariants` gives `high` = 16000 budget tokens, and a 256-token cap
  // would derive a budget below Anthropic's 1024 minimum and be refused.
  // Billing is by tokens emitted, not by the cap, and these scenarios emit a
  // sentence each.
  {
    id: "anthropic",
    npm: "@ai-sdk/anthropic",
    family: "anthropic",
    realBaseURL: "https://api.anthropic.com/v1",
    auth: "key",
    keyEnv: "PARITY_KEY_ANTHROPIC",
    modelID: ANTHROPIC_MODEL,
    // The reasoning scenario asks for extended thinking the way the catalog
    // does: `reasoning_options` below is byte-identical to the models.dev
    // entry for this model, so `ProviderTransform.reasoningOptionVariants`
    // derives the same `high`/`max` thinking budgets production derives, and
    // the scenario selects `high` instead of inventing a body.
    variants: { reasoning: "high" },
    model: {
      name: "Claude Haiku 4.5",
      limit: { context: 200000, output: 64000 },
      reasoning: true,
      reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      tool_call: true,
      attachment: true,
      temperature: true,
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    },
  },
]

export type ParityScenario = {
  readonly id: string
  /** HTTP interactions one run of this scenario makes. */
  readonly interactions: number
  readonly system: string
  readonly user: string
  /**
   * Run this scenario ONLY for a provider that names it in `scenarios`.
   *
   * The default is the opposite — a provider with no `scenarios` list runs
   * every scenario — which is right for the three that describe a capability
   * every lane has. A scenario written to corner ONE runtime difference is not
   * that: adding it plainly would put a case on every other entry, none of
   * which has a cassette for it, and would make a re-record of an unrelated
   * provider spend a request on it.
   */
  readonly optIn?: boolean
}

const WEATHER_RESULT = { temperature: 22, condition: "sunny" } as const
const WEATHER_SYSTEM = "Use the get_weather tool exactly once to look up Paris, then reply with exactly: Paris is sunny."

export const SCENARIOS: ReadonlyArray<ParityScenario> = [
  {
    id: "text",
    interactions: 1,
    system: "Reply with exactly the words: parity check",
    user: "Go.",
  },
  {
    id: "tool-loop",
    interactions: 2,
    system: WEATHER_SYSTEM,
    user: "What is the weather in Paris?",
  },
  {
    id: "reasoning",
    interactions: 1,
    system: "Think step by step, then answer with only the final number.",
    user: "What is 17 * 23?",
  },
  // A problem with four separate stages, and a system line that asks for one
  // summary paragraph PER stage: that is what makes the response carry more
  // than one reasoning summary part, which is the whole point of the entry
  // that opts into it. The short arithmetic scenario above cannot — it
  // produces one part, where the two runtimes agree by accident.
  {
    id: "reasoning-long",
    interactions: 1,
    optIn: true,
    system:
      "Work the problem in separate steps. Summarise your reasoning in detail, one short paragraph per step, then give the two answers on their own line.",
    user: "A train leaves at 09:15 and travels 240 km at 80 km/h. It then waits 25 minutes, then travels a further 150 km at 100 km/h. What time does it arrive, and how many minutes did the whole journey take?",
  },
]

export const cassetteName = (provider: ParityProvider, scenario: ParityScenario) =>
  `${provider.family}/${provider.id}-${scenario.id}`

/** A provider with no `scenarios` list runs them all, minus the opt-in ones. */
export const runs = (provider: ParityProvider, scenario: ParityScenario) =>
  provider.scenarios ? provider.scenarios.includes(scenario.id) : !scenario.optIn

/**
 * Put the entry's `apiEndpoint` on the RESOLVED model, where both runtimes
 * look for it.
 *
 * `Provider.getModel` hands back the instance's own model object, so this is
 * the same field production's models hook writes, on the same object, before
 * anything reads it: `getLanguage` has not been called yet (its memo key does
 * not include the endpoint, so a later stamp would be ignored), and the native
 * runtime reads it off the model carried in `LLM.StreamInput`.
 *
 * The cast is the same one `native-request.ts` uses to READ it: `endpoint` is
 * deliberately absent from the `ProviderApiInfo` schema.
 */
export const stampEndpoint = (provider: ParityProvider, model: Provider.Model): Provider.Model => {
  if (!provider.apiEndpoint) return model
  ;(model.api as { endpoint?: string }).endpoint = provider.apiEndpoint
  return model
}

export const auth = (provider: ParityProvider): ParityAuth => provider.auth ?? "none"

const decodeAuthEntry = Schema.decodeUnknownOption(Auth.Info)

/** The config / auth.json provider id. Defaults to the harness entry id. */
export const providerKey = (provider: ParityProvider): string => provider.providerID ?? provider.id

/**
 * The `type: "api"` key this provider id holds in an auth.json, or `undefined`
 * when the file, the entry or the type is not there.
 *
 * This is the SAME file the OAuth providers already copy into the sandbox, so
 * a record run needs no second credential channel and no live key in the
 * environment (where it would reach every child process and every crash dump).
 * The entry is decoded through the engine's own `Auth.Info` union rather than
 * read field-by-field, so a shape this build does not accept is rejected here
 * instead of being sent to a real endpoint. The owner's file is only READ.
 *
 * The return value is a credential: it goes into the test config and the proxy,
 * and must never be logged, written to a cassette, or put in a report.
 */
export const authFileKey = (providerID: string, authFile: string | undefined): string | undefined => {
  if (!authFile) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(authFile, "utf8"))
  } catch {
    // A missing or unparsable file is "no key here", not a crash: the caller
    // reports the absence through `recordBlocker` with the env var named.
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const entry = (parsed as Record<string, unknown>)[providerID]
  if (entry === undefined) return undefined
  const decoded = Option.getOrUndefined(decodeAuthEntry(entry))
  return decoded?.type === "api" ? decoded.key : undefined
}

/**
 * The third place a key lives: the owner's `origami.json`, where a connection
 * made from the extension's Connections pane stores it as
 * `provider.<id>.options.apiKey` (the Anthropic and OpenRouter keys are there,
 * not in auth.json — measured 2026-09-04). Same rules as `authFileKey`: the
 * file is only READ, a missing/unparsable file or entry is "no key here", and
 * the value is a credential that never goes to a log, a cassette or a report.
 */
export const configFileKey = (providerID: string, configFile: string | undefined): string | undefined => {
  if (!configFile) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configFile, "utf8"))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const providers = (parsed as Record<string, unknown>)["provider"]
  if (providers === null || typeof providers !== "object") return undefined
  const entry = (providers as Record<string, unknown>)[providerID]
  if (entry === null || typeof entry !== "object") return undefined
  const options = (entry as Record<string, unknown>)["options"]
  if (options === null || typeof options !== "object") return undefined
  const key = (options as Record<string, unknown>)["apiKey"]
  return typeof key === "string" && key.trim() ? key : undefined
}

/**
 * The API key a record run puts in the config (and hands the proxy). The env
 * var wins so a one-off key can override the stored one; then the provider's
 * `type: "api"` entry in PARITY_AUTH_FILE; then `provider.<id>.options.apiKey`
 * in PARITY_CONFIG_FILE. OAuth providers get none: the plugin auth loader
 * supplies the dummy key and replaces the header with the real token.
 */
export const recordKey = (provider: ParityProvider, authFile?: string, configFile?: string): string | undefined => {
  if (auth(provider) !== "key") return undefined
  const fromEnv = process.env[provider.keyEnv ?? ""]
  if (fromEnv) return fromEnv
  const stored = providerKey(provider)
  return authFileKey(stored, authFile) ?? configFileKey(stored, configFile)
}

/**
 * The API key a replay run puts in the config. A keyed provider gets a
 * placeholder (the proxy answers from the cassette, so it is never sent
 * anywhere real). An OAuth provider gets none: the harness writes a fixture
 * auth.json into the sandbox on replay, so its plugin loader runs and
 * supplies the dummy key + signing fetch exactly as at record time.
 */
export const replayKey = (provider: ParityProvider): string | undefined =>
  auth(provider) === "key" ? REPLAY_API_KEY : undefined

/** Why this provider cannot record right now, or `undefined` when it can. */
export const recordBlocker = (
  provider: ParityProvider,
  authFile: string | undefined,
  configFile?: string | undefined,
): string | undefined => {
  if (auth(provider) === "key" && !recordKey(provider, authFile, configFile))
    return `parity: PARITY_PROVIDER selected "${provider.id}" but none of ${provider.keyEnv ?? "<keyEnv>"}, an "${provider.id}" entry of type "api" in PARITY_AUTH_FILE, or provider.${provider.id}.options.apiKey in PARITY_CONFIG_FILE supplies a key — set one or drop the provider from the list.`
  if (auth(provider) === "oauth" && !authFile)
    return `parity: PARITY_PROVIDER selected "${provider.id}", which authenticates with OAuth — set PARITY_AUTH_FILE to an auth.json holding a "${providerKey(provider)}" credential.`
  return undefined
}

export const providerConfig = (
  provider: ParityProvider,
  baseURL: string,
  apiKey?: string,
): Partial<ConfigV1.Info> => ({
  enabled_providers: [providerKey(provider)],
  provider: {
    [providerKey(provider)]: {
      name: providerKey(provider),
      npm: provider.npm,
      options: apiKey ? { baseURL, apiKey } : { baseURL },
      models: { [provider.modelID]: provider.model },
    },
  },
})

export const writeConfig = (directory: string, config: Partial<ConfigV1.Info>) =>
  Effect.promise(() => Bun.write(path.join(directory, "origami.json"), JSON.stringify(config)))

const weatherTool = tool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async () => WEATHER_RESULT,
})

/**
 * Turn 2 of the tool loop: the assistant message carries turn 1's reasoning
 * parts with their provider metadata under `providerOptions`, the field the
 * AI SDK reads on a prompt part (message-v2 stores it there too); the native
 * adapter reads `providerMetadata` first and falls back to the same field. So
 * the reasoning replay path is exercised on both sides from the same shape.
 */
const toolRoundtrip = (
  events: ReadonlyArray<LLMEvent>,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
  result: JSONValue,
): ModelMessage[] => [
  {
    role: "assistant",
    content: [
      ...events.filter(LLMEvent.is.reasoningEnd).map((part) => ({
        type: "reasoning" as const,
        text: events
          .filter(LLMEvent.is.reasoningDelta)
          .filter((event) => event.id === part.id)
          .map((event) => event.text)
          .join(""),
        // Native metadata is typed `unknown`-valued; on the wire it is JSON.
        providerOptions: part.providerMetadata as Record<string, Record<string, JSONValue>> | undefined,
      })),
      { type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: call.id, toolName: call.name, output: { type: "json", value: result } },
    ],
  },
]

export type DriveInput<E, R> = {
  readonly provider: ParityProvider
  readonly scenario: ParityScenario
  readonly model: Provider.Model
  readonly collect: (input: LLM.StreamInput) => Effect.Effect<LLMEvent[], E, R>
}

/**
 * Runs one scenario through whichever runtime `collect` is bound to and
 * returns the concatenated event stream. A tool loop returns turn 1 followed
 * by turn 2 — one stream, because parity is about the whole exchange.
 */
export const drive = <E, R>(input: DriveInput<E, R>) =>
  Effect.gen(function* () {
    const { provider, scenario, model, collect } = input
    const sessionID = SessionID.make(`session-parity-${provider.id}-${scenario.id}`)
    const agent = {
      name: "test",
      mode: "primary",
      prompt: "Answer using tools when appropriate.",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
      // `sampling: false` drops this knob so the capability gate decides. See
      // the field's note on ParityProvider.
      ...(provider.sampling === false ? {} : { temperature: 0 }),
    } satisfies Agent.Info
    const userMessage = { role: "user", content: scenario.user } satisfies ModelMessage
    const tools: Record<string, Tool> = scenario.id === "tool-loop" ? { get_weather: weatherTool } : {}
    const base = {
      user: {
        id: MessageID.make(`msg_user-parity-${provider.id}-${scenario.id}`),
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: agent.name,
        model: {
          providerID: model.providerID,
          modelID: model.id,
          ...(provider.variants?.[scenario.id] ? { variant: provider.variants[scenario.id] } : {}),
        },
      } satisfies SessionV1.User,
      sessionID,
      model,
      agent,
      system: [scenario.system],
      tools,
    }

    const turn1 = yield* collect({ ...base, messages: [userMessage] })
    if (scenario.id !== "tool-loop") return turn1

    const call = turn1.find(LLMEvent.is.toolCall)
    // No tool call means the run made one HTTP interaction, not two — the
    // caller's interaction-count assertion is what reports that.
    if (!call) return turn1

    const turn2 = yield* collect({
      ...base,
      messages: [userMessage, ...toolRoundtrip(turn1, call, WEATHER_RESULT)],
    })
    return [...turn1, ...turn2]
  })

export * as LLMParityScenarios from "./scenarios"

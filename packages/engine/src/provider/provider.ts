import { LayerNode } from "@origami/core/effect/layer-node"
import os from "os"
import { ConfigV1 } from "@origami/core/v1/config/config"
import fuzzysort from "fuzzysort"
import { Config } from "@/config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Hash } from "@origami/core/util/hash"
import { Plugin } from "../plugin"
import { serviceUse } from "@origami/core/effect/service-use"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import { ModelsDev } from "@origami/core/models-dev"
import { Auth } from "../auth"
import { Env } from "../env"
import { InstallationVersion } from "@origami/core/installation/version"
import { iife } from "@/util/iife"
import { Global } from "@origami/core/global"
import path from "path"
import { Effect, Layer, Context, Schema, Types } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { EffectPromise } from "@/effect/promise"
import { FSUtil } from "@origami/core/fs-util"
import { isRecord } from "@/util/record"
import { optional } from "@origami/core/schema"
import { ProviderTransform } from "./transform"
import { ProviderConcurrency } from "./concurrency"
import { ProviderRequestIdentity } from "./request-identity"
import { SessionProviderQueue } from "@/session/provider-queue"
import { ProviderEffortDemotion } from "./effort-demotion"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { ModelStatus } from "./model-status"
import { discoveryKey, memoizeDiscovery, runDiscoveryLoaders } from "./discovery"
import { discoverOpenAICompatContext } from "../origami/openai-compat-context"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderError } from "./error"
import { ProviderProtocol } from "./protocol"
import { ClaudeSubscription } from "./claude-subscription"

const OPENAI_HEADER_TIMEOUT_DEFAULT = 300_000

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new ProviderError.ResponseStreamError("SSE read timed out")
          ctl.abort(err)
          void reader.cancel(err)
          reject(err)
        }, ms)

        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}

/**
 * True for baseURLs that point at a self-hosted server (loopback, RFC1918 LAN,
 * CGNAT/Tailscale, .local/.lan/.ts.net, bare LAN hostnames). Used to default
 * chunkTimeout: a wedged local generation hangs its SSE stream forever with no
 * server-side reaper, whereas cloud endpoints manage their own request
 * lifetimes and get no default.
 */
function isSelfHostedURL(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  host = host.replace(/^\[|\]$/g, "")
  if (host === "localhost" || host === "0.0.0.0") return true
  if (host === "::1" || host.startsWith("fd") || host.startsWith("fe80")) return true
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".ts.net")) return true
  if (!host.includes(".") && !host.includes(":")) return true
  const octets = host.split(".").map(Number)
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = octets
    if (a === 127 || a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  return false
}

// Ceiling on the gap between SSE reads for self-hosted providers when the user
// sets no chunkTimeout. Applies to the FIRST chunk too, so it must clear the
// worst honest case — a huge-context prefill on local hardware can run minutes
// before the first token. 5 minutes of total silence mid-stream = wedged.
const LOCAL_CHUNK_TIMEOUT_DEFAULT = 300_000

// Ceiling on time-to-headers for self-hosted providers when the user sets no
// headerTimeout. The raw fetch runs with `timeout: false`, so a wedged-but-
// accepting local server that never sends headers would otherwise hang the
// request forever — the chunk timeout only guards AFTER headers arrive.
// Disarms the moment headers land (timeoutController is cleared on fetch
// resolve), so healthy streams are never touched. Generous because a busy
// server-side queue can hold headers until the request is dequeued.
const LOCAL_HEADER_TIMEOUT_DEFAULT = 300_000

/** Test-only surface for the provider fetch internals (permit lifecycle,
 *  self-hosted detection), so they are verifiable without the whole SDK stack
 *  (test/provider/semaphore-leak.test.ts). Not part of the public API. The
 *  permit halves live in provider/concurrency.ts, shared with the native
 *  runtime. */
export const _concurrencyInternals = {
  AsyncSemaphore: ProviderConcurrency.AsyncSemaphore,
  releaseOnBodyEnd: ProviderConcurrency.releaseOnBodyEnd,
  isSelfHostedURL,
}

function googleVertexAnthropicBaseURL(project: string | undefined, location: string | undefined) {
  if (!project) return
  if (location !== "eu" && location !== "us") return
  // Continental multi-regions require Regional Endpoint Platform domains.
  return `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`
}

type BundledSDK = {
  languageModel(modelId: string): LanguageModelV3
  chat?: (modelId: string) => LanguageModelV3
  responses?: (modelId: string) => LanguageModelV3
}

const BUNDLED_PROVIDERS: Record<string, () => Promise<(opts: any) => BundledSDK>> = {
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock),
  "@ai-sdk/amazon-bedrock/mantle": () => import("@ai-sdk/amazon-bedrock/mantle").then((m) => m.createBedrockMantle),
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  "@ai-sdk/azure": () => import("@ai-sdk/azure").then((m) => m.createAzure),
  "@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex),
  "@ai-sdk/google-vertex/anthropic": () =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic),
  "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible),
  "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter),
  "@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai),
  "@ai-sdk/mistral": () => import("@ai-sdk/mistral").then((m) => m.createMistral),
  "@ai-sdk/groq": () => import("@ai-sdk/groq").then((m) => m.createGroq),
  "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra),
  "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras").then((m) => m.createCerebras),
  "@ai-sdk/cohere": () => import("@ai-sdk/cohere").then((m) => m.createCohere),
  "@ai-sdk/gateway": () => import("@ai-sdk/gateway").then((m) => m.createGateway),
  "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI),
  "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity").then((m) => m.createPerplexity),
  "@ai-sdk/vercel": () => import("@ai-sdk/vercel").then((m) => m.createVercel),
  "@ai-sdk/alibaba": () => import("@ai-sdk/alibaba").then((m) => m.createAlibaba),
  "gitlab-ai-provider": () => import("gitlab-ai-provider").then((m) => m.createGitLab),
  // origami_change: this package IS in the bundle (packages/engine/package.json
  // "ai-gateway-provider") and the entry has to be here or the provider stops
  // loading, now that the npm-install path is gone. The factory it returns is a
  // callable with `.chat`, not a `languageModel` SDK - the
  // `cloudflare-ai-gateway` model loader above ignores the client it is handed
  // and builds its own.
  "ai-gateway-provider": () =>
    import("ai-gateway-provider").then((m) => m.createAiGateway as unknown as (opts: any) => BundledSDK),
  "@ai-sdk/github-copilot": () =>
    import("@origami/core/github-copilot/copilot-provider").then((m) => m.createOpenaiCompatible),
  "venice-ai-sdk-provider": () => import("venice-ai-sdk-provider").then((m) => m.createVenice),
  // origami_change (t-tija5f): not a package. The subscription family runs only
  // on the native runtime; this SDK's models refuse every AI SDK call.
  [ClaudeSubscription.NPM]: () => Promise.resolve(ClaudeSubscription.createSDK),
}

/**
 * The provider packages this build ships. An `npm` outside this list is
 * refused at model load - see `ProviderProtocol`. Exported so
 * `test/provider/protocol.test.ts` can hold the shipped catalog against it.
 */
export const BUNDLED_PROVIDER_IDS: readonly string[] = Object.keys(BUNDLED_PROVIDERS)

type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>, model?: Model) => Promise<any>
type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
type CustomDiscoverModels = () => Promise<Record<string, Model>>
type CustomLoader = (provider: Info) => Effect.Effect<{
  autoload: boolean
  getModel?: CustomModelLoader
  vars?: CustomVarsLoader
  options?: Record<string, any>
  discoverModels?: CustomDiscoverModels
}>

type CustomDep = {
  auth: (id: string) => Effect.Effect<Auth.Info | undefined>
  config: () => Effect.Effect<ConfigV1.Info>
  env: () => Effect.Effect<Record<string, string | undefined>>
  get: (key: string) => Effect.Effect<string | undefined>
}

function selectAzureLanguageModel(sdk: any, modelID: string, useChat: boolean) {
  if (useChat && sdk.chat) return sdk.chat(modelID)
  if (sdk.responses) return sdk.responses(modelID)
  if (sdk.messages) return sdk.messages(modelID)
  if (sdk.chat) return sdk.chat(modelID)
  return sdk.languageModel(modelID)
}

function selectBedrockMantleLanguageModel(sdk: BundledSDK, modelID: string) {
  if (modelID === "openai.gpt-oss-safeguard-20b" || modelID === "openai.gpt-oss-safeguard-120b")
    return sdk.chat?.(modelID) ?? sdk.languageModel(modelID)
  return sdk.responses?.(modelID) ?? sdk.languageModel(modelID)
}

function custom(dep: CustomDep): Record<string, CustomLoader> {
  return {
    anthropic: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }),
    // OpenCode Zen. Keyed on `opencode` because that is the id the shipped
    // models.dev catalog serves.
    //
    // FORK: it is NEVER auto-enabled. Upstream autoloads the free tier under a
    // public key with no credential, which would send a fresh install's prompts
    // to opencode.ai by default. A prompt leaving the machine is the one thing
    // this fork does not do unasked, so Zen appears only once the user OPTS IN:
    // an env var, `origami providers login opencode`, or a `provider.opencode`
    // block in origami.json. Only the keyless autoload is gone.
    //
    // An opted-in block with no key of its own KEEPS the old free-tier
    // behaviour (paid models dropped, public key) -- that user did ask.
    opencode: Effect.fnUntraced(function* (input: Info) {
      const env = yield* dep.env()
      const hasKey = iife(() => {
        if (input.env.some((item) => env[item])) return true
        return false
      })
      const cfg = yield* dep.config()
      const ok = hasKey || Boolean(yield* dep.auth(input.id)) || Boolean(cfg.provider?.["opencode"]?.options?.apiKey)

      if (!ok) {
        if (!cfg.provider?.["opencode"]) return { autoload: false }
        for (const [key, value] of Object.entries(input.models)) {
          if (value.cost.input === 0) continue
          delete input.models[key]
        }
      }

      return {
        autoload: Object.keys(input.models).length > 0,
        options: ok ? {} : { apiKey: "public" },
      }
    }),
    openai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: { headerTimeout: OPENAI_HEADER_TIMEOUT_DEFAULT },
      }),
    meta: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
      }),
    xai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      }),
    "github-copilot": () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>, model?: Model) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          if (model && "endpoint" in model.api) {
            if (model.api.endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
            if (model.api.endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
          }
          const match = /^gpt-(\d+)/.exec(modelID)
          if (match && Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")) return sdk.responses(modelID)
          return sdk.chat(modelID)
        },
        options: {},
      }),
    azure: Effect.fnUntraced(function* (provider: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(provider.id)
      const resource = iife(() => {
        return [
          provider.options?.resourceName,
          auth?.type === "api" ? auth.metadata?.resourceName : undefined,
          env["AZURE_RESOURCE_NAME"],
        ].find((name) => typeof name === "string" && name.trim() !== "")
      })

      if (!resource && !provider.options?.baseURL) {
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "AZURE_RESOURCE_NAME is missing, set it using env var or reconnecting the azure provider and setting it",
            )
          },
        }
      }

      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          resourceName: resource,
        },
        vars(_options): Record<string, string> {
          if (resource) {
            return {
              AZURE_RESOURCE_NAME: resource,
            }
          }
          return {}
        },
      }
    }),
    "azure-cognitive-services": Effect.fnUntraced(function* (provider: Info) {
      const resourceName = yield* dep.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          baseURL: resourceName
            ? `https://${resourceName}.cognitiveservices.azure.com/openai${provider.options?.useDeploymentBasedUrls ? "" : "/v1"}`
            : undefined,
        },
      }
    }),
    "amazon-bedrock": Effect.fnUntraced(function* () {
      const providerConfig = (yield* dep.config()).provider?.["amazon-bedrock"]
      const auth = yield* dep.auth("amazon-bedrock")
      const env = yield* dep.env()

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = env["AWS_REGION"]
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = env["AWS_PROFILE"]
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = env["AWS_ACCESS_KEY_ID"]
      const configApiKey = providerConfig?.options?.apiKey

      // TODO: Using process.env directly because Env.set only updates a process.env shallow copy,
      // until the scope of the Env API is clarified (test only or runtime?)
      const awsBearerToken = iife(() => {
        const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
        if (envToken) return envToken
        if (auth?.type === "api") {
          process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = env["AWS_WEB_IDENTITY_TOKEN_FILE"]

      const containerCreds = Boolean(
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      )

      if (
        !profile &&
        !awsAccessKeyId &&
        !awsBearerToken &&
        !configApiKey &&
        !awsWebIdentityTokenFile &&
        !containerCreds
      )
        return { autoload: false }

      const { fromNodeProviderChain } = yield* Effect.promise(() => import("@aws-sdk/credential-providers"))

      const providerOptions: Record<string, any> = {
        region: defaultRegion,
      }

      // A bearer token takes precedence over the credential chain (profiles,
      // access keys, IAM roles, web identity tokens).
      if (!awsBearerToken && !configApiKey) {
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        vars(options: Record<string, any>) {
          return { AWS_REGION: options.region ?? defaultRegion }
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>, model?: Model) {
          if (model?.api.npm === "@ai-sdk/amazon-bedrock/mantle") return selectBedrockMantleLanguageModel(sdk, modelID)

          // Skip region prefixing if model already has a cross-region inference profile prefix
          // Models from models.dev may already include prefixes like us., eu., global., etc.
          const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
          if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
            return sdk.languageModel(modelID)
          }

          // A per-model `options.region` outranks the resolved default above.
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    }),
    llmgateway: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://origami.gratis/",
            "X-Title": "origami",
            "X-Source": "origami",
          },
        },
      }),
    openrouter: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://origami.gratis/",
            "X-Title": "origami",
          },
        },
      }),
    nvidia: (provider) =>
      Effect.succeed({
        autoload: provider.source === "config",
        options: {
          headers: {
            "HTTP-Referer": "https://origami.gratis/",
            "X-Title": "origami",
            "X-BILLING-INVOKE-ORIGIN": "Origami",
          },
        },
      }),
    vercel: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://origami.gratis/",
            "x-title": "origami",
          },
        },
      }),
    "google-vertex": Effect.fnUntraced(function* (provider: Info) {
      const env = yield* dep.env()
      // models.dev advertises GOOGLE_VERTEX_PROJECT for Vertex; keep the wider
      // Google Cloud project env names as fallbacks for existing ADC setups.
      const project =
        provider.options?.project ??
        env["GOOGLE_VERTEX_PROJECT"] ??
        env["GOOGLE_CLOUD_PROJECT"] ??
        env["GCP_PROJECT"] ??
        env["GCLOUD_PROJECT"]

      const location = String(
        provider.options?.location ??
          env["GOOGLE_VERTEX_LOCATION"] ??
          env["GOOGLE_CLOUD_LOCATION"] ??
          env["VERTEX_LOCATION"] ??
          "us-central1",
      )

      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        vars(_options: Record<string, any>) {
          const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
          return {
            ...(project && { GOOGLE_VERTEX_PROJECT: project }),
            GOOGLE_VERTEX_LOCATION: location,
            GOOGLE_VERTEX_ENDPOINT: endpoint,
          }
        },
        options: {
          project,
          location,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const { GoogleAuth } = await import("google-auth-library")
            const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
            const client = await auth.getClient()
            const token = await client.getAccessToken()

            const headers = new Headers(init?.headers)
            headers.set("Authorization", `Bearer ${token.token}`)

            return fetch(input, { ...init, headers })
          },
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "google-vertex-anthropic": Effect.fnUntraced(function* () {
      const env = yield* dep.env()
      const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCP_PROJECT"] ?? env["GCLOUD_PROJECT"]
      const location = env["GOOGLE_CLOUD_LOCATION"] ?? env["VERTEX_LOCATION"] ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      const baseURL = googleVertexAnthropicBaseURL(project, location)
      return {
        autoload: true,
        options: {
          project,
          location,
          ...(baseURL && { baseURL }),
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "sap-ai-core": Effect.fnUntraced(function* () {
      const auth = yield* dep.auth("sap-ai-core")
      // TODO: Using process.env directly because Env.set only updates a shallow copy (not process.env),
      // until the scope of the Env API is clarified (test only or runtime?)
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = process.env.AICORE_SERVICE_KEY
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          process.env.AICORE_SERVICE_KEY = auth.key
          return auth.key
        }
        return undefined
      })
      const deploymentId = process.env.AICORE_DEPLOYMENT_ID
      const resourceGroup = process.env.AICORE_RESOURCE_GROUP

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    }),
    zenmux: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://origami.gratis/",
            "X-Title": "origami",
          },
        },
      }),
    gitlab: Effect.fnUntraced(function* (input: Info) {
      const {
        VERSION: GITLAB_PROVIDER_VERSION,
        isWorkflowModel,
        discoverWorkflowModels,
      } = yield* Effect.promise(() => import("gitlab-ai-provider"))

      const instanceUrl = (yield* dep.get("GITLAB_INSTANCE_URL")) || "https://gitlab.com"

      const auth = yield* dep.auth(input.id)
      const apiKey = auth?.type === "oauth" ? auth.access : auth?.type === "api" ? auth.key : undefined
      const token = apiKey ?? (yield* dep.get("GITLAB_TOKEN"))

      const providerConfig = (yield* dep.config()).provider?.["gitlab"]
      const directory = yield* InstanceState.directory

      const aiGatewayHeaders = {
        "User-Agent": `origami/${InstallationVersion} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        "anthropic-beta": "context-1m-2025-08-07",
        ...providerConfig?.options?.aiGatewayHeaders,
      }

      const featureFlags = {
        duo_agent_platform_agentic_chat: true,
        duo_agent_platform: true,
        ...providerConfig?.options?.featureFlags,
      }

      return {
        autoload: !!token,
        options: {
          instanceUrl,
          apiKey: token,
          aiGatewayHeaders,
          featureFlags,
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (modelID.startsWith("duo-workflow-")) {
            const workflowRef = typeof options?.workflowRef === "string" ? options.workflowRef : undefined
            const sdkModelID = isWorkflowModel(modelID) ? modelID : "duo-workflow"
            const workflowDefinition =
              typeof options?.workflowDefinition === "string" ? options.workflowDefinition : undefined
            const model = sdk.workflowChat(sdkModelID, {
              featureFlags,
              workflowDefinition,
            })
            if (workflowRef) {
              model.selectedModelRef = workflowRef
            }
            return model
          }
          return sdk.agenticChat(modelID, {
            aiGatewayHeaders,
            featureFlags,
          })
        },
        async discoverModels(): Promise<Record<string, Model>> {
          if (!apiKey) {
            return {}
          }

          try {
            const token = apiKey
            const getHeaders = (): Record<string, string> =>
              auth?.type === "api" ? { "PRIVATE-TOKEN": token } : { Authorization: `Bearer ${token}` }

            const result = await discoverWorkflowModels({ instanceUrl, getHeaders }, { workingDirectory: directory })

            if (!result.models.length) {
              return {}
            }

            const models: Record<string, Model> = {}
            for (const m of result.models) {
              if (!input.models[m.id]) {
                models[m.id] = {
                  id: ModelV2.ID.make(m.id),
                  providerID: ProviderV2.ID.make("gitlab"),
                  name: `Agent Platform (${m.name})`,
                  family: "",
                  api: {
                    id: m.id,
                    url: instanceUrl,
                    npm: "gitlab-ai-provider",
                  },
                  status: "active",
                  headers: {},
                  options: { workflowRef: m.ref },
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                  limit: { context: m.context, output: m.output },
                  capabilities: {
                    temperature: false,
                    reasoning: true,
                    attachment: true,
                    toolcall: true,
                    input: {
                      text: true,
                      audio: false,
                      image: true,
                      video: false,
                      pdf: true,
                    },
                    output: {
                      text: true,
                      audio: false,
                      image: false,
                      video: false,
                      pdf: false,
                    },
                    interleaved: false,
                  },
                  release_date: "",
                  variants: {},
                }
              }
            }

            return models
          } catch (e) {
            return {}
          }
        },
      }
    }),
    "cloudflare-workers-ai": Effect.fnUntraced(function* (input: Info) {
      // When baseURL is already configured (e.g. corporate config routing through a proxy/gateway),
      // skip the account ID check because the URL is already fully specified.
      if (input.options?.baseURL) return { autoload: false }

      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      if (!accountId)
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "CLOUDFLARE_ACCOUNT_ID is missing. Set it with: export CLOUDFLARE_ACCOUNT_ID=<your-account-id>",
            )
          },
        }

      const apiKey = env["CLOUDFLARE_API_KEY"] || (auth?.type === "api" ? auth.key : undefined)

      return {
        autoload: !!apiKey,
        options: {
          apiKey,
          headers: {
            "User-Agent": `origami/${InstallationVersion} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
          },
        },
        async getModel(sdk: any, modelID: string) {
          return sdk.languageModel(modelID)
        },
        vars(_options) {
          return {
            CLOUDFLARE_ACCOUNT_ID: accountId,
          }
        },
      }
    }),
    "cloudflare-ai-gateway": Effect.fnUntraced(function* (input: Info) {
      // When baseURL is already configured (e.g. corporate config), skip the ID checks.
      if (input.options?.baseURL) return { autoload: false }

      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      // The Cloudflare auth prompt stores this value as gatewayId metadata.
      const gateway = env["CLOUDFLARE_GATEWAY_ID"] || (auth?.type === "api" ? auth.metadata?.gatewayId : undefined)

      if (!accountId || !gateway) {
        const missing = [
          !accountId ? "CLOUDFLARE_ACCOUNT_ID" : undefined,
          !gateway ? "CLOUDFLARE_GATEWAY_ID" : undefined,
        ].filter((x): x is string => Boolean(x))
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              `${missing.join(" and ")} missing. Set with: ${missing.map((x) => `export ${x}=<value>`).join(" && ")}`,
            )
          },
        }
      }

      // Get API token from env or auth - required for authenticated gateways
      const apiToken =
        env["CLOUDFLARE_API_TOKEN"] || env["CF_AIG_TOKEN"] || (auth?.type === "api" ? auth.key : undefined)

      if (!apiToken) {
        throw new Error(
          "CLOUDFLARE_API_TOKEN (or CF_AIG_TOKEN) is required for Cloudflare AI Gateway. " +
            "Set it via environment variable or run `origami auth cloudflare-ai-gateway`.",
        )
      }

      // Use official ai-gateway-provider package (v2.x for AI SDK v5 compatibility)
      const { createAiGateway } = yield* Effect.promise(() => import("ai-gateway-provider"))
      const { createUnified } = yield* Effect.promise(() => import("ai-gateway-provider/providers/unified"))

      const metadata = iife(() => {
        if (input.options?.metadata) return input.options.metadata
        try {
          return JSON.parse(input.options?.headers?.["cf-aig-metadata"])
        } catch {
          return undefined
        }
      })
      const opts = {
        metadata,
        cacheTtl: input.options?.cacheTtl,
        cacheKey: input.options?.cacheKey,
        skipCache: input.options?.skipCache,
        collectLog: input.options?.collectLog,
        headers: {
          "User-Agent": `origami/${InstallationVersion} cloudflare-ai-gateway (${os.platform()} ${os.release()}; ${os.arch()})`,
        },
      }

      const aigateway = createAiGateway({
        accountId,
        gateway,
        apiKey: apiToken,
        ...(Object.values(opts).some((v) => v !== undefined) ? { options: opts } : {}),
      })
      const unified = createUnified({ apiKey: apiToken })

      return {
        autoload: true,
        async getModel(_sdk: any, modelID: string, _options?: Record<string, any>) {
          // Model IDs use Unified API format: provider/model (e.g., "anthropic/claude-sonnet-4-5")
          return aigateway(unified(modelID))
        },
        options: {},
      }
    }),
    cerebras: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "origami",
          },
        },
      }),
    kilo: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://origami.gratis/",
            "X-Title": "origami",
          },
        },
      }),
    "snowflake-cortex": Effect.fnUntraced(function* (input: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(input.id)

      const account =
        env["SNOWFLAKE_ACCOUNT"] ??
        (auth?.type === "api" ? auth.metadata?.account : undefined) ??
        (auth?.type === "oauth" ? auth.accountId : undefined) ??
        input.options?.account

      const envToken = env["SNOWFLAKE_CORTEX_TOKEN"] ?? env["SNOWFLAKE_CORTEX_PAT"]
      const apiKeyToken = auth?.type === "api" ? auth.key : undefined
      const oauthToken = auth?.type === "oauth" ? auth.access : undefined
      const configToken = input.options?.token ?? input.options?.apiKey

      const token = envToken ?? apiKeyToken ?? oauthToken ?? configToken

      if (!account || !token) {
        const missing = [!account && "SNOWFLAKE_ACCOUNT", !token && "SNOWFLAKE_CORTEX_TOKEN"].filter(Boolean).join(", ")
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              `Snowflake Cortex: missing credentials (${missing}). Provide a bearer token (OAuth, JWT, or PAT) via env var, origami auth, or provider options.`,
            )
          },
        }
      }

      const baseURL = `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`

      const options: Record<string, any> = { baseURL, apiKey: token }

      // Only skip provider-level fetch when the token is from OAuth with no override.
      // For OAuth tokens, the plugin auth loader's combined fetch handles
      // OAuth refresh + snowflake transformations in one place.
      // For env/config/API-key tokens, the provider fetch applies snowflake
      // transformations directly.
      const useOAuthHandler =
        oauthToken !== undefined && envToken === undefined && apiKeyToken === undefined && configToken === undefined
      if (!useOAuthHandler) {
        options.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.body && typeof init.body === "string") {
            try {
              const body = JSON.parse(init.body)
              if ("max_tokens" in body) {
                body.max_completion_tokens = body.max_tokens
                delete body.max_tokens
                init = { ...init, body: JSON.stringify(body) }
              }
            } catch {}
          }

          const response = await fetch(url, init)

          if (!response.ok && response.status === 400) {
            try {
              const errorData = await response.clone().json()
              const errorMessage = String(errorData.message || errorData.error || "")
              if (errorMessage.toLowerCase().includes("conversation complete")) {
                return new Response(
                  JSON.stringify({
                    choices: [{ finish_reason: "stop", message: { content: "", role: "assistant" } }],
                  }),
                  { status: 200, headers: new Headers({ "content-type": "application/json" }) },
                )
              }
            } catch {}
          }

          if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
            const reader = response.body.getReader()
            const encoder = new TextEncoder()
            const decoder = new TextDecoder()
            const stream = new ReadableStream({
              async pull(ctrl) {
                const { done, value } = await reader.read()
                if (done) {
                  ctrl.close()
                  return
                }
                const text = decoder.decode(value, { stream: true })
                ctrl.enqueue(encoder.encode(text.replace(/"role"\s*:\s*""/g, '"role":"assistant"')))
              },
              cancel() {
                reader.cancel()
              },
            })
            return new Response(stream, { headers: response.headers, status: response.status })
          }

          return response
        }
      }

      return {
        autoload: input.source === "config",
        options,
      }
    }),
  }
}

const ProviderApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
})

const ProviderModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const ProviderInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
  }),
])

const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: ProviderModalities,
  output: ProviderModalities,
  interleaved: ProviderInterleaved,
})

const ProviderCacheCost = Schema.Struct({
  read: Schema.Finite,
  write: Schema.Finite,
})

const ProviderCostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const ProviderCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tiers: optional(Schema.Array(ProviderCostTier)),
  experimentalOver200K: optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache: ProviderCacheCost,
    }),
  ),
})

const ProviderLimit = Schema.Struct({
  context: Schema.Finite,
  input: optional(Schema.Finite),
  output: Schema.Finite,
  // origami_change: how many IMAGES this endpoint takes in one prompt. Absent
  // for every hosted model (models.dev does not publish it), so
  // `ProviderTransform.IMAGE_WINDOW_DEFAULT` applies; an operator whose own
  // server was started with `--limit-mm-per-prompt` declares the real number.
  images: optional(Schema.Finite),
})

export const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  api: ProviderApiInfo,
  name: Schema.String,
  family: optional(Schema.String),
  capabilities: ProviderCapabilities,
  cost: ProviderCost,
  limit: ProviderLimit,
  status: ModelStatus,
  options: Schema.Record(Schema.String, Schema.Any),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  variants: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
}).annotate({ identifier: "Model" })
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export const Info = Schema.Struct({
  id: ProviderV2.ID,
  name: Schema.String,
  source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String),
  key: optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any),
  models: Schema.Record(Schema.String, Model),
}).annotate({ identifier: "Provider" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

const DefaultModelIDs = Schema.Record(Schema.String, Schema.String)

export const ListResult = Schema.Struct({
  all: Schema.Array(Info),
  default: DefaultModelIDs,
  connected: Schema.Array(Schema.String),
})
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

export const ConfigProvidersResult = Schema.Struct({
  providers: Schema.Array(Info),
  default: DefaultModelIDs,
})
export type ConfigProvidersResult = Types.DeepMutable<Schema.Schema.Type<typeof ConfigProvidersResult>>

export function toPublicInfo(provider: Info): Info {
  return JSON.parse(
    JSON.stringify(
      {
        ...provider,
        models: Object.fromEntries(Object.entries(provider.models).filter(([, model]) => Schema.is(Model)(model))),
      },
      (_, value) => {
        if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined
        if (typeof value === "bigint") return value.toString()
        return value
      },
    ),
  )
}

/**
 * origami_change (t-woacbl): the provider state's table of public rows, copied
 * from the catalog when a row is first READ, not all at once. The state keeps
 * only the providers the user can use, but the eager copy checked and cloned
 * every catalog row (~220 providers, 8,000 models): 180-230 ms of one
 * main-thread block at every engine's first prompt. Same keys in the same order,
 * same values; a written row replaces its key in place, a new key goes last.
 * `env` reads a row's env list without copying it (a copy keeps the list as is).
 */
export function _lazyPublicRows<T extends { env: string[] }>(catalog: Record<string, T>, copy: (row: T) => T) {
  const rows = {} as Record<string, T>
  const pending = new Set(Object.keys(catalog))
  const settle = (id: string, value: T) => {
    pending.delete(id)
    Object.defineProperty(rows, id, { value, writable: true, enumerable: true, configurable: true })
  }
  for (const id of pending) {
    Object.defineProperty(rows, id, {
      get: () => {
        const value = copy(catalog[id]!)
        settle(id, value)
        return value
      },
      set: (value: T) => settle(id, value),
      enumerable: true,
      configurable: true,
    })
  }
  return { rows, env: (id: string) => (pending.has(id) ? catalog[id]!.env : rows[id]!.env) }
}

export function defaultModelIDs<T extends { models: Record<string, { id: string }> }>(providers: Record<string, T>) {
  return mapValues(providers, (item) => sort(Object.values(item.models))[0].id)
}

export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()("ProviderModelNotFoundError", {
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  suggestions: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const suggestions = this.suggestions?.length ? ` Did you mean: ${this.suggestions.join(", ")}?` : ""
    return `Model not found: ${this.providerID}/${this.modelID}.${suggestions}`
  }

  static isInstance(input: unknown): input is ModelNotFoundError {
    return input instanceof ModelNotFoundError
  }
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("ProviderInitError", {
  providerID: ProviderV2.ID,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Failed to initialize provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is InitError {
    return input instanceof InitError
  }
}

export class NoProvidersError extends Schema.TaggedErrorClass<NoProvidersError>()("ProviderNoProvidersError", {}) {
  override get message() {
    return "No providers are available"
  }

  static isInstance(input: unknown): input is NoProvidersError {
    return input instanceof NoProvidersError
  }
}

export class NoModelsError extends Schema.TaggedErrorClass<NoModelsError>()("ProviderNoModelsError", {
  providerID: ProviderV2.ID,
}) {
  override get message() {
    return `No models are available for provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is NoModelsError {
    return input instanceof NoModelsError
  }
}

export type DefaultModelError = ModelNotFoundError | NoProvidersError | NoModelsError
export type Error = ModelNotFoundError | InitError | NoProvidersError | NoModelsError

export interface Interface {
  readonly list: () => Effect.Effect<Record<ProviderV2.ID, Info>>
  readonly getProvider: (providerID: ProviderV2.ID) => Effect.Effect<Info>
  readonly getModel: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<Model, ModelNotFoundError>
  readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV3, ModelNotFoundError>
  readonly closest: (
    providerID: ProviderV2.ID,
    query: string[],
  ) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: string } | undefined>
  readonly getSmallModel: (providerID: ProviderV2.ID) => Effect.Effect<Model | undefined>
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }, DefaultModelError>
  /**
   * origami_change: drop this instance's provider state - the merged provider
   * list, the SDK client map and the language-model map - so the next
   * resolution rebuilds it from `config.get()`.
   *
   * The PAIR to `Config.invalidateInstance()`, and useless without it: config
   * alone re-reads the files, but this list is a second `InstanceState` built
   * from them and survives that untouched. Both together are what makes a
   * credential written while the engine runs take effect with no restart.
   *
   * Neither state registers a finalizer or a scoped fork, so this is a memo drop
   * and not a teardown: a turn already in flight keeps the client it holds and
   * rebuilds on its next step. That is why `provider_refresh` uses this instead
   * of the HTTP `config.refresh` route's whole-instance disposal, which tears
   * down session and MCP state with it.
   */
  readonly invalidate: () => Effect.Effect<void>
}

interface State {
  models: Map<string, LanguageModelV3>
  providers: Record<ProviderV2.ID, Info>
  catalog: Record<ProviderV2.ID, Info>
  sdk: Map<string, BundledSDK>
  modelLoaders: Record<string, CustomModelLoader>
  varsLoaders: Record<string, CustomVarsLoader>
}

export class Service extends Context.Service<Service, Interface>()("@origami/Provider") {}

export const use = serviceUse(Service)

function cost(c: ModelsDev.Model["cost"]): Model["cost"] {
  const result: Model["cost"] = {
    input: c?.input ?? 0,
    output: c?.output ?? 0,
    cache: {
      read: c?.cache_read ?? 0,
      write: c?.cache_write ?? 0,
    },
  }
  if (c?.tiers) {
    result.tiers = c.tiers.map((item) => ({
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read ?? 0,
        write: item.cache_write ?? 0,
      },
      tier: item.tier,
    }))
  }
  if (c?.context_over_200k) {
    result.experimentalOver200K = {
      cache: {
        read: c.context_over_200k.cache_read ?? 0,
        write: c.context_over_200k.cache_write ?? 0,
      },
      input: c.context_over_200k.input,
      output: c.context_over_200k.output,
    }
  }
  return result
}

function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
  const base: Model = {
    id: ModelV2.ID.make(model.id),
    providerID: ProviderV2.ID.make(provider.id),
    name: model.name,
    family: model.family,
    api: {
      id: model.id,
      url: model.provider?.api ?? provider.api ?? "",
      // The shipped catalog carries no `protocol`, so this resolves exactly as
      // it always did; it goes through the same function only so ONE place
      // decides what an `npm`/`protocol` pair means.
      npm: ProviderProtocol.resolveProviderPackage({
        providerID: provider.id,
        modelID: model.id,
        model: model.provider,
        provider,
      }),
    },
    status: model.status ?? "active",
    headers: {},
    options: {},
    cost: cost(model.cost),
    limit: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    capabilities: {
      temperature: model.temperature ?? false,
      reasoning: model.reasoning ?? false,
      attachment: model.attachment ?? false,
      toolcall: model.tool_call ?? true,
      input: {
        text: model.modalities?.input?.includes("text") ?? false,
        audio: model.modalities?.input?.includes("audio") ?? false,
        image: model.modalities?.input?.includes("image") ?? false,
        video: model.modalities?.input?.includes("video") ?? false,
        pdf: model.modalities?.input?.includes("pdf") ?? false,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? false,
        audio: model.modalities?.output?.includes("audio") ?? false,
        image: model.modalities?.output?.includes("image") ?? false,
        video: model.modalities?.output?.includes("video") ?? false,
        pdf: model.modalities?.output?.includes("pdf") ?? false,
      },
      interleaved: model.interleaved ?? false,
    },
    release_date: model.release_date ?? "",
    variants: {},
  }

  const variants = ProviderTransform.reasoningVariants(model, base) ?? ProviderTransform.variants(base)

  return {
    ...base,
    variants: mapValues(variants, (v) => v),
  }
}

export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
  const models: Record<string, Model> = {}
  for (const [key, model] of Object.entries(provider.models)) {
    models[key] = fromModelsDevModel(provider, model)
    for (const [mode, opts] of Object.entries(model.experimental?.modes ?? {})) {
      const id = `${model.id}-${mode}`
      const base = fromModelsDevModel(provider, model)
      models[id] = {
        ...base,
        id: ModelV2.ID.make(id),
        name: `${model.name} ${mode[0].toUpperCase()}${mode.slice(1)}`,
        cost: opts.cost ? mergeDeep(base.cost, cost(opts.cost)) : base.cost,
        options: modeOptions(base, opts.provider?.body),
        headers: opts.provider?.headers ?? base.headers,
      }
    }
  }
  return {
    id: ProviderV2.ID.make(provider.id),
    source: "custom",
    name: provider.name,
    env: [...(provider.env ?? [])],
    options: {},
    models,
  }
}

function modeOptions(model: Model, body: Record<string, unknown> | undefined) {
  if (!body) return model.options
  const options = Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value]),
  )
  const reasoning = body.reasoning
  if (model.api.npm !== "@ai-sdk/openai" || !isRecord(reasoning) || typeof reasoning.mode !== "string") return options
  const { reasoning: _, ...rest } = options
  return { ...rest, reasoningMode: reasoning.mode }
}

function modelSuggestions(provider: Info | undefined, modelID: ModelV2.ID, enableExperimentalModels: boolean) {
  const available = provider
    ? Object.keys(provider.models).filter((id) => {
        const model = provider.models[id]
        if (model.status === "deprecated") return false
        if (model.status === "alpha" && !enableExperimentalModels) return false
        return true
      })
    : []
  const fuzzy = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 }).map((m) => m.target)
  if (fuzzy.length) return fuzzy
  const query = modelID
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1)
  return sortBy(
    available
      .map((id) => ({
        id,
        score: query.filter((part) => id.toLowerCase().includes(part)).length,
      }))
      .filter((item) => item.score > 0),
    [(item) => item.score, "desc"],
    [(item) => item.id, "asc"],
  )
    .slice(0, 3)
    .map((item) => item.id)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const env = yield* Env.Service
    const plugin = yield* Plugin.Service
    const modelsDevSvc = yield* ModelsDev.Service
    const runtimeFlags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(() =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const cfg = yield* config.get()
        const modelsDev = yield* modelsDevSvc.get()
        const catalog = mapValues(modelsDev, fromModelsDevProvider)
        // origami_change (t-woacbl): rows are copied when read (_lazyPublicRows).
        const { rows: database, env: databaseEnv } = _lazyPublicRows(catalog, toPublicInfo)

        const providers: Record<ProviderV2.ID, Info> = {} as Record<ProviderV2.ID, Info>
        const languages = new Map<string, LanguageModelV3>()
        const modelLoaders: {
          [providerID: string]: CustomModelLoader
        } = {}
        const varsLoaders: {
          [providerID: string]: CustomVarsLoader
        } = {}
        const sdk = new Map<string, BundledSDK>()
        const discoveryLoaders: {
          [providerID: string]: CustomDiscoverModels
        } = {}
        const dep = {
          auth: (id: string) => auth.get(id).pipe(Effect.orDie),
          config: () => config.get(),
          env: () => env.all(),
          get: (key: string) => env.get(key),
        }

        function mergeProvider(providerID: ProviderV2.ID, provider: Partial<Info>) {
          const existing = providers[providerID]
          if (existing) {
            // @ts-expect-error
            providers[providerID] = mergeDeep(existing, provider)
            return
          }
          const match = database[providerID]
          if (!match) return
          // @ts-expect-error
          providers[providerID] = mergeDeep(match, provider)
        }

        // load plugins first so config() hook runs before reading cfg.provider
        const plugins = yield* plugin.list()

        // now read config providers - includes any modifications from plugin config() hook
        const configProviders = Object.entries(cfg.provider ?? {})
        const disabled = new Set(cfg.disabled_providers ?? [])
        const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : null

        function isProviderAllowed(providerID: ProviderV2.ID): boolean {
          if (enabled && !enabled.has(providerID)) return false
          if (disabled.has(providerID)) return false
          return true
        }

        for (const hook of plugins) {
          const p = hook.provider
          if (!p) continue

          const providerID = ProviderV2.ID.make(p.id)
          if (disabled.has(providerID)) continue
          const pluginAuth = yield* auth.get(providerID).pipe(Effect.orDie)

          // origami_change: registered BEFORE the database-miss guard below,
          // deliberately. `models` filters rows the database already has, but
          // `discoverModels` is a SOURCE of rows, and the providers that need it
          // most are the ones with no database entry, so registering it behind
          // that guard would make it dead code. The merge still needs a provider
          // row to land in, which the config pass above has built by then.
          if (p.discoverModels) {
            const discover = p.discoverModels
            const credential =
              pluginAuth?.type === "oauth"
                ? pluginAuth.access
                : pluginAuth?.type === "api"
                  ? pluginAuth.key
                  : undefined
            discoveryLoaders[providerID] = memoizeDiscovery(discoveryKey(providerID, credential), async () => {
              const discovered = await discover({ auth: pluginAuth })
              return Object.fromEntries(
                Object.entries(discovered).map(([id, model]) => [
                  id,
                  { ...model, id: ModelV2.ID.make(id), providerID } as Model,
                ]),
              )
            })
          }

          const models = p.models
          if (!models) continue
          const provider = database[providerID]
          if (!provider) continue

          const before = Object.keys(provider.models).length
          provider.models = yield* Effect.promise(async () => {
            const next = await models(toPublicInfo(provider), { auth: pluginAuth })
            return Object.fromEntries(
              Object.entries(next).map(([id, model]) => [
                id,
                {
                  ...model,
                  id: ModelV2.ID.make(id),
                  providerID,
                },
              ]),
            )
          })
          // A hook that answers with NOTHING is the one outcome nobody sees: the
          // config pass below rebuilds every declared model on top of it, so the
          // picker still shows the seed rows and the empty live list leaves no
          // trace — while the endpoint refuses those seed rows at inference.
          if (Object.keys(provider.models).length === 0) {
            yield* Effect.logWarning("provider models hook returned no models; only config-declared rows will show", {
              providerID,
              catalogBefore: before,
            })
          }
        }

        // origami_change (t-tija5f, t-ty02bb): Claude through the owner's
        // subscription, only while its flag is on. It goes into the DATABASE,
        // before the config pass, so a config block named `claude-subscription`
        // merges over the family's rows the way config merges over any catalog
        // row: what the block leaves out (npm, URL, window, effort ladder) stays
        // the family's. Merged AFTER the config pass (0.4.169-0.4.170), the
        // block's rows replaced the family's with the protocol default,
        // `@ai-sdk/openai-compatible`, and a request on an unready CLI reached
        // that adapter's "requires a base URL" instead of Gate B. The extension
        // writes such a block on every pick (firstFold.writeModelConfig). The
        // probe runs `claude --version` and `claude auth status` only; see
        // provider/claude-subscription.ts. A copy: the memoised row is shared.
        const claudeSubscriptionID = ProviderV2.ID.make(ClaudeSubscription.PROVIDER_ID)
        const claudeSubscription =
          runtimeFlags.experimentalClaudeSubscription && isProviderAllowed(claudeSubscriptionID)
        if (claudeSubscription)
          database[claudeSubscriptionID] = structuredClone(yield* Effect.promise(() => ClaudeSubscription.providerInfo()))
        // Flag off, but a config block still names the family: its rows, not
        // probed, so a request says the route is off instead of failing there.
        else if (isProviderAllowed(claudeSubscriptionID) && configProviders.some(([id]) => id === claudeSubscriptionID))
          database[claudeSubscriptionID] = ClaudeSubscription.offInfo()

        // extend database from config
        for (const [providerID, provider] of configProviders) {
          const existing = database[providerID]
          const parsed: Info = {
            id: ProviderV2.ID.make(providerID),
            name: provider.name ?? existing?.name ?? providerID,
            env: provider.env ?? existing?.env ?? [],
            options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
            source: "config",
            models: existing?.models ?? {},
          }

          for (const [modelID, model] of Object.entries(provider.models ?? {})) {
            const existingModel = parsed.models[model.id ?? modelID]
            const apiID = model.id ?? existingModel?.api.id ?? modelID
            const apiNpm = ProviderProtocol.resolveProviderPackage({
              providerID,
              modelID,
              model: model.provider,
              provider,
              fallback: [existingModel?.api.npm, modelsDev[providerID]?.npm],
            })
            // origami_change (t-y5ecbj): in a `claude-subscription` block a name equal to the
            // model id is a persisted pick (the extension writes `name: <id>`), not a label:
            // the family's own name stays, and a row it does not list gets a readable one.
            const subscriptionRow = providerID === claudeSubscriptionID
            const name = iife(() => {
              if (model.name && !(subscriptionRow && model.name === modelID)) return model.name
              if (model.id && model.id !== modelID) return modelID
              return existingModel?.name ?? (subscriptionRow ? ClaudeSubscription.readableName(modelID) : modelID)
            })
            const parsedModel: Model = {
              id: ModelV2.ID.make(modelID),
              api: {
                id: apiID,
                npm: apiNpm,
                url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api ?? "",
              },
              status: model.status ?? existingModel?.status ?? "active",
              name,
              providerID: ProviderV2.ID.make(providerID),
              capabilities: {
                temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
                reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
                attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
                toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
                input: {
                  text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
                  audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
                  image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
                  video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
                  pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
                },
                output: {
                  text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
                  audio:
                    model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
                  image:
                    model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
                  video:
                    model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
                  pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
                },
                interleaved:
                  model.interleaved ??
                  existingModel?.capabilities.interleaved ??
                  (!existingModel && apiNpm === "@ai-sdk/openai-compatible" && apiID.includes("deepseek")
                    ? { field: "reasoning_content" }
                    : false),
              },
              cost: {
                input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
                output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
                cache: {
                  read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
                  write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
                },
              },
              options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
              limit: {
                context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
                input: model.limit?.input ?? existingModel?.limit?.input,
                output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
                images: model.limit?.images ?? existingModel?.limit?.images,
              },
              headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
              family: model.family ?? existingModel?.family ?? "",
              release_date: model.release_date ?? existingModel?.release_date ?? "",
              variants: {},
            }
            // origami_change: a config model may DECLARE its reasoning controls
            // the models.dev way, and the declaration WINS over the name-regex
            // heuristic - the operator knows what the endpoint takes. No
            // declaration means `undefined` here, so the heuristic still applies.
            // Explicit `variants` merge on top of whichever source won.
            const declared = ProviderTransform.reasoningOptionVariants(model.reasoning_options, parsedModel)
            const variants =
              declared ??
              (existingModel?.api.npm === parsedModel.api.npm
                ? (existingModel.variants ?? ProviderTransform.variants(parsedModel))
                : ProviderTransform.variants(parsedModel))
            const merged = mergeDeep(variants, model.variants ?? {})
            parsedModel.variants = mapValues(
              pickBy(merged, (v) => !v.disabled),
              (v) => omit(v, ["disabled"]),
            )
            // origami_change (t-48ffvz): a tier this model has ANSWERED 400 on
            // is struck off the ladder the picker reads, for this user, for
            // good. Applied LAST so it outranks every source above it - those
            // are claims made before the request; a refusal is made after it.
            parsedModel.variants = ProviderEffortDemotion.filterVariants(
              providerID,
              modelID,
              parsedModel.variants,
            )
            parsed.models[modelID] = parsedModel
          }
          database[providerID] = parsed
        }

        // load env
        const envs = yield* env.all()
        for (const id of Object.keys(database)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          // origami_change (t-woacbl): the env list only; a row with a key is
          // copied by `mergeProvider`, the rest never are.
          const names = databaseEnv(id)
          const apiKey = names.map((item) => envs[item]).find(Boolean)
          if (!apiKey) continue
          mergeProvider(providerID, {
            source: "env",
            key: names.length === 1 ? apiKey : undefined,
          })
        }

        // load apikeys
        const auths = yield* auth.all().pipe(Effect.orDie)
        for (const [id, provider] of Object.entries(auths)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          if (provider.type === "api") {
            mergeProvider(providerID, {
              source: "api",
              key: provider.key,
            })
          }
        }

        // plugin auth loader - database now has entries for config providers
        for (const plugin of plugins) {
          if (!plugin.auth) continue
          const providerID = ProviderV2.ID.make(plugin.auth.provider)
          if (disabled.has(providerID)) continue

          const stored = yield* auth.get(providerID).pipe(Effect.orDie)
          if (!stored) continue
          if (!plugin.auth.loader) continue
          // A credential can exist for a provider the DATABASE has never heard
          // of: this fork ships no models.dev data, so until a config block
          // declares it, `openai` / `xai` are absent here even with a stored
          // OAuth token. `toPublicInfo(undefined)` would throw and take the whole
          // provider list down. Skipping is equivalent anyway: with no database
          // entry `mergeProvider` returns early on `!match`.
          if (!database[providerID]) continue

          const options = yield* Effect.promise(() =>
            plugin.auth!.loader!(
              () => bridge.promise(auth.get(providerID).pipe(Effect.orDie)) as any,
              toPublicInfo(database[plugin.auth!.provider]),
            ),
          )
          const opts = options ?? {}
          const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
          mergeProvider(providerID, patch)
        }

        for (const [id, fn] of Object.entries(custom(dep))) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          const data = database[providerID]
          if (!data) {
            continue
          }
          const result = yield* fn(data)
          if (result && (result.autoload || providers[providerID])) {
            if (result.getModel) modelLoaders[providerID] = result.getModel
            if (result.vars) varsLoaders[providerID] = result.vars
            // Memoised on the same ten-minute clock as the plugin loaders: the
            // provider list is rebuilt per instance AND on every
            // `provider_refresh`, so without this a picker open would put the
            // credential back on the wire every time.
            if (result.discoverModels) discoveryLoaders[providerID] = memoizeDiscovery(discoveryKey(providerID, data.key), result.discoverModels)
            const opts = result.options ?? {}
            const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
            mergeProvider(providerID, patch)
          }
        }

        // load config - re-apply with updated data
        for (const [id, provider] of configProviders) {
          const providerID = ProviderV2.ID.make(id)
          const partial: Partial<Info> = { source: "config" }
          if (provider.env) partial.env = provider.env
          if (provider.name) partial.name = provider.name
          if (provider.options) partial.options = provider.options
          mergeProvider(providerID, partial)
        }

        // origami_change (t-d94t8t): a bare config block for an OpenAI-compatible
        // endpoint (a raw "Other" connection, vLLM, sglang) carries no models.dev
        // row, so any model it declares with no `limit.context` sits at 0 -
        // disabling auto-compaction and hiding the context meter, unlike a NAMED
        // provider whose window models.dev already knows. These servers publish
        // it themselves on GET /v1/models (`max_model_len` / `max_context_length`
        // / `context_length`), so probe it here. Registered as a `discoverModels`
        // loader so the merge rule in discovery.ts applies: only a model already
        // at 0 gets backfilled, and only models the config already named are ever
        // candidates - see `discoverOpenAICompatContext`.
        for (const [providerID, provider] of configProviders) {
          const id = ProviderV2.ID.make(providerID)
          if (disabled.has(id) || discoveryLoaders[providerID]) continue
          const built = database[providerID]
          const baseURL = typeof provider.options?.baseURL === "string" ? provider.options.baseURL : undefined
          if (!built || !baseURL) continue
          const targets = Object.keys(built.models).filter(
            (modelID) => built.models[modelID].api.npm === "@ai-sdk/openai-compatible" && built.models[modelID].limit.context <= 0,
          )
          if (targets.length === 0) continue
          discoveryLoaders[providerID] = memoizeDiscovery(discoveryKey(providerID, baseURL), () =>
            discoverOpenAICompatContext(baseURL, built.models, targets),
          )
        }

        // The family's row (seeded into the database above) is listed with no
        // key or config block, and before the variants pass below. A config
        // block of the same id already put it here, merged.
        if (claudeSubscription && !providers[claudeSubscriptionID])
          providers[claudeSubscriptionID] = database[claudeSubscriptionID]!

        // origami_change: EVERY registered loader, not just gitlab. The guards
        // are unchanged (the provider must exist here and must not be disabled);
        // the merge rule itself lives in discovery.ts, stated once.
        //
        // Placement is load-bearing and must not drift: AFTER the config pass,
        // so an operator declaration always wins over a discovered row, and
        // BEFORE the variants pass below, so a discovered row that carries no
        // variants of its own still gets the heuristic ones.
        yield* Effect.promise(() =>
          runDiscoveryLoaders({
            loaders: discoveryLoaders,
            providers,
            isAllowed: (id) => isProviderAllowed(ProviderV2.ID.make(id)),
          }),
        )

        for (const [id, provider] of Object.entries(providers)) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) {
            delete providers[providerID]
            continue
          }

          const configProvider = cfg.provider?.[providerID]

          for (const [modelID, model] of Object.entries(provider.models)) {
            model.api.id = model.api.id ?? model.id ?? modelID
            if (
              // These chat aliases are invalid for the special handling in the
              // built-in providers below, but custom providers may support them.
              (modelID === "gpt-5-chat-latest" &&
                (providerID === ProviderV2.ID.openai ||
                  providerID === ProviderV2.ID.githubCopilot ||
                  providerID === ProviderV2.ID.openrouter)) ||
              (providerID === ProviderV2.ID.openrouter && modelID === "openai/gpt-5-chat")
            )
              delete provider.models[modelID]
            if (model.status === "alpha" && !runtimeFlags.enableExperimentalModels) delete provider.models[modelID]
            if (model.status === "deprecated") delete provider.models[modelID]
            if (
              (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
              (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
            )
              delete provider.models[modelID]

            if (model.variants === undefined) {
              model.variants = mapValues(ProviderTransform.variants(model), (v) => v)
            }

            const configVariants = configProvider?.models?.[modelID]?.variants
            if (configVariants && model.variants) {
              const merged = mergeDeep(model.variants, configVariants)
              model.variants = mapValues(
                pickBy(merged, (v) => !v.disabled),
                (v) => omit(v, ["disabled"]),
              )
            }
          }

          if (Object.keys(provider.models).length === 0) {
            delete providers[providerID]
            continue
          }
        }

        return {
          models: languages,
          providers,
          catalog,
          sdk,
          modelLoaders,
          varsLoaders,
        }
      }),
    )

    const list = Effect.fn("Provider.list")(() => InstanceState.use(state, (s) => s.providers))

    /**
     * The SDK-client cache key for a model, and the resolved options that
     * produced it.
     *
     * origami_change: split out of `resolveSDK` so `getLanguage` can memoise on
     * the SAME material this cache is keyed by. Pure over its arguments - every
     * `varsLoaders` entry is a formatter that only reads `options` - so calling
     * it a second time on a miss costs a spread and a hash, not a side effect.
     */
    function sdkOptions(model: Model, s: State, envs: Record<string, string | undefined>) {
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      if (
        model.providerID === "google-vertex" &&
        model.api.npm === "@ai-sdk/google-vertex/anthropic" &&
        !options.baseURL
      ) {
        const baseURL = googleVertexAnthropicBaseURL(
          typeof options.project === "string" ? options.project : undefined,
          typeof options.location === "string" ? options.location : undefined,
        )
        if (baseURL) options.baseURL = baseURL
      }

      if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
        delete options.fetch
      }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      const baseURL = iife(() => {
        let url =
          typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
        if (!url) return

        const loader = s.varsLoaders[model.providerID]
        if (loader) {
          const vars = loader(options)
          for (const [key, value] of Object.entries(vars)) {
            const field = "${" + key + "}"
            url = url.replaceAll(field, value)
          }
        }

        url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
          const val = envs[String(key)]
          return val ?? item
        })
        return url
      })

      if (baseURL !== undefined) options["baseURL"] = baseURL
      // FALSY, not `=== undefined`. A config block can carry `"apiKey": ""` and
      // an empty string is not a credential: a strict check treats it as one and
      // SHADOWS a good auth.json / env credential, sending the request with no
      // Authorization header at all. Covered by
      // test/provider/credential-resolution.test.ts, which reads the header off a
      // real server rather than off `provider.options`.
      if (!options["apiKey"] && provider.key) options["apiKey"] = provider.key
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }

      const key = Hash.fast(
        JSON.stringify({
          providerID: model.providerID,
          npm: model.api.npm,
          options,
        }),
      )
      return { key, options }
    }

    async function resolveSDK(model: Model, s: State, envs: Record<string, string | undefined>) {
      try {
        const { key, options } = sdkOptions(model, s, envs)
        const existing = s.sdk.get(key)
        if (existing) return existing

        const customFetch = options["fetch"]
        // Self-hosted servers get a default chunk timeout (a wedged local
        // generation otherwise hangs its stream forever); explicit values —
        // including false = off — always win. Cloud endpoints get no default.
        const chunkTimeout =
          options["chunkTimeout"] ?? (isSelfHostedURL(options["baseURL"]) ? LOCAL_CHUNK_TIMEOUT_DEFAULT : undefined)
        const headerTimeout =
          options["headerTimeout"] ?? (isSelfHostedURL(options["baseURL"]) ? LOCAL_HEADER_TIMEOUT_DEFAULT : undefined)
        // Per-provider concurrency cap: generations in flight to this provider at
        // once (e.g. match a vLLM server's max_num_seqs); undefined = unlimited.
        // Read + strip here so it never reaches the SDK factory below.
        const maxConcurrent = typeof options["max_concurrent"] === "number" ? options["max_concurrent"] : undefined
        delete options["chunkTimeout"]
        delete options["headerTimeout"]
        delete options["max_concurrent"]

        options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
          const fetchFn = customFetch ?? fetch
          const opts = init ?? {}
          const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
          const headerTimeoutMs = headerTimeout === false ? undefined : headerTimeout
          const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
          const signals: AbortSignal[] = []

          if (opts.signal) signals.push(opts.signal)
          if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
          if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
          if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
            signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
          if (combined) opts.signal = combined

          // Who is asking, read off the request's own headers — the AI SDK
          // client is built once per provider, so this wrapper's closure knows
          // nothing about the step. PARENT PRIORITY, the same rule the native
          // runtime applies (`native-runtime.ts gatedFetch`): a step with no
          // parent session is a parent and jumps the permit queue ahead of every
          // queued child, so a fan-out of N children against a cap of N cannot
          // starve the turn that spawned them. A NESTED child keeps its parent id
          // and is therefore ordinary on both runtimes: one rule, one meaning of
          // "parent" (the root step), and no way for a middle layer to outrank
          // the root. It can still queue behind its own grandchildren, bounded by
          // the generations in flight.
          const identity = ProviderRequestIdentity.read(opts)
          const noticeSessionID = identity.sessionID
          const notice = noticeSessionID
            ? {
                onWait: (ahead: number) =>
                  SessionProviderQueue.publishProviderQueue({
                    sessionID: noticeSessionID,
                    providerID: model.providerID,
                    state: { type: "waiting", ahead },
                  }),
                onStart: () =>
                  SessionProviderQueue.publishProviderQueue({
                    sessionID: noticeSessionID,
                    providerID: model.providerID,
                    state: { type: "started" },
                  }),
              }
            : undefined
          // The permit is taken INSIDE this wrapper, after the timeouts above are
          // composed and armed on `opts.signal`: `limitFetch` reads the signal
          // back off `init` to free the slot on an abort, and a queued request
          // must not be burning its header timeout while it waits.
          const send = ProviderConcurrency.limitFetch(
            model.providerID,
            maxConcurrent,
            async (target: any, requestInit?: BunFetchRequestInit) => {
              const res = await fetchFn(target, {
                ...requestInit,
                // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
                timeout: false,
              }).finally(() => headerTimeoutCtl?.clear())
              return chunkAbortCtl ? wrapSSE(res, chunkTimeout as number, chunkAbortCtl) : res
            },
            {
              priority: identity.sessionID !== undefined && identity.parentSessionID === undefined,
              ...(notice ? { notice } : {}),
            },
          )
          return await send(input, opts)
        }

        const bundledLoader = BUNDLED_PROVIDERS[model.api.npm]
        if (bundledLoader) {
          const factory = await bundledLoader()
          const loaded = factory({
            name: model.providerID,
            ...options,
          })
          s.sdk.set(key, loaded)
          return loaded as SDK
        }

        // origami_change: a model id outside the bundled table used to install
        // the named npm package (or import a `file://` entrypoint) and call
        // whatever `create*` export it found. That downloaded and ran arbitrary
        // code from a config file, so it is gone. Declare the wire protocol
        // instead; every protocol has a client in the bundle.
        throw new ProviderProtocol.ProtocolError(
          `Provider "${model.providerID}" asks for the package "${model.api.npm}", which this build does not ship. Origami no longer downloads provider packages. Declare the wire protocol instead - set "protocol" on the provider (or on the model's "provider" block) to one of: ${ProviderProtocol.PROTOCOLS.join(", ")}.`,
        )
      } catch (e) {
        throw new InitError({ providerID: model.providerID, cause: e })
      }
    }

    const getProvider = Effect.fn("Provider.getProvider")((providerID: ProviderV2.ID) =>
      InstanceState.use(state, (s) => s.providers[providerID]),
    )

    const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderV2.ID, modelID: ModelV2.ID) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) {
        const catalogProvider = s.catalog[providerID]
        const suggestions = catalogProvider
          ? modelSuggestions(catalogProvider, modelID, runtimeFlags.enableExperimentalModels)
          : fuzzysort
              .go(providerID, Object.keys({ ...s.catalog, ...s.providers }), { limit: 3, threshold: -10000 })
              .map((m) => m.target)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }

      const info = provider.models[modelID]
      if (!info) {
        const current = modelSuggestions(provider, modelID, runtimeFlags.enableExperimentalModels)
        const suggestions = current.length
          ? current
          : modelSuggestions(s.catalog[providerID], modelID, runtimeFlags.enableExperimentalModels)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }
      return info
    })

    const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
      const s = yield* InstanceState.get(state)
      const envs = yield* env.all()
      const provider = s.providers[model.providerID]
      // origami_change: memoise on the SDK CACHE KEY, not on `providerID/modelID`
      // alone. The `s.sdk` map below is credential-sensitive - its key hashes the
      // RESOLVED options, apiKey and per-model headers included - so keying this
      // map by id alone hands a resolution whose options changed the language
      // model built with the FIRST credential. `provider` is missing only for a
      // model no `getModel` produced; `sdkOptions` would throw on it, so key
      // plainly there and let `resolveSDK` raise its InitError.
      const key = provider
        ? `${model.providerID}/${model.id}/${sdkOptions(model, s, envs).key}`
        : `${model.providerID}/${model.id}`
      if (s.models.has(key)) return s.models.get(key)!

      return yield* EffectPromise.refineRejection(
        async () => {
          const sdk = await resolveSDK(model, s, envs)
          const language = s.modelLoaders[model.providerID]
            ? await s.modelLoaders[model.providerID](
                sdk,
                model.api.id,
                {
                  ...provider.options,
                  ...model.options,
                },
                model,
              )
            : sdk.languageModel(model.api.id)
          s.models.set(key, language)
          return language
        },
        (cause) =>
          cause instanceof NoSuchModelError
            ? new ModelNotFoundError({ modelID: model.id, providerID: model.providerID, cause })
            : undefined,
      )
    })

    const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderV2.ID, query: string[]) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined
      for (const item of query) {
        for (const modelID of Object.keys(provider.models)) {
          if (modelID.includes(item)) return { providerID, modelID }
        }
      }
      return undefined
    })

    const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (providerID: ProviderV2.ID) {
      const cfg = yield* config.get()

      if (cfg.small_model) {
        const parsed = parseModel(cfg.small_model)
        return yield* getModel(parsed.providerID, parsed.modelID).pipe(
          Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)),
        )
      }

      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined

      const experimental = yield* plugin.trigger<"experimental.provider.small_model">(
        "experimental.provider.small_model",
        { provider: toPublicInfo(provider) },
        { model: undefined },
      )
      if (experimental.model) {
        return {
          ...experimental.model,
          id: ModelV2.ID.make(experimental.model.id),
          providerID: ProviderV2.ID.make(experimental.model.providerID),
        }
      }

      // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
      if (providerID === ProviderV2.ID.azure || providerID === ProviderV2.ID.make("azure-cognitive-services")) {
        return undefined
      }

      const priority = providerID.startsWith("opencode")
        ? ["gpt-nano"]
        : providerID.startsWith("github-copilot")
          ? ["gpt-mini", ...smallModelFamilyPriority]
          : smallModelFamilyPriority
      const models = sortBy(
        Object.values(provider.models),
        [(model) => model.release_date, "desc"],
        [(model) => model.id, "desc"],
      )
      for (const family of priority) {
        const candidates = models.filter((model) => model.family === family)
        if (providerID === ProviderV2.ID.amazonBedrock) {
          const crossRegionPrefixes = ["global.", "us.", "eu."]

          const globalMatch = candidates.find((model) => model.id.startsWith("global."))
          if (globalMatch) return globalMatch

          const region = provider.options?.region
          if (region) {
            const regionPrefix = region.split("-")[0]
            if (regionPrefix === "us" || regionPrefix === "eu") {
              const regionalMatch = candidates.find((model) => model.id.startsWith(`${regionPrefix}.`))
              if (regionalMatch) return regionalMatch
            }
          }

          const unprefixed = candidates.find((model) => !crossRegionPrefixes.some((p) => model.id.startsWith(p)))
          if (unprefixed) return unprefixed
          continue
        }
        if (candidates[0]) return candidates[0]
      }

      return undefined
    })

    const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
      const cfg = yield* config.get()
      if (cfg.model) return parseModel(cfg.model)

      const s = yield* InstanceState.get(state)
      const recent = yield* fs.readJson(path.join(Global.Path.state, "model.json")).pipe(
        Effect.map((x): { providerID: ProviderV2.ID; modelID: ModelV2.ID }[] => {
          if (!isRecord(x) || !Array.isArray(x.recent)) return []
          return x.recent.flatMap((item) => {
            if (!isRecord(item)) return []
            if (typeof item.providerID !== "string") return []
            if (typeof item.modelID !== "string") return []
            return [{ providerID: ProviderV2.ID.make(item.providerID), modelID: ModelV2.ID.make(item.modelID) }]
          })
        }),
        Effect.catch(() => Effect.succeed([] as { providerID: ProviderV2.ID; modelID: ModelV2.ID }[])),
      )
      for (const entry of recent) {
        const provider = s.providers[entry.providerID]
        if (!provider) continue
        if (!provider.models[entry.modelID]) continue
        return { providerID: entry.providerID, modelID: entry.modelID }
      }

      const configured = Object.keys(cfg.provider ?? {})
      const provider = Object.values(s.providers).find((p) => configured.length === 0 || configured.includes(p.id))
      if (!provider) return yield* new NoProvidersError()
      const [model] = sort(Object.values(provider.models))
      if (!model) return yield* new NoModelsError({ providerID: provider.id })
      return {
        providerID: provider.id,
        modelID: model.id,
      }
    })

    const invalidate = Effect.fn("Provider.invalidate")(function* () {
      yield* InstanceState.invalidate(state)
    })

    return Service.of({ list, getProvider, getModel, getLanguage, closest, getSmallModel, defaultModel, invalidate })
  }),
)

const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
const smallModelFamilyPriority = ["gemini-flash", "gpt-nano", "claude-haiku"]
export function sort<T extends { id: string }>(models: T[]) {
  return sortBy(
    models,
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.id, "desc"],
  )
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ModelV2.ID.make(rest.join("/")),
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Config.node, Auth.node, Env.node, Plugin.node, ModelsDev.node, RuntimeFlags.node],
})

export * as Provider from "./provider"

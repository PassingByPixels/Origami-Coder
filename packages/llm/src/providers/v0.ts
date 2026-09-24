import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"

// This facade is for the "v0" catalog id (Vercel's v0.dev model API), NOT the
// "vercel" catalog id — that id is a different product (Vercel AI Gateway,
// see the note in providers/index.ts on why it is skipped).
//
// Base URL and env var read from node_modules/@ai-sdk/vercel/dist/index.mjs
// (npm "@ai-sdk/vercel"): `withoutTrailingSlash(options.baseURL) ??
// "https://api.v0.dev/v1"`, and it constructs its models with
// `OpenAICompatibleChatLanguageModel` imported directly from
// `@ai-sdk/openai-compatible` — a first-party OpenAI Chat Completions wire.
// The bundle's own `loadApiKey` default is "VERCEL_API_KEY", but
// packages/engine/test/tool/fixtures/models-api.json's "v0" entry
// (`"npm": "@ai-sdk/vercel"`) declares `"env": ["V0_API_KEY"]` — the name the
// shipped catalog actually collects. Both are tried, catalog name first.
export const id = ProviderID.make("v0")

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleChat.route]

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, ["V0_API_KEY", "VERCEL_API_KEY"])

const configuredChatRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return OpenAICompatibleChat.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? OpenAICompatibleProfiles.profiles.v0.baseURL },
    auth: auth(input),
  })
}

export const configure = (input: ModelOptions = {}) => {
  const chatRoute = configuredChatRoute(input)
  const chat = (modelID: string | ModelID) => chatRoute.model({ id: modelID })
  return {
    id,
    model: chat,
    chat,
    configure,
  }
}

export const provider = configure()
export const model = provider.model
export const chat = provider.chat

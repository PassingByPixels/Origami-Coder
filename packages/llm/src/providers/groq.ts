import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"

// Base URL and env var read from node_modules/@ai-sdk/groq/dist/index.mjs:
// `withoutTrailingSlash(options.baseURL) ?? "https://api.groq.com/openai/v1"`
// and `loadApiKey({ environmentVariableName: "GROQ_API_KEY" })`. Groq's own
// base path already carries "/openai/v1" — it is a first-party OpenAI Chat
// Completions endpoint. Catalog id "groq" matches
// packages/engine/test/tool/fixtures/models-api.json.
export const id = ProviderID.make("groq")

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleChat.route]

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "GROQ_API_KEY")

const configuredChatRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return OpenAICompatibleChat.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? OpenAICompatibleProfiles.profiles.groq.baseURL },
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

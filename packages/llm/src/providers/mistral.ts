import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"

// Base URL and env var read from node_modules/@ai-sdk/mistral/dist/index.mjs:
// `withoutTrailingSlash(options.baseURL) ?? "https://api.mistral.ai/v1"` and
// `loadApiKey({ environmentVariableName: "MISTRAL_API_KEY" })`. Chat wire is
// plain OpenAI Chat Completions (`${baseURL}/chat/completions`, `messages`/
// `model`/`stream` body). Catalog id "mistral" matches
// packages/engine/test/tool/fixtures/models-api.json.
export const id = ProviderID.make("mistral")

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleChat.route]

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "MISTRAL_API_KEY")

const configuredChatRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return OpenAICompatibleChat.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? OpenAICompatibleProfiles.profiles.mistral.baseURL },
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

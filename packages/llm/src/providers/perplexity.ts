import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"

// Base URL and env var read from
// node_modules/@ai-sdk/perplexity/dist/index.mjs:
// `withoutTrailingSlash(...) ?? "https://api.perplexity.ai"`, requests go to
// `${baseURL}/chat/completions`, and
// `loadApiKey({ environmentVariableName: "PERPLEXITY_API_KEY" })`. Body
// fields (`model`, `messages`, `role`, `stream`, `max_tokens`,
// `response_format`) are OpenAI Chat Completions shaped — no `tools` support
// in this SDK version, but the wire itself is compatible. Catalog id
// "perplexity" matches packages/engine/test/tool/fixtures/models-api.json.
export const id = ProviderID.make("perplexity")

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleChat.route]

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "PERPLEXITY_API_KEY")

const configuredChatRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return OpenAICompatibleChat.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? OpenAICompatibleProfiles.profiles.perplexity.baseURL },
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

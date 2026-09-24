import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"

// Base URL and env var read from
// node_modules/venice-ai-sdk-provider/dist/index.mjs (npm id
// "venice-ai-sdk-provider", not an @ai-sdk/* scoped package):
// `withoutTrailingSlash(...) ?? "https://api.venice.ai/api/v1"` and
// `loadApiKey({ environmentVariableName: "VENICE_API_KEY" })`. Venice ships
// its own chat-model class (not @ai-sdk/openai-compatible's) to support
// vision/audio/video extras, but it still posts to
// `${baseURL}/chat/completions` with `model`/`messages`/`role`/`stream`/
// `tools`/`tool_calls` fields — an OpenAI Chat Completions superset. Catalog
// id "venice" matches packages/engine/test/tool/fixtures/models-api.json.
export const id = ProviderID.make("venice")

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleChat.route]

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "VENICE_API_KEY")

const configuredChatRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return OpenAICompatibleChat.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? OpenAICompatibleProfiles.profiles.venice.baseURL },
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

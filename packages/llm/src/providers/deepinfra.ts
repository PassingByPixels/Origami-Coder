import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"

// Base URL and env var read from node_modules/@ai-sdk/deepinfra/dist/index.mjs:
// `withoutTrailingSlash(...) ?? "https://api.deepinfra.com/v1"`, requests go
// to `${baseURL}/openai${path}` — hence the profile bakes the "/openai"
// suffix into the base URL itself. Env is
// `loadApiKey({ environmentVariableName: "DEEPINFRA_API_KEY" })`. Plain
// OpenAI Chat Completions wire, proven already by the `openai-compatible.ts`
// family tests (`test/provider/openai-compatible-chat.test.ts`). Catalog id
// "deepinfra" matches packages/engine/test/tool/fixtures/models-api.json.
export const id = ProviderID.make("deepinfra")

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleChat.route]

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "DEEPINFRA_API_KEY")

const configuredChatRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return OpenAICompatibleChat.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? OpenAICompatibleProfiles.profiles.deepinfra.baseURL },
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

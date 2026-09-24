import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"

// Base URL confirmed from TWO independent sources:
// (1) node_modules/@ai-sdk/alibaba/dist/index.mjs — its own default is
//     `withoutTrailingSlash(...) ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"`,
//     requests go to `${baseURL}/chat/completions`.
// (2) packages/engine/test/tool/fixtures/models-api.json — the "alibaba"
//     entry's "api" field is the identical URL.
// Env: the fixture declares `"env": ["DASHSCOPE_API_KEY"]` (Alibaba's own
// credential name — that is what the shipped catalog collects from a user),
// while the @ai-sdk/alibaba bundle's own `loadApiKey` default is
// "ALIBABA_API_KEY". Both are tried, catalog name first. Catalog id
// "alibaba" matches the fixture above.
export const id = ProviderID.make("alibaba")

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleChat.route]

const auth = (options: ProviderAuthOption<"optional">) =>
  AuthOptions.bearer(options, ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY"])

const configuredChatRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return OpenAICompatibleChat.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? OpenAICompatibleProfiles.profiles.alibaba.baseURL },
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

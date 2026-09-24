import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { mergeProviderOptions, ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"
import * as OpenAIResponses from "../protocols/openai-responses"

export const id = ProviderID.make("xai")

export type ModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAIResponses.route, OpenAICompatibleChat.route]

const auth = (options: ProviderAuthOption<"optional">) => AuthOptions.bearer(options, "XAI_API_KEY")

// `@ai-sdk/xai` appends `reasoning.encrypted_content` to `include` on every
// stateless Responses request (`xai-responses-language-model.ts`, bundled at
// dist/index.mjs:2162-2169: `if (options.store === false) include = [...]`).
// The Responses route pins `store: false` in its own defaults, so the xAI
// facade carries the matching include as a route default the same way the
// OpenAI facade does through `withOpenAIOptions`. A caller's own `include`
// still wins: route defaults merge UNDER the model and request options.
const RESPONSES_DEFAULT_OPTIONS = { openai: { include: ["reasoning.encrypted_content"] } }

const configuredResponsesRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return OpenAIResponses.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? OpenAICompatibleProfiles.profiles.xai.baseURL },
    auth: auth(input),
    providerOptions: mergeProviderOptions(RESPONSES_DEFAULT_OPTIONS, rest.providerOptions),
  })
}

const configuredChatRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return OpenAICompatibleChat.route.with({
    ...rest,
    provider: id,
    endpoint: { baseURL: baseURL ?? OpenAICompatibleProfiles.profiles.xai.baseURL },
    auth: auth(input),
  })
}

export const configure = (input: ModelOptions = {}) => {
  const responsesRoute = configuredResponsesRoute(input)
  const chatRoute = configuredChatRoute(input)
  const responses = (modelID: string | ModelID) => responsesRoute.model({ id: modelID })
  const chat = (modelID: string | ModelID) => chatRoute.model({ id: modelID })
  return {
    id,
    model: responses,
    responses,
    chat,
    configure,
  }
}

export const provider = configure()
export const model = provider.model
export const responses = provider.responses
export const chat = provider.chat

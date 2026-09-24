/**
 * origami_change: a provider block DECLARES the wire protocol it speaks, not an
 * npm package to download.
 *
 * The engine routes on `model.api.npm`, so the protocol is translated to that
 * package id here, once. `npm` still works, but only the bundled ids resolve.
 */

export const PROTOCOL_PACKAGE = {
  "openai-chat": "@ai-sdk/openai-compatible",
  "openai-responses": "@ai-sdk/openai",
  "anthropic-messages": "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
  "bedrock-converse": "@ai-sdk/amazon-bedrock",
} as const

export type Protocol = keyof typeof PROTOCOL_PACKAGE

export const PROTOCOLS = Object.keys(PROTOCOL_PACKAGE) as Protocol[]

export const DEFAULT_PACKAGE = PROTOCOL_PACKAGE["openai-chat"]

export class ProtocolError extends Error {
  public override readonly name = "ProviderProtocolError"
}

/** One `origami.json` block that may carry either key. */
export type ProtocolBlock = {
  readonly protocol?: string | undefined
  readonly npm?: string | undefined
}

function blockPackage(block: ProtocolBlock | undefined, where: string): string | undefined {
  if (!block) return undefined
  const protocol = block.protocol
  const npm = block.npm
  if (protocol && npm)
    throw new ProtocolError(
      `${where} declares both "protocol" and "npm" - choose one. Use "protocol" (${PROTOCOLS.join(", ")}) unless you need a legacy package id.`,
    )
  if (!protocol) return npm || undefined
  const resolved = PROTOCOL_PACKAGE[protocol as Protocol]
  if (!resolved)
    throw new ProtocolError(`${where} declares an unknown protocol "${protocol}". Use one of: ${PROTOCOLS.join(", ")}.`)
  return resolved
}

/**
 * The internal package id for a model. Model-level declaration wins over
 * provider-level; the first `fallback` entry with a value is taken after both.
 */
export function resolveProviderPackage(input: {
  readonly providerID: string
  readonly modelID?: string
  readonly model?: ProtocolBlock | undefined
  readonly provider?: ProtocolBlock | undefined
  readonly fallback?: readonly (string | undefined)[]
}): string {
  const model = input.modelID === undefined ? "" : `, model "${input.modelID}"`
  const fromModel = blockPackage(input.model, `Provider "${input.providerID}"${model}: the model's "provider" block`)
  if (fromModel) return fromModel
  const fromProvider = blockPackage(input.provider, `Provider "${input.providerID}": the provider block`)
  if (fromProvider) return fromProvider
  return (input.fallback ?? []).find((item) => Boolean(item)) ?? DEFAULT_PACKAGE
}

export * as ProviderProtocol from "./protocol"

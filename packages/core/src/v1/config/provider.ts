export * as ConfigProviderV1 from "./provider"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])

/**
 * origami_change: the wire protocol a custom provider speaks. Declaring this
 * replaces the old `npm` package name, so the engine picks a BUILT-IN client
 * instead of downloading an arbitrary package at model load.
 */
export const Protocol = Schema.Literals([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini",
  "bedrock-converse",
])
export type Protocol = Schema.Schema.Type<typeof Protocol>

/**
 * origami_change: MIRROR of `ReasoningOption` in `packages/core/src/models-dev.ts`
 * - the same shape models.dev publishes, so a self-hosted endpoint can declare
 * its reasoning controls the way the catalog would. Declared here rather than
 * imported because `models-dev.ts` pulls in the global/HTTP layers and this
 * module is a leaf of the config schema.
 *
 * `packages/engine/test/provider/transform.test.ts` reads both files and fails
 * when they drift.
 */
export const ReasoningOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("effort"),
    values: Schema.Array(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("toggle"),
  }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
])

export const Model = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  attachment: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  reasoning_options: Schema.optional(Schema.Array(ReasoningOption)).annotate({
    description:
      "Reasoning controls this model accepts, in the models.dev shape. Declaring them replaces the generated variants, which are guessed from the model name and cannot know a self-hosted endpoint's knobs.",
  }),
  temperature: Schema.optional(Schema.Boolean),
  tool_call: Schema.optional(Schema.Boolean),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
      context_over_200k: Schema.optional(
        Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          cache_read: Schema.optional(Schema.Finite),
          cache_write: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.Finite,
      input: Schema.optional(Schema.Finite),
      output: Schema.Finite,
      images: Schema.optional(Schema.Finite).annotate({
        description:
          "Maximum images this endpoint accepts in ONE prompt. Match a self-hosted server's own cap (a vLLM server's --limit-mm-per-prompt image value). Older images beyond it are replaced with a short note instead of being sent. Omit to use the engine default.",
      }),
    }),
  ),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])))),
      output: Schema.optional(
        Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
      ),
    }),
  ),
  experimental: Schema.optional(Schema.Boolean),
  status: Schema.optional(ModelStatus),
  provider: Schema.optional(
    Schema.Struct({
      npm: Schema.optional(Schema.String),
      api: Schema.optional(Schema.String),
      protocol: Schema.optional(Protocol).annotate({
        description:
          "Wire protocol this model speaks. Overrides the provider-level protocol. Do not set it together with npm.",
      }),
    }),
  ),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  variants: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          disabled: Schema.optional(Schema.Boolean).annotate({ description: "Disable this variant for the model" }),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ).annotate({ description: "Variant-specific configuration" }),
  ),
})

export const Info = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  env: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  id: Schema.optional(Schema.String),
  npm: Schema.optional(Schema.String),
  protocol: Schema.optional(Protocol).annotate({
    description:
      "Wire protocol every model of this provider speaks. Set this instead of npm: the engine has a built-in client for each protocol and no longer downloads provider packages. Do not set both.",
  }),
  whitelist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  blacklist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  options: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        apiKey: Schema.optional(Schema.String),
        baseURL: Schema.optional(Schema.String),
        enterpriseUrl: Schema.optional(Schema.String).annotate({
          description: "GitHub Enterprise URL for copilot authentication",
        }),
        setCacheKey: Schema.optional(Schema.Boolean).annotate({
          description:
            "Send the per-session prompt cache key (and, on OpenAI models that document it, prompt_cache_retention) to this provider. ON by default for providers whose API documents the key - OpenAI, Azure, xAI, Mistral, DeepInfra, Cerebras, Venice and the OpenCode gateways. Set false to turn it off; set true to force it on for another provider.",
        }),
        timeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description: "Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.",
          }),
        ).annotate({
          description: "Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.",
        }),
        headerTimeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description:
              "Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.",
          }),
        ).annotate({
          description:
            "Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.",
        }),
        chunkTimeout: Schema.optional(PositiveInt).annotate({
          description:
            "Timeout in milliseconds between streamed SSE chunks for this provider. If no chunk arrives within this window, the request is aborted.",
        }),
        max_concurrent: Schema.optional(PositiveInt).annotate({
          description:
            "Maximum number of generations in flight to this provider at once. Match a self-hosted server's capacity (e.g. a vLLM server's max_num_seqs) so parallel subagents queue instead of starving the server. Omit for unlimited.",
        }),
      }),
      [Schema.Record(Schema.String, Schema.Any)],
    ),
  ),
  models: Schema.optional(Schema.Record(Schema.String, Model)),
}).annotate({ identifier: "ProviderConfig" })
export type Info = Schema.Schema.Type<typeof Info>

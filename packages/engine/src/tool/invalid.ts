import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Invalid Tool",
        // Name the tool: this text is the model's only feedback, and it may
        // have several calls in flight when one of them is rejected.
        output: `The ${params.tool} tool was called with invalid arguments: ${params.error}`,
        metadata: {},
      }),
  }),
)

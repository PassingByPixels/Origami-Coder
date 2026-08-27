import { EventV2 } from "@origami/core/event"
import { Schema } from "effect"

export const MAX_OUTPUT_BYTES = 8_000

export const Event = {
  Updated: EventV2.define({
    type: "origami.shell.telemetry",
    schema: {
      sessionId: Schema.String,
      toolCallId: Schema.String,
      jobId: Schema.optional(Schema.String),
      state: Schema.Union([Schema.Literal("foreground"), Schema.Literal("background"), Schema.Literal("promoted")]),
      status: Schema.Union([
        Schema.Literal("running"),
        Schema.Literal("completed"),
        Schema.Literal("error"),
        Schema.Literal("cancelled"),
      ]),
      startedAt: Schema.Number,
      lastOutputAt: Schema.optional(Schema.Number),
      output: Schema.String,
      exit: Schema.optional(Schema.NullOr(Schema.Number)),
    },
  }),
}

export function boundedOutput(output: string) {
  const bytes = Buffer.byteLength(output, "utf-8")
  if (bytes <= MAX_OUTPUT_BYTES) return output
  const buffer = Buffer.from(output, "utf-8")
  let start = buffer.length - MAX_OUTPUT_BYTES
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
  return buffer.subarray(start).toString("utf-8")
}

export type State = "foreground" | "background" | "promoted"

export * as ShellTelemetry from "./shell-telemetry"

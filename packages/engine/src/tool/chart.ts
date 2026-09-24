import { Effect, Schema } from "effect"
import * as Tool from "./tool"

// Terse inline description: fold sessions run small local models that pay for
// every line of it out of their task context.

const types = ["bar", "line", "pie"] as const

type ChartType = (typeof types)[number]

/**
 * Flat on purpose, not a discriminated union: a oneOf/anyOf schema is the shape
 * models mis-emit most often, and the failure is silent. One flat struct always
 * round-trips; `execute` enforces which fields the chosen type needs.
 */
export const Parameters = Schema.Struct({
  type: Schema.Literals(types).annotate({ description: "bar, line or pie." }),
  title: Schema.optional(Schema.String).annotate({ description: "Title drawn above the chart." }),
  xLabels: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "bar and line only: one label per x position.",
  }),
  series: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String).annotate({ description: "Legend name for this series." }),
        data: Schema.Array(Schema.Number).annotate({ description: "One number per x position." }),
      }),
    ),
  ).annotate({ description: "REQUIRED for bar and line, ignored for pie. One entry per series." }),
  slices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        label: Schema.String.annotate({ description: "Slice label." }),
        value: Schema.Number.annotate({ description: "Slice size, zero or more." }),
      }),
    ),
  ).annotate({ description: "REQUIRED for pie, ignored for bar and line. One entry per slice." }),
})

const DESCRIPTION = [
  "Draw a chart in the user's chat: bar, line or pie.",
  "Use it instead of a table when the shape of the numbers is the point.",
  'bar and line need series, e.g. {"type":"bar","xLabels":["Q1","Q2"],"series":[{"name":"Sales","data":[3,5]}]}.',
  'pie needs slices, e.g. {"type":"pie","slices":[{"label":"Chrome","value":62}]}.',
].join(" ")

/** `ok` is the one status a client may trust: a chart the engine could not draw
 *  still completes the tool call, so the ACP status cannot separate them. */
type ChartMetadata = {
  ok: boolean
  type: ChartType
}

/** One valid call per type, short enough to paste, used in every refusal. */
const EXAMPLE: Record<ChartType, string> = {
  bar: '{"type":"bar","xLabels":["Q1","Q2"],"series":[{"name":"Sales","data":[3,5]}]}',
  line: '{"type":"line","xLabels":["Q1","Q2"],"series":[{"name":"Sales","data":[3,5]}]}',
  pie: '{"type":"pie","slices":[{"label":"Chrome","value":62}]}',
}

export const ChartTool = Tool.define(
  "chart",
  Effect.succeed({
    description: DESCRIPTION,
    // Every field but `type` is optional, so a misspelled key is dropped, decode
    // succeeds, and a chart draws with labels or a series missing under a green
    // tick. A refused call the model can retry beats a wrong picture.
    rejectUnknownKeys: true,
    parameters: Parameters,
    deferrable: true,
    execute: (params: Schema.Schema.Type<typeof Parameters>) => Effect.succeed(draw(params)),
  }),
)

/**
 * The rules below are the renderer's (webview/shared/chartBlock.ts parseSpec)
 * and must agree with it: every shape parseSpec rejects is refused here with the
 * field named, or a call answered ok gets silently dropped downstream.
 */
function draw(params: Schema.Schema.Type<typeof Parameters>): Tool.ExecuteResult<ChartMetadata> {
  if (params.type === "pie") {
    const slices = params.slices ?? []
    if (slices.length === 0) return refused(params.type, 'pie needs a non-empty "slices" list.')
    if (slices.some((slice) => slice.value < 0)) {
      return refused(params.type, 'every "slices" value must be zero or more.')
    }
    if (slices.every((slice) => slice.value === 0)) {
      return refused(params.type, 'at least one "slices" value must be above zero, or there is no pie to draw.')
    }
    return drawn(params.type, params.title, { type: params.type, title: params.title, slices })
  }

  const series = params.series ?? []
  if (series.length === 0) return refused(params.type, `${params.type} needs a non-empty "series" list.`)
  if (series.some((entry) => entry.data.length === 0)) {
    return refused(params.type, 'every "series" entry needs a non-empty "data" list of numbers.')
  }
  return drawn(params.type, params.title, {
    type: params.type,
    title: params.title,
    xLabels: params.xLabels,
    series,
  })
}

/** The output is the spec: the chat card feeds it straight back through the
 *  shared renderer, so it must stay the shape chartBlock.ts accepts. */
function drawn(type: ChartType, title: string | undefined, spec: object): Tool.ExecuteResult<ChartMetadata> {
  return {
    title: `chart ${type}${title ? `: ${title}` : ""}`,
    metadata: { ok: true, type },
    output: JSON.stringify(spec),
  }
}

/** A refusal the model can act on alone: the wrong field, then one valid call. */
function refused(type: ChartType, reason: string): Tool.ExecuteResult<ChartMetadata> {
  return {
    title: `chart ${type}: refused`,
    metadata: { ok: false, type },
    output: `Refused: ${reason} Call chart again with arguments shaped like ${EXAMPLE[type]}`,
  }
}

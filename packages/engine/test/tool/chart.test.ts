import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { ChartTool } from "../../src/tool/chart"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The failure this tool exists to end: charts shipped as a ```chart fence whose
// body had to be exact JSON, and a live session emitted YAML into it instead.
// parseSpec only ever calls JSON.parse, so every chart degraded to an anonymous
// code block and NOTHING said so. A tool call cannot degrade quietly: the shape
// is a schema, and a shape the renderer would drop comes back as a correction.

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

/** The registry as a given CLIENT sees it. The chart tool's reach is decided by
 *  ORIGAMI_CLIENT, so the client is the variable these cases turn on. */
const registryAs = (client: string) =>
  testEffect(
    LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
      [
        Config.node,
        TestConfig.layer({
          directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
        }),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ client })],
    ]),
  )

// "acp" is the VS Code shell, the one client that owns the renderer.
const withRegistry = registryAs("acp")

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_chart-test"),
  messageID: MessageID.make("msg_chart-test"),
  callID: "chart-call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const exec = (args: Tool.InferParameters<typeof ChartTool>) =>
  Effect.gen(function* () {
    const info = yield* ChartTool
    const tool = yield* info.init()
    return yield* tool.execute(args, ctx)
  })

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.chart", () => {
  it.instance("draws a bar chart as the spec the chat card renders", () =>
    Effect.gen(function* () {
      const result = yield* exec({
        type: "bar",
        title: "Revenue",
        xLabels: ["Q1", "Q2"],
        series: [{ name: "Sales", data: [3, 5] }],
      })

      // The output IS the renderer's input, so it is checked as parsed data,
      // not as a string: a card that cannot JSON.parse this draws nothing.
      expect(JSON.parse(result.output)).toEqual({
        type: "bar",
        title: "Revenue",
        xLabels: ["Q1", "Q2"],
        series: [{ name: "Sales", data: [3, 5] }],
      })
      expect(result.metadata).toMatchObject({ ok: true, type: "bar" })
      expect(result.title).toBe("chart bar: Revenue")
    }),
  )

  // The snake_case twin of the one field a chart can lose without failing.
  // `xLabels` is OPTIONAL, so a model sending `x_labels` used to have the key
  // dropped as an excess property and still get a drawn chart back, stamped
  // ok:true — with no labels on the x axis. That is worse than a refusal: a
  // WRONG picture that reads as a right one, and nothing invites a retry.
  //
  // The repair belongs to normalisation (tool/normalize.ts aliases each tool's
  // OWN parameter names, wired in at tool.ts's untyped->typed boundary), and
  // this asserts the OUTCOME for chart rather than that seam's mechanism: the
  // labels arrive, or the model is told. Never a silent unlabelled chart.
  it.instance("takes x_labels as xLabels instead of quietly drawing no labels", () =>
    Effect.gen(function* () {
      const result = yield* exec({
        type: "bar",
        title: "Revenue",
        x_labels: ["Q1", "Q2"],
        series: [{ name: "Sales", data: [3, 5] }],
      } as never)

      if (result.metadata.ok) {
        // The output IS the renderer's input, so the labels have to be in it.
        expect(
          JSON.parse(result.output).xLabels,
          "an ok:true chart that lost its x labels is the silent failure, wearing a green check",
        ).toEqual(["Q1", "Q2"])
      } else {
        // A refusal is an acceptable answer only if it NAMES the field, so the
        // model can fix the call from the message alone.
        expect(result.output).toContain("xLabels")
      }
    }),
  )

  // `x_labels` was the INSTANCE; this is the CLASS. An underscore is only one of
  // the ways a model renames a key — kebab, run-together and shouted spellings
  // are the same mistake, and each one used to be dropped as an excess property
  // and answered with a drawn, unlabelled, ok:true chart. The match is made on a
  // canonical form (separators stripped, case folded) against the names the tool
  // DECLARES, so one rule covers every spelling of the same rename.
  for (const spelling of ["xlabels", "x-labels", "X_Labels", "XLABELS"]) {
    it.instance(`takes ${spelling} as xLabels instead of quietly drawing no labels`, () =>
      Effect.gen(function* () {
        const result = yield* exec({
          type: "bar",
          [spelling]: ["Q1", "Q2"],
          series: [{ name: "Sales", data: [3, 5] }],
        } as never)

        expect(
          JSON.parse(result.output).xLabels,
          `${spelling} was dropped and the chart drew unlabelled under a green tick`,
        ).toEqual(["Q1", "Q2"])
      }),
    )
  }

  it.instance("draws a pie chart from slices alone", () =>
    Effect.gen(function* () {
      const result = yield* exec({ type: "pie", slices: [{ label: "Chrome", value: 62 }] })

      expect(JSON.parse(result.output)).toEqual({ type: "pie", slices: [{ label: "Chrome", value: 62 }] })
      expect(result.metadata).toMatchObject({ ok: true, type: "pie" })
    }),
  )

  it.instance("refuses bar and line with no series, naming the field and one valid call", () =>
    Effect.gen(function* () {
      for (const type of ["bar", "line"] as const) {
        const result = yield* exec({ type, xLabels: ["Q1"] })

        expect(result.metadata).toMatchObject({ ok: false, type })
        expect(result.output).toContain("series")
        // A correction is only a correction if the model can fix it from the
        // message alone, so the example must be a real, callable spec of the
        // type that was asked for - not the other branch's.
        const example = /shaped like (\{.*\})$/.exec(result.output)?.[1]
        expect(example, result.output).toBeDefined()
        expect(JSON.parse(example!)).toMatchObject({ type })
        const retry = yield* exec(JSON.parse(example!))
        expect(retry.metadata).toMatchObject({ ok: true, type })
      }
    }),
  )

  it.instance("refuses pie with no slices, naming the field and one valid call", () =>
    Effect.gen(function* () {
      const result = yield* exec({ type: "pie", title: "Share" })

      expect(result.metadata).toMatchObject({ ok: false, type: "pie" })
      expect(result.output).toContain("slices")
      const example = /shaped like (\{.*\})$/.exec(result.output)?.[1]
      expect(JSON.parse(example!)).toMatchObject({ type: "pie" })
      const retry = yield* exec(JSON.parse(example!))
      expect(retry.metadata).toMatchObject({ ok: true, type: "pie" })
    }),
  )

  // Everything below is a shape the RENDERER drops (chartBlock.ts parseSpec).
  // Answering any of them ok would put the silent failure back: a green tool
  // call with no chart under it.
  it.instance("refuses a series carrying no data points", () =>
    Effect.gen(function* () {
      const result = yield* exec({ type: "line", series: [{ name: "Sales", data: [] }] })

      expect(result.metadata).toMatchObject({ ok: false, type: "line" })
      expect(result.output).toContain("data")
    }),
  )

  it.instance("refuses a pie whose slices are all zero, or negative", () =>
    Effect.gen(function* () {
      const zeroes = yield* exec({ type: "pie", slices: [{ label: "a", value: 0 }, { label: "b", value: 0 }] })
      const negative = yield* exec({ type: "pie", slices: [{ label: "a", value: -3 }] })

      expect(zeroes.metadata).toMatchObject({ ok: false })
      expect(negative.metadata).toMatchObject({ ok: false })
      expect(negative.output).toContain("zero or more")
    }),
  )

  it.instance("stamps a verdict on every path, so no answer is silent", () =>
    Effect.gen(function* () {
      const calls = [
        yield* exec({ type: "bar", series: [{ data: [1] }] }),
        yield* exec({ type: "bar" }),
        yield* exec({ type: "pie", slices: [{ label: "a", value: 1 }] }),
        yield* exec({ type: "pie" }),
      ]

      expect(calls.map((call) => call.metadata.ok)).toEqual([true, false, true, false])
      expect(calls.every((call) => typeof call.metadata.type === "string")).toBe(true)
    }),
  )
})

describe("tool.chart registration", () => {
  withRegistry.instance("is offered to the model as a FLAT schema, never a oneOf union", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      expect(yield* registry.ids()).toContain("chart")

      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const chart = tools.find((tool) => tool.id === "chart")
      if (!chart) throw new Error("chart tool was not offered")

      const schema = ToolJsonSchema.fromTool(chart as Tool.Def)
      // A discriminated union is the shape models mis-emit; the whole point of
      // the flat struct is that the wire schema stays one object with `type`
      // plus the branch fields beside it.
      expect(schema.oneOf).toBeUndefined()
      expect(schema.anyOf).toBeUndefined()
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["series", "slices", "title", "type", "xLabels"])
      expect(schema.required).toEqual(["type"])
      expect(chart.description).toContain("pie")
    }),
  )
})

// A tool offered where nothing can draw its output is the silent failure this
// tool exists to end, relocated: the call completes ok:true, no picture appears,
// and nothing says so. The renderer (renderChartBlock) lives in exactly one
// place — packages/vscode/webview/shared/chartBlock.ts — and only the VS Code
// shell mounts it, over `origami acp`. packages/tui and packages/ui carry no
// chart code, so on every other client the tool must not be on the menu at all.
describe("tool.chart reach — offered only where a chart can be drawn", () => {
  registryAs("acp").instance("is offered to the ACP client, which owns the renderer", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("chart")
    }),
  )

  // "cli" is also the DEFAULT (Flag.ORIGAMI_CLIENT falls back to it), so this
  // is the plain TUI/CLI session as well as an unset environment.
  for (const client of ["cli", "app", "desktop"]) {
    registryAs(client).instance(`is withheld from ${client}, which has no renderer`, () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids, `a ${client} session cannot draw a chart, so it must not be offered one`).not.toContain("chart")
        // The gate must be the chart's alone — withholding it from a client is
        // not licence to thin that client's toolset.
        expect(ids).toContain("browser")
        expect(ids).toContain("todowrite")
      }),
    )
  }
})

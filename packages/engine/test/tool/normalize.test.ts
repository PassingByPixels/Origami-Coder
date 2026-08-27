import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { jsonSchema, streamText, tool as aiTool } from "ai"
import { MockLanguageModelV3, simulateReadableStream } from "ai/test"
import { WriteTool, Parameters as WriteParameters } from "../../src/tool/write"
import { EditTool, Parameters as EditParameters } from "../../src/tool/edit"
import { ChartTool, Parameters as ChartParameters } from "../../src/tool/chart"
import { parameterSchema as shellParameterSchema } from "../../src/tool/shell/prompt"
import { ToolNormalize } from "@/tool/normalize"
import { ToolJsonSchema } from "@/tool/json-schema"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@origami/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test-normalize-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

// The wrap erases the parameter type on purpose; these tests exist to push
// payloads the schema rejects, so they go in untyped.
const call = Effect.fn("NormalizeTest.call")(function* (tool: { execute: unknown }, args: unknown) {
  const execute = tool.execute as (args: unknown, ctx: Tool.Context) => Effect.Effect<{ output: string }>
  return yield* execute(args, ctx)
})

const writeSchema = ToolJsonSchema.fromSchema(WriteParameters)
const editSchema = ToolJsonSchema.fromSchema(EditParameters)
const shellSchema = ToolJsonSchema.fromSchema(shellParameterSchema())
const chartSchema = ToolJsonSchema.fromSchema(ChartParameters)

describe("normalizeToolInput", () => {
  test("valid input is returned untouched", () => {
    const args = { filePath: "/tmp/a.txt", content: "hello" }
    expect(ToolNormalize.normalizeToolInput(args)).toBe(args)
    expect(ToolNormalize.normalizeToolInput(args)).toEqual({ filePath: "/tmp/a.txt", content: "hello" })
  })

  test("unwraps a sole-key arguments wrapper", () => {
    expect(ToolNormalize.normalizeToolInput({ arguments: { filePath: "/tmp/a.txt", content: "hi" } })).toEqual({
      filePath: "/tmp/a.txt",
      content: "hi",
    })
  })

  test("unwraps the doubly nested arguments wrapper", () => {
    expect(
      ToolNormalize.normalizeToolInput({ arguments: { arguments: { filePath: "/tmp/a.txt", content: "hi" } } }),
    ).toEqual({ filePath: "/tmp/a.txt", content: "hi" })
  })

  test("leaves an arguments key that has siblings alone", () => {
    const args = { arguments: { filePath: "/tmp/a.txt" }, content: "hi" }
    expect(ToolNormalize.normalizeToolInput(args)).toBe(args)
  })

  test("leaves an arguments key whose value is not an object alone", () => {
    const args = { arguments: "--verbose" }
    expect(ToolNormalize.normalizeToolInput(args)).toBe(args)
  })

  test("parses a JSON-string payload where an object was expected", () => {
    expect(ToolNormalize.normalizeToolInput('{"filePath":"/tmp/a.txt","content":"hi"}')).toEqual({
      filePath: "/tmp/a.txt",
      content: "hi",
    })
  })

  test("returns an unparseable string unchanged", () => {
    const args = '{"command":"echo hi'
    expect(ToolNormalize.normalizeToolInput(args)).toBe(args)
  })

  test("maps snake_case to the camelCase key the tool declares", () => {
    expect(
      ToolNormalize.normalizeToolInput(
        {
          file_path: "/tmp/a.txt",
          old_string: "a",
          new_string: "b",
          replace_all: true,
        },
        { keys: ToolNormalize.parameterKeys(editSchema) },
      ),
    ).toEqual({ filePath: "/tmp/a.txt", oldString: "a", newString: "b", replaceAll: true })
  })

  // snake_case is one spelling of a rename, not the only one. The match is made
  // on a canonical form — separators dropped, case folded — against the names
  // the TOOL declares, so kebab, run-together and shouted spellings all land on
  // the same declared key by the same rule.
  test("maps any separator or case spelling onto the key the tool declares", () => {
    for (const spelling of ["x_labels", "x-labels", "xlabels", "X Labels", "XLABELS"]) {
      expect(
        ToolNormalize.normalizeToolInput({ [spelling]: ["Q1"] }, { keys: ToolNormalize.parameterKeys(chartSchema) }),
        spelling,
      ).toEqual({ xLabels: ["Q1"] })
    }
  })

  // Canonical matching must stay a RENAME, never a merge: two sent keys reducing
  // to the same declared name would silently overwrite one another, and which
  // one survived would be an accident of key order.
  test("aliases nothing when two sent keys claim the same declared name", () => {
    const args = { x_labels: ["a"], "x-labels": ["b"] }
    expect(ToolNormalize.normalizeToolInput(args, { keys: ["xLabels"] })).toBe(args)
  })

  // The mirror of it: a canonical form two DECLARED names share names no single
  // target, so it aliases nothing rather than picking one.
  test("aliases nothing when two declared keys share a canonical form", () => {
    const args = { x_labels: ["a"] }
    expect(ToolNormalize.normalizeToolInput(args, { keys: ["xLabels", "xlabels"] })).toBe(args)
  })

  test("keeps the camelCase key when the model sends both spellings", () => {
    expect(
      ToolNormalize.normalizeToolInput(
        { filePath: "/real.txt", file_path: "/decoy.txt" },
        { keys: ToolNormalize.parameterKeys(editSchema) },
      ),
    ).toEqual({
      filePath: "/real.txt",
      file_path: "/decoy.txt",
    })
  })

  // No key list means no knowledge of the tool, and a rename made without that
  // knowledge is how one tool ends up wearing another tool's parameter names.
  test("aliases nothing when the caller declares no keys", () => {
    const args = { file_path: "/tmp/a.txt", x_labels: ["Q1"] }
    expect(ToolNormalize.normalizeToolInput(args)).toBe(args)
  })

  test("only aliases keys the tool declares", () => {
    const args = { some_other: 1 }
    expect(ToolNormalize.normalizeToolInput(args)).toBe(args)
    expect(ToolNormalize.normalizeToolInput(args, { keys: ["someOther"] })).toEqual({ someOther: 1 })
  })

  // The task tool really declares `subagent_type` / `task_id`. A blanket
  // snake_case-to-camelCase rule would rename them out of existence.
  test("leaves snake_case keys a tool genuinely declares alone", () => {
    const args = { subagent_type: "general", task_id: "t1" }
    expect(ToolNormalize.normalizeToolInput(args, { keys: ["subagent_type", "task_id"] })).toBe(args)
  })

  test("does not unwrap for a tool that declares an arguments parameter", () => {
    const args = { arguments: { raw: "text" } }
    expect(ToolNormalize.normalizeToolInput(args, { keys: ["arguments"] })).toBe(args)
  })

  // Built the way a real payload arrives, because an object literal would
  // treat `__proto__` as the prototype setter rather than a key.
  test("aliasing keeps every key it did not rename, including __proto__", () => {
    const args: unknown = JSON.parse('{"file_path":"/tmp/a.txt","__proto__":"keep"}')
    const result = ToolNormalize.normalizeToolInput(args, {
      keys: ToolNormalize.parameterKeys(writeSchema),
    }) as Record<string, unknown>
    expect(Object.hasOwn(result, "__proto__")).toBe(true)
    expect(result["filePath"]).toBe("/tmp/a.txt")
  })

  test("non-object input is returned unchanged", () => {
    expect(ToolNormalize.normalizeToolInput(null)).toBe(null)
    expect(ToolNormalize.normalizeToolInput(undefined)).toBe(undefined)
    expect(ToolNormalize.normalizeToolInput(42)).toBe(42)
    const list = [{ file_path: "/tmp/a.txt" }]
    expect(ToolNormalize.normalizeToolInput(list)).toBe(list)
  })
})

describe("unrecognisedKeys", () => {
  test("names the top-level keys the tool does not declare", () => {
    expect(ToolNormalize.unrecognisedKeys({ type: "bar", labels: ["Q1"] }, ["type", "xLabels"])).toEqual(["labels"])
  })

  // An exotic schema the converter cannot handle degrades to no keys at all
  // (tool.ts). Judged against that empty list every key looks unrecognised, so
  // the tool that opted in would refuse EVERY call — the schema being
  // unreadable is not the model's mistake.
  test("judges nothing when the tool's own keys could not be read", () => {
    expect(ToolNormalize.unrecognisedKeys({ type: "bar", labels: ["Q1"] }, [])).toEqual([])
  })

  test("judges nothing when the payload is not an object", () => {
    expect(ToolNormalize.unrecognisedKeys('{"type":"bar"', ["type"])).toEqual([])
    expect(ToolNormalize.unrecognisedKeys(null, ["type"])).toEqual([])
  })
})

describe("parameterKeys", () => {
  test("reads the tool's own top-level parameter names", () => {
    expect(ToolNormalize.parameterKeys(writeSchema)).toEqual(["content", "filePath"])
    expect(ToolNormalize.parameterKeys(chartSchema)).toContain("xLabels")
    // No edit key belongs to bash; a fixed alias list would hand it some anyway.
    expect(ToolNormalize.parameterKeys(shellSchema)).not.toContain("filePath")
  })

  test("returns nothing describable for a schema with no properties", () => {
    expect(ToolNormalize.parameterKeys(undefined)).toEqual([])
    expect(ToolNormalize.parameterKeys({ type: "string" })).toEqual([])
  })
})

/**
 * The premise the tool wrap rests on, measured against the real ai package in
 * this worktree rather than assumed. session/tools.ts builds every tool as
 * `tool({ inputSchema: jsonSchema(plainObject) })`, and that helper leaves
 * `validate` undefined, so the SDK checks JSON SYNTAX and nothing else: shape
 * errors run straight into execute. That is why shape repair belongs in
 * Tool.wrap, and why session/llm.ts's repair hook forwards the SDK's own
 * message instead of shape advice. If a test here fails, the premise moved and
 * both comments have to be rewritten before the code is.
 */
describe("ai SDK tool-call validation", () => {
  const seamA = async (input: string) => {
    const seen: { hits: number; error?: string; executed?: unknown } = { hits: 0 }
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "call-1", toolName: "write", input },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      },
    ]
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) })
    const result = streamText({
      model,
      prompt: "go",
      maxRetries: 0,
      tools: {
        write: aiTool({
          description: "write a file",
          inputSchema: jsonSchema(writeSchema),
          execute: async (args: unknown) => {
            seen.executed = args
            return "ok"
          },
        }),
      },
      async experimental_repairToolCall(failed) {
        seen.hits++
        seen.error = failed.error.message
        return null
      },
      onError() {},
    })
    for await (const _ of result.fullStream) {
    }
    return seen
  }

  test("jsonSchema() carries no validate function", () => {
    expect(jsonSchema(writeSchema).validate).toBeUndefined()
  })

  test("a wrapped payload is never seen by the repair hook", async () => {
    const seen = await seamA(JSON.stringify({ arguments: { filePath: "/a.txt", content: "hi" } }))
    expect(seen.hits).toBe(0)
    expect(seen.executed).toEqual({ arguments: { filePath: "/a.txt", content: "hi" } })
  })

  test("a snake_case payload is never seen by the repair hook", async () => {
    const seen = await seamA(JSON.stringify({ file_path: "/a.txt", content: "hi" }))
    expect(seen.hits).toBe(0)
    expect(seen.executed).toEqual({ file_path: "/a.txt", content: "hi" })
  })

  test("a payload missing a required key is never seen by the repair hook", async () => {
    const seen = await seamA(JSON.stringify({ filePath: "/a.txt" }))
    expect(seen.hits).toBe(0)
    expect(seen.executed).toEqual({ filePath: "/a.txt" })
  })

  // The one payload the hook does get. Its diagnosis is about syntax, so the
  // hook must pass that message on: telling this model to unwrap an "arguments"
  // object or rename a key would be advice for a mistake it did not make.
  test("only unparseable JSON reaches the repair hook, with a syntax diagnosis", async () => {
    const seen = await seamA('{"command":"rm -rf /tmp/build && echo do')
    expect(seen.hits).toBe(1)
    expect(seen.executed).toBeUndefined()
    expect(seen.error).toContain("JSON parsing failed")
    expect(seen.error).toContain("Unterminated string")
  })
})

describe("tool wrap normalisation", () => {
  it.instance("wrapped write payload reaches the tool and writes the file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "wrapped.txt")
      const tool = yield* (yield* WriteTool).init()

      yield* call(tool, { arguments: { filePath, content: "wrapped body" } })

      expect(yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))).toBe("wrapped body")
    }),
  )

  it.instance("doubly wrapped write payload reaches the tool and writes the file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "double.txt")
      const tool = yield* (yield* WriteTool).init()

      yield* call(tool, { arguments: { arguments: { filePath, content: "double body" } } })

      expect(yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))).toBe("double body")
    }),
  )

  it.instance("snake_case payload reaches the edit tool", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "snake.txt")
      yield* Effect.promise(() => fs.writeFile(filePath, "before", "utf-8"))
      const tool = yield* (yield* EditTool).init()

      yield* call(tool, { file_path: filePath, old_string: "before", new_string: "after" })

      expect(yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))).toBe("after")
    }),
  )

  it.instance("keeps filePath when the model also sends file_path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const real = path.join(test.directory, "real.txt")
      const decoy = path.join(test.directory, "decoy.txt")
      yield* Effect.promise(() => fs.writeFile(real, "before", "utf-8"))
      const tool = yield* (yield* EditTool).init()

      yield* call(tool, { filePath: real, file_path: decoy, oldString: "before", newString: "after" })

      expect(yield* Effect.promise(() => fs.readFile(real, "utf-8"))).toBe("after")
      expect(
        yield* Effect.promise(() =>
          fs.access(decoy).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )

  it.instance("an unrescuable call names the tool and the expected flat keys", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* WriteTool).init()

      const exit = yield* call(tool, { path: "/tmp/a.txt", body: "hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
      const message = (error as Tool.InvalidArgumentsError).message
      expect(message).toContain("write tool")
      expect(message).toContain("flat top-level JSON keys")
      expect(message).toContain("filePath")
      expect(message).toContain("content")
      expect(message).toContain("Unrecognised keys: path, body")
    }),
  )

  // Missing and unrecognised are counted on what reached the DECODER, not on the
  // payload as sent. `file_path` was rescued into the key write declares, so
  // listing it as unrecognised — and `filePath` as missing — tells the model to
  // fix the one thing it got right. Only `body` is unrecognised, only `content`
  // is missing.
  it.instance("a rescued key is reported as neither missing nor unrecognised", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* WriteTool).init()

      const exit = yield* call(tool, { file_path: "/tmp/a.txt", body: "hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      const message = (error as Tool.InvalidArgumentsError).message
      expect(message).toContain("Missing required keys: content.")
      expect(message).toContain("Unrecognised keys: body.")
    }),
  )

  // The wrapper is GONE by the time the decoder runs, so a sentence built from
  // the payload as sent names `arguments` unrecognised and both real keys
  // missing — when the only fault is content's type, which Effect's own prefix
  // already names. Nothing about the shape is wrong any more.
  it.instance("an unwrapped payload is judged on what the decoder received", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* WriteTool).init()

      const exit = yield* call(tool, { arguments: { filePath: "/tmp/a.txt", content: 123 } }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      const message = (error as Tool.InvalidArgumentsError).message
      expect(message, "the wrapper was removed; nothing is missing and nothing is unrecognised").not.toContain(
        "Missing required keys",
      )
      expect(message).not.toContain("Unrecognised keys")
      expect(message).toContain("content")
    }),
  )

  // Same rule, the other repair: a JSON STRING is not a record, so a sentence
  // built from the payload as sent sees no keys at all and tells a model that
  // sent both keys correctly that both are missing.
  it.instance("a JSON-string payload is judged on the object it parsed to", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* WriteTool).init()

      const exit = yield* call(tool, '{"filePath":"/tmp/a.txt","content":123}').pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      const message = (error as Tool.InvalidArgumentsError).message
      expect(message, "both keys were sent under their real names").not.toContain("Missing required keys")
      expect(message).not.toContain("Unrecognised keys")
    }),
  )

  it.instance("a plain valid payload still reaches the tool untouched", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "plain.txt")
      const tool = yield* (yield* WriteTool).init()

      yield* call(tool, { filePath, content: "plain body" })

      expect(yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))).toBe("plain body")
    }),
  )

  // The chart tool declares xLabels, so x_labels is its to repair. Aliased
  // against a fixed edit/write key list instead, x_labels survived, the decoder
  // dropped it as an excess property, and the chart drew unlabelled with a
  // success tick — the silent failure the tool exists to end.
  it.instance("chart x_labels reaches the chart tool as xLabels", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* ChartTool).init()

      const result = yield* call(tool, {
        type: "bar",
        x_labels: ["Q1", "Q2"],
        series: [{ name: "Sales", data: [3, 5] }],
      })

      expect(JSON.parse(result.output).xLabels).toEqual(["Q1", "Q2"])
    }),
  )

  // Aliasing bounded by the tool's own parameters: chart declares no filePath to
  // rename anything into, so `file_path` must still be `file_path` when the
  // decoder sees it. That is asserted on the KEY LIST the guard reports, which
  // is read off the normalised record — under a fixed alias list `file_path`
  // becomes `filePath` and this case fails, which is what makes it a test.
  it.instance("a tool is never handed another tool's parameter names", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* ChartTool).init()

      const exit = yield* call(tool, {
        type: "bar",
        series: [{ name: "Sales", data: [3, 5] }],
        file_path: "/tmp/a.txt",
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      const message = (error as Tool.InvalidArgumentsError).message
      expect(message).toContain("Unrecognised keys: file_path.")
      expect(message, "the decoder was handed a key the model never typed").not.toContain("filePath")
    }),
  )

  // Round 2 closed the x_labels INSTANCE and left the CLASS open. chart marks
  // every field but `type` optional, so the decoder DROPS an unrecognised key
  // and SUCCEEDS — which means the corrective message, built inside the
  // decode-failure branch, could never fire for it. Any misspelling chart's
  // canonical alias rule cannot place therefore drew a wrong-but-green chart.
  // A refused call is better than a picture that reads as right and is not.
  it.instance("chart refuses a top-level key it does not understand", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* ChartTool).init()

      const exit = yield* call(tool, {
        type: "bar",
        labels: ["Q1", "Q2"],
        series: [{ name: "Sales", data: [3, 5] }],
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit), "an unrecognised key drew a chart without it, stamped ok").toBe(true)
      if (!Exit.isFailure(exit)) return

      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      const message = (error as Tool.InvalidArgumentsError).message
      expect(message).toContain("Unrecognised keys: labels.")
      expect(message, "a refusal has to name the key the model probably meant").toContain(
        "Did you mean xLabels instead of labels",
      )
    }),
  )

  // Rejecting an excess key is CHART's choice, not a new rule for all 30 tools:
  // chart is the tool whose optional fields make the loss invisible. write keeps
  // the decoder's default, so a stray key still writes the file.
  it.instance("a tool that has not opted in still ignores an excess key", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "excess.txt")
      const tool = yield* (yield* WriteTool).init()

      yield* call(tool, { filePath, content: "excess body", encoding: "utf-8" })

      expect(yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))).toBe("excess body")
    }),
  )
})

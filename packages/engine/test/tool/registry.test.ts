import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Layer, Result, Schema } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"

import { ToolJsonSchema } from "@/tool/json-schema"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { MCP } from "@/mcp"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/client"
// The Tools pane's scaffold text, imported from the SAME module the pane
// writes from. Pure — no `vscode` import, no I/O (see its header) — so an
// engine test can hold it against the loader that has to accept it.
import { toolTemplate } from "../../../vscode/src/dashboard/toolScaffold"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
})

// Fake Plugin.Service that returns a single plugin whose `tool` map contains
// one definition with `args: undefined`. Used to exercise the plugin entry
// point of `fromPlugin` for the #27451 / #27630 regression.
const brokenPluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            broken_plugin_tool: {
              description: "plugin tool with missing args",
              args: undefined as unknown as Record<string, never>,
              execute: async () => "ok",
            },
          },
        },
      ]),
  }),
)

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  [Config.node, configLayer],
  [RuntimeFlags.node, RuntimeFlags.layer()],
] as const

const it = testEffect(LayerNode.compile(root, replacements))
const withCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () =>
          Effect.succeed({
            weather_current: {
              def: {
                name: "current",
                description: "current weather",
                inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              } as MCPToolDef,
              client: {} as MCP.McpTool["client"],
            },
          }),
        clients: () => Effect.succeed({ weather: {} as any }),
      }),
    ],
  ]),
)
const withEmptyCodeMode = testEffect(
  LayerNode.compile(root, [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        tools: () => Effect.succeed({}),
        clients: () => Effect.succeed({}),
      }),
    ],
  ]),
)
const withBrokenPlugin = testEffect(LayerNode.compile(root, [...replacements, [Plugin.node, brokenPluginLayer]]))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
    }),
  )

  it.instance("exposes the file, process and git_diff tools to the model", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const ids = tools.map((tool) => tool.id)

      expect(ids).toContain("file")
      expect(ids).toContain("process")
      expect(ids).toContain("git_diff")
      // The descriptions the model actually sees must be the .txt files, not empty strings.
      expect(tools.find((tool) => tool.id === "file")?.description).toContain("mkdir")
      expect(tools.find((tool) => tool.id === "process")?.description).toContain("cannot start, stop, signal or kill")
    }),
  )

  it.instance("exposes the whole Folds board, board_register and board_worktrees included", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const ids = tools.map((tool) => tool.id)

      for (const id of ["board_repos", "board_tickets", "board_create", "board_update"]) expect(ids).toContain(id)
      // The two that shell out to git — wired last, and the pair a model can
      // never call if the registry forgets them however green their own tests are.
      expect(ids).toContain("board_register")
      expect(ids).toContain("board_worktrees")
      // A tool the model can see but not understand is a tool it will not use.
      expect(tools.find((tool) => tool.id === "board_register")?.description).toContain("git repo root")
      expect(tools.find((tool) => tool.id === "board_worktrees")?.description).toContain("Read-only")
    }),
  )

  it.instance("does not expose execute unless code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("execute")
    }),
  )

  withCodeMode.instance("exposes execute when code mode is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = yield* registry.ids()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const execute = tools.find((tool) => tool.id === "execute")

      expect(ids).toContain("execute")
      expect(tools.map((tool) => tool.id)).toContain("execute")
      expect(execute?.description).toContain("tools.weather.current(input: {\n  city: string,\n})")
    }),
  )

  withEmptyCodeMode.instance("does not expose execute when code mode has no visible tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      expect(tools.map((tool) => tool.id)).not.toContain("execute")
    }),
  )

  it.instance("hides task background parameter unless experimental background subagents are enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )

  it.instance("loads tools from .origami/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const origami = path.join(test.directory, ".origami")
      const tool = path.join(origami, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  // t-kgtaac round 3: the Tools pane's copy-path button hands an agent this
  // exact path, and its source badge reads this exact tag — both come off
  // `Tool.Def` untouched, so a scan that finds the file but forgets to tag it
  // would read as "builtin" on the pane, silently hiding a real user file.
  it.instance("tags a .origami/tool file with source user-file and its absolute path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const origami = path.join(test.directory, ".origami")
      const tool = path.join(origami, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      const helloPath = path.join(tool, "hello.ts")
      yield* Effect.promise(() =>
        Bun.write(
          helloPath,
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((t) => t.id === "hello")
      if (!loaded) throw new Error("hello tool was not loaded")
      expect(loaded.source).toBe("user-file")
      expect(loaded.location).toBe(helloPath)

      // A builtin must not pick up a source/location — undefined reads as
      // "builtin" everywhere this is projected.
      const read = (yield* registry.all()).find((t) => t.id === "read")
      expect(read?.source).toBeUndefined()
      expect(read?.location).toBeUndefined()
    }),
  )

  it.instance("ignores non-tool exports in .origami/tool files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".origami", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "mixed.ts"),
          [
            "export const helper = 'not a tool'",
            "export default {",
            "  description: 'mixed tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("mixed")
      expect(ids).not.toContain("mixed_helper")
    }),
  )

  // Regression for #27451 / #27630: a custom tool that omits `args` must not
  // crash registry initialization with
  // `Object.entries requires that input parameter not be null or undefined`.
  // Pre-1.14.49 the code path was `z.object(def.args)`, and `z.object(undefined)`
  // silently produced an empty schema — so the tool registered as no-args.
  // Preserve that tolerance.
  it.instance("tolerates a custom tool exporting null/undefined args (no-args fallback)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".origami", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "noargs.ts"),
          [
            "export default {",
            "  description: 'tool with no args',",
            "  args: undefined,",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      // Built-in tools must still load — a single malformed custom tool must
      // not poison the whole registry.
      expect(ids).toContain("read")
      const loaded = (yield* registry.all()).find((t) => t.id === "noargs")
      if (!loaded) throw new Error("noargs tool was not loaded")
      expect(loaded.jsonSchema).toMatchObject({ type: "object", properties: {} })
    }),
  )

  // Same regression, plugin entry point. The original reports (#27451, #27630)
  // came in through `plugin.list()` — `oh-my-origami` was registering a tool
  // with `args: undefined` and crashing every message submit. The file-scan
  // and plugin-list loops both funnel through `fromPlugin`, but covering both
  // entry points means a future refactor that splits them won't silently lose
  // protection.
  withBrokenPlugin.instance("tolerates a plugin tool registered with null/undefined args", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("read")
      expect(ids).toContain("broken_plugin_tool")

      // Plugin-sourced tools are tagged "plugin", never "user-file" — they
      // have no `.origami/tool/*.ts` file of their own for the Tools pane to
      // point a copy-path button at.
      const loaded = (yield* registry.all()).find((t) => t.id === "broken_plugin_tool")
      expect(loaded?.source).toBe("plugin")
      expect(loaded?.location).toBeUndefined()
    }),
  )

  it.instance("loads tools from .origami/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const origami = path.join(test.directory, ".origami")
      const tools = path.join(origami, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads Zod-schema custom tools with JSON Schema and validation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".origami", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "sql.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'query database',",
            "  args: { query: tool.schema.string().describe('SQL query to execute') },",
            "  execute: async ({ query }) => query,",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "sql")
      if (!loaded) throw new Error("custom sql tool was not loaded")
      expect(loaded?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({ query: "select 1" }))).toBe(true)
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({}))).toBe(false)

      const agents = yield* Agent.Service
      const promptTools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const promptTool = promptTools.find((tool) => tool.id === "sql")
      if (!promptTool) throw new Error("custom sql tool was not returned for prompts")
      expect(ToolJsonSchema.fromTool(promptTool)).toMatchObject({
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
    }),
  )

  it.instance(
    "preserves Zod arg descriptions from older config-scoped plugin packages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const origami = path.join(test.directory, ".origami")
        const customTools = path.join(origami, "tools")
        const plugin = path.join(origami, "node_modules", "@origami", "plugin")
        yield* Effect.promise(() => fs.mkdir(path.join(plugin, "dist"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
        yield* Effect.promise(() =>
          fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(origami, "node_modules", "zod"), {
            dereference: true,
            recursive: true,
          }),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "package.json"),
            JSON.stringify({ name: "@origami/plugin", type: "module", exports: { ".": "./dist/index.js" } }),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "dist", "index.js"),
            [
              "import { z } from 'zod'",
              "export function tool(input) {",
              "  return input",
              "}",
              "tool.schema = z",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(customTools, "addition.ts"),
            [
              'import { tool } from "@origami/plugin"',
              "export default tool({",
              "  description: 'Use this tool to add two numbers and return their sum.',",
              "  args: {",
              "    left: tool.schema.number().describe('The first number to add'),",
              "    right: tool.schema.number().describe('The second number to add'),",
              "  },",
              "  execute: async (args) => `${args.left} + ${args.right} = ${args.left + args.right}`,",
              "})",
              "",
            ].join("\n"),
          ),
        )

        const registry = yield* ToolRegistry.Service
        const loaded = (yield* registry.all()).find((tool) => tool.id === "addition")
        if (!loaded) throw new Error("custom addition tool was not loaded")

        expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
          properties: {
            left: { type: "number", description: "The first number to add" },
            right: { type: "number", description: "The second number to add" },
          },
        })
      }),
    20_000,
  )

  it.instance("preserves attachments from structured custom tool results", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".origami", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "image.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'image tool',",
            "  args: {},",
            "  execute: async () => ({",
            "    output: 'here is an image',",
            "    attachments: [{ type: 'file', mime: 'image/png', filename: 'picture.png', url: 'data:image/png;base64,AAAA' }],",
            "  }),",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "image")
      if (!loaded) throw new Error("custom image tool was not loaded")
      const agents = yield* Agent.Service
      const result = yield* loaded.execute({}, {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        agent: (yield* agents.defaultInfo()).name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context)

      expect(result.output).toBe("here is an image")
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/png", filename: "picture.png", url: "data:image/png;base64,AAAA" },
      ])
    }),
  )

  it.instance("loads legacy JSON-schema-shaped custom tools with wire schema", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = path.join(test.directory, ".origami", "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "legacy.ts"),
          [
            "export default {",
            "  description: 'legacy schema tool',",
            "  args: { text: { type: 'string', description: 'Text to render' } },",
            "  execute: async ({ text }) => text,",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "legacy")
      if (!loaded) throw new Error("legacy custom tool was not loaded")
      expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
        type: "object",
        properties: {
          text: { type: "string", description: "Text to render" },
        },
        required: ["text"],
      })
    }),
  )

  // ── BROKEN USER TOOL FILE ─────────────────────────────────────────────────
  // The incident: the Tools pane's "New tool" box wrote its own scaffold to
  // `.origami/tool/ticket.ts`, and from that moment EVERY prompt in the
  // workspace failed with a redacted `Origami service failure` and the Tools
  // pane answered `Could not read the tool list`. One unresolvable import in
  // one user file took down `ToolRegistry.state`, and with it `all()`,
  // `ids()`, `tools()` and `SessionPrompt.run`.
  //
  // Three properties are load-bearing and each is asserted below: the healthy
  // tools SURVIVE, the prompt path still RESOLVES, and the bad file is
  // REPORTED by name rather than swallowed.

  /** The exact context shape a tool is executed with, as session/tools.ts builds it. */
  const execContext = (agent: string): Tool.Context => ({
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  })

  const healthy = [
    "export default {",
    "  description: 'a tool that loads',",
    "  args: {},",
    "  execute: async () => 'fine',",
    "}",
    "",
  ].join("\n")

  // THE TEMPLATE IS IMPORTED, NOT RETYPED. `toolTemplate` is the same constant
  // the Tools pane writes to disk, so if the scaffold ever goes back to
  // emitting an import that cannot resolve from a workspace folder, this test
  // fails instead of the user's whole workspace.
  it.instance("loads the Tools pane's own scaffold template unedited, and runs it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, ".origami", "tool")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "ticket.ts"), toolTemplate("ticket")))

      const registry = yield* ToolRegistry.Service
      // Nothing was skipped: the scaffold is loadable as written.
      expect(yield* registry.problems()).toEqual([])

      const loaded = (yield* registry.all()).find((t) => t.id === "ticket")
      if (!loaded) throw new Error("the scaffolded ticket tool was not registered")
      expect(loaded.source).toBe("user-file")

      // REGISTERED IS NOT ENOUGH — execute it, or "loads" only proves the glob ran.
      const agents = yield* Agent.Service
      const result = yield* loaded.execute({ subject: "the incident" }, execContext((yield* agents.defaultInfo()).name))
      expect(result.output).toContain("ticket ran against the incident")
    }),
  )

  it.instance("skips a user tool whose import cannot resolve, and names the file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, ".origami", "tool")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      // Verbatim the first line the scaffold used to write. `@origami/plugin`
      // is workspace-internal and unpublished, and the engine no longer tries
      // to npm-install it into `.origami/` (that add always 404'd and took the
      // directory's real dependencies down with it — config.ts's
      // `waitForDependencies` note), so this specifier does not resolve unless
      // the user puts the package there by hand. The test above proves that
      // manual convention still loads; this one proves the far commoner case
      // — a file importing a package that is simply not there — is contained.
      const broken = path.join(dir, "ticket.ts")
      yield* Effect.promise(() =>
        Bun.write(
          broken,
          [
            'import { tool } from "@origami/plugin"',
            "export default tool({ description: 'x', args: {}, execute: async () => 'x' })",
            "",
          ].join("\n"),
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(dir, "healthy.ts"), healthy))

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("read") // builtins survive
      expect(ids).toContain("healthy") // the OTHER user file survives
      expect(ids).not.toContain("ticket") // only the bad one is dropped

      // The prompt path itself. `registry.tools(...)` is the exact call
      // session/tools.ts:120 makes inside `SessionTools.resolve` — the frame
      // the incident stack died in on its way to `SessionPrompt.run`.
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      expect(tools.map((tool) => tool.id)).toContain("healthy")

      // Surfaced, with the path — this is what the Tools pane renders, and a
      // filename is not a secret worth redacting.
      const problems = yield* registry.problems()
      expect(problems).toHaveLength(1)
      expect(problems[0]!.file).toBe(broken)
      expect(problems[0]!.message).toContain("@origami/plugin")
    }),
  )

  // Not just a bad specifier: a module whose TOP LEVEL throws rejects the same
  // dynamic import and must take the same skip-and-surface path. Covered
  // separately because a catch written narrowly around resolution would pass
  // the test above and still let this one kill the registry.
  it.instance("contains a user tool that throws at module init", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, ".origami", "tool")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      const exploding = path.join(dir, "exploding.ts")
      yield* Effect.promise(() =>
        Bun.write(
          exploding,
          [
            "throw new Error('boom at module init')",
            "export default { description: 'never', args: {}, execute: async () => 'never' }",
            "",
          ].join("\n"),
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(dir, "healthy.ts"), healthy))

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("read")
      expect(ids).toContain("healthy")
      expect(ids).not.toContain("exploding")

      const problems = yield* registry.problems()
      expect(problems).toHaveLength(1)
      expect(problems[0]!.file).toBe(exploding)
      expect(problems[0]!.message).toContain("boom at module init")
    }),
  )

  it.instance("reports no problems when every user tool loads", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, ".origami", "tool")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "healthy.ts"), healthy))

      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("healthy")
      expect(yield* registry.problems()).toEqual([])
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const origami = path.join(test.directory, ".origami")
      const tools = path.join(origami, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(origami, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@origami/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(origami, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@origami/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(origami, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )
})

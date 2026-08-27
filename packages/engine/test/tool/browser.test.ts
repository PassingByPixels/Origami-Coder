import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Wildcard } from "@origami/core/util/wildcard"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { toToolKind } from "@/acp/tool"
import { permissionTitle } from "@/acp/permission"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { BrowserBridge } from "@/browser/bridge"
import { BrowserTool } from "../../src/tool/browser"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The browser tool holds no service of its own: the stack is only what the
// Tool.define wrapper needs (Truncate + Agent). The client half is the module
// bridge, which each test installs by hand.
const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

// A second harness, over the REAL registry, so "the model is offered this tool"
// is checked on the surface that offers it rather than inferred from the import.
const withRegistry = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

/**
 * A tool context that records every permission ask, and appends to a shared
 * trace so a test can prove the ask happened BEFORE the browser was driven.
 */
function makeCtx(trace: string[] = [], ask?: (request: Ask) => Effect.Effect<void>) {
  const asks: Ask[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_browser-test"),
    messageID: MessageID.make("msg_browser-test"),
    callID: "browser-call",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.suspend(() => {
        asks.push(request)
        trace.push("ask")
        return ask ? ask(request) : Effect.void
      }),
  }
  return { ctx, asks }
}

/** Install a bridge handler that records what the tool sent, and answers with `reply`. */
function useHandler(reply: BrowserBridge.Response, trace: string[] = []) {
  const calls: BrowserBridge.Request[] = []
  BrowserBridge.register(async (request) => {
    calls.push(request)
    trace.push("bridge")
    return reply
  })
  return calls
}

const exec = (args: Tool.InferParameters<typeof BrowserTool>, ctx: Tool.Context) =>
  Effect.gen(function* () {
    const info = yield* BrowserTool
    const tool = yield* info.init()
    return yield* tool.execute(args, ctx)
  })

beforeEach(() => BrowserBridge.register(undefined))
afterEach(async () => {
  BrowserBridge.register(undefined)
  await disposeAllInstances()
})

describe("tool.browser", () => {
  it.instance("explains the missing VS Code client instead of failing the call", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const result = yield* exec({ action: "read" }, ctx)
      expect(result.output).toBe(BrowserBridge.UNAVAILABLE)
      expect(result.output).toContain("VS Code")
      expect(result.attachments).toBeUndefined()
      // The call COMPLETES, so the client can only tell success from failure by
      // this flag - the title and the prose are not a status.
      expect(result.metadata).toMatchObject({ ok: false })
    }),
  )

  it.instance("returns a screenshot as an image attachment the model can view", () =>
    Effect.gen(function* () {
      const imageBase64 = Buffer.from([137, 80, 78, 71]).toString("base64")
      useHandler({ ok: true, url: "https://example.com/app", imageBase64, imageMime: "image/jpeg" })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "screenshot" }, ctx)

      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      expect(result.attachments?.[0].url).toBe(`data:image/jpeg;base64,${imageBase64}`)
      expect(result.output).toContain("https://example.com/app")
    }),
  )

  it.instance("assumes png when the client names no image type", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, url: "https://example.com", imageBase64: "AAAA" })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "screenshot" }, ctx)

      expect(result.attachments?.[0].mime).toBe("image/png")
      expect(result.attachments?.[0].url).toBe("data:image/png;base64,AAAA")
    }),
  )

  it.instance("does not invent an attachment when a screenshot comes back empty", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, url: "https://example.com" })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "screenshot" }, ctx)

      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("no image")
    }),
  )

  it.instance("sends a screenshot request carrying nothing the client cannot use", () =>
    Effect.gen(function* () {
      // VS Code's screenshot_page takes a pageId and an optional element - it
      // has no whole-page capture at all. The tool used to offer the model a
      // `fullPage` flag and put it on the wire, which was a knob wired to
      // nothing: the client dropped it and the model was told it had worked.
      const calls = useHandler({ ok: true, url: "https://example.com/app", imageBase64: "AAAA" })
      const { ctx } = makeCtx()

      yield* exec({ action: "screenshot" }, ctx)

      expect(calls[0]).toEqual({ action: "screenshot" })
    }),
  )

  it.instance("asks permission before it opens the page", () =>
    Effect.gen(function* () {
      const trace: string[] = []
      const calls = useHandler({ ok: true, url: "https://example.com/app" }, trace)
      const { ctx, asks } = makeCtx(trace)

      const result = yield* exec({ action: "open", url: "https://example.com/app" }, ctx)

      expect(trace).toEqual(["ask", "bridge"])
      expect(asks.length).toBe(1)
      // `always` is the HOST, not "*": one Always answer covers that site and
      // leaves every other site still gated.
      expect(asks[0]).toEqual({
        permission: "browser",
        patterns: ["example.com"],
        always: ["example.com"],
        metadata: { action: "open", url: "https://example.com/app" },
      })
      expect(calls[0]).toEqual({ action: "open", url: "https://example.com/app" })
      expect(result.output).toContain("Opened https://example.com/app")
      expect(result.metadata).toMatchObject({ ok: true, action: "open", url: "https://example.com/app" })
    }),
  )

  it.instance("gates a page interaction before it reaches the browser", () =>
    Effect.gen(function* () {
      const trace: string[] = []
      useHandler({ ok: true, url: "https://bank.example", pageText: "balance" }, trace)
      const { ctx, asks } = makeCtx(trace)

      yield* exec({ action: "read" }, ctx)

      // The page already open may be authenticated, so reading it costs an
      // approval - and the ask happens BEFORE the bridge sees the request.
      expect(trace).toEqual(["ask", "bridge"])
      expect(asks[0]).toEqual({
        permission: "browser",
        patterns: ["page"],
        always: ["page"],
        metadata: { action: "read" },
      })
    }),
  )

  it.instance("never reads the open page when the page gate is denied", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true, pageText: "secret" })
      const { ctx } = makeCtx([], () => Effect.die(new Error("permission rejected")))

      const exit = yield* exec({ action: "screenshot" }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls.length).toBe(0)
    }),
  )

  it.instance("gates every page-driving action, not just the one that reads text", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, url: "https://example.com" })
      const { ctx, asks } = makeCtx()

      yield* exec({ action: "screenshot" }, ctx)
      yield* exec({ action: "click", selector: "#go" }, ctx)
      yield* exec({ action: "type", selector: "#q", text: "hi" }, ctx)

      expect(asks.map((ask) => ask.metadata)).toEqual([
        { action: "screenshot" },
        { action: "click" },
        { action: "type" },
      ])
      expect(asks.every((ask) => ask.always[0] === "page")).toBe(true)
    }),
  )

  it.instance("never reaches the browser when the permission ask is denied", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true, url: "https://example.com" })
      const { ctx } = makeCtx([], () => Effect.die(new Error("permission rejected")))

      const exit = yield* exec({ action: "navigate", url: "https://example.com" }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls.length).toBe(0)
    }),
  )

  it.instance("keeps an Always answer to one site from covering every other site", () =>
    Effect.gen(function* () {
      // The consequence the ask shape decides, checked with the matcher the
      // permission service itself uses on a saved "always" rule. With always:["*"]
      // the second expectation was false: one Always click opened every host.
      useHandler({ ok: true })
      const { ctx, asks } = makeCtx()

      yield* exec({ action: "open", url: "https://trusted.example/app" }, ctx)
      yield* exec({ action: "open", url: "https://evil.test/steal" }, ctx)

      const savedByAlways = asks[0]?.always ?? []
      const allows = (pattern: string) => savedByAlways.some((saved) => Wildcard.match(pattern, saved))
      expect(allows(asks[0]?.patterns[0] ?? "")).toBe(true)
      expect(allows(asks[1]?.patterns[0] ?? "")).toBe(false)
    }),
  )

  it.instance("lets one Always answer cover the whole site it was given for", () =>
    Effect.gen(function* () {
      useHandler({ ok: true })
      const { ctx, asks } = makeCtx()

      yield* exec({ action: "open", url: "https://trusted.example/app" }, ctx)
      yield* exec({ action: "navigate", url: "https://trusted.example/other/page" }, ctx)

      const savedByAlways = asks[0]?.always ?? []
      expect(savedByAlways.some((saved) => Wildcard.match(asks[1]?.patterns[0] ?? "", saved))).toBe(true)
    }),
  )

  it.instance("gates a bare local path on the path itself, not on a drive-letter host", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, url: "C:/tmp/page.html" })
      const { ctx, asks } = makeCtx()

      yield* exec({ action: "open", url: "C:/tmp/page.html" }, ctx)

      expect(asks[0]?.patterns).toEqual(["C:/tmp/page.html"])
    }),
  )

  it.instance("gates a file: url on its decoded path", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, url: "file:///C:/tmp/page.html" })
      const { ctx, asks } = makeCtx()

      yield* exec({ action: "open", url: "file:///C:/tmp/page.html" }, ctx)

      const pattern = asks[0]?.patterns[0] ?? ""
      expect(pattern.startsWith("file:")).toBe(false)
      expect(pattern).toContain("tmp")
      expect(pattern).toContain("page.html")
    }),
  )

  it.instance("refuses a url that would be stored as a wildcard rule, before it asks anything", () =>
    Effect.gen(function* () {
      // An "always" answer is kept as a glob, so `https://*` would save the
      // pattern `*`: one Always click on a model-chosen url would then allow
      // every site. The refusal must land before the user is even asked.
      const calls = useHandler({ ok: true })
      const { ctx, asks } = makeCtx()

      // Both matcher wildcards, on both target shapes: a host and a bare path.
      for (const url of ["https://*", "https://*.example.com", "C:/tmp/a?b.html"]) {
        const result = yield* exec({ action: "open", url }, ctx)
        expect(result.output.startsWith("Refused:")).toBe(true)
        expect(result.output).toContain("wildcard")
        expect(result.metadata).toMatchObject({ ok: false })
      }

      expect(asks.length).toBe(0)
      expect(calls.length).toBe(0)
    }),
  )

  it.instance("refuses a local file url whose path carries a wildcard", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true })
      const { ctx, asks } = makeCtx()

      const result = yield* exec({ action: "navigate", url: "file:///C:/tmp/*.html" }, ctx)

      expect(result.output.startsWith("Refused:")).toBe(true)
      expect(asks.length).toBe(0)
      expect(calls.length).toBe(0)
    }),
  )

  it.instance("refuses non-page schemes before it asks anything", () =>
    Effect.gen(function* () {
      // A hostless scheme like javascript: falls through permissionTarget to
      // the raw string - the user would be asked to allow a thing that is not
      // a page. Refuse the scheme up front; no ask, no bridge call.
      const calls = useHandler({ ok: true })
      const { ctx, asks } = makeCtx()

      for (const url of ["javascript:alert(1)", "data:text/html,<h1>x</h1>", "about:blank"]) {
        const result = yield* exec({ action: "open", url }, ctx)
        expect(result.output.startsWith("Refused:")).toBe(true)
        expect(result.output).toContain("scheme")
        expect(result.metadata).toMatchObject({ ok: false })
      }

      expect(asks.length).toBe(0)
      expect(calls.length).toBe(0)
    }),
  )

  it.instance("still opens an ordinary url, gating on its literal host", () =>
    Effect.gen(function* () {
      // The wildcard lives in the QUERY, which never reaches the saved pattern:
      // checking the raw url instead of the derived target would refuse this.
      const calls = useHandler({ ok: true, url: "https://example.com/search?q=a*b" })
      const { ctx, asks } = makeCtx()

      const result = yield* exec({ action: "open", url: "https://example.com/search?q=a*b" }, ctx)

      expect(asks[0]?.patterns).toEqual(["example.com"])
      expect(asks[0]?.always).toEqual(["example.com"])
      expect(calls.length).toBe(1)
      expect(result.metadata).toMatchObject({ ok: true })
    }),
  )

  it.instance("refuses open without a url and drives nothing", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true })
      const { ctx, asks } = makeCtx()

      const result = yield* exec({ action: "open" }, ctx)

      expect(result.output.startsWith("Refused:")).toBe(true)
      expect(result.output).toContain("url")
      expect(calls.length).toBe(0)
      expect(asks.length).toBe(0)
    }),
  )

  it.instance("refuses click without a selector and drives nothing", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "click" }, ctx)

      expect(result.output.startsWith("Refused:")).toBe(true)
      expect(result.output).toContain("selector")
      expect(calls.length).toBe(0)
    }),
  )

  it.instance("refuses type without text even when a selector is given", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "type", selector: "#name" }, ctx)

      expect(result.output.startsWith("Refused:")).toBe(true)
      expect(result.output).toContain("text")
      expect(calls.length).toBe(0)
      expect(result.metadata).toMatchObject({ ok: false })
    }),
  )

  it.instance("forwards an empty string instead of deciding for the client", () =>
    Effect.gen(function* () {
      // An empty text is a real request, so the engine passes it on. Whether it
      // can be served is the CLIENT's answer: VS Code's type tool refuses empty
      // text outright and says so in its own words, and another ACP client may
      // well fill the field. Refusing here would answer for both of them.
      const calls = useHandler({ ok: true, url: "https://example.com" })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "type", selector: "#name", text: "" }, ctx)

      expect(calls[0]).toEqual({ action: "type", selector: "#name", text: "" })
      expect(result.output.startsWith("Refused:")).toBe(false)
      expect(result.metadata).toMatchObject({ ok: true })
    }),
  )

  it.instance("carries the client's own note into the result instead of dropping it", () =>
    Effect.gen(function* () {
      // The reduced VS Code open SUCCEEDS but leaves the page unreadable, and
      // says so. That sentence is the only warning before the next read fails,
      // so an open confirmation that swallowed it would strand the model.
      const note = "Opened WITHOUT being shared with the agent."
      useHandler({ ok: true, url: "https://example.com/app", pageText: note })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "open", url: "https://example.com/app" }, ctx)

      expect(result.output).toContain("Opened https://example.com/app")
      expect(result.output).toContain(note)
      // Still a success: the page IS on screen. Only metadata carries the verdict.
      expect(result.metadata).toMatchObject({ ok: true })
    }),
  )

  it.instance("returns the page text for read", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, url: "https://example.com", pageText: "Hello from the integrated browser" })
      const { ctx, asks } = makeCtx()

      const result = yield* exec({ action: "read" }, ctx)

      expect(result.output).toBe("Hello from the integrated browser")
      expect(result.attachments).toBeUndefined()
      // read reaches into a page the user may be signed in to, so it costs one
      // approval - the same class of approval every page interaction takes.
      expect(asks.length).toBe(1)
      expect(result.metadata).toMatchObject({ ok: true })
    }),
  )

  it.instance("calls a page with no text a success, not a failure", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, url: "https://example.com", pageText: "" })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "read" }, ctx)

      // Nothing went wrong: the page really is empty. Only a broken call is red.
      expect(result.metadata).toMatchObject({ ok: true })
    }),
  )

  it.instance("marks a screenshot that came back without an image as failed", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, url: "https://example.com" })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "screenshot" }, ctx)

      expect(result.attachments).toBeUndefined()
      expect(result.metadata).toMatchObject({ ok: false })
    }),
  )

  it.instance("says so when the page carries no readable text", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, url: "https://example.com", pageText: "   " })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "read" }, ctx)

      expect(result.output).toContain("no readable text")
    }),
  )

  it.instance("surfaces a client-reported failure as readable output", () =>
    Effect.gen(function* () {
      useHandler({ ok: false, error: "No element matches #missing." })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "click", selector: "#missing" }, ctx)

      expect(result.output).toBe("No element matches #missing.")
      expect(result.attachments).toBeUndefined()
      expect(result.metadata).toMatchObject({ ok: false, action: "click" })
    }),
  )

  it.instance("puts the ELEMENT on a screenshot request when the model named one", () =>
    Effect.gen(function* () {
      // VS Code's screenshot_page takes ref/selector/element and crops to that
      // element's box. The selector reached the wire but the CLIENT dropped it,
      // so every element capture came back as the viewport and was reported as
      // the element that was asked for. The wire half is asserted here; the
      // client half is browserBridge.test.ts.
      const calls = useHandler({ ok: true, url: "https://example.com/app", imageBase64: "AAAA" })
      const { ctx } = makeCtx()

      yield* exec({ action: "screenshot", selector: "#chart" }, ctx)

      expect(calls[0]).toEqual({ action: "screenshot", selector: "#chart" })
    }),
  )

  it.instance("sends a keypress as a key, and does not invent text to go with it", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true, url: "https://example.com" })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "type", selector: "#q", key: "Enter" }, ctx)

      expect(calls[0]).toEqual({ action: "type", selector: "#q", key: "Enter" })
      // and the confirmation says what happened - a key was pressed, not typed.
      expect(result.output).toContain("Pressed Enter")
      expect(result.output).not.toContain("Typed")
    }),
  )

  it.instance("lets a key stand in for both the selector and the text a type owes", () =>
    Effect.gen(function* () {
      // With no selector the client presses the key on whatever the PAGE
      // focused, which is the only way to answer a widget no selector names.
      const calls = useHandler({ ok: true, url: "https://example.com" })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "type", key: "Escape" }, ctx)

      expect(calls[0]).toEqual({ action: "type", key: "Escape" })
      expect(result.output.startsWith("Refused:")).toBe(false)
      expect(result.output).toContain("the focused element")
    }),
  )

  it.instance("sends hover, drag and dialog with the arguments each one names", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true, url: "https://example.com" })
      const { ctx } = makeCtx()

      yield* exec({ action: "hover", selector: "#menu" }, ctx)
      yield* exec({ action: "drag", selector: "#card", toSelector: "#bin" }, ctx)
      yield* exec({ action: "dialog", accept: false, text: "no" }, ctx)

      expect(calls).toEqual([
        { action: "hover", selector: "#menu" },
        { action: "drag", selector: "#card", toSelector: "#bin" },
        { action: "dialog", text: "no", accept: false },
      ])
    }),
  )

  it.instance("refuses every new action that is missing an argument, and drives nothing", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true })
      const { ctx } = makeCtx()

      const cases: [Tool.InferParameters<typeof BrowserTool>, string][] = [
        [{ action: "hover" }, "selector"],
        [{ action: "drag", toSelector: "#bin" }, "selector"],
        [{ action: "drag", selector: "#card" }, "toSelector"],
        [{ action: "dialog" }, "accept"],
        [{ action: "raw" }, "code"],
        // `text` was the only way to say what a type does; `key` is the second,
        // so neither alone is now the refusal - only NEITHER is.
        [{ action: "type", selector: "#q" }, "text or key"],
      ]
      for (const [args, said] of cases) {
        const result = yield* exec(args, ctx)
        expect(result.output.startsWith("Refused:"), args.action).toBe(true)
        expect(result.output, args.action).toContain(said)
        expect(result.metadata).toMatchObject({ ok: false })
      }

      expect(calls.length).toBe(0)
    }),
  )

  it.instance("gates raw on its OWN target, so an Always on page interaction never covers code", () =>
    Effect.gen(function* () {
      // The consequence, checked with the matcher the permission service uses on
      // a saved rule: approving "read this page, always" must not silently
      // become permission to run javascript in that same signed-in page.
      const trace: string[] = []
      const calls = useHandler({ ok: true, pageText: 'Result: "Origami"' }, trace)
      const { ctx, asks } = makeCtx(trace)

      yield* exec({ action: "read" }, ctx)
      const result = yield* exec({ action: "raw", code: "return page.title()" }, ctx)

      expect(trace).toEqual(["ask", "bridge", "ask", "bridge"])
      const savedByPage = asks[0]?.always ?? []
      expect(savedByPage.some((saved) => Wildcard.match(asks[1]?.patterns[0] ?? "", saved))).toBe(false)
      // and the ask names the code, because the code is what is being approved.
      expect(asks[1]?.metadata).toEqual({ action: "raw", code: "return page.title()" })
      expect(calls[1]).toEqual({ action: "raw", code: "return page.title()" })
      // What the snippet RETURNED is the answer, not a confirmation sentence.
      expect(result.output).toBe('Result: "Origami"')
    }),
  )

  it.instance("never runs the snippet when the raw gate is denied", () =>
    Effect.gen(function* () {
      const calls = useHandler({ ok: true, pageText: "ran" })
      const { ctx } = makeCtx([], () => Effect.die(new Error("permission rejected")))

      const exit = yield* exec({ action: "raw", code: "return page.title()" }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls.length).toBe(0)
    }),
  )

  it.instance("says a snippet returned nothing rather than calling it page text", () =>
    Effect.gen(function* () {
      useHandler({ ok: true, pageText: "" })
      const { ctx } = makeCtx()

      const result = yield* exec({ action: "raw", code: "await page.mouse.wheel(0, 400)" }, ctx)

      expect(result.output).toContain("returned nothing")
      expect(result.output).not.toContain("no readable text")
      expect(result.metadata).toMatchObject({ ok: true, action: "raw" })
    }),
  )
})

describe("tool.browser registration", () => {
  withRegistry.instance("is offered to the model with a description that names the client it needs", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      expect(yield* registry.ids()).toContain("browser")

      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const browser = tools.find((tool) => tool.id === "browser")
      expect(browser?.description).toContain("VS Code")
    }),
  )

  withRegistry.instance("tells the model it can drive a real browser through the shell when the VS Code view is too limiting", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const browser = tools.find((tool) => tool.id === "browser")
      expect(browser?.description).toContain("drive an actual browser through the shell")
    }),
  )

  test("renders on the client as a fetch card", () => {
    expect(toToolKind("browser")).toBe("fetch")
  })

  test("names the page in a plain ACP client's permission bar", () => {
    // Without a case here the bar shows no title at all, so the user approves
    // "browser" with no idea which page.
    expect(permissionTitle("browser", { action: "open", url: "https://example.com/app" })).toBe(
      "https://example.com/app",
    )
    expect(permissionTitle("browser", { action: "read" })).toBe("read")
  })

  test("shows the CODE in the bar when raw asks to run a snippet", () => {
    // A bar reading "raw" hides the whole decision: the snippet is the thing
    // being approved, and it is the only part of a raw call the user can judge.
    expect(permissionTitle("browser", { action: "raw", code: "return page.title()" })).toBe("return page.title()")
  })
})

describe("browser bridge", () => {
  test("sends the ext method and payload the VS Code lane is built against", async () => {
    const seen: { method?: string; params?: Record<string, unknown> } = {}
    BrowserBridge.registerConnection({
      extMethod: async (method, params) => {
        seen.method = method
        seen.params = params
        return { ok: true, url: "https://example.com" }
      },
    })

    const response = await BrowserBridge.send({ action: "navigate", url: "https://example.com" })

    expect(seen.method).toBe("origami/browser")
    // toEqual, not toMatchObject: an absent field must be absent on the wire.
    expect(seen.params).toEqual({ action: "navigate", url: "https://example.com" })
    expect(response).toEqual({ ok: true, url: "https://example.com" })
  })

  test("carries every field the new actions need, and still omits the absent ones", async () => {
    // The extension is built against THIS shape sight-unseen: a field the wire
    // drops is a silent no-op on the far side, which is how an element
    // screenshot spent a release capturing the whole viewport.
    const seen: Record<string, unknown>[] = []
    BrowserBridge.registerConnection({
      extMethod: async (_method, params) => {
        seen.push(params)
        return { ok: true }
      },
    })

    await BrowserBridge.send({ action: "drag", selector: "#card", toSelector: "#bin" })
    await BrowserBridge.send({ action: "type", selector: "#q", key: "Control+a" })
    await BrowserBridge.send({ action: "dialog", accept: false, text: "no" })
    await BrowserBridge.send({ action: "raw", code: "return page.title()" })

    expect(seen).toEqual([
      { action: "drag", selector: "#card", toSelector: "#bin" },
      { action: "type", selector: "#q", key: "Control+a" },
      { action: "dialog", text: "no", accept: false },
      { action: "raw", code: "return page.title()" },
    ])
  })

  test("keeps `accept: false` on the wire, where an absent field would mean the opposite", async () => {
    // The one boolean in the contract, and the one field a truthiness test would
    // quietly turn into "accept" - dismissing a confirm() and accepting it are
    // opposite answers to the same dialog.
    const seen: Record<string, unknown>[] = []
    BrowserBridge.registerConnection({
      extMethod: async (_method, params) => {
        seen.push(params)
        return { ok: true }
      },
    })

    await BrowserBridge.send({ action: "dialog", accept: false })
    await BrowserBridge.send({ action: "dialog" })

    expect(seen[0]).toEqual({ action: "dialog", accept: false })
    expect(seen[1]).toEqual({ action: "dialog" })
  })

  test("fails a request that outlives its timeout", async () => {
    BrowserBridge.register(() => new Promise<BrowserBridge.Response>(() => {}))

    const response = await BrowserBridge.send({ action: "screenshot" }, 20)

    expect(response.ok).toBe(false)
    expect(response.error).toContain("did not answer")
    expect(response.error).toContain("screenshot")
  })

  test("turns a rejected client call into a readable failure", async () => {
    BrowserBridge.register(() => Promise.reject(new Error("the browser view was disposed")))

    const response = await BrowserBridge.send({ action: "read" })

    expect(response.ok).toBe(false)
    expect(response.error).toContain("the browser view was disposed")
  })

  test("tells a client with no browser that it has none, not that VS Code failed", async () => {
    // acp/agent.ts registers EVERY ACP connection, so a Zed session has a live
    // handler that answers JSON-RPC -32601. That is "this client cannot drive a
    // browser", which is exactly what UNAVAILABLE says.
    BrowserBridge.register(() => Promise.reject(Object.assign(new Error('"Method not found"'), { code: -32601 })))

    const response = await BrowserBridge.send({ action: "screenshot" })

    expect(response).toEqual({ ok: false, error: BrowserBridge.UNAVAILABLE })
    expect(response.error).not.toContain("failed to handle")
  })

  test("keeps a real client-side error verbatim rather than blaming the client's kind", async () => {
    BrowserBridge.register(() => Promise.reject(Object.assign(new Error("no active page"), { code: -32603 })))

    const response = await BrowserBridge.send({ action: "read" })

    expect(response.error).toContain("no active page")
    expect(response.error).not.toBe(BrowserBridge.UNAVAILABLE)
  })

  test("treats a reply that is not ok:true as a refusal", () => {
    expect(BrowserBridge.fromWire({})).toEqual({
      ok: false,
      error: "The VS Code browser refused the request and gave no reason.",
    })
    expect(BrowserBridge.fromWire({ ok: false, error: "tab closed" })).toEqual({ ok: false, error: "tab closed" })
    expect(BrowserBridge.fromWire(undefined).ok).toBe(false)
  })

  test("keeps only the documented fields with the documented types", () => {
    const decoded = BrowserBridge.fromWire({
      ok: true,
      url: 42,
      pageText: "text",
      imageBase64: "AAAA",
      imageMime: "image/png",
      tools: ["screenshot", 7],
      unexpected: "dropped",
    })

    expect(decoded).toEqual({
      ok: true,
      pageText: "text",
      imageBase64: "AAAA",
      imageMime: "image/png",
      tools: ["screenshot"],
    })
  })

  test("reports itself unavailable until a client registers", async () => {
    expect(BrowserBridge.available()).toBe(false)
    expect(await BrowserBridge.send({ action: "probe" })).toEqual({ ok: false, error: BrowserBridge.UNAVAILABLE })

    BrowserBridge.registerConnection({ extMethod: async () => ({ ok: true, tools: ["screenshot", "read"] }) })
    expect(BrowserBridge.available()).toBe(true)
    expect((await BrowserBridge.send({ action: "probe" })).tools).toEqual(["screenshot", "read"])
  })
})

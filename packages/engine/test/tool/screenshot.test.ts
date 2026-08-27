import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Global } from "@origami/core/global"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import {
  capture,
  capturePlan,
  captureFile,
  MACOS_ALL_NOTE,
  MACOS_TCC_NOTE,
  MAX_ATTACHMENT_BYTES,
  platformNotes,
  powershellScript,
  ScreenshotTool,
  type Runner,
} from "@/tool/screenshot"
import { MessageID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/** A real 1x1 PNG. Nothing under test parses it, but a fixture that is a valid
 *  file of the type claimed is the only kind worth round-tripping. */
const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

const dirs: string[] = []
async function tmpdir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-screenshot-test-"))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

/** A runner that never spawns anything: it just drops `bytes` where the real
 *  capture command would have written them, and reports `code`. */
function fakeRunner(file: string, bytes: Buffer | undefined, code = 0): { run: Runner; commands: string[][] } {
  const commands: string[][] = []
  const run: Runner = async (command) => {
    commands.push(command)
    if (bytes) await fs.writeFile(file, bytes)
    return { code, stderr: code === 0 ? "" : "capture blew up" }
  }
  return { run, commands }
}

describe("tool.screenshot command builder", () => {
  // Every case names its platform EXPLICITLY. A builder test that reads
  // process.platform pins whichever branch this host happens to be and asserts
  // nothing at all about the other two.
  test("win32 makes itself DPI aware BEFORE it reads the screen bounds", () => {
    const script = powershellScript("primary", "C:\\tmp\\shot.png")
    // Match the INVOCATION, not the P/Invoke declaration. The declaration
    // (`public static extern bool SetProcessDPIAware();`) sits in the Add-Type
    // line, which precedes the bounds read whatever order the call is in - an
    // assertion anchored on the bare name can never go red, and did not when
    // the call was deliberately moved after the bounds read.
    const call = "[void][OrigamiNative.Dpi]::SetProcessDPIAware()"
    expect(script).toContain(call)
    // Order is the whole point: bounds read while the process is still
    // DPI-unaware come back scaled, and the capture silently takes a crop.
    expect(script.indexOf(call)).toBeLessThan(script.indexOf("PrimaryScreen.Bounds"))
  })

  test("win32 picks the bounds source from the display mode", () => {
    const primary = powershellScript("primary", "C:\\tmp\\shot.png")
    expect(primary).toContain("[System.Windows.Forms.Screen]::PrimaryScreen.Bounds")
    expect(primary).not.toContain("VirtualScreen")

    const all = powershellScript("all", "C:\\tmp\\shot.png")
    expect(all).toContain("[System.Windows.Forms.SystemInformation]::VirtualScreen")
    expect(all).not.toContain("PrimaryScreen.Bounds")
  })

  test("win32 script carries no double quote, and doubles one in the path", () => {
    // The script crosses cross-spawn -> Windows command line -> powershell.exe.
    // powershell.exe does not honour the `\"` escaping Node applies, so a double
    // quote anywhere in the argument corrupts the re-parse.
    expect(powershellScript("primary", "C:\\tmp\\shot.png")).not.toContain('"')
    // A username with an apostrophe is enough to close the literal early.
    expect(powershellScript("primary", "C:\\Users\\O'Brien\\shot.png")).toContain("'C:\\Users\\O''Brien\\shot.png'")
  })

  test("win32 plan runs powershell non-interactively", () => {
    const plan = capturePlan("win32", "primary", "C:\\tmp\\shot.png")
    expect(plan.supported).toBe(true)
    if (!plan.supported) return
    expect(plan.command.slice(0, 4)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-Command"])
  })

  test("darwin plan is a silent screencapture to the target file", () => {
    const plan = capturePlan("darwin", "primary", "/tmp/shot.png")
    expect(plan.supported).toBe(true)
    if (!plan.supported) return
    expect(plan.command).toEqual(["screencapture", "-x", "/tmp/shot.png"])
    // "all" is the SAME single-file command on macOS - one display, documented.
    expect(capturePlan("darwin", "all", "/tmp/shot.png")).toEqual(plan)
  })

  test("linux is unsupported, and says so instead of throwing", () => {
    const plan = capturePlan("linux", "primary", "/tmp/shot.png")
    expect(plan.supported).toBe(false)
    if (plan.supported) return
    expect(plan.reason).toContain("screenshot is not supported on linux yet")
  })

  test("the macOS permission trap rides on every darwin capture", () => {
    expect(platformNotes("darwin", "primary")).toEqual([MACOS_TCC_NOTE])
    expect(platformNotes("darwin", "all")).toEqual([MACOS_ALL_NOTE, MACOS_TCC_NOTE])
    // ...and on no other platform's.
    expect(platformNotes("win32", "all")).toEqual([])
    expect(platformNotes("linux", "primary")).toEqual([])
  })

  test("two captures in the same millisecond do not collide on one file", async () => {
    const dir = await tmpdir()
    expect(captureFile(dir)).not.toBe(captureFile(dir))
  })
})

describe("tool.screenshot result", () => {
  test("attaches the PNG in the shape the browser tool uses", async () => {
    const dir = await tmpdir()
    const file = path.join(dir, "shot.png")
    const { run, commands } = fakeRunner(file, FIXTURE_PNG)

    const result = await capture({ platform: "win32", display: "primary", file, run })

    expect(commands).toHaveLength(1)
    expect(result.metadata).toMatchObject({ ok: true, display: "primary", attached: true, bytes: FIXTURE_PNG.length })
    // Same three fields browser.ts:277-283 emits for its screenshot.
    expect(result.attachments).toHaveLength(1)
    const attachment = result.attachments![0]!
    expect(Object.keys(attachment).toSorted()).toEqual(["mime", "type", "url"])
    expect(attachment.type).toBe("file")
    expect(attachment.mime).toBe("image/png")
    expect(attachment.url.startsWith("data:image/png;base64,")).toBe(true)
    // The payload is the file, not a truncation of it.
    const carried = Buffer.from(attachment.url.slice("data:image/png;base64,".length), "base64")
    expect(carried.equals(FIXTURE_PNG)).toBe(true)
  })

  test("output names the absolute path, the size and the display mode", async () => {
    const dir = await tmpdir()
    const file = path.join(dir, "shot.png")
    const { run } = fakeRunner(file, FIXTURE_PNG)

    const result = await capture({ platform: "win32", display: "all", file, run })

    expect(result.output).toContain(file)
    expect(path.isAbsolute(file)).toBe(true)
    expect(result.output).toContain(`${FIXTURE_PNG.length} bytes`)
    expect(result.output).toContain("all displays")
  })

  test("a darwin capture always carries the Screen Recording warning", async () => {
    const dir = await tmpdir()
    const file = path.join(dir, "shot.png")
    const { run } = fakeRunner(file, FIXTURE_PNG)

    // The capture SUCCEEDED. The warning is on the success path precisely
    // because a TCC-blocked capture also succeeds - it just returns a desktop
    // with no windows, which nothing here can detect.
    const result = await capture({ platform: "darwin", display: "primary", file, run })

    expect(result.metadata).toMatchObject({ ok: true })
    expect(result.output).toContain(MACOS_TCC_NOTE)
    expect(result.output).toContain("Screen Recording")
  })

  test("an oversized PNG is left on disk instead of inlined", async () => {
    const dir = await tmpdir()
    const file = path.join(dir, "huge.png")
    const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0)
    FIXTURE_PNG.copy(huge)
    const { run } = fakeRunner(file, huge)

    const result = await capture({ platform: "win32", display: "primary", file, run })

    expect(result.metadata).toMatchObject({ ok: true, attached: false, bytes: MAX_ATTACHMENT_BYTES + 1 })
    expect(result.attachments).toBeUndefined()
    expect(result.output).toContain("NOT attached")
    // The path has to survive, or the picture is unreachable.
    expect(result.output).toContain(file)
    expect(result.output).toContain("read tool")
  })

  test("a capture that writes nothing reports failure rather than an empty image", async () => {
    const dir = await tmpdir()
    const file = path.join(dir, "missing.png")
    const { run } = fakeRunner(file, undefined, 1)

    const result = await capture({ platform: "win32", display: "primary", file, run })

    expect(result.metadata).toMatchObject({ ok: false })
    expect(result.attachments).toBeUndefined()
    expect(result.output).toContain("capture blew up")
  })

  test("an unsupported platform returns output and runs nothing", async () => {
    const dir = await tmpdir()
    const file = path.join(dir, "shot.png")
    const { run, commands } = fakeRunner(file, FIXTURE_PNG)

    const result = await capture({ platform: "linux", display: "primary", file, run })

    expect(commands).toHaveLength(0)
    expect(result.metadata).toMatchObject({ ok: false, platform: "linux" })
    expect(result.output).toContain("not supported on linux")
  })
})

const agentLayer = LayerNode.compile(
  LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
)
const itAgent = testEffect(agentLayer)

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.screenshot permission", () => {
  itAgent.instance("defaults to ASK, where an ordinary tool defaults to allow", () =>
    Effect.gen(function* () {
      const build = (yield* Agent.Service.use((svc) => svc.list())).find((item) => item.name === "build")
      expect(build).toBeDefined()
      // The contrast is the assertion. The base ruleset is `"*": "allow"`, so
      // `glob` - which names no rule of its own - is allowed silently. If
      // `screenshot: "ask"` ever falls out of the defaults, this flips to
      // "allow" and the gate is gone without a single test going red elsewhere.
      expect(Permission.evaluate("glob", "*", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("screenshot", "primary display", build!.permission).action).toBe("ask")
      expect(Permission.evaluate("screenshot", "all displays", build!.permission).action).toBe("ask")
    }),
  )

  itAgent.instance("an archetype deny cage refuses it by NAME, not in silence", () =>
    Effect.gen(function* () {
      const build = (yield* Agent.Service.use((svc) => svc.list())).find((item) => item.name === "build")
      // What the read-only archetypes (ask/architect/scout) put on an agent.
      const caged = Permission.merge(build!.permission, Permission.fromConfig({ "*": "deny" }))
      const rule = Permission.evaluate("screenshot", "primary display", caged)
      expect(rule.action).toBe("deny")
      // The refusal the model reads has to name the gate, or it retries forever.
      const denial = new PermissionV1.DeniedError({
        ruleset: [rule],
        permission: "screenshot",
        pattern: "primary display",
      })
      expect(denial.message).toContain("screenshot")
      expect(denial.message).toContain("Retrying it will be refused")
    }),
  )
})

// Over the REAL registry, so "the model is offered this tool" is checked on the
// surface that offers it rather than inferred from the import existing.
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

describe("tool.screenshot registration", () => {
  withRegistry.instance("is a builtin the model can actually call", () =>
    Effect.gen(function* () {
      const ids = yield* ToolRegistry.Service.use((svc) => svc.ids())
      expect(ids).toContain("screenshot")
    }),
  )
})

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

function makeCtx() {
  const asks: Ask[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_screenshot-test"),
    messageID: MessageID.make("msg_screenshot-test"),
    callID: "screenshot-call",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.suspend(() => {
        asks.push(request)
        return Effect.void
      }),
  }
  return { ctx, asks }
}

const itTool = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

/** The `instance` helper carries `.skip` but no `.skipIf`, so the choice is made
 *  here. Guarded on the HOST platform deliberately - this is the one test in the
 *  file that needs a real screen, and it is skipped rather than faked elsewhere. */
const liveOnWin32 = process.platform === "win32" ? itTool.instance : itTool.instance.skip

describe("tool.screenshot tool", () => {
  itTool.instance("asks with an EMPTY always list, so no answer covers the next capture", () =>
    Effect.gen(function* () {
      const info = yield* ScreenshotTool
      const tool = yield* info.init()
      const { ctx, asks } = makeCtx()
      // Refuse at the ask, so nothing is captured: this test is about the gate.
      const rejecting: Tool.Context = {
        ...ctx,
        ask: (request) =>
          Effect.suspend(() => {
            asks.push(request)
            return Effect.die(new Error("stop here"))
          }),
      }
      yield* tool.execute({ display: "all" }, rejecting).pipe(Effect.exit)

      expect(asks).toHaveLength(1)
      expect(asks[0]!.permission).toBe("screenshot")
      expect(asks[0]!.patterns).toEqual(["all displays"])
      // An "Always allow" answer approves the patterns in `always`. Empty means
      // it approves nothing, so the very next capture asks again.
      expect(asks[0]!.always).toEqual([])
      expect(asks[0]!.metadata).toMatchObject({ display: "all" })
    }),
  )

  itTool.instance("an omitted display means the primary monitor", () =>
    Effect.gen(function* () {
      const info = yield* ScreenshotTool
      const tool = yield* info.init()
      const { ctx, asks } = makeCtx()
      const rejecting: Tool.Context = {
        ...ctx,
        ask: (request) =>
          Effect.suspend(() => {
            asks.push(request)
            return Effect.die(new Error("stop here"))
          }),
      }
      // The model calling `screenshot` with no arguments is the common case, so
      // the documented default is checked through the DECODER, not just the
      // `??` in the tool body.
      yield* tool.execute({}, rejecting).pipe(Effect.exit)
      expect(asks[0]!.patterns).toEqual(["primary display"])
      expect(asks[0]!.metadata).toMatchObject({ display: "primary" })
    }),
  )

  // ENVIRONMENT-DEPENDENT. This one really photographs the screen, so it runs
  // only on the Windows box that has one. It is the only test here that proves
  // the PowerShell string survives the cross-spawn/powershell.exe re-parse -
  // every other assertion about that script is a string check.
  liveOnWin32(
    "[win32 only] really captures the screen and attaches a PNG",
    () =>
      Effect.gen(function* () {
        const info = yield* ScreenshotTool
        const tool = yield* info.init()
        const { ctx, asks } = makeCtx()

        const result = yield* tool.execute({ display: "primary" }, ctx)

        expect(asks).toHaveLength(1)
        expect(result.metadata).toMatchObject({ ok: true, display: "primary", attached: true })
        const file = (result.metadata as { path?: string }).path!
        expect(file.startsWith(path.join(Global.Path.tmp, "screenshot"))).toBe(true)

        const bytes = yield* Effect.promise(() => fs.readFile(file))
        expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
        expect(bytes.length).toBeGreaterThan(1024)

        const url = result.attachments![0]!.url
        const carried = Buffer.from(url.slice("data:image/png;base64,".length), "base64")
        expect(carried.equals(bytes)).toBe(true)

        yield* Effect.promise(() => fs.rm(file, { force: true }))
      }),
    30_000,
  )
})

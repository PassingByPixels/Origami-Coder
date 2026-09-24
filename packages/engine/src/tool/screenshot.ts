import path from "path"
import fs from "fs/promises"
import { Effect, Schema } from "effect"
import { Global } from "@origami/core/global"
import { Identifier } from "@/id/id"
import { Process } from "@/util/process"
import DESCRIPTION from "./screenshot.txt"
import * as Tool from "./tool"

const displays = ["primary", "all"] as const
export type Display = (typeof displays)[number]

export const Parameters = Schema.Struct({
  display: Schema.optional(Schema.Literals(displays)).annotate({
    description:
      'Which screen to capture. "primary" (the default) is the main monitor; "all" is every monitor in one image. ' +
      'macOS captures the main display only, so "all" behaves as "primary" there.',
  }),
})

/**
 * The largest PNG that still comes back inline as a base64 attachment. A data:
 * URL costs roughly 4/3 of the file in prompt text, so an unbounded 4K grab
 * could outweigh the rest of the session. Past this it stays on disk.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/**
 * How long a capture may run before it is killed. A screen grab is sub-second on
 * a healthy machine; the deadline is for the unhealthy one - a macOS permission
 * dialog waiting on a click, a wedged PowerShell - which would otherwise leave
 * the session sitting `running` forever.
 */
export const CAPTURE_TIMEOUT_MS = 15_000

/**
 * The sentence a macOS capture always carries. Without Screen Recording, macOS
 * does not fail the capture - it returns the desktop wallpaper with every window
 * missing, in a structurally valid PNG nothing here can detect. Saying so every
 * time is the only defence.
 */
export const MACOS_TCC_NOTE =
  "macOS: if the image shows the desktop without windows, grant Screen Recording to the VS Code process in " +
  "System Settings > Privacy & Security, then retry."

/** macOS `screencapture` writes one file, which is the main display's. */
export const MACOS_ALL_NOTE = 'macOS captures the main display only, so "all" returned the same image as "primary".'

export type Plan = { supported: true; command: string[] } | { supported: false; reason: string }

export type ScreenshotMetadata = {
  /** The one field a client may trust: prose and titles are not a status. */
  ok: boolean
  display: Display
  platform: string
  path?: string
  bytes?: number
  /** False when the capture succeeded but the PNG was too big to inline. */
  attached?: boolean
}

/**
 * PowerShell escape for a path going into a single-quoted string literal. The
 * path sits under the user's profile, so a username holding an apostrophe
 * (O'Brien) would close the literal early and turn the rest into commands.
 */
function psLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * The Windows capture script, as one `-Command` argument. Two things are
 * deliberate and easy to "tidy" into a bug:
 *
 * 1. It contains no double quote characters. The script crosses a cross-spawn
 *    -> Windows command-line -> powershell.exe re-parse, and powershell.exe
 *    does not honour the C-runtime `\"` convention Node quotes with, so the one
 *    double quote the C# snippet needs is built from `[char]34`.
 * 2. SetProcessDPIAware runs BEFORE the screen bounds are read. Without it, on
 *    a 200% display `PrimaryScreen.Bounds` reports the scaled logical size and
 *    CopyFromScreen captures only the top-left quadrant — succeeding, and
 *    looking plausible.
 */
export function powershellScript(display: Display, file: string): string {
  const bounds =
    display === "all"
      ? "[System.Windows.Forms.SystemInformation]::VirtualScreen"
      : "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds"
  return [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$q=[char]34",
    "Add-Type -Namespace OrigamiNative -Name Dpi -MemberDefinition ('[DllImport(' + $q + 'user32.dll' + $q + ')] public static extern bool SetProcessDPIAware();')",
    "[void][OrigamiNative.Dpi]::SetProcessDPIAware()",
    `$b=${bounds}`,
    "$m=New-Object System.Drawing.Bitmap($b.Width,$b.Height)",
    "$g=[System.Drawing.Graphics]::FromImage($m)",
    "$g.CopyFromScreen($b.X,$b.Y,0,0,$b.Size)",
    `$m.Save('${psLiteral(file)}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose()",
    "$m.Dispose()",
  ].join("; ")
}

/** What to run to put a PNG at `file` - or why this platform cannot. Takes the
 *  platform as an argument so a test can pin all three branches on any host. */
export function capturePlan(platform: NodeJS.Platform, display: Display, file: string): Plan {
  if (platform === "win32") {
    return {
      supported: true,
      command: ["powershell", "-NoProfile", "-NonInteractive", "-Command", powershellScript(display, file)],
    }
  }
  if (platform === "darwin") {
    // -x is "no camera sound": a capture the user did not initiate should not
    // announce itself.
    return { supported: true, command: ["screencapture", "-x", file] }
  }
  return {
    supported: false,
    reason: [
      `screenshot is not supported on ${platform} yet.`,
      "It captures the screen on Windows and macOS only.",
      "On this machine, ask the user to take the screenshot and attach it, or read an image file they point you at.",
    ].join(" "),
  }
}

/** The platform truths that ride along with a successful capture. */
export function platformNotes(platform: NodeJS.Platform, display: Display): string[] {
  if (platform !== "darwin") return []
  if (display === "all") return [MACOS_ALL_NOTE, MACOS_TCC_NOTE]
  return [MACOS_TCC_NOTE]
}

/** Where this capture goes. The id's leading hex is the millisecond timestamp
 *  and its random tail keeps two concurrent sub-agent captures off one file. */
export function captureFile(dir: string): string {
  return path.join(dir, `${Identifier.create("screen", "ascending")}.png`)
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} bytes`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export type Runner = (command: string[]) => Promise<{ code: number; stderr: string }>

/** Run the capture and build the tool result. Given the platform and the runner
 *  as arguments so the result shape is testable without capturing anything. */
export async function capture(input: {
  platform: NodeJS.Platform
  display: Display
  file: string
  run: Runner
}): Promise<Tool.ExecuteResult<ScreenshotMetadata>> {
  const { platform, display, file } = input
  const base: ScreenshotMetadata = { ok: false, display, platform }

  const plan = capturePlan(platform, display, file)
  if (!plan.supported) {
    // An unsupported platform is a fact the model should work around, not a
    // defect, so it returns output rather than failing.
    return { title: `screenshot: unsupported on ${platform}`, metadata: base, output: plan.reason }
  }

  await fs.mkdir(path.dirname(file), { recursive: true })
  const outcome = await input.run(plan.command)
  const stat = await fs.stat(file).catch(() => undefined)

  if (outcome.code !== 0 || !stat || stat.size === 0) {
    const detail = outcome.stderr.trim()
    return {
      title: "screenshot: failed",
      metadata: base,
      output: [
        `The screen capture failed (exit code ${outcome.code}).`,
        detail || "The capture command wrote no error.",
        ...platformNotes(platform, display),
      ].join("\n"),
    }
  }

  const where = display === "all" ? "all displays" : "the primary display"
  const lines = [
    `Screen capture of ${where}.`,
    `${file} (${formatBytes(stat.size)})`,
    ...platformNotes(platform, display),
  ]

  if (stat.size > MAX_ATTACHMENT_BYTES) {
    lines.push(
      `The image is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}, so it is NOT attached to this result. ` +
        "Open it with the read tool if you need to look at it.",
    )
    return {
      title: `screenshot: ${where}`,
      metadata: { ...base, ok: true, path: file, bytes: stat.size, attached: false },
      output: lines.join("\n"),
    }
  }

  const bytes = await fs.readFile(file)
  return {
    title: `screenshot: ${where}`,
    metadata: { ...base, ok: true, path: file, bytes: stat.size, attached: true },
    output: lines.join("\n"),
    attachments: [
      {
        type: "file" as const,
        mime: "image/png",
        url: `data:image/png;base64,${bytes.toString("base64")}`,
      },
    ],
  }
}

/** The real runner: never throws, and never outlives {@link CAPTURE_TIMEOUT_MS}. */
function processRunner(abort: AbortSignal): Runner {
  return async (command) => {
    try {
      const out = await Process.run(command, {
        nothrow: true,
        // `Process` has no run deadline of its own - its `timeout` option is the
        // grace period between SIGTERM and SIGKILL - so the deadline arrives as
        // a signal, alongside the user's own cancellation.
        abort: AbortSignal.any([abort, AbortSignal.timeout(CAPTURE_TIMEOUT_MS)]),
        timeout: 5_000,
      })
      return { code: out.code, stderr: out.stderr.toString() }
    } catch (err) {
      // `nothrow` covers a failed process, not a spawn that throws outright:
      // an already-aborted signal, or a missing executable.
      return { code: 1, stderr: err instanceof Error ? err.message : String(err) }
    }
  }
}

/** What the user is shown. The pattern is the display mode rather than a path:
 *  the file is a temp name nobody has seen, and the only thing worth consenting
 *  to is how much of the desktop gets photographed. */
const patternFor = (display: Display) => (display === "all" ? "all displays" : "primary display")

export const ScreenshotTool = Tool.define(
  "screenshot",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    deferrable: true,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const display: Display = params.display ?? "primary"

        // Ask every time. Two halves, both load-bearing:
        // 1. `screenshot: "ask"` in the agent defaults (agent/agent.ts). The
        //    base ruleset is `"*": "allow"`, so an id nobody names there is
        //    silently allowed.
        // 2. `always: []` here. "Always allow" approves the patterns in this
        //    array; an empty array approves nothing, so the next capture asks
        //    again. A whole-screen grab can contain anything on the desktop.
        yield* ctx.ask({
          permission: "screenshot",
          patterns: [patternFor(display)],
          always: [],
          metadata: { display },
        })

        const file = captureFile(path.join(Global.Path.tmp, "screenshot"))
        return yield* Effect.promise(() =>
          capture({ platform: process.platform, display, file, run: processRunner(ctx.abort) }),
        )
      }).pipe(Effect.orDie),
  }),
)

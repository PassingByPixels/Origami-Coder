import { Effect, Exit, Scope, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@origami/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@origami/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { DEFAULT_IDLE_TIMEOUT_MS, MAX_TIMEOUT_MS, ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { BackgroundJob } from "@/background/job"
import { Interject } from "@/origami/interject" // origami_change
import { ShellTelemetry, type State as ShellTelemetryState } from "@/origami/shell-telemetry"
import { EventV2Bridge } from "@/event-v2-bridge"

// origami_change: shell telemetry continues through EventV2 after detachment.

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000

/**
 * Outer ceiling on ending a command we have decided to end. The spawner bounds
 * its own kill acknowledgement, so this is the backstop for the case that bound
 * cannot see: a kill that fails outright. `taskkill /pid <n> /T /F` against a
 * pid that has ALREADY exited reports "not found" and returns non-zero, which
 * is a FAILED effect, not a slow one - and a failed kill that was being died-on
 * turned a tool call into a defect while the user watched the card say
 * "running...". A target that is already gone is the outcome we wanted.
 */
const KILL_DEADLINE_MS = 15_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

/**
 * The one metadata shape every return path of this tool produces. Declared
 * rather than inferred, because the paths legitimately disagree about which
 * facts they carry - a backgrounded call has a job id and no exit code, a
 * finished one the reverse - and inference over that union settles on whichever
 * branch it reads first, then rejects the others.
 */
type ShellMetadata = {
  output: string
  exit: number | null
  truncated: boolean
  outputPath?: string
  /** Detached: this call did not wait for the command. */
  background?: boolean
  /** Detached BECAUSE it outlived its timeout, rather than by request. */
  promoted?: boolean
  jobId?: string
  state?: ShellTelemetryState
  startedAt?: number
  lastOutputAt?: number
  shellDisplay?: string
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

/**
 * The escape from a blocking call, written as the call itself. A killed command
 * is exactly the moment the model needs the background form, and "consider a
 * background task" is advice it has already proved it will not act on; a literal
 * argument object is something it can copy.
 */
function backgroundHint(command: string) {
  return `If the command has no end of its own - a server, a watcher, a tail - run it detached instead of blocking: call this tool with {"command": ${JSON.stringify(command)}, "background": true}. It returns a task id at once, streams output to a file you can Read or Grep, reports status through task_list and stops through task_stop.`
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const jobs = yield* BackgroundJob.Service
    const interjections = yield* Interject.Service // origami_change
    const events = yield* Effect.serviceOption(EventV2Bridge.Service)
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000
    const idleTimeoutMs = flags.bashIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    const backgroundMaxMs = flags.backgroundJobMaxDurationMs ?? BackgroundJob.DEFAULT_MAX_DURATION_MS

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        /**
         * Silence window, in ms, after which the command counts as hung. Omit
         * to race on the wall clock alone - which is what a DETACHED run wants,
         * because a server that says nothing for an hour is a server working.
         */
        idleTimeout?: number
        /** Stream every byte here from the first chunk, not only on overflow. */
        logPath?: string
        /** No `ctx.abort` arm: the run outlives the turn that started it. */
        detached?: boolean
        /**
         * On wall-clock expiry with the process STILL ALIVE, hand it to the
         * background registry instead of killing it. Off for a detached run,
         * which is already a job and has nowhere to be promoted to.
         */
        promoteOnExpiry?: boolean
        telemetryState?: ShellTelemetryState
        jobId?: string
        shellDisplay: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = input.logPath ?? ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false
      let idled = false
      /**
       * Set when the still-running process was handed to the background
       * registry at expiry. It is the one outcome where this call returns
       * WITHOUT the process being reaped, so it also decides whether the scope
       * below is closed here or by the job that now owns it.
       */
      // origami_change: `reason` rides the promotion - expiry and an
      // interjection take the same path but do not read the same to the model.
      let promotion: { jobId: string; logPath: string; reason: "timeout" | "interject" } | undefined
      /**
       * False once this call has settled. The output stream keeps running after
       * a promotion - that is the point - but `ctx.metadata` must stop, because
       * a settled tool call has no card left to update and writing to one is a
       * claim about something nobody is looking at.
       */
      let live = true
      // Wall-clock stamp of the last byte seen on stdout/stderr. Date.now, not
      // the Effect Clock, because it is written from inside the stream callback
      // where there is no fiber to yield on; every caller of this races on the
      // real clock.
      let lastOutput = Date.now()
      const startedAt = Date.now()
      let firstOutputAt: number | undefined
      let lastTelemetryAt = 0
      const telemetry = (
        status: "running" | "completed" | "error" | "cancelled",
        state = input.telemetryState ?? "foreground",
        exit?: number | null,
      ) =>
        events._tag === "None"
          ? Effect.void
          : events.value.publish(ShellTelemetry.Event.Updated, {
                sessionId: ctx.sessionID,
                toolCallId: ctx.callID ?? "",
                ...(input.jobId ? { jobId: input.jobId } : {}),
                state,
                status,
                startedAt,
                ...(firstOutputAt ? { lastOutputAt: lastOutput } : {}),
                output: ShellTelemetry.boundedOutput(last),
                ...(exit !== undefined ? { exit } : {}),
              }).pipe(Effect.asVoid, Effect.catch(() => Effect.void))
      // The silence window, or 0 for "not armed". It must be strictly SHORTER
      // than the wall clock to mean anything: at or above it the two arms fire
      // together and the race decides which reason the model is told, so a
      // plain timeout would be reported as a hang at random. Capping it to the
      // clock is therefore switching it OFF, not shrinking it.
      const idleLimit = input.idleTimeout !== undefined && input.idleTimeout < input.timeout ? input.idleTimeout : 0

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
          shellDisplay: input.shellDisplay,
        },
      })

      // The process scope is opened BY HAND rather than by `Effect.scoped`,
      // because one outcome - promotion at expiry - must return from this call
      // with the scope still open and the process still alive, owned by the
      // background job instead. `Effect.onExit` below restores the guarantee
      // `Effect.scoped` gave for every other outcome, interruption included.
      const scope = yield* Scope.make()
      const code: number | null = yield* Effect.gen(
        function* () {
          yield* Effect.addFinalizer(closeSink)
          // Opened INSIDE the scope, after the finalizer that closes it: a
          // stream created a line earlier is one an interrupt in between would
          // leave open with nobody holding a reference to it.
          if (input.logPath) sink = createWriteStream(input.logPath, { flags: "a" })
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              lastOutput = Date.now()
              firstOutputAt ??= lastOutput
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)
              const publishTelemetry = lastOutput - lastTelemetryAt >= 250
              if (publishTelemetry) lastTelemetryAt = lastOutput

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          shellDisplay: input.shellDisplay,
                        },
                      }),
                    ),
                  )
                }
              }

              if (!live) return publishTelemetry ? telemetry("running") : Effect.void
              return ctx.metadata({
                metadata: {
                  output: last,
                  shellDisplay: input.shellDisplay,
                },
              }).pipe(Effect.andThen(publishTelemetry ? telemetry("running") : Effect.void))
            }),
          )

          const abort = input.detached
            ? Effect.never
            : Effect.callback<void>((resume) => {
                if (ctx.abort.aborted) return resume(Effect.void)
                const handler = () => resume(Effect.void)
                ctx.abort.addEventListener("abort", handler, { once: true })
                return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
              })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          // The silence watchdog. It re-checks rather than sleeping once,
          // because every chunk moves the deadline forward - a command that
          // prints one line a minute is working, not hung.
          const idle =
            idleLimit > 0
              ? Effect.gen(function* () {
                  while (true) {
                    const quiet = Date.now() - lastOutput
                    if (quiet >= idleLimit) return
                    yield* Effect.sleep(`${idleLimit - quiet} millis`)
                  }
                })
              : Effect.never

          // origami_change-start (interject): the fifth arm. A foreground
          // command that runs for minutes never reaches a tool boundary, so
          // the user's queued message would wait behind it however urgent it
          // is. Completing this signal takes the SAME promotion path expiry
          // takes - the process is untouched and its output keeps streaming -
          // which settles this call and lets the turn read the message. A
          // detached run has no `promoteOnExpiry`, so it never arms.
          const interjected = input.promoteOnExpiry ? interjections.wait(ctx.sessionID) : Effect.never
          // origami_change-end

          // Hand the still-live process to the registry. Shared by expiry and
          // by an interjection, because "the work already done survives" is
          // the same requirement whichever brought the deadline forward.
          // Returns false when there is nothing to promote - a process that is
          // already gone, or a run with nowhere to be promoted to.
          const promote = Effect.fnUntraced(function* (reason: "timeout" | "interject") {
            const running = yield* handle.isRunning.pipe(Effect.catch(() => Effect.succeed(false)))
            if (!input.promoteOnExpiry || !running) return false
            // Output must go to a FILE from here on: the tool call it was
            // streaming to is about to settle, so the metadata channel stops
            // being a place anyone reads.
            const logPath = file || (yield* trunc.write(list.map((item) => item.text).join("")))
            if (!sink) sink = createWriteStream(logPath, { flags: "a" })
            file = logPath
            live = false
            const job = yield* jobs.start({
              type: ShellID.ToolID,
              title: input.command,
              maxDurationMs: backgroundMaxMs,
              metadata: {
                background: true,
                promoted: true,
                sessionId: ctx.sessionID,
                command: input.command,
                logPath,
              },
              // The job now OWNS the process scope: it closes it when the
              // command ends, and `ensuring` means a `task_stop` interrupt
              // closes it too - which runs the spawner's release and
              // tree-kills the process. Without that, stopping the task
              // would only forget about it.
              run: handle.exitCode.pipe(
                Effect.tap((value) => telemetry(value === 0 ? "completed" : "error", "promoted", value)),
                Effect.map((value) => `Command exited with code ${value}. Full output: ${logPath}`),
                Effect.catch(() => Effect.succeed(`Command ended without an exit code. Full output: ${logPath}`)),
                Effect.onInterrupt(() => telemetry("cancelled", "promoted")),
                Effect.ensuring(Scope.close(scope, Exit.void)),
              ),
            })
            promotion = { jobId: job.id, logPath, reason }
            input.jobId = job.id
            yield* telemetry("running", "promoted")
            return true
          })

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
            idle.pipe(Effect.map(() => ({ kind: "idle" as const, code: null }))),
            // origami_change: the user pushed a message into the running turn.
            interjected.pipe(Effect.map(() => ({ kind: "interject" as const, code: null }))),
          ])

          // Ending the command, bounded and failure-tolerant. `Effect.orDie`
          // used to sit here, which made the two ways a kill goes wrong both
          // fatal to a call the user was already waiting on: an unacknowledged
          // kill hung it, and a kill that FAILED - `taskkill` on a pid that had
          // already exited, which is precisely the wedged-parent case - turned
          // it into a defect. Neither is a reason to withhold the output we
          // have; a target that will not die is reported through the metadata
          // note below, not by never answering.
          const reap = Effect.ignore(
            Effect.timeoutOrElse(handle.kill({ forceKillAfter: "3 seconds" }), {
              duration: `${KILL_DEADLINE_MS} millis`,
              orElse: () => Effect.void,
            }),
          )

          if (exit.kind === "abort") {
            aborted = true
            yield* reap
          }
          if (exit.kind === "timeout") {
            // A command that is STILL RUNNING at expiry has not failed - it is
            // longer than the caller guessed. Killing it and printing the
            // background call to copy left the model to run the whole thing
            // again from zero; hand the live process to the registry instead,
            // and the work already done survives the deadline. Only a process
            // that is already gone (or a run with nowhere to be promoted to)
            // takes the kill path.
            if (yield* promote("timeout")) return null
            expired = true
            yield* reap
          }
          // origami_change-start (interject): promoted for the user's message,
          // never killed for it. Losing this race to `exit` is possible - the
          // command finished in the same instant - and that is not a promotion
          // failure, so report the real exit rather than invent an outcome.
          if (exit.kind === "interject") {
            if (yield* promote("interject")) return null
            return yield* handle.exitCode.pipe(Effect.catch(() => Effect.succeed(null)))
          }
          // origami_change-end
          if (exit.kind === "idle") {
            idled = true
            yield* reap
          }

          return exit.kind === "exit" ? exit.code : null
        },
      ).pipe(
        Scope.provide(scope),
        // The guarantee `Effect.scoped` used to give, minus the one case it
        // cannot express: a promoted process is owned by its job now, and
        // closing the scope here would kill the very command we just told the
        // model was still running. Every other exit - success, failure,
        // interruption - closes it exactly as before.
        Effect.onExit((exit) => (promotion ? Effect.void : Scope.close(scope, exit))),
        Effect.orDie,
      )

      // Settled: the stream fiber, if a promotion left one running, must stop
      // writing to this call's card from here.
      live = false
      if (!promotion) yield* telemetry(code === 0 ? "completed" : aborted ? "cancelled" : "error", undefined, code)

      if (promotion) {
        const metadata: ShellMetadata = {
          output: last,
          exit: null,
          truncated: false,
          background: true,
          promoted: true,
          jobId: promotion.jobId,
          outputPath: promotion.logPath,
          state: "promoted",
          startedAt,
          ...(firstOutputAt ? { lastOutputAt: lastOutput } : {}),
          shellDisplay: input.shellDisplay,
        }
        return {
          title: input.command,
          metadata,
          output: [
            promotion.reason === "interject"
              ? // origami_change: promoted to reach a tool boundary, not on a deadline.
                `The user sent you a message, so this command was moved into the background rather than killed - it is task ${promotion.jobId} and it is still going.`
              : `The command was STILL RUNNING after its ${input.timeout} ms timeout, so it was moved into the background rather than killed - it is task ${promotion.jobId} and it is still going.`,
            `Command: ${input.command}`,
            `You do not need to run it again. Its output - including everything printed before the timeout - streams to ${promotion.logPath}; Read or Grep that file when you want to know what it has done.`,
            `task_list reports whether it is still running; task_stop with task_id ${promotion.jobId} ends it and every process under it.`,
            `Do NOT poll it with repeated shell calls.`,
          ].join("\n"),
        }
      }

      const meta: string[] = []
      if (expired) {
        // The old text told the model to "retry with a larger timeout" whatever
        // had happened, which turned every hung command into a ladder of longer
        // and longer blocking calls. Name the two real causes instead, and give
        // background work an exit that is not another blocking call. The
        // background line spells the call out rather than describing it: an
        // instruction to "use the task tool" is what the model was already
        // ignoring, and this tool can now do it itself.
        meta.push(
          [
            `shell tool terminated command after exceeding timeout ${input.timeout} ms.`,
            `Decide which of these it is before you run anything again.`,
            `If the command was waiting for interactive input, change the command so it cannot wait - a larger timeout will not help it.`,
            `If it is genuinely long-running, either retry it ONCE with a single timeout sized to how long it really takes (maximum ${MAX_TIMEOUT_MS} ms), or start it as a background task with the task tool and carry on with other work.`,
            `Do NOT poll it with repeated short blocking calls.`,
            backgroundHint(input.command),
          ].join(" "),
        )
      }
      if (idled) {
        meta.push(
          [
            `shell tool killed the command: it produced no output for ${idleLimit} ms, so it was treated as hung.`,
            `It did not run out of time - it went silent, which is what a command waiting for input or a server with nothing to say both look like.`,
            `A longer timeout fixes neither, so do NOT simply retry with one.`,
            `If it was waiting for input, change the command so it cannot wait.`,
            backgroundHint(input.command),
          ].join(" "),
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      const metadata: ShellMetadata = {
        output: last || preview(output),
        exit: code,
        truncated: cut,
        state: "foreground",
        startedAt,
        ...(firstOutputAt ? { lastOutputAt: lastOutput } : {}),
        shellDisplay: input.shellDisplay,
        ...(cut && file ? { outputPath: file } : {}),
      }
      return {
        title: input.command,
        metadata,
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const shellDisplay = Shell.ps(shell) ? "PowerShell" : name === "cmd" ? "cmd" : "Bash"
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs, idleTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              // The schema carries the same bound, so a provider that validates
              // arguments rejects this first. This is the guard for the callers
              // that do not - the cap is what keeps one blocking call bounded.
              if (params.timeout !== undefined && params.timeout > MAX_TIMEOUT_MS) {
                throw new Error(
                  `Invalid timeout value: ${params.timeout}. The maximum timeout is ${MAX_TIMEOUT_MS} ms. Run a longer job as a background task with the task tool instead of blocking on it here.`,
                )
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              const env = yield* shellEnv(ctx, cwd)

              if (params.background === true) {
                // Detached: the run belongs to the background registry, not to
                // this turn. No `ctx.abort` arm (the turn ending must not kill a
                // server the model deliberately started) and no silence
                // watchdog (silence is a server's normal state). What bounds it
                // instead is the registry's own max-duration watchdog.
                //
                // Output goes to a file from the first byte, because the tool
                // call it belongs to is already finished by then: nothing is
                // listening to the stream, so a file the model can Read or Grep
                // is the only honest channel. `ctx.metadata` is stubbed out for
                // the same reason - writing to a settled tool call is a claim
                // about a card nobody is looking at.
                const logPath = yield* trunc.write("")
                const detachedCtx: Tool.Context = { ...ctx, metadata: () => Effect.void }
                const jobId = `shell-${ctx.callID}`
                const startedAt = Date.now()
                const job = yield* jobs.start({
                  id: jobId,
                  type: ShellID.ToolID,
                  title: params.command,
                  maxDurationMs: backgroundMaxMs,
                  metadata: {
                    background: true,
                    sessionId: ctx.sessionID,
                    command: params.command,
                    logPath,
                  },
                  run: run(
                    {
                      shell,
                      command: params.command,
                      cwd,
                      env,
                      timeout: params.timeout ?? backgroundMaxMs,
                      logPath,
                      detached: true,
                      telemetryState: "background",
                      jobId,
                      shellDisplay,
                    },
                    detachedCtx,
                  ).pipe(Effect.map((result) => result.output)),
                })
                const metadata: ShellMetadata = {
                  output: "",
                  exit: null,
                  truncated: false,
                  background: true,
                  jobId: job.id,
                  outputPath: logPath,
                  state: "background",
                  startedAt,
                  shellDisplay,
                }
                return {
                  title: params.command,
                  metadata,
                  output: [
                    `Started in the background as task ${job.id}. This turn is not waiting for it.`,
                    `Command: ${params.command}`,
                    `Its output streams to ${logPath} - Read or Grep that file when you want to know what it has done.`,
                    `task_list reports whether it is still running; task_stop with task_id ${job.id} ends it and every process under it.`,
                    `Do NOT poll it with repeated shell calls.`,
                  ].join("\n"),
                }
              }

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env,
                  timeout,
                  idleTimeout: idleTimeoutMs,
                  // Expiry with the process still alive is a mis-sized
                  // timeout, not a failure: promote it. Silence is NOT
                  // promoted - a command with nothing to say is the shape of
                  // one waiting for input, and backgrounding that would leave
                  // it waiting forever instead of ending it.
                  promoteOnExpiry: true,
                  shellDisplay,
                },
                ctx,
              )
            }),
        }
      })
  }),
)

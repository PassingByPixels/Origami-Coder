import { PermissionV1 } from "@origami/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import type * as Scope from "effect/Scope"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@origami/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { MAX_TIMEOUT_MS } from "@/tool/shell/prompt"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { FSUtil } from "@origami/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { BackgroundJob } from "@/background/job"
import { Interject } from "@/origami/interject"
import { TaskListTool } from "@/tool/task_list"
import { TaskStopTool } from "@/tool/task_stop"
import { execSync } from "node:child_process"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      // The shell tool now owns the `background: true` escape, so it needs the
      // job registry the detached run is filed in.
      BackgroundJob.node,
      Interject.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Omit<Tool.InferParameters<typeof ShellTool>, "explanation"> & { explanation?: string },
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute({ ...args, explanation: args.explanation ?? "Run the shell test command" }, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Omit<Tool.InferParameters<typeof ShellTool>, "explanation"> & { explanation?: string },
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
/**
 * Is this pid a LIVE process? Asked through the platform's own process table
 * (`tasklist` / `ps`) rather than `process.kill(pid, 0)`, because the signal-0
 * probe answers "can I open a handle to it", which a terminated-but-unreaped
 * process on Windows still satisfies - i.e. it can report a corpse as alive.
 */
const alive = (pid: number) => {
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: "utf-8", windowsHide: true })
      return out.includes(`"${pid}"`)
    }
    return execSync(`ps -p ${pid} -o pid=`, { encoding: "utf-8" }).trim().length > 0
  } catch {
    return false
  }
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const capture = (requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  each("basic", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo test",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      }),
    ),
  )

  it.live("falls back from terminal-only configured shell", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { shell: "fish" } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          const fallback = Shell.name(Shell.acceptable("fish"))
          expect(fallback).not.toBe("fish")
          expect(bash.description).toContain(fallback)

          const result = yield* bash.execute(
            {
              explanation: "Verify the configured shell fallback",
              command: "echo fallback",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo hello")
        }),
      )
    }),
  )

  each("asks for bash permission with multiple commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo foo")
          expect(requests[0].patterns).toContain("echo bar")
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.always).toContain("Remove-Item *")
              expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
            }),
          )
        }),
      ),
    )
  }

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      }),
    ),
  )

  if (process.platform === "win32") {
    if (bash) {
      it.live("asks for nested bash command permissions [bash]", () =>
        withShell(
          { label: "bash", shell: bash },
          Effect.gen(function* () {
            const outerTmp = yield* tmpdirScoped()
            yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
            yield* runIn(
              projectRoot,
              Effect.gen(function* () {
                const file = path.join(outerTmp, "outside.txt").replaceAll("\\", "/")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
                  },
                  capture(requests),
                )
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const bashReq = requests.find((r) => r.permission === "bash")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp, "*")))
                expect(bashReq).toBeDefined()
                expect(bashReq!.patterns).toContain(`cat "${file}"`)
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell paths after switches [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for nested PowerShell command permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $HOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for missing PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = "ORIGAMI_TEST_MISSING"
              const prev = process.env[key]
              delete process.env[key]
              return { key, prev }
            }),
            ({ key }) =>
              runIn(
                projectRoot,
                Effect.gen(function* () {
                  const err = new Error("stop after permission")
                  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                      },
                      capture(requests, err),
                    ),
                  ).toMatchObject({ message: err.message })
                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  expect(extDirReq).toBeDefined()
                  expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
                }),
              ),
            ({ key, prev }) =>
              Effect.sync(() => {
                if (prev === undefined) delete process.env[key]
                else process.env[key] = prev
              }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for braced PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`treats Set-Location like cd for permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not add nested PowerShell expressions to permission prompts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
                },
                capture(requests),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            }),
          ),
        ),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          }),
        ),
      ),
    )
  }

  each("asks for external_directory permission when cd to parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
        }),
      )
    }),
  )

  each("asks for external_directory permission when workdir is outside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
        }),
      )
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes external_directory workdir variants on Windows", () =>
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const outerTmp = yield* tmpdirScoped()
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const want = Filesystem.normalizePathPattern(path.join(outerTmp, "*"))

            for (const dir of forms(outerTmp)) {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })

              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                dir,
                patterns: [want],
                always: [want],
              })
            }
          }),
        )
      }),
    )

    if (bash) {
      it.live("uses Git Bash /tmp semantics for external workdir", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )

      it.live("uses Git Bash /tmp semantics for external file paths", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/origami-does-not-exist",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", () =>
    Effect.gen(function* () {
      const outerTmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
          expect(extDirReq!.metadata).toMatchObject({
            command: `cat ${filepath}`,
            directories: [outerTmp],
            patterns: [expected],
          })
        }),
      )
    }),
  )

  each("does not ask for external_directory permission when rm inside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp, "tmpfile"), "x"))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `rm -rf ${path.join(tmp, "nested")}`,
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        }),
      )
    }),
  )

  each("includes always patterns for auto-approval", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git log --oneline -5",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].always.length).toBeGreaterThan(0)
          expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
        }),
      )
    }),
  )

  each("does not ask for bash permission when command is cd only", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeUndefined()
        }),
      )
    }),
  )

  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(yield* fail({ command: "echo test > output.txt" }, capture(requests, err))).toMatchObject({
            message: err.message,
          })
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  each("always pattern has space before wildcard to not include different commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: "ls -la" }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe("ls *")
        }),
      )
    }),
  )
})

describe("tool.shell abort", () => {
  it.live(
    "preserves output when aborted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const collected: string[] = []
          const res = yield* run(
            {
              command: `echo before && sleep 30`,
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          )
          expect(res.output).toContain("before")
          expect(res.output).toContain("User aborted the command")
          expect(collected.length).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )

  // RESTATED (t-kgs7om). This test used to assert that a timeout KILLS. It no
  // longer does when the process is still alive: the expiry hands the live
  // process to the background registry, because a command that outlives its
  // clock has been mis-sized, not failed, and killing it threw away work the
  // model then had to redo from zero. What survives unchanged is the property
  // the old assertions were really about — a blocking call ends at its
  // deadline, and the model is never sent back into another blocking wait.
  it.live(
    "ends the blocking wait at the deadline and hands the work on, without inviting a longer wait",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const started = Date.now()
          const result = yield* run({
            command: `sleep 60`,
            timeout: 500,
          })
          // The turn is released at the deadline. That was always the point.
          expect(Date.now() - started).toBeLessThan(10_000)
          expect(result.output).toContain("STILL RUNNING after its 500 ms timeout")
          expect(result.output).not.toContain("retry with a larger timeout")
          expect(result.output).toContain("Do NOT poll it with repeated shell calls")
          const jobId = (result.metadata as { jobId?: string }).jobId!
          yield* (yield* BackgroundJob.Service).cancel(jobId)
        }),
      ),
    15_000,
  )

  it.live("rejects a timeout larger than the maximum instead of blocking for it", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        // Rejected at the tool boundary by the parameter schema, so the call
        // never reaches a shell and never holds the turn open.
        const err = yield* fail({ command: `echo hi`, timeout: MAX_TIMEOUT_MS + 1 })
        expect(err.message).toContain(`${MAX_TIMEOUT_MS}`)
        expect(err.message).toContain(`${MAX_TIMEOUT_MS + 1}`)
      }),
    ),
  )

  it.live("accepts a timeout exactly at the maximum", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({ command: `echo hi`, timeout: MAX_TIMEOUT_MS })
        expect(result.metadata.exit).toBe(0)
      }),
    ),
  )

  it.live("tells the model the maximum timeout it may ask for, and the schema holds it to that", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const tool = yield* initShell()
        expect(tool.description).toContain(`The largest timeout you can ask for is ${MAX_TIMEOUT_MS}ms`)
        const decode = Schema.decodeUnknownExit(tool.parameters)
        expect(Exit.isSuccess(decode({ explanation: "Print a greeting", command: "echo hi", timeout: MAX_TIMEOUT_MS }))).toBe(true)
        expect(Exit.isFailure(decode({ explanation: "Print a greeting", command: "echo hi", timeout: MAX_TIMEOUT_MS + 1 }))).toBe(true)
        expect(Exit.isFailure(decode({ command: "echo hi" }))).toBe(true)
      }),
    ),
  )

  it.live(
    "uses RuntimeFlags bashDefaultTimeoutMs when timeout is omitted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const tool = yield* initShell()
          expect(tool.description).toContain("commands will time out after 500ms")
          const result = yield* tool.execute(
            {
              explanation: "Run until the configured timeout",
              command: `sleep 60`,
            },
            ctx,
          )
          // The subject here is the FLAG, not what expiry does with it: the
          // deadline the call actually ran to has to be the configured 500 ms.
          expect(result.output).toContain("its 500 ms timeout")
          yield* (yield* BackgroundJob.Service).cancel((result.metadata as { jobId?: string }).jobId!)
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 500 }))),
    15_000,
  )

  // --- hang protection: silence, not elapsed time, is what identifies a hang ---

  // `;` is the sequential separator in both bash and every PowerShell; cmd
  // wants `&`, and its `timeout` has one-second granularity, so the chatty
  // case below cannot be expressed there.
  const seq = (parts: string[]) => parts.join(sh() === "cmd" ? " & " : "; ")

  it.live(
    "kills a command that goes SILENT long before its timeout expires",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const command = seq(["echo hi", "sleep 30"])
          const started = Date.now()
          const result = yield* run({ command, timeout: 20_000 })
          const elapsed = Date.now() - started
          // The wall clock had 20 s left to run. Returning inside a few seconds
          // is the whole claim: something OTHER than the timeout ended it.
          expect(elapsed).toBeLessThan(10_000)
          expect(result.output).toContain("hi")
          expect(result.output).toContain("produced no output for 400 ms")
          expect(result.output).not.toContain("exceeding timeout")
          // A killed-for-silence command must not be sent back into a longer
          // blocking call; it must be sent to the background form, spelled out.
          expect(result.output).toContain(`"command": ${JSON.stringify(command)}`)
          expect(result.output).toContain(`"background": true`)
          expect(result.metadata.exit).toBe(null)
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashIdleTimeoutMs: 400 }))),
    30_000,
  )

  if (sh() !== "cmd") {
    it.live(
      "leaves a chatty command alone: every chunk moves the silence deadline",
      () =>
        runIn(
          projectRoot,
          Effect.gen(function* () {
            // Ticks every 150 ms for ~900 ms, twice the 400 ms silence window.
            // A watchdog that slept ONCE for the window would kill this.
            const parts: string[] = []
            for (let i = 0; i < 7; i++) parts.push(`echo tick${i}`, "sleep 0.15")
            const result = yield* run({ command: seq(parts), timeout: 20_000 })
            expect(result.metadata.exit).toBe(0)
            expect(result.output).toContain("tick0")
            expect(result.output).toContain("tick6")
            expect(result.output).not.toContain("produced no output")
          }),
        ).pipe(Effect.provide(RuntimeFlags.layer({ bashIdleTimeoutMs: 400 }))),
      30_000,
    )
  }

  it.live(
    "the description states the silence rule with its real precondition, not as an unconditional one",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const tool = yield* initShell()
          // The watchdog is armed only when the caller asks for a clock longer
          // than the window. Describing it unconditionally would be a claim the
          // engine does not honour on a default call.
          expect(tool.description).toContain("If you ask for a timeout LONGER than 400ms")
          expect(tool.description).toContain("no output at all for 400ms is killed as hung")
          expect(tool.description).toContain("`background: true`")
          expect(tool.description).toContain("task_stop")
          // The two expiries do DIFFERENT things now, and a description that
          // said "timeout" and meant "killed" is the sentence that sends the
          // model off to re-run work that is still going.
          expect(tool.description).toContain("Reaching the timeout does NOT kill a command that is still working")
          expect(tool.description).toContain("Do not run the command again")
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashIdleTimeoutMs: 400 }))),
  )

  it.live(
    "a silence window that is not SHORTER than the clock is off, so a plain timeout still reads as one",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          // Armed at the same instant as the wall clock, the two arms race and
          // the model is told a hang or a timeout at random. Equal means off.
          const result = yield* run({ command: `sleep 30`, timeout: 400 })
          // The WALL CLOCK arm won, not the silence arm - that is still the
          // claim; what expiry then does with the process changed (t-kgs7om).
          expect(result.output).toContain("its 400 ms timeout")
          expect(result.output).not.toContain("produced no output")
          yield* (yield* BackgroundJob.Service).cancel((result.metadata as { jobId?: string }).jobId!)
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashIdleTimeoutMs: 400 }))),
    15_000,
  )

  // RESTATED (t-kgs7om). Spelling out the `background: true` call to copy was
  // the 0.3.58 answer to a timeout, and it FAILED live: the model was handed
  // an argument object and a dead command, and had to start again. Expiry now
  // does the backgrounding itself, so the notice names the task that ALREADY
  // exists rather than a call the model would have to make.
  it.live(
    "the timeout notice names the task that now exists, not a call the model must still make",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({ command: `sleep 60`, timeout: 500 })
          const jobId = (result.metadata as { jobId?: string }).jobId!
          expect(result.output).toContain(`task_stop with task_id ${jobId}`)
          expect(result.output).not.toContain(`"background": true`)
          yield* (yield* BackgroundJob.Service).cancel(jobId)
        }),
      ),
    15_000,
  )

  it.live(
    "background: true returns a task id at once and task_stop reaches the run",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const started = Date.now()
          const result = yield* run({ command: `sleep 60`, background: true })
          const elapsed = Date.now() - started
          // The command sleeps for a minute. Anything but an immediate return
          // means the turn is still being held, which is the defect itself.
          expect(elapsed).toBeLessThan(5_000)
          const meta = result.metadata as { background?: boolean; jobId?: string; outputPath?: string; exit?: unknown }
          expect(meta.background).toBe(true)
          expect(meta.exit).toBe(null)
          const jobId = meta.jobId
          expect(typeof jobId).toBe("string")
          expect(result.output).toContain(`Started in the background as task ${jobId}`)
          expect(result.output).toContain(meta.outputPath!)
          expect(yield* Effect.promise(() => Bun.file(meta.outputPath!).exists())).toBe(true)

          // Through the REAL tools the result tells the model to use, not through
          // the registry behind them.
          const listTool = yield* Tool.init(yield* TaskListTool)
          const listed = yield* listTool.execute({}, ctx)
          expect(listed.output).toContain(jobId!)
          expect(listed.output).toContain("[running]")

          const stopTool = yield* Tool.init(yield* TaskStopTool)
          const stopped = yield* stopTool.execute({ task_id: jobId! }, ctx)
          expect(stopped.metadata.status).toBe("cancelled")
        }),
      ),
    30_000,
  )

  it.live(
    "background: true survives the turn's abort signal - the turn ending must not kill a server",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const result = yield* run({ command: `sleep 60`, background: true }, { ...ctx, abort: controller.signal })
          const jobId = (result.metadata as { jobId?: string }).jobId!
          controller.abort()
          yield* Effect.sleep("300 millis")
          const jobs = yield* BackgroundJob.Service
          expect((yield* jobs.get(jobId))?.status).toBe("running")
          yield* jobs.cancel(jobId)
        }),
      ),
    30_000,
  )

  // RESTATED (t-kgs7om). The tree-kill property is unchanged and still the
  // point; what moved is WHICH event performs it. A timeout no longer kills a
  // live process - it promotes it - so the reaping now happens when the task is
  // STOPPED. Asserting it on the old trigger would have quietly stopped testing
  // tree-kill at all, which is why this is restated rather than deleted: the
  // grandchild is two levels below the handle the spawner holds, and nothing
  // else in the suite proves it dies.
  it.live(
    "task_stop on a promoted command kills the WHOLE process tree, not just the shell",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const beat = path.join(dir, "beat.txt").replaceAll("\\", "/")
        const pidFile = path.join(dir, "child.pid").replaceAll("\\", "/")
        const child = path.join(dir, "child.ts").replaceAll("\\", "/")
        const parent = path.join(dir, "parent.ts").replaceAll("\\", "/")
        // Grandchild: proves it is RUNNING by appending to a file, which is a
        // stronger claim than "a pid lookup failed" - a terminated process can
        // linger in the table while a stopped one cannot write.
        yield* Effect.promise(() =>
          Bun.write(
            child,
            `import {appendFileSync} from "fs"\nwhile(true){appendFileSync(${JSON.stringify(beat)},"x");await Bun.sleep(60)}\n`,
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            parent,
            `import {writeFileSync} from "fs"\nconst p = Bun.spawn([${JSON.stringify(process.execPath)},"run",${JSON.stringify(child)}],{stdout:"inherit",stderr:"inherit"})\nwriteFileSync(${JSON.stringify(pidFile)}, String(p.pid))\nawait Bun.sleep(600000)\n`,
          ),
        )

        const text = `${quote(process.execPath.replaceAll("\\", "/"))} run ${quote(parent)}`
        yield* runIn(
          dir,
          Effect.gen(function* () {
            const result = yield* run({ command: PS.has(sh()) ? `& ${text}` : text, timeout: 2_000 })
            // Still alive at the deadline, so it was promoted rather than
            // reaped - the precondition for the rest of this test.
            const jobId = (result.metadata as { jobId?: string }).jobId!
            expect(typeof jobId).toBe("string")
            const stopTool = yield* Tool.init(yield* TaskStopTool)
            const stopped = yield* stopTool.execute({ task_id: jobId }, ctx)
            expect(stopped.metadata.status).toBe("cancelled")
          }),
        )

        // shell -> bun (parent.ts) -> bun (child.ts): the grandchild is two
        // levels below the process the spawner holds a handle to.
        const pid = Number((yield* Effect.promise(() => Bun.file(pidFile).text())).trim())
        expect(Number.isInteger(pid)).toBe(true)
        const size = () => Bun.file(beat).size
        expect(yield* Effect.sync(size)).toBeGreaterThan(0)
        const before = yield* Effect.sync(size)
        yield* Effect.sleep("1500 millis")
        expect(yield* Effect.sync(size)).toBe(before)
        expect(yield* Effect.sync(() => alive(pid))).toBe(false)
      }),
    45_000,
  )

  if (process.platform !== "win32") {
    it.live("captures stderr in output", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo stdout_msg && echo stderr_msg >&2`,
          })
          expect(result.output).toContain("stdout_msg")
          expect(result.output).toContain("stderr_msg")
          expect(result.metadata.exit).toBe(0)
        }),
      ),
    )
  }

  it.live("returns non-zero exit code", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `exit 42`,
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  it.live("streams metadata updates progressively", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const updates: string[] = []
        const result = yield* run(
          {
            command: `echo first && sleep 0.1 && echo second`,
          },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                const output = (input.metadata as { output?: string })?.output
                if (output) updates.push(output)
              }),
          },
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThanOrEqual(1)
      }),
    ),
  )
})

describe("tool.shell truncation", () => {
  it.live("truncates output exceeding line limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 500
        const result = yield* run({
          command: fill("lines", lineCount),
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("truncates output exceeding byte limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("does not truncate small output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: fill("lines", 1),
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("1")
      }),
    ),
  )

  it.live("full output is saved to file when truncated", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 100
        const result = yield* run({
          command: fill("lines", lineCount),
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* FSUtil.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      }),
    ),
  )
})

// The 0.3.58 hang protection failed live: a bash call that started a server -
// print a banner, launch it detached, exit - sat at "running..." for 22 minutes,
// past a 10-minute cap, with its shell process ALREADY DEAD and only the
// detached grandchild alive. These tests reproduce that exact shape, because
// every one of the earlier hang tests used a command that stays in the
// foreground, which is the one case the defect could not reach.
describe("tool.shell hang recovery", () => {
  const chain = (parts: string[]) => parts.join(sh() === "cmd" ? " & " : "; ")
  const invoke = (text: string) => (PS.has(sh()) ? `& ${text}` : text)
  const kill = (pid: number) => {
    try {
      if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: "ignore" })
      else process.kill(pid, "SIGKILL")
    } catch {
      // Already gone is the outcome we wanted.
    }
  }

  /**
   * Writes the `Start-Process` shape as two real scripts: a parent that prints,
   * launches a grandchild with its OWN stdout/stderr, and exits at once; and a
   * grandchild that outlives it holding those inherited pipes. `lifeMs` is a
   * hard ceiling on the grandchild so a regression here cannot leave a process
   * running on the machine after the suite ends.
   */
  const detachedServer = Effect.fn("ShellToolTest.detachedServer")(function* (dir: string, lifeMs: number) {
    const pidFile = path.join(dir, "child.pid").replaceAll("\\", "/")
    const child = path.join(dir, "child.ts").replaceAll("\\", "/")
    const parent = path.join(dir, "parent.ts").replaceAll("\\", "/")
    yield* Effect.promise(() =>
      Bun.write(child, `const end = Date.now() + ${lifeMs}\nwhile (Date.now() < end) await Bun.sleep(50)\n`),
    )
    yield* Effect.promise(() =>
      Bun.write(
        parent,
        [
          `import {writeFileSync} from "fs"`,
          `import {spawn} from "child_process"`,
          `console.log("server started")`,
          // `detached` + INHERITED stdout/stderr is the whole scenario in one
          // line: the grandchild leaves the parent's process group AND keeps
          // the very pipes the spawner reads, so `close` cannot fire while it
          // lives. Deliberately node's spawn and not `Bun.spawn` - bun puts its
          // children in a job object that reaps them when it exits, which is
          // the opposite of the shape under test (proven: with `Bun.spawn` the
          // grandchild was already dead by the time the call returned).
          `const p = spawn(${JSON.stringify(process.execPath)},["run",${JSON.stringify(child)}],{detached:true,stdio:["ignore",1,2]})`,
          `writeFileSync(${JSON.stringify(pidFile)}, String(p.pid))`,
          `p.unref()`,
        ].join("\n"),
      ),
    )
    return { command: invoke(`${bin} run ${quote(parent)}`), pidFile }
  })

  it.live(
    "returns when the SHELL exits, even though a detached grandchild still holds its stdio pipes",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const server = yield* detachedServer(dir, 25_000)
        const started = Date.now()
        const result = yield* runIn(dir, run({ command: server.command, timeout: 30_000 }))
        const elapsed = Date.now() - started

        // THE claim. The shell prints and exits inside a second; thirty seconds
        // of wall clock were deliberately left on the table. Returning here can
        // only mean the race settled on the process EXIT - settling on stream
        // close would have waited for the grandchild, which is the 22-minute
        // card.
        expect(elapsed).toBeLessThan(12_000)
        expect(result.output).toContain("server started")
        expect(result.metadata.exit).toBe(0)
        expect(result.output).not.toContain("exceeding timeout")

        // ...and the grandchild really did outlive its parent, or the scenario
        // under test never happened and the assertion above proves nothing.
        const pid = Number((yield* Effect.promise(() => Bun.file(server.pidFile).text())).trim())
        expect(Number.isInteger(pid)).toBe(true)
        expect(yield* Effect.sync(() => alive(pid))).toBe(true)
        yield* Effect.sync(() => kill(pid))
      }),
    60_000,
  )

  it.live(
    "a kill aimed at an already-dead shell settles the call instead of hanging or dying",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const server = yield* detachedServer(dir, 25_000)
        // The registry is instance-scoped, so `jobs.get` has to run inside the
        // same instance the call did - reading it from outside dies on a
        // missing InstanceRef rather than telling you anything about the job.
        return yield* runIn(
          dir,
          Effect.gen(function* () {
            // Detached, so there is no promotion arm: expiry goes straight to
            // the kill. The clock is HALF the exit-settlement grace so it fires
            // AFTER the shell has exited (it does so as soon as bun starts,
            // ~0.1-0.5 s) but BEFORE that grace elapses - the window in which
            // the process is gone and `taskkill /pid` reports "not found".
            // Derived from the constant so a change to the grace moves this
            // test's window with it instead of silently invalidating it.
            const timeout = Math.floor(CrossSpawnSpawner.EXIT_SETTLE_GRACE_MS / 2)
            const result = yield* run({ command: server.command, background: true, timeout })
            const jobId = (result.metadata as { jobId?: string }).jobId!
            const jobs = yield* BackgroundJob.Service

            // `completed` is the whole assertion, and it is three claims in
            // one: the kill did not hang (that leaves the job `running` for its
            // full 30-minute ceiling), it was not died on (that settles the job
            // `error`), and the call still produced its output.
            //
            // Honest scope: this is a REGRESSION GUARD, not a proof of the
            // bounded kill. Break-checked by restoring the pre-fix
            // `kill(...).pipe(Effect.orDie)` - it still passed, because Windows
            // keeps the pid valid while the spawner holds an open handle to it,
            // so `taskkill` returns 0 rather than failing, and the await after
            // it is already bounded by the exit-settlement grace. The branch the
            // deadline exists for - a target that never acknowledges - is not
            // reachable from this tool's surface on this platform.
            let status: string | undefined
            for (let i = 0; i < 60; i++) {
              status = (yield* jobs.get(jobId))?.status
              if (status && status !== "running") break
              yield* Effect.sleep("250 millis")
            }
            expect(status).toBe("completed")

            const pid = Number((yield* Effect.promise(() => Bun.file(server.pidFile).text())).trim())
            yield* Effect.sync(() => kill(pid))
          }),
        )
      }),
    60_000,
  )

  it.live(
    "promotes a command still running at its timeout into a background task instead of killing it",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const command = chain(["echo before-the-deadline", "sleep 60"])
          const result = yield* run({ command, timeout: 1_500 })
          const meta = result.metadata as {
            promoted?: boolean
            background?: boolean
            jobId?: string
            outputPath?: string
            exit?: unknown
          }
          expect(meta.promoted).toBe(true)
          expect(meta.background).toBe(true)
          expect(meta.exit).toBe(null)
          expect(typeof meta.jobId).toBe("string")
          // The point of promoting rather than killing: the model is told the
          // work SURVIVED, so it does not start again from zero.
          expect(result.output).toContain("still going")
          expect(result.output).toContain("You do not need to run it again")
          expect(result.output).toContain(meta.jobId!)
          expect(result.output).toContain(meta.outputPath!)

          // Still running for real, not just described as running.
          const jobs = yield* BackgroundJob.Service
          expect((yield* jobs.get(meta.jobId!))?.status).toBe("running")

          // Everything printed BEFORE the deadline is in the file the model was
          // pointed at - otherwise "you do not need to run it again" is a lie.
          const saved = yield* (yield* FSUtil.Service).readFileString(meta.outputPath!)
          expect(saved).toContain("before-the-deadline")

          // And the escape hatch still reaches it.
          const stopTool = yield* Tool.init(yield* TaskStopTool)
          const stopped = yield* stopTool.execute({ task_id: meta.jobId! }, ctx)
          expect(stopped.metadata.status).toBe("cancelled")
        }),
      ),
    45_000,
  )

  it.live(
    "silence is still killed, never promoted: a command with nothing to say is one waiting for input",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({ command: chain(["echo hi", "sleep 30"]), timeout: 20_000 })
          const meta = result.metadata as { promoted?: boolean; jobId?: string }
          expect(meta.promoted).toBeUndefined()
          expect(meta.jobId).toBeUndefined()
          expect(result.output).toContain("produced no output for 400 ms")
          expect(result.metadata.exit).toBe(null)
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashIdleTimeoutMs: 400 }))),
    45_000,
  )

  // origami_change (interject): the fifth race arm. A command that runs for
  // minutes never reaches a tool boundary, so a message the user pushed into
  // the turn would wait behind it however urgent it is.
  it.live(
    "an interjection promotes a running foreground command, so the turn can reach the message",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const interjections = yield* Interject.Service
          let printed = false
          // Signal only once the command has BOTH parked a waiter (the shell
          // registers its wait when the race starts, which is after the spawn)
          // and printed something. Firing before either would prove nothing,
          // and the "work already done survived" assertion below is only
          // meaningful once there is work to survive. Bounded, so an arm that
          // never arms fails on the assertions rather than spinning here.
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 200; attempt++) {
                if (printed && (yield* interjections.signal(ctx.sessionID)) > 0) return
                yield* Effect.sleep("50 millis")
              }
            }),
          )
          // 25s clock against a 60s command: nothing but the interjection can
          // end this call early, so an early return IS the interjection.
          const result = yield* run(
            { command: chain(["echo before-the-message", "sleep 60"]), timeout: 25_000 },
            {
              ...ctx,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output?.includes("before-the-message")) printed = true
                }),
            },
          )
          const meta = result.metadata as {
            promoted?: boolean
            background?: boolean
            jobId?: string
            outputPath?: string
            exit?: unknown
          }
          expect(meta.promoted).toBe(true)
          expect(meta.background).toBe(true)
          expect(meta.exit).toBe(null)
          // The model is told WHY, and the reason is not a deadline - it has
          // not been told to wait longer, it has been told to go and read.
          expect(result.output).toContain("The user sent you a message")
          expect(result.output).not.toContain("STILL RUNNING after its")
          expect(result.output).toContain("still going")

          // Promoted, not killed: the process is alive in the registry.
          const jobs = yield* BackgroundJob.Service
          expect((yield* jobs.get(meta.jobId!))?.status).toBe("running")

          // And the work already done survived, which is the whole point of
          // promoting rather than killing.
          const saved = yield* (yield* FSUtil.Service).readFileString(meta.outputPath!)
          expect(saved).toContain("before-the-message")

          const stopTool = yield* Tool.init(yield* TaskStopTool)
          expect((yield* stopTool.execute({ task_id: meta.jobId! }, ctx)).metadata.status).toBe("cancelled")
        }),
      ),
    45_000,
  )

  it.live(
    "a background task ignores an interjection: only a BLOCKING call is in the way of the message",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({ command: chain(["echo detached", "sleep 20"]), background: true })
          const meta = result.metadata as { jobId?: string; promoted?: boolean; state?: string }
          expect(meta.state).toBe("background")
          expect(meta.promoted).toBeUndefined()

          // Well under way by now, and still nobody parked: a detached run
          // never arms the arm, so an interjection cannot disturb it. A count
          // of 1 here would mean a server the model deliberately started can
          // be re-filed under the registry by an unrelated chat message.
          yield* Effect.sleep("500 millis")
          const interjections = yield* Interject.Service
          expect(yield* interjections.signal(ctx.sessionID)).toBe(0)

          const jobs = yield* BackgroundJob.Service
          expect((yield* jobs.get(meta.jobId!))?.status).toBe("running")
          yield* jobs.cancel(meta.jobId!)
        }),
      ),
    30_000,
  )
})


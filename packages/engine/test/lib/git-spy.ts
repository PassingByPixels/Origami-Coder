import { AppProcess } from "@origami/core/process"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Layer } from "effect"

/**
 * A real AppProcess that records every `git` command it runs, and lets a test
 * act on the disk just before one runs. The hook is how a test reproduces a
 * race: a file that vanishes between the snapshot's listing and its `git add`,
 * or another engine's `index.lock` held at that moment.
 */
export type GitCall = { readonly args: readonly string[]; readonly start: number; readonly end: number }

export const gitSpy = {
  calls: [] as GitCall[],
  before: undefined as ((args: readonly string[]) => void | Promise<void>) | undefined,
  reset() {
    this.calls = []
    this.before = undefined
  },
}

/** The git subcommand: the first argument after the `-c k=v` and `--git-dir`/`--work-tree` options. */
export const subcommand = (args: readonly string[]) => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
      i++
      continue
    }
    if (arg.startsWith("-")) continue
    return arg
  }
  return undefined
}

/**
 * One snapshot add() pass. Each pass lists the untracked files exactly once,
 * and runs `git add` only when that listing (or diff-files) found something.
 */
export const isAddPass = (args: readonly string[]) =>
  subcommand(args) === "ls-files" && args.includes("--others")

export const gitSpyLayer = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const real = yield* AppProcess.Service
    return AppProcess.Service.of({
      ...real,
      run: (command, options) => {
        if (command._tag !== "StandardCommand" || command.command !== "git") return real.run(command, options)
        const args = command.args
        return Effect.gen(function* () {
          const hook = gitSpy.before
          if (hook) yield* Effect.promise(async () => hook(args))
          const start = performance.now()
          const result = yield* real.run(command, options)
          gitSpy.calls.push({ args, start, end: performance.now() })
          return result
        })
      },
    })
  }),
).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))

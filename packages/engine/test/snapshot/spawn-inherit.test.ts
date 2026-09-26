import { afterEach, expect } from "bun:test"
import { AppProcess } from "@origami/core/process"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Fiber } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { SnapshotGit } from "../../src/snapshot/git-runner"
import { Process } from "../../src/util/process"
import { testEffect } from "../lib/effect"

// t-x0lim2: on Windows a new process gets every inheritable handle of its
// parent process, and a process start makes the child's ends of its stdio pipes
// inheritable for the length of the start call. The main thread and the
// snapshot git Worker each start processes on their own thread. When two starts
// overlap, each child can take the other child's pipe ends and keep them for
// its whole life. These tests start the two at the same moment, a few times,
// and check both directions:
// - reverse: a long git on the Worker must not hold the output pipe of a short
//   child the main thread starts, so the main thread's read ends when that
//   child exits (not when the Worker's git exits);
// - forward: a long child the main thread starts must not hold the pipe of a
//   git the Worker starts (git-runner counts such a run as `held`).

const it = testEffect(LayerNode.compile(AppProcess.node))
const live = process.platform === "win32" ? it.live : it.live.skip

afterEach(() => {
  SnapshotGit.testing.reset()
})

const ATTEMPTS = 6
/** How long the long process lives. A read that waits for it takes this long. */
const HOLD_SECONDS = 6
/** A short child's read that takes longer than this waited for another process. */
const READ_LIMIT_MS = 3_000

// A git that runs HOLD_SECONDS: the alias runs `sleep` in the foreground.
const longGit = ["-c", `alias.x0hold=!sleep ${HOLD_SECONDS}`, "x0hold"]

const noInline = Effect.die(new Error("the inline run must not be needed"))

// Start the Worker, so the next run posts to a Worker that is ready.
const warm = SnapshotGit.run({ args: ["--version"] }, noInline)

const reverse = (read: Effect.Effect<string, unknown, AppProcess.Service>) =>
  Effect.gen(function* () {
    yield* warm
    const took: number[] = []
    for (let i = 0; i < ATTEMPTS; i++) {
      // The Worker gets the message at once; the main thread starts its child
      // in the same tick.
      const long = yield* Effect.forkChild(SnapshotGit.run({ args: longGit }, noInline), { startImmediately: true })
      const started = Date.now()
      const out = yield* read
      took.push(Date.now() - started)
      expect(out).toContain("git version")
      yield* Fiber.interrupt(long)
    }
    expect(Math.max(...took), `main-thread reads (ms): ${took.join(", ")}`).toBeLessThan(READ_LIMIT_MS)
  })

live(
  "reverse: a long Worker git does not hold the output of a child started on the main thread (CrossSpawnSpawner)",
  () =>
    reverse(
      AppProcess.Service.use((proc) => proc.run(ChildProcess.make("git", ["--version"]))).pipe(
        Effect.map((result) => result.stdout.toString()),
      ),
    ),
  90_000,
)

live(
  "reverse: a long Worker git does not hold the output of a child started on the main thread (node:child_process)",
  () => reverse(Effect.promise(() => Process.text(["git", "--version"])).pipe(Effect.map((result) => result.text))),
  90_000,
)

live(
  "forward: a long child started on the main thread does not hold the output of a Worker git",
  () =>
    Effect.gen(function* () {
      yield* warm
      const kids: Process.Child[] = []
      try {
        for (let i = 0; i < ATTEMPTS; i++) {
          const run = yield* Effect.forkChild(SnapshotGit.run({ args: ["--version"] }, noInline), {
            startImmediately: true,
          })
          kids.push(Process.spawn(["git", ...longGit], { stdout: "pipe", stderr: "pipe" }))
          const output = yield* Fiber.join(run)
          expect(new TextDecoder().decode(output.stdout)).toContain("git version")
        }
        expect(SnapshotGit.testing.held()).toBe(0)
      } finally {
        for (const kid of kids) kid.kill()
      }
    }),
  90_000,
)

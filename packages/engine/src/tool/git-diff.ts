import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./git-diff.txt"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"

export const Parameters = Schema.Struct({
  staged: Schema.optional(Schema.Boolean).annotate({
    description:
      "Show the staged diff (index vs HEAD) - what a commit would contain. Defaults to false, which shows unstaged working-tree changes.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Limit the diff to this file or directory. Defaults to the whole repository.",
  }),
  stat: Schema.optional(Schema.Boolean).annotate({
    description: "Show a per-file summary instead of the full patch. Defaults to false.",
  }),
})

type Params = { staged?: boolean; path?: string; stat?: boolean }

const MAX_OUTPUT_BYTES = 400_000

/** Counts derived from porcelain v1 status codes: `XY path`, X = index, Y = worktree. */
export function summarize(items: ReadonlyArray<{ code: string }>) {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const item of items) {
    if (item.code === "??") {
      untracked++
      continue
    }
    if (item.code[0] && item.code[0] !== " ") staged++
    if (item.code[1] && item.code[1] !== " ") unstaged++
  }
  return { staged, unstaged, untracked }
}

export const GitDiffTool = Tool.define(
  "git_diff",
  Effect.gen(function* () {
    const git = yield* Git.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const cwd = instance.directory

          yield* ctx.ask({
            permission: "git_diff",
            patterns: [params.path ?? "*"],
            always: ["*"],
            metadata: { staged: params.staged === true, path: params.path, stat: params.stat === true },
          })

          if (!(yield* git.hasHead(cwd)) && !(yield* git.branch(cwd)))
            throw new Error(`Not a git repository (or it has no commits yet): ${cwd}`)

          const counts = summarize(yield* git.status(cwd))
          const header = `Staged: ${counts.staged} file(s), unstaged: ${counts.unstaged} file(s), untracked: ${counts.untracked} file(s)`

          // Hard-coded argv: this tool can only ever read.
          const args = ["diff", "--no-ext-diff", "--no-color"]
          if (params.staged) args.push("--cached")
          if (params.stat) args.push("--stat")
          args.push("--")
          args.push(params.path ?? ".")

          const result = yield* git.run(args, { cwd, maxOutputBytes: MAX_OUTPUT_BYTES })
          if (result.exitCode !== 0) {
            const stderr = result.stderr.toString("utf8").trim()
            throw new Error(`git diff failed: ${stderr || `exit ${result.exitCode}`}`)
          }

          const body = result.text().trimEnd()
          const label = params.staged ? "staged" : "unstaged"
          const empty = params.path
            ? `No ${label} changes under ${params.path}.`
            : `No ${label} changes.${!params.staged && counts.untracked > 0 ? " (Untracked files do not appear in a diff.)" : ""}`

          return {
            title: params.staged ? "staged" : "unstaged",
            metadata: {
              staged: params.staged === true,
              counts,
              empty: body.length === 0,
              clipped: result.truncated,
            },
            output: [header, "", body.length ? body : empty, result.truncated ? "\n(diff truncated)" : ""]
              .join("\n")
              .trimEnd(),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

import { describe, expect, it } from "bun:test"
import path from "path"
import { Effect } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { Instructions } from "@/acp/instructions"
import { Agent } from "@/acp/agent"

const worktree = path.resolve("/workspace")
const globalPaths = [path.resolve("/home/u/.config/origami/AGENTS.md"), path.resolve("/home/u/.claude/CLAUDE.md")]
const memoryPaths = [path.resolve("/home/u/.origami/memory.md"), path.join(worktree, ".origami", "memory.md")]

const classify = (filepath: string) => Instructions.classify({ filepath, globalPaths, memoryPaths, worktree })

describe("instruction classification", () => {
  it("separates a project AGENTS.md from a memory store", () => {
    expect(classify(path.join(worktree, "AGENTS.md"))).toBe("project")
    expect(classify(path.join(worktree, ".origami", "memory.md"))).toBe("memory")
  })

  it("labels the global and cross-project stores distinctly from project files", () => {
    expect(classify(globalPaths[0]!)).toBe("global")
    expect(classify(globalPaths[1]!)).toBe("global")
    expect(classify(memoryPaths[0]!)).toBe("memory")
  })

  it("treats an arbitrary configured instruction file as config, not project", () => {
    expect(classify(path.join(worktree, "docs", "house-style.md"))).toBe("config")
    expect(classify(path.resolve("/elsewhere/rules.md"))).toBe("config")
  })

  it("does not call a CLAUDE.md outside the worktree a project file", () => {
    expect(classify(path.resolve("/somewhere/else/CLAUDE.md"))).toBe("config")
  })
})

// --- The base-prompt row. It is the one entry that is not a file the user
// added: it is the prompt they never chose, so the bugs worth catching are the
// dishonest ones — a built-in row that claims to be the user's file, a size
// taken from the built-in while an override is live, or a text field that does
// not match what a shell would seed the file with.

describe("the base-prompt entry", () => {
  const builtIn = "BUILT-IN BASE PROMPT"
  const overridePath = path.resolve("/home/u/.config/origami/base-prompt.md")

  it("reports the BUILT-IN sizes and overridden:false when no override file exists", () => {
    const { entry, info } = Instructions.overrideRow({
      source: "base-prompt",
      builtIn,
      overridePath,
      override: undefined,
    })

    expect(entry.source).toBe("base-prompt")
    expect(entry.overridden).toBe(false)
    expect(entry.chars).toBe(builtIn.length)
    expect(entry.tokensApprox).toBe(Instructions.estimateTokens(builtIn.length))
    // The path still names WHERE an edit would go — that is the point of the row.
    expect(entry.path).toBe(overridePath)
    expect(info).toEqual({ path: overridePath, overridden: false, text: builtIn })
  })

  it("reports the OVERRIDE's sizes and overridden:true once the file supplies the prompt", () => {
    const mine = "MY OWN MUCH LONGER BASE PROMPT, WRITTEN BY HAND."
    const { entry, info } = Instructions.overrideRow({ source: "base-prompt", builtIn, overridePath, override: mine })

    expect(entry.overridden).toBe(true)
    expect(entry.chars).toBe(mine.length)
    expect(entry.chars).not.toBe(builtIn.length)
    expect(entry.path).toBe(overridePath)
    // The EFFECTIVE text, so a seeding shell never writes back the built-in
    // over a prompt the user already wrote.
    expect(info.text).toBe(mine)
    expect(info.overridden).toBe(true)
  })

  it("sizes multi-byte text in real bytes while chars stays a character count", () => {
    const { entry } = Instructions.overrideRow({ source: "base-prompt", builtIn, overridePath, override: "éé" })

    expect(entry.chars).toBe(2)
    expect(entry.bytes).toBe(4)
  })

  it("carries the base prompt on the set, and leaves it absent when none was resolved", () => {
    const { entry, info } = Instructions.overrideRow({
      source: "base-prompt",
      builtIn,
      overridePath,
      override: undefined,
    })
    const withBase = Instructions.totals([entry], info)

    expect(withBase.basePrompt).toEqual(info)
    // Its size counts toward the total: it really is prepended to every prompt.
    expect(withBase.totalChars).toBe(builtIn.length)
    expect("basePrompt" in Instructions.totals([entry])).toBe(false)
  })
})

// --- The COLLAB override row. Same shape and same job as the base prompt
// above, and the bug worth catching is the one that would make it invisible
// again: a row that reports the base prompt's source, or a built-in that reads
// as a file already sitting on disk.
//
// There is exactly ONE collab row. The room manual was a second, and it is
// gone: what is left below a collab persona is this turn's live state, which
// has no file behind it and nothing for a user to edit.

describe("the collab override entry", () => {
  const row = (override?: string) =>
    Instructions.overrideRow({
      source: "collab-agent-base",
      builtIn: "SHIPPED COLLAB TEXT",
      overridePath: path.resolve("/home/u/.config/origami/collab-agent-base.md"),
      override,
    })

  it("labels the row with its OWN source, not the base prompt's", () => {
    expect(row().entry.source).toBe("collab-agent-base")
  })

  it("reports the built-in sizes and overridden:false until a file supplies the text", () => {
    const { entry, info } = row()

    expect(entry.overridden).toBe(false)
    expect(entry.chars).toBe("SHIPPED COLLAB TEXT".length)
    // The path names where an edit WOULD go — that is the point of the row.
    expect(info.path).toBe(path.resolve("/home/u/.config/origami/collab-agent-base.md"))
    expect(info.text).toBe("SHIPPED COLLAB TEXT")
  })

  it("switches to the OVERRIDE's text and sizes once the user writes the file", () => {
    const { entry, info } = row("MY ROOM RULES")

    expect(entry.overridden).toBe(true)
    expect(entry.chars).toBe("MY ROOM RULES".length)
    // The EFFECTIVE text, so a seeding shell never writes the built-in back
    // over rules the user already wrote.
    expect(info.text).toBe("MY ROOM RULES")
  })

  it("rides the set alongside the base prompt rather than replacing it", () => {
    const base = Instructions.overrideRow({
      source: "base-prompt",
      builtIn: "BASE",
      overridePath: path.resolve("/home/u/.config/origami/base-prompt.md"),
      override: undefined,
    })
    const set = {
      ...Instructions.totals([base.entry, row().entry], base.info),
      collabAgentBase: row().info,
    }

    expect(set.basePrompt).toEqual(base.info)
    expect(set.collabAgentBase?.path).toContain("collab-agent-base.md")
    expect(set.entries.map((e) => e.source)).toEqual(["base-prompt", "collab-agent-base"])
  })
})

describe("instruction totals", () => {
  it("sums chars, bytes and the approximate token counts, and names the estimator", () => {
    const set = Instructions.totals([
      { path: "/a", source: "project", chars: 400, bytes: 400, tokensApprox: 100 },
      { path: "/b", source: "memory", chars: 10, bytes: 12, tokensApprox: 3 },
    ])

    expect(set.totalChars).toBe(410)
    expect(set.totalBytes).toBe(412)
    expect(set.totalTokensApprox).toBe(103)
    // The estimate must never be presented as a measurement.
    expect(set.tokensApproxMethod).toBe("chars/4")
  })

  it("rounds the chars/4 heuristic up so a short file is never zero tokens", () => {
    expect(Instructions.estimateTokens(1)).toBe(1)
    expect(Instructions.estimateTokens(4)).toBe(1)
    expect(Instructions.estimateTokens(5)).toBe(2)
    expect(Instructions.estimateTokens(0)).toBe(0)
  })
})

const stubSdk = {} as unknown as OrigamiClient

function serviceWithInstructions(calls: string[]) {
  const instructions: Instructions.Interface = {
    list: (directory: string) => {
      calls.push(directory)
      return Effect.succeed(
        Instructions.totals([{ path: path.join(directory, "AGENTS.md"), source: "project", chars: 8, bytes: 8, tokensApprox: 2 }]),
      )
    },
  }
  return ACPService.make({ sdk: stubSdk, instructions })
}

describe("list_instructions service method", () => {
  it("passes the requested cwd through and returns the inventory", async () => {
    const calls: string[] = []
    const result = await Effect.runPromise(serviceWithInstructions(calls).listInstructions({ cwd: "/workspace" }))

    expect(calls).toEqual(["/workspace"])
    expect(result.entries).toHaveLength(1)
    expect(result.totalChars).toBe(8)
  })

  it("falls back to the process cwd when none is supplied", async () => {
    const calls: string[] = []
    await Effect.runPromise(serviceWithInstructions(calls).listInstructions({}))

    expect(calls).toEqual([process.cwd()])
  })

  it("returns sizes only — never file contents", async () => {
    const result = await Effect.runPromise(serviceWithInstructions([]).listInstructions({ cwd: "/workspace" }))

    for (const entry of result.entries) {
      expect(Object.keys(entry).sort()).toEqual(["bytes", "chars", "path", "source", "tokensApprox"])
    }
  })
})

describe("ext method dispatch", () => {
  const service = {
    runSteps: (input: { sessionId: string; cwd?: string }) =>
      Effect.succeed({ steps: [{ ordinal: 0, kind: "prompt" as const, title: input.sessionId }], truncated: false, total: 1 }),
    listInstructions: () => Effect.succeed(Instructions.totals([])),
  } as unknown as ACPService.Interface

  it("accepts the `_` wire prefix clients send for extension methods", async () => {
    const agent = new Agent(service)
    const prefixed = await agent.extMethod("_run_steps", { sessionId: "ses_1" })
    const bare = await agent.extMethod("run_steps", { sessionId: "ses_1" })

    expect(prefixed).toEqual(bare)
    expect((prefixed as { total: number }).total).toBe(1)
  })

  it("routes list_instructions to the service", async () => {
    const agent = new Agent(service)
    const result = await agent.extMethod("_list_instructions", {})

    expect(result).toMatchObject({ tokensApproxMethod: "chars/4", totalChars: 0 })
  })

  it("rejects run_steps without a sessionId rather than querying a blank session", () => {
    const agent = new Agent(service)

    expect(() => agent.extMethod("_run_steps", {})).toThrow()
  })

  it("reports an unknown ext method as method-not-found", () => {
    const agent = new Agent(service)

    expect(() => agent.extMethod("_does_not_exist", {})).toThrow()
  })
})

// t-q90p6v — the one-off title repair (script/rewrite-tool-titles.ts).
//
// FIXTURE PROVENANCE: the archive entries below are the shape the owner's own
// C:\Users\dev\.origami\sessions files carry, read on 2026-09-21 — a `tool` entry whose
// `tool.call` holds the PENDING frame (bare tool name, `rawInput` of `{cwd}` for bash, `{}` for
// read) while the resolved title sits on the entry's `text` and on `tool.result.title`. Contents
// are shortened; the keys and the values' character are not invented.

import { describe, expect, test } from "bun:test"
import { derivedTitle, emptyCounts, isPlaceholderTitle, rewriteSessionArchive, rewriteToolPart } from "../../script/rewrite-tool-titles"

const archive = () => ({
  messages: [
    { kind: "user", text: "go", timestamp: 1 },
    {
      kind: "tool",
      text: 'Get-Content "C:\\Users\\dev\\Desktop\\Workspace\\HANDOFF.md" -TotalCount 80',
      timestamp: 2,
      tool: {
        call: { toolCallId: "t1", title: "bash", kind: "execute", status: "pending", toolName: "bash", rawInput: { cwd: "c:\\Workspace" } },
        result: {
          toolCallId: "t1",
          status: "completed",
          title: 'Get-Content "C:\\Users\\dev\\Desktop\\Workspace\\HANDOFF.md" -TotalCount 80',
          toolName: "bash",
          content: "# HANDOFF",
        },
      },
    },
    {
      kind: "tool",
      text: "wiki\\pages\\mediagen.md",
      timestamp: 3,
      tool: {
        call: { toolCallId: "t2", title: "read", kind: "read", status: "pending", toolName: "read", rawInput: {} },
        result: { toolCallId: "t2", status: "completed", title: "wiki\\pages\\mediagen.md", toolName: "read", content: "---" },
      },
    },
    // A call that never completed: nothing better than the tool name exists anywhere, so the row
    // must be reported as skipped rather than given an invented title.
    { kind: "tool", text: "glob", timestamp: 4, tool: { call: { toolCallId: "t3", title: "glob", toolName: "glob", rawInput: {} } } },
  ],
})

describe("rewrite-tool-titles", () => {
  test("rebuilds the live title on the stored CALL, which is what a restore reads", () => {
    const store = archive()
    const counts = emptyCounts()

    expect(rewriteSessionArchive(store, counts)).toBe(true)

    const titles = store.messages.filter((m) => m.kind === "tool").map((m) => m.tool?.call.title)
    expect(titles).toEqual([
      'Get-Content "C:\\Users\\dev\\Desktop\\Workspace\\HANDOFF.md" -TotalCount 80',
      "wiki\\pages\\mediagen.md",
      "glob",
    ])
    expect(counts).toEqual({ scanned: 3, rewritten: 2, skipped: { "no title derivable from the stored input": 1 } })
  })

  test("is idempotent — a second pass rewrites nothing", () => {
    const store = archive()
    rewriteSessionArchive(store, emptyCounts())

    const second = emptyCounts()
    expect(rewriteSessionArchive(store, second)).toBe(false)
    expect(second.rewritten).toBe(0)
    expect(second.skipped["title already resolved"]).toBe(2)
  })

  test("a bash title prefers the model's explanation, then the command — as the live card does", () => {
    expect(derivedTitle("bash", { command: "ls", explanation: "list the lane" }, "bash")).toBe("list the lane")
    expect(derivedTitle("bash", { command: "ls" }, "bash")).toBe("ls")
    // Nothing to derive from, and the stored title is the placeholder: the row is left alone.
    expect(derivedTitle("bash", {}, "bash")).toBeUndefined()
    // apply_patch reads its own header, never the multi-line result blob.
    expect(derivedTitle("apply_patch", { patchText: "*** Update File: src/app.ts\n@@" }, "Success. Updated:\nM src/app.ts")).toBe("src/app.ts")
  })

  test("the placeholder test is the tool's own name, case-insensitively", () => {
    expect(isPlaceholderTitle("bash", "bash")).toBe(true)
    expect(isPlaceholderTitle("Edit", "edit")).toBe(true)
    expect(isPlaceholderTitle("bash", "")).toBe(true)
    expect(isPlaceholderTitle("bash", "git status")).toBe(false)
  })

  test("an engine part is repaired from its own stored input, and a good one is left alone", () => {
    const counts = emptyCounts()
    const part = { type: "tool", tool: "bash", state: { title: "bash", input: { command: "bun test" } } }
    expect(rewriteToolPart(part, counts)).toBe(true)
    expect(part.state.title).toBe("bun test")

    const healthy = { type: "tool", tool: "read", state: { title: "src/app.ts", input: { filePath: "src/app.ts" } } }
    expect(rewriteToolPart(healthy, counts)).toBe(false)
    expect(healthy.state.title).toBe("src/app.ts")
    expect(counts.skipped["title already resolved"]).toBe(1)
  })
})

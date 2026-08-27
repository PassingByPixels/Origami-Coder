import { resolve } from "path"
import { describe, expect, test } from "bun:test"
import {
  completedToolContent,
  completedToolUpdate,
  completedToolRawOutput,
  duplicateRunningToolUpdate,
  errorToolUpdate,
  extractImageAttachments,
  imageContents,
  pendingToolCall,
  runningToolUpdate,
  shellOutputSnapshot,
  toLocations,
  toToolKind,
} from "../../src/acp/tool"

describe("acp tool conversion", () => {
  test("maps Origami tool ids to ACP tool kinds", () => {
    expect(toToolKind("bash")).toBe("execute")
    expect(toToolKind("shell")).toBe("execute")
    expect(toToolKind("webfetch")).toBe("fetch")
    expect(toToolKind("edit")).toBe("edit")
    expect(toToolKind("apply_patch")).toBe("edit")
    expect(toToolKind("patch")).toBe("edit")
    expect(toToolKind("write")).toBe("edit")
    expect(toToolKind("grep")).toBe("search")
    expect(toToolKind("glob")).toBe("search")
    expect(toToolKind("context7_resolve_library_id")).toBe("search")
    expect(toToolKind("context7_get_library_docs")).toBe("search")
    expect(toToolKind("read")).toBe("read")
    expect(toToolKind("task")).toBe("think")
    expect(toToolKind("custom_tool")).toBe("other")
  })

  test("extracts file locations from tool input", () => {
    expect(toLocations("read", { filePath: "/tmp/a.ts" })).toEqual([{ path: "/tmp/a.ts" }])
    expect(toLocations("edit", { filePath: "/tmp/b.ts" })).toEqual([{ path: "/tmp/b.ts" }])
    expect(toLocations("write", { filePath: "/tmp/c.ts" })).toEqual([{ path: "/tmp/c.ts" }])
    expect(toLocations("grep", { path: "/repo/src" })).toEqual([{ path: "/repo/src" }])
    expect(toLocations("glob", { path: "/repo/test" })).toEqual([{ path: "/repo/test" }])
    expect(toLocations("context7_get_library_docs", { path: "/docs" })).toEqual([{ path: "/docs" }])
    expect(toLocations("external_directory", { directories: ["/tmp/outside"], patterns: ["/tmp/outside/*"] })).toEqual([
      { path: "/tmp/outside" },
    ])
    expect(toLocations("bash", { cmd: "pwd" }, "/workspace")).toEqual([{ path: "/workspace" }])
    // Relative workdir resolves against cwd via the platform path resolver (backslashes on Windows).
    expect(toLocations("bash", { command: "pwd", workdir: "subdir" }, "/workspace")).toEqual([
      { path: resolve("/workspace", "subdir") },
    ])
    expect(toLocations("bash", { command: "pwd", workdir: "/abs/dir" }, "/workspace")).toEqual([{ path: "/abs/dir" }])
    expect(toLocations("bash", { command: "printf hello" })).toEqual([])
    expect(toLocations("read", { path: "/tmp/missing-file-path.ts" })).toEqual([])
  })

  test("builds completed content with text, edit diffs, and image attachments", () => {
    const image = Buffer.from("image-data").toString("base64")

    expect(
      completedToolContent("edit", {
        status: "completed",
        input: {
          filePath: "/tmp/file.ts",
          oldString: "before",
          newString: "after",
        },
        output: "edited /tmp/file.ts",
        attachments: [
          {
            type: "file",
            mime: "image/png",
            filename: "image.png",
            url: `data:image/png;base64,${image}`,
          },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZQ==",
          },
        ],
      }),
    ).toEqual([
      {
        type: "content",
        content: { type: "text", text: "edited /tmp/file.ts" },
      },
      {
        type: "diff",
        path: "/tmp/file.ts",
        oldText: "before",
        newText: "after",
      },
      {
        type: "content",
        content: { type: "image", mimeType: "image/png", data: image },
      },
    ])
  })

  test("omits edit diffs until old and new text fields exist", () => {
    expect(
      completedToolContent("write", {
        status: "completed",
        input: {
          filePath: "/tmp/file.ts",
          content: "created",
        },
        output: "wrote /tmp/file.ts",
      }),
    ).toEqual([
      {
        type: "content",
        content: { type: "text", text: "wrote /tmp/file.ts" },
      },
    ])
  })

  test("sends completed tool calls as partial updates", () => {
    expect(
      pendingToolCall({
        toolCallId: "tool-1",
        toolName: "edit",
        state: {
          input: {
            filePath: "/tmp/file.ts",
            oldString: "before",
            newString: "after",
          },
        },
      }),
    ).toMatchObject({
      kind: "edit",
      locations: [{ path: "/tmp/file.ts" }],
      rawInput: {
        filePath: "/tmp/file.ts",
        oldString: "before",
        newString: "after",
      },
    })

    expect(
      completedToolUpdate({
        toolCallId: "tool-1",
        toolName: "edit",
        state: {
          status: "completed",
          input: {
            filePath: "/tmp/file.ts",
            oldString: "before",
            newString: "after",
          },
          output: "Edit applied successfully.",
        },
      }),
    ).toEqual({
      toolCallId: "tool-1",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Edit applied successfully." },
        },
        {
          type: "diff",
          path: "/tmp/file.ts",
          oldText: "before",
          newText: "after",
        },
      ],
      rawOutput: {
        output: "Edit applied successfully.",
      },
      _meta: { origami_tool_name: "edit" },
    })

    expect(
      completedToolUpdate({
        toolCallId: "tool-1",
        toolName: "edit",
        state: {
          status: "completed",
          input: {
            filePath: "/tmp/file.ts",
            oldString: "before",
            newString: "after",
          },
          title: "file.ts",
          output: "Edit applied successfully.",
        },
      }),
    ).toMatchObject({
      toolCallId: "tool-1",
      status: "completed",
      title: "file.ts",
    })
  })

  test("uses apply_patch result metadata for a single-file before and after diff", () => {
    expect(
      completedToolContent("apply_patch", {
        status: "completed",
        input: { patchText: "*** Begin Patch" },
        output: "Success. Updated the following files:\nM file.ts",
        metadata: {
          files: [{ filePath: "/tmp/file.ts", oldContent: "before\n", newContent: "after\n" }],
        },
      }),
    ).toContainEqual({ type: "diff", path: "/tmp/file.ts", oldText: "before\n", newText: "after\n" })
  })

  test("uses the model-written shell explanation as the title while preserving the exact command", () => {
    expect(
      pendingToolCall({
        toolCallId: "shell-1",
        toolName: "bash",
        state: { input: { command: "npm test -- --runInBand", explanation: "Run the focused test suite" } },
      }),
    ).toMatchObject({
      title: "Run the focused test suite",
      rawInput: { command: "npm test -- --runInBand", explanation: "Run the focused test suite" },
    })
  })

  test("falls back to the exact command for legacy shell calls without an explanation", () => {
    expect(
      pendingToolCall({ toolCallId: "shell-old", toolName: "bash", state: { input: { command: "git status" } } }),
    ).toMatchObject({ title: "git status", rawInput: { command: "git status" } })
  })

  test("adds the resolved PowerShell family to running shell input", () => {
    expect(
      runningToolUpdate({
        toolCallId: "shell-ps",
        toolName: "bash",
        state: {
          status: "running",
          input: { explanation: "Run tests", command: "npm test" },
          metadata: { shellDisplay: "PowerShell" },
        },
      }),
    ).toMatchObject({
      rawInput: { explanation: "Run tests", command: "npm test", shellDisplay: "PowerShell" },
    })
  })

  test("adds Bash to duplicate running input without claiming a family for legacy metadata", () => {
    expect(
      duplicateRunningToolUpdate({
        toolCallId: "shell-bash",
        toolName: "bash",
        state: {
          status: "running",
          input: { explanation: "Run tests", command: "npm test" },
          metadata: { shellDisplay: "Bash" },
        },
      }).rawInput,
    ).toMatchObject({ shellDisplay: "Bash" })
    expect(
      runningToolUpdate({
        toolCallId: "shell-legacy",
        toolName: "bash",
        state: { status: "running", input: { explanation: "Run tests", command: "npm test" } },
      }).rawInput,
    ).not.toHaveProperty("shellDisplay")
  })

  test("uses clean read display text for completed content", () => {
    const output = [
      "<path>/tmp/file.ts</path>",
      "<type>file</type>",
      "<content>",
      "7: first",
      "8: second",
      "",
      "(End of file - total 8 lines)",
      "</content>",
    ].join("\n")
    const state = {
      status: "completed" as const,
      input: { filePath: "/tmp/file.ts" },
      output,
      metadata: {
        display: {
          type: "file",
          path: "/tmp/file.ts",
          text: "first\nsecond",
          lineStart: 7,
          lineEnd: 8,
          totalLines: 8,
          truncated: false,
        },
      },
    }

    expect(completedToolContent("read", state)).toEqual([
      {
        type: "content",
        content: { type: "text", text: "first\nsecond" },
      },
    ])
    expect(completedToolRawOutput(state)).toEqual({
      output,
      metadata: state.metadata,
    })
  })

  test("builds completed raw output with optional metadata and attachments", () => {
    const attachments = [
      {
        type: "file",
        mime: "image/jpeg",
        filename: "photo.jpg",
        url: "data:image/jpeg;base64,AAAA",
      },
    ]

    expect(
      completedToolRawOutput({
        status: "completed",
        input: {},
        output: "done",
        metadata: { exit: 0 },
        attachments,
      }),
    ).toEqual({
      output: "done",
      metadata: { exit: 0 },
      attachments,
    })

    expect(
      completedToolRawOutput({
        status: "completed",
        input: {},
        output: "done",
      }),
    ).toEqual({ output: "done" })
  })

  test("extracts image attachments only from data URLs", () => {
    const attachments = [
      {
        mime: "image/webp",
        url: "data:image/webp;charset=utf-8;base64,AAAA",
      },
      {
        mime: "image/png",
        url: "https://example.com/image.png",
      },
      {
        mime: "text/plain",
        url: "data:text/plain;base64,BBBB",
      },
    ]

    expect(extractImageAttachments(attachments)).toEqual([{ mimeType: "image/webp", data: "AAAA" }])
    expect(imageContents(attachments)).toEqual([
      {
        type: "content",
        content: { type: "image", mimeType: "image/webp", data: "AAAA" },
      },
    ])
  })

  test("reads shell output snapshot from string metadata output", () => {
    expect(shellOutputSnapshot({ metadata: { output: "line 1\nline 2" } })).toBe("line 1\nline 2")
    expect(shellOutputSnapshot({ metadata: { output: 42 } })).toBeUndefined()
    expect(shellOutputSnapshot({ metadata: undefined })).toBeUndefined()
  })

  // The VS Code shell distinguishes a `task` sub-agent spawn from an ordinary
  // tool call purely by `_meta.origami_tool_name` — ACP's own payload carries
  // only a coarse `kind` ("think" for task, shared with other tools). Drop this
  // decoration and sub-agent cards silently degrade to a generic tool dump, with
  // nothing failing anywhere. That is exactly what an upstream import did once.
  test("stamps the originating tool name on every tool-call shape the client sees", () => {
    const input = { filePath: "/tmp/a.ts" }

    expect(pendingToolCall({ toolCallId: "t1", toolName: "task", state: { input } })._meta).toEqual({
      origami_tool_name: "task",
    })
    expect(
      runningToolUpdate({ toolCallId: "t1", toolName: "task", state: { status: "running", input } })._meta,
    ).toEqual({ origami_tool_name: "task" })
    expect(
      duplicateRunningToolUpdate({ toolCallId: "t1", toolName: "task", state: { status: "running", input } })._meta,
    ).toEqual({ origami_tool_name: "task" })
    expect(
      completedToolUpdate({
        toolCallId: "t1",
        toolName: "task",
        state: { status: "completed", input, output: "done" },
      })._meta,
    ).toEqual({ origami_tool_name: "task" })
    expect(
      errorToolUpdate({ toolCallId: "t1", toolName: "task", state: { status: "error", input, error: "boom" } })._meta,
    ).toEqual({ origami_tool_name: "task" })

    // Not task-specific — the client keys every card off this field.
    expect(pendingToolCall({ toolCallId: "t2", toolName: "read", state: { input } })._meta).toEqual({
      origami_tool_name: "read",
    })
  })

  // GPT-family models get apply_patch swapped in for edit/write (tool/registry.ts),
  // and the whole edit arrives as one opaque `patchText` string. With no path in
  // locations and no title, the collapsed chat row reads a bare "apply_patch" and
  // the user has to expand it to learn which file was touched.
  test("recovers the edited path and title from an apply_patch envelope", () => {
    const update = runningToolUpdate({
      toolCallId: "p1",
      toolName: "apply_patch",
      state: {
        status: "running",
        input: {
          patchText: ["*** Begin Patch", "*** Update File: src/app.ts", "@@ fn()", "-old", "+new", "*** End Patch"].join(
            "\n",
          ),
        },
      },
    })

    expect(update.locations).toEqual([{ path: "src/app.ts" }])
    expect(update.title).toBe("src/app.ts")

    expect(
      toLocations("apply_patch", {
        patchText: ["*** Begin Patch", "*** Add File: docs/new.md", "+hello", "*** End Patch"].join("\n"),
      }),
    ).toEqual([{ path: "docs/new.md" }])
    expect(
      toLocations("apply_patch", {
        patchText: ["*** Begin Patch", "*** Delete File: obsolete.txt", "*** End Patch"].join("\n"),
      }),
    ).toEqual([{ path: "obsolete.txt" }])
  })

  test("reports a renamed file as one file with both of its paths", () => {
    const update = runningToolUpdate({
      toolCallId: "p2",
      toolName: "apply_patch",
      state: {
        status: "running",
        input: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: src/app.py",
            "*** Move to: src/main.py",
            "@@ def greet():",
            '-print("Hi")',
            '+print("Hello")',
            "*** End Patch",
          ].join("\n"),
        },
      },
    })

    // Both ends of the rename are places the edit landed, so both are offered.
    expect(update.locations).toEqual([{ path: "src/app.py" }, { path: "src/main.py" }])
    // It is still ONE file: the header names the destination, not "2 files".
    expect(update.title).toBe("src/main.py")
  })

  test("titles a multi-file patch by file count", () => {
    const update = runningToolUpdate({
      toolCallId: "p3",
      toolName: "apply_patch",
      state: {
        status: "running",
        input: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: a.ts",
            "@@ x",
            "-1",
            "+2",
            "*** Add File: b.ts",
            "+created",
            "*** Delete File: c.ts",
            "*** End Patch",
          ].join("\n"),
        },
      },
    })

    expect(update.locations).toEqual([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }])
    expect(update.title).toBe("3 files")
  })

  test("never throws on a partial or malformed patch payload", () => {
    // The RUNNING frame can carry a payload that is still streaming, so the End
    // marker may be absent. Patch.parsePatch rejects that outright; a display
    // path must still show what it can already see.
    expect(
      toLocations("apply_patch", {
        patchText: ["*** Begin Patch", "*** Update File: src/app.ts", "@@ fn()", "-old"].join("\n"),
      }),
    ).toEqual([{ path: "src/app.ts" }])
    expect(toLocations("apply_patch", { patchText: "*** Begin Patch\r\n*** Update File: src/win.ts\r\n" })).toEqual([
      { path: "src/win.ts" },
    ])

    expect(toLocations("apply_patch", { patchText: "*** Begin Patch\n" })).toEqual([])
    expect(toLocations("apply_patch", { patchText: "*** Update File:   " })).toEqual([])
    expect(toLocations("apply_patch", { patchText: "" })).toEqual([])
    expect(toLocations("apply_patch", { patchText: 42 })).toEqual([])
    expect(toLocations("apply_patch", {})).toEqual([])

    // The pending frame genuinely has no input yet (session/processor.ts), so the
    // tool id is all that is left to show — but it must not crash getting there.
    expect(pendingToolCall({ toolCallId: "p4", toolName: "apply_patch", state: { input: {} } }).title).toBe(
      "apply_patch",
    )
  })

  // On session restore a COMPLETED part is replayed through toolStart, and
  // apply_patch's completion title (tool/apply_patch.ts) is the multi-line
  // "Success. Updated the following files:..." blob. A single-line header must
  // never end up carrying it.
  test("keeps a restored apply_patch header on one line", () => {
    const blob = "Success. Updated the following files:\nM src/app.ts\nA docs/new.md"

    expect(
      pendingToolCall({
        toolCallId: "p5",
        toolName: "apply_patch",
        state: {
          input: {
            patchText: [
              "*** Begin Patch",
              "*** Update File: src/app.ts",
              "@@ x",
              "-1",
              "+2",
              "*** Add File: docs/new.md",
              "+hello",
              "*** End Patch",
            ].join("\n"),
          },
          title: blob,
        },
      }).title,
    ).toBe("2 files")

    // Even with nothing readable in the envelope the header cannot go multi-line.
    const degraded = pendingToolCall({
      toolCallId: "p6",
      toolName: "apply_patch",
      state: { input: {}, title: blob },
    }).title
    expect(degraded).toBe("Success. Updated the following files:")
    expect(degraded).not.toContain("\n")
  })

  // The completed update carries the LAST title the client sees, so the blob
  // would land there live too and undo the path header the running frame set.
  test("does not let the apply_patch result blob overwrite the completed header", () => {
    const patchText = ["*** Begin Patch", "*** Update File: src/app.ts", "@@ x", "-1", "+2", "*** End Patch"].join("\n")
    const output = "Success. Updated the following files:\nM src/app.ts"

    const update = completedToolUpdate({
      toolCallId: "p7",
      toolName: "apply_patch",
      state: { status: "completed", input: { patchText }, output, title: output },
    })

    expect(update.title).toBe("src/app.ts")
    // The full summary is not lost — it still reaches the client as body text.
    expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: output } })

    // Other tools keep their own result title verbatim.
    expect(
      completedToolUpdate({
        toolCallId: "p8",
        toolName: "write",
        state: { status: "completed", input: { filePath: "/tmp/a.ts" }, output: "ok", title: "a.ts" },
      }).title,
    ).toBe("a.ts")
  })
})

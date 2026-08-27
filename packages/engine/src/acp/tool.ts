import { isAbsolute, resolve } from "path"
import type { ToolCall, ToolCallContent, ToolCallLocation, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk"

export type ToolInput = Record<string, unknown>

export type ToolAttachment = {
  readonly mime?: string
  readonly url?: string
  readonly [key: string]: unknown
}

export type CompletedToolState = {
  readonly status: "completed"
  readonly input: ToolInput
  readonly output: string
  readonly metadata?: unknown
  readonly attachments?: ReadonlyArray<ToolAttachment>
}

export type RunningToolState = {
  readonly status: "running"
  readonly input: ToolInput
  readonly title?: string
  readonly metadata?: unknown
}

export type ErrorToolState = {
  readonly status: "error"
  readonly input: ToolInput
  readonly error: string
  readonly metadata?: unknown
}

export type ImageAttachment = {
  readonly mimeType: string
  readonly data: string
}

export function toToolKind(toolName: string): ToolKind {
  const tool = toolName.toLocaleLowerCase()

  switch (tool) {
    case "bash":
    case "shell":
      return "execute"

    case "webfetch":
    case "browser":
      return "fetch"

    case "edit":
    case "apply_patch":
    case "patch":
    case "write":
      return "edit"

    case "grep":
    case "glob":
    case "context":
    case "context7_resolve_library_id":
    case "context7_get_library_docs":
      return "search"

    case "read":
      return "read"

    case "task":
      return "think"

    default:
      return "other"
  }
}

export function toLocations(toolName: string, input: ToolInput, cwd?: string): ToolCallLocation[] {
  const tool = toolName.toLocaleLowerCase()

  switch (tool) {
    case "bash":
    case "shell": {
      const workdir = shellWorkdir(input, cwd)
      return workdir ? [{ path: workdir }] : []
    }

    case "read":
    case "edit":
    case "write":
      return locationFrom(input.filePath ?? input.filepath)

    case "external_directory":
      return locationFrom(input.filePath ?? input.filepath, input.parentDir, input.directories)

    // apply_patch hides every path inside one opaque `patchText` blob, so without
    // this case the collapsed chat row has no locations[0].path and renders as a
    // bare "apply_patch" — GPT-family models only, since that is where the tool
    // replaces edit/write.
    case "apply_patch":
      return locationFrom(...patchFiles(input.patchText).flatMap((file) => [file.filePath, file.movePath]))

    case "grep":
    case "glob":
    case "context":
    case "context7_resolve_library_id":
    case "context7_get_library_docs":
      return locationFrom(input.path)

    default:
      return []
  }
}

export function completedToolContent(toolName: string, state: CompletedToolState): ToolCallContent[] {
  const text =
    toolName.toLocaleLowerCase() === "read" ? (readDisplayText(state.metadata) ?? state.output) : state.output
  const content: ToolCallContent[] = [
    {
      type: "content",
      content: {
        type: "text",
        text,
      },
    },
  ]

  if (toToolKind(toolName) === "edit") {
    content.push(...diffContent(state.input))
    const patch = applyPatchDiff(state.metadata)
    if (patch) content.push(patch)
  }

  content.push(...imageContents(state.attachments ?? []))
  return content
}

export function pendingToolCall(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: { readonly input: ToolInput; readonly title?: string }
  readonly cwd?: string
}): ToolCall {
  return {
    toolCallId: input.toolCallId,
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    kind: toToolKind(input.toolName),
    status: "pending",
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
    // Wire-contract decoration: surface the real tool name so the client can
    // tell a `task` sub-agent spawn apart from the main agent's own tools.
    // Plain ACP clients ignore it. Dropping it silently degrades the shell's
    // sub-agent cards to a generic tool dump — re-check after any upstream
    // import that replaces this file.
    _meta: { origami_tool_name: input.toolName },
  }
}

export function runningToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: RunningToolState
  readonly output?: string
  readonly cwd?: string
}): ToolCallUpdate {
  const content = input.output
    ? [
        {
          type: "content" as const,
          content: {
            type: "text" as const,
            text: input.output,
          },
        },
      ]
    : undefined

  return {
    toolCallId: input.toolCallId,
    status: "in_progress",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: shellDisplayInput(input.toolName, rawInput(input.toolName, input.state.input, input.cwd), input.state.metadata),
    _meta: { origami_tool_name: input.toolName },
    ...(content ? { content } : {}),
  }
}

export function duplicateRunningToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: RunningToolState
  readonly cwd?: string
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    status: "in_progress",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: shellDisplayInput(input.toolName, rawInput(input.toolName, input.state.input, input.cwd), input.state.metadata),
    _meta: { origami_tool_name: input.toolName },
  }
}

export function completedToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: CompletedToolState & { readonly title?: string }
  readonly cwd?: string
}): ToolCallUpdate {
  // apply_patch's own result title is the multi-line "Success. Updated the
  // following files:..." summary, so forwarding it raw would replace the path
  // header the running frame set with a blob. The full text still ships as
  // content and rawOutput; only the one-line header is normalised. Every other
  // tool keeps its own title untouched.
  const title =
    input.toolName.toLocaleLowerCase() === "apply_patch"
      ? applyPatchTitle(input.state.input, input.state.title)
      : input.state.title

  return {
    toolCallId: input.toolCallId,
    status: "completed",
    ...(title ? { title } : {}),
    content: completedToolContent(input.toolName, input.state),
    rawOutput: completedToolRawOutput(input.state),
    _meta: { origami_tool_name: input.toolName },
  }
}

export function errorToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: ErrorToolState
  readonly cwd?: string
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    status: "failed",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.state.input, undefined),
    locations: toLocations(input.toolName, input.state.input, input.cwd),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: input.state.error,
        },
      },
    ],
    rawOutput: {
      error: input.state.error,
      metadata: input.state.metadata,
    },
    _meta: { origami_tool_name: input.toolName },
  }
}

export function completedToolRawOutput(state: CompletedToolState) {
  return {
    output: state.output,
    ...(state.metadata !== undefined ? { metadata: state.metadata } : {}),
    ...(state.attachments?.length ? { attachments: state.attachments } : {}),
  }
}

export function imageContents(attachments: ReadonlyArray<ToolAttachment>): ToolCallContent[] {
  return extractImageAttachments(attachments).map((attachment): ToolCallContent => {
    return {
      type: "content",
      content: {
        type: "image",
        mimeType: attachment.mimeType,
        data: attachment.data,
      },
    }
  })
}

export function extractImageAttachments(attachments: ReadonlyArray<ToolAttachment>): ImageAttachment[] {
  return attachments.flatMap((attachment): ImageAttachment[] => {
    const data = dataUrlImage(attachment)
    return data ? [data] : []
  })
}

export function shellOutputSnapshot(state: { readonly metadata?: unknown }) {
  if (!state.metadata || typeof state.metadata !== "object") return undefined
  return stringValue((state.metadata as Record<string, unknown>).output)
}

// origami_change: shell cards use the model-written explanation as their title.
// Legacy calls without one fall back to the exact command.
function toolTitle(toolName: string, input: ToolInput, fallback: string | undefined) {
  if (isShell(toolName)) return stringValue(input.explanation) ?? shellCommand(input) ?? fallback ?? toolName
  if (toolName.toLocaleLowerCase() === "apply_patch") return applyPatchTitle(input, fallback)
  return fallback || toolName
}

// The tool's own completion title (tool/apply_patch.ts) is the multi-line
// "Success. Updated the following files:\nM <path>\n..." summary, and a session
// restore replays the completed part back through pendingToolCall, so that blob
// would arrive as the fallback and land verbatim in a single-line header.
// Deriving from patchText therefore wins over the fallback; when no header is
// readable only the fallback's first line is used, so the title stays one line
// whatever the caller passes. Multi-file wording matches editTitle in
// acp/permission.ts so patches and multi-file edits read the same.
function applyPatchTitle(input: ToolInput, fallback: string | undefined) {
  const files = patchFiles(input.patchText)
  if (files.length === 1) return files[0].movePath ?? files[0].filePath
  if (files.length > 1) return `${files.length} files`
  return firstLine(fallback) || "apply_patch"
}

const PATCH_FILE_HEADERS = ["*** Add File:", "*** Delete File:", "*** Update File:"]
const PATCH_MOVE_HEADER = "*** Move to:"

// Tolerant on purpose: this is a DISPLAY path that runs on the RUNNING frame,
// where the payload can still be partial. Patch.parsePatch throws when the
// Begin/End markers are missing, so it must not be reused here — we mirror only
// parsePatchHeader's header reading and report whatever is already visible.
function patchFiles(patchText: unknown): Array<{ filePath: string; movePath?: string }> {
  const text = stringValue(patchText)
  if (!text) return []

  const lines = text.split(/\r?\n/)
  const files: Array<{ filePath: string; movePath?: string }> = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const header = PATCH_FILE_HEADERS.find((prefix) => line.startsWith(prefix))
    if (!header) continue

    const filePath = line.slice(header.length).trim()
    if (!filePath) continue

    // A rename is one file with two paths, as in parsePatchHeader. Counting the
    // destination as a second file would inflate the "N files" title.
    const next = lines[index + 1]
    const movePath = next?.startsWith(PATCH_MOVE_HEADER) ? next.slice(PATCH_MOVE_HEADER.length).trim() : ""
    if (movePath) index++

    files.push(movePath ? { filePath, movePath } : { filePath })
  }

  return files
}

function firstLine(value: string | undefined) {
  return value?.split(/\r?\n/, 1)[0]?.trim()
}

// Enrich shell rawInput with the resolved working directory so clients can show
// where the command runs, unless the model already specified one.
function rawInput(toolName: string, input: ToolInput, cwd?: string): ToolInput {
  if (!isShell(toolName)) return input
  if (input.cwd || input.workdir) return input
  const workdir = shellWorkdir(input, cwd)
  return workdir ? { ...input, cwd: workdir } : input
}

function shellDisplayInput(toolName: string, input: ToolInput, metadata: unknown): ToolInput {
  if (!isShell(toolName) || !metadata || typeof metadata !== "object") return input
  const shellDisplay = stringValue((metadata as Record<string, unknown>).shellDisplay)
  return shellDisplay ? { ...input, shellDisplay } : input
}

function shellWorkdir(input: ToolInput, cwd?: string) {
  const explicit = stringValue(input.workdir) ?? stringValue(input.cwd)
  return resolvePath(explicit, cwd) ?? cwd
}

function resolvePath(value: string | undefined, cwd?: string) {
  if (!value) return undefined
  if (isAbsolute(value)) return value
  return resolve(cwd ?? process.cwd(), value)
}

function shellCommand(input: ToolInput) {
  return stringValue(input.command) ?? stringValue(input.cmd)
}

function isShell(toolName: string) {
  const tool = toolName.toLocaleLowerCase()
  return tool === "bash" || tool === "shell"
}

export const mapToolKind = toToolKind
export const extractLocations = toLocations
export const buildCompletedToolContent = completedToolContent
export const buildCompletedRawOutput = completedToolRawOutput
export const extractShellOutputSnapshot = shellOutputSnapshot
export const buildPendingToolCall = pendingToolCall
export const buildRunningToolUpdate = runningToolUpdate
export const buildDuplicateRunningToolUpdate = duplicateRunningToolUpdate
export const buildCompletedToolUpdate = completedToolUpdate
export const buildErrorToolUpdate = errorToolUpdate

function locationFrom(...values: unknown[]): ToolCallLocation[] {
  return Array.from(
    new Set(
      values.flatMap((value): string[] => {
        if (Array.isArray(value)) {
          return value.filter((item): item is string => typeof item === "string" && item.length > 0)
        }
        const path = stringValue(value)
        return path ? [path] : []
      }),
    ),
    (path) => ({ path }),
  )
}

function diffContent(input: ToolInput): ToolCallContent[] {
  const oldText = stringValue(input.oldString)
  const newText = stringValue(input.newString) ?? stringValue(input.content)
  if (oldText === undefined || newText === undefined) return []

  return [
    {
      type: "diff",
      path: stringValue(input.filePath) ?? "",
      oldText,
      newText,
    },
  ]
}

function applyPatchDiff(metadata: unknown): ToolCallContent | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const files = (metadata as Record<string, unknown>).files
  if (!Array.isArray(files) || files.length !== 1 || !files[0] || typeof files[0] !== "object") return undefined
  const file = files[0] as Record<string, unknown>
  const path = stringValue(file.movePath) ?? stringValue(file.filePath)
  const oldText = stringValue(file.oldContent)
  const newText = stringValue(file.newContent)
  if (!path || oldText === undefined || newText === undefined) return undefined
  return { type: "diff", path, oldText, newText }
}

function readDisplayText(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return undefined
  const display = (metadata as Record<string, unknown>).display
  if (!display || typeof display !== "object") return undefined
  const info = display as Record<string, unknown>
  if (info.type === "file") return stringValue(info.text)
  if (info.type === "directory" && Array.isArray(info.entries)) {
    return info.entries.filter((item): item is string => typeof item === "string").join("\n")
  }
  return undefined
}

function dataUrlImage(attachment: ToolAttachment) {
  const match = stringValue(attachment.url)?.match(/^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/)
  const mime = match?.[1] ?? stringValue(attachment.mime)
  if (!mime?.startsWith("image/")) return undefined

  const data = match?.[2]
  if (data === undefined) return undefined
  return { mimeType: mime, data }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

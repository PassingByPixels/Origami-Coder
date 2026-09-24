import { SessionV1 } from "@origami/core/v1/session"
import { buildPrompt } from "@origami/core/session/compaction"

/**
 * The compaction USER prompt, engine side.
 *
 * `@origami/core`'s `buildPrompt` owns the section spec and stays the authority
 * on it. This module WRAPS it: core's prompt first, then the engine's
 * working-set amendment and the deterministic blocks it refers to.
 *
 * Those blocks are computed, not asked for: a summariser asked to "list the
 * files you touched" re-reads a truncated history and guesses, while the engine
 * already holds the tool calls. The model's only job is to keep the extracted
 * list and say why each path matters.
 */

/** Beyond this many paths the block is bloat, so the oldest are dropped. */
export const MAX_FILES = 40

/** Beyond this many characters a single path is a runaway argument, not a path. */
const MAX_PATH_CHARS = 400

export type TouchedFile = {
  readonly path: string
  /** `lines 10-60`, or `whole file` when no range was ever recorded. */
  readonly range: string
}

const WHOLE = "whole file"

function readRange(input: Record<string, unknown>): string {
  const offset = typeof input["offset"] === "number" ? input["offset"] : undefined
  const limit = typeof input["limit"] === "number" ? input["limit"] : undefined
  if (offset === undefined && limit === undefined) return WHOLE
  const start = offset ?? 1
  if (limit === undefined) return `lines ${start}-end`
  return `lines ${start}-${start + limit - 1}`
}

/** Paths named by an apply_patch body. The markers are the ones `patch/index.ts`
 *  parses, so a patch this engine can APPLY is a patch this can read. */
function patchPaths(patchText: string): string[] {
  const markers = ["*** Add File:", "*** Delete File:", "*** Update File:", "*** Move to:"]
  const found: string[] = []
  for (const line of patchText.split("\n")) {
    const marker = markers.find((item) => line.startsWith(item))
    if (!marker) continue
    const path = line.slice(marker.length).trim()
    if (path) found.push(path)
  }
  return found
}

function fromTool(part: SessionV1.ToolPart): TouchedFile[] {
  const input = part.state.input as Record<string, unknown> | undefined
  if (!input) return []
  const filePath = typeof input["filePath"] === "string" ? input["filePath"] : undefined
  switch (part.tool) {
    case "read":
      return filePath ? [{ path: filePath, range: readRange(input) }] : []
    case "edit":
    case "write":
      return filePath ? [{ path: filePath, range: WHOLE }] : []
    case "apply_patch": {
      const text = typeof input["patchText"] === "string" ? input["patchText"] : ""
      return patchPaths(text).map((path) => ({ path, range: WHOLE }))
    }
    case "grep": {
      const path = typeof input["path"] === "string" ? input["path"] : undefined
      return path ? [{ path, range: WHOLE }] : []
    }
    default:
      return []
  }
}

/**
 * Every path the session touched, OLDEST FIRST and each carrying its LAST known
 * range. A path read twice appears once, at its most recent touch, so the newest
 * work is what survives the truncation at `MAX_FILES`.
 */
export function filesTouched(messages: readonly SessionV1.WithParts[]): TouchedFile[] {
  const order: string[] = []
  const ranges = new Map<string, string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      for (const touched of fromTool(part)) {
        if (touched.path.length > MAX_PATH_CHARS) continue
        const at = order.indexOf(touched.path)
        if (at >= 0) order.splice(at, 1)
        order.push(touched.path)
        // A later WHOLE never erases an earlier range: "lines 10-60" is the
        // more useful fact, and an edit reports no range at all.
        if (touched.range !== WHOLE || !ranges.has(touched.path)) ranges.set(touched.path, touched.range)
      }
    }
  }
  return order.map((path) => ({ path, range: ranges.get(path) ?? WHOLE }))
}

/** The open items of the LAST `todowrite` call, in the order the model set them. */
export function openTodos(messages: readonly SessionV1.WithParts[]): string[] {
  let latest: unknown
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "todowrite") continue
      const input = part.state.input as Record<string, unknown> | undefined
      if (input && Array.isArray(input["todos"])) latest = input["todos"]
    }
  }
  if (!Array.isArray(latest)) return []
  return latest.flatMap((item) => {
    if (typeof item !== "object" || item === null) return []
    const content = "content" in item && typeof item.content === "string" ? item.content : undefined
    const status = "status" in item && typeof item.status === "string" ? item.status : "pending"
    if (!content) return []
    if (status === "completed" || status === "cancelled") return []
    return [`${content} (${status})`]
  })
}

export function filesBlock(files: readonly TouchedFile[]): string | undefined {
  if (!files.length) return undefined
  const kept = files.slice(-MAX_FILES)
  const dropped = files.length - kept.length
  const lines = kept.map((item) => `- ${item.path} (${item.range})`)
  if (dropped > 0) lines.unshift(`- (${dropped} older files omitted)`)
  return ["<files-touched>", ...lines, "</files-touched>"].join("\n")
}

export function todosBlock(todos: readonly string[]): string | undefined {
  if (!todos.length) return undefined
  return ["<open-todos>", ...todos.map((item) => `- ${item}`), "</open-todos>"].join("\n")
}

/**
 * The amendment to core's template. It is an ADDITION, not a replacement: the
 * section order core specifies is unchanged and `## Working set` goes last. The
 * word budget is the other half of the trade - the prose gives up room for the
 * working set, which is the part the next turn actually reads.
 */
const WORKING_SET = `Then add ONE more section after the last section of the template, with this exact structure:

## Working set
### Files
- [path (line range or "whole file"): one clause on why it matters]
### Decisions
- [decision already made and the reason, one line each, or "(none)"]
### Open todo items
- [item and its status, or "(none)"]

Working set rules:
- List every path from <files-touched> below, in the same order, and add no path that is not there.
- Keep each path and its bracketed range exactly as given.
- List every item from <open-todos> below when that block is present; write "(none)" when it is not.
- Put decisions here, not in the prose sections.
- Keep the prose sections above (everything before "## Working set") to 200 words in total.`

export function build(input: {
  readonly previousSummary?: string
  readonly context: readonly string[]
  readonly messages: readonly SessionV1.WithParts[]
}): string {
  const blocks = [filesBlock(filesTouched(input.messages)), todosBlock(openTodos(input.messages))].filter(
    (item): item is string => item !== undefined,
  )
  return buildPrompt({
    previousSummary: input.previousSummary,
    context: [WORKING_SET, ...blocks, ...input.context],
  })
}

export * as SessionCompactionPrompt from "./compaction-prompt"

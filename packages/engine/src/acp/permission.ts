import type {
  AgentSideConnection,
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import { applyPatch } from "diff"
import { exists, readText } from "@/util/filesystem"
import type { ACPSession } from "./session"
import { ACPAncestor } from "./ancestor"
import { pendingToolCall, toLocations, type ToolInput } from "./tool"
import { Effect } from "effect"

type PermissionEvent = Extract<Event, { type: "permission.asked" }>
type Reply = "once" | "always" | "reject"
type Connection = Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>

/** Exported for a direct unit test, like permissionTitle below.
 *
 *  An EMPTY `always` list is a tool declaring "no answer covers the next call"
 *  (`screenshot` is the first — a whole-screen grab can hold anything on the
 *  desktop). The engine already stores nothing for an "always" reply with no
 *  patterns, so offering the button would be a LIE the user only discovers on
 *  the next capture; omit it instead. `undefined` (an older engine, or a
 *  client-fabricated event) keeps the full list — the lie is only certain when
 *  the emptiness is. */
export function permissionOptions(always: readonly string[] | undefined): PermissionOption[] {
  return [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    ...(always?.length === 0 ? [] : [{ optionId: "always", kind: "allow_always", name: "Always allow" } as PermissionOption]),
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ]
}

export class Handler {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly input: {
      sdk: OrigamiClient
      connection: Connection
      session: ACPSession.Interface
    },
  ) {}

  handle(event: PermissionEvent) {
    const permission = event.properties
    const previous = this.queues.get(permission.sessionID) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(event))
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(permission.sessionID) === next) {
          this.queues.delete(permission.sessionID)
        }
      })
    this.queues.set(permission.sessionID, next)
  }

  private async process(event: PermissionEvent) {
    const permission = event.properties
    // A subagent session is never registered in the ACP-layer session store, so
    // tryGet misses for a subagent's ask and an early return would silently drop
    // it: the client never sees the request, the subagent's tool call sits running
    // forever, and its parent's task call freezes with it. When the direct lookup
    // misses, walk the domain parent chain (shared helper - acp/ancestor.ts, also
    // used by the event boundary) to the nearest registered ancestor and surface
    // the ask under THAT ancestor's ACP session id (the only id the client knows).
    const session =
      (await Effect.runPromise(this.input.session.tryGet(permission.sessionID))) ??
      (await ACPAncestor.resolveRegisteredAncestor({
        sdk: this.input.sdk,
        session: this.input.session,
        sessionID: permission.sessionID,
      }))
    // NO SESSION, NO SILENCE. An early return here left the ask pending with
    // nothing on either end of it: the client never sees a bar, the tool call
    // sits `running` for the life of the session, and a parent waiting on the
    // sub-agent hangs behind it with no reason shown. The ancestor walk above
    // is what makes this rare, and rare is exactly when a silent drop is worst
    // to debug. So it is refused, the same shape the `requestPermission`
    // branch below already uses — a refusal is an answer the agent can report.
    //
    // The reply needs a directory and there is no session to read one off, so
    // it falls back to the engine's own cwd. `directory` scopes an "always"
    // approval; a reject stores nothing, so nothing is scoped to the wrong
    // project by this.
    if (!session) {
      await this.reply(permission.id, "reject", process.cwd())
      return
    }

    if (!this.input.connection.requestPermission) {
      await this.reply(permission.id, "reject", session.cwd)
      return
    }

    const result = await this.input.connection
      .requestPermission({
        // Forward under the RESOLVED session (self for a registered session, the
        // registered ancestor for a subagent). The reply below still targets the
        // ORIGINAL permission id, and the Permission service keys pending requests
        // on request id (not session id), so the reply resolves the real ask.
        sessionId: session.id,
        toolCall: await permissionToolCall({
          toolCallId: permission.tool?.callID ?? permission.id,
          toolName: permission.permission,
          input: permission.metadata,
        }),
        options: permissionOptions(permission.always),
      })
      .catch(async () => {
        await this.reply(permission.id, "reject", session.cwd)
        return undefined
      })

    if (!result) return

    const reply = selectedReply(result)
    if (reply !== "once" && reply !== "always") {
      await this.reply(permission.id, "reject", session.cwd)
      return
    }

    if (permission.permission === "edit") {
      await this.writeProposedEdit(session.id, permission.metadata).catch(() => {})
    }

    await this.reply(permission.id, reply, session.cwd)
  }

  private async reply(requestID: string, reply: Reply, directory: string) {
    await this.input.sdk.permission.reply({
      requestID,
      reply,
      directory,
    })
  }

  private async writeProposedEdit(sessionId: string, metadata: ToolInput) {
    const filepath = stringValue(metadata.filepath)
    const diff = stringValue(metadata.diff)
    if (!filepath || !diff || !this.input.connection.writeTextFile) return

    const content = (await exists(filepath)) ? await readText(filepath) : ""
    const next = applyPatch(content, diff)
    if (next === false) {
      return
    }

    void this.input.connection.writeTextFile({
      sessionId,
      path: filepath,
      content: next,
    })
  }
}

async function permissionToolCall(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: ToolInput
}): Promise<ToolCallUpdate> {
  const toolCall = pendingToolCall({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    state: {
      input: input.input,
      title: permissionTitle(input.toolName, input.input),
    },
  })
  const content = await permissionContent(input.toolName, input.input)
  return {
    ...toolCall,
    locations: permissionLocations(input.toolName, input.input),
    ...(content.length ? { content } : {}),
  }
}

/** Exported for a direct unit test: this is a pure name -> title mapping, and
 *  reaching it through the whole ACP harness proves less about the mapping. */
export function permissionTitle(toolName: string, input: ToolInput) {
  const tool = toolName.toLocaleLowerCase()
  switch (tool) {
    case "external_directory":
      return stringValue(input.description) ?? stringValue(input.command) ?? stringValue(input.parentDir)

    case "webfetch":
      return stringValue(input.url)

    // Same shape as webfetch: name the page. The actions that drive a page
    // already open (read/screenshot/click/type/hover/drag/dialog) carry no url,
    // so they name the action instead of leaving a plain ACP client an
    // unlabelled permission bar. `raw` carries CODE, and the code is what is
    // being approved - a bar reading "raw" would hide the whole decision.
    case "browser":
      return stringValue(input.code) ?? stringValue(input.url) ?? stringValue(input.action)

    case "websearch":
      return stringValue(input.query)

    case "grep":
    case "glob":
      return stringValue(input.pattern)

    case "read":
    case "edit":
    case "write":
      return editTitle(input)

    default:
      return undefined
  }
}

function editTitle(input: ToolInput) {
  const files = fileMetadata(input)
  if (files.length === 1) return files[0]?.relativePath ?? files[0]?.filePath
  if (files.length > 1) return `${files.length} files`
  return stringValue(input.filePath) ?? stringValue(input.filepath) ?? stringValue(input.path)
}

function permissionLocations(toolName: string, input: ToolInput): ToolCallLocation[] {
  const files = fileMetadata(input)
  if (files.length) {
    return Array.from(
      new Set(files.flatMap((file) => [file.filePath, file.movePath].filter((path): path is string => !!path))),
      (path) => ({ path }),
    )
  }
  return toLocations(toolName, input)
}

async function permissionContent(toolName: string, input: ToolInput): Promise<ToolCallContent[]> {
  if (toolName.toLocaleLowerCase() !== "edit") return []

  const files = fileMetadata(input)
  if (files.length) return diffContentForFiles(files)

  const filepath = stringValue(input.filepath) ?? stringValue(input.filePath)
  const diff = stringValue(input.diff)
  if (!filepath || !diff) return []
  const content = await diffContentForPatch(filepath, diff)
  return content ? [content] : []
}

async function diffContentForFiles(files: PermissionFileMetadata[]) {
  const content = await Promise.all(
    files.map(async (file) => {
      if (!file.patch) return []
      const content = await diffContentForPatch(file.filePath, file.patch, file.movePath)
      return content ? [content] : []
    }),
  )
  return content.flat()
}

async function diffContentForPatch(filepath: string, diff: string, displayPath = filepath) {
  const content = (await exists(filepath)) ? await readText(filepath) : ""
  const next = applyPatch(content, diff)
  if (next === false) return undefined
  return {
    type: "diff" as const,
    path: displayPath,
    oldText: content,
    newText: next,
  }
}

function selectedReply(result: RequestPermissionResponse): Reply {
  if (result.outcome.outcome !== "selected") return "reject"
  if (result.outcome.optionId === "once" || result.outcome.optionId === "always") return result.outcome.optionId
  return "reject"
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

type PermissionFileMetadata = {
  readonly filePath: string
  readonly relativePath?: string
  readonly movePath?: string
  readonly patch?: string
}

function fileMetadata(input: ToolInput): PermissionFileMetadata[] {
  if (!Array.isArray(input.files)) return []
  return input.files.flatMap((file): PermissionFileMetadata[] => {
    if (!file || typeof file !== "object") return []
    const info = file as Record<string, unknown>
    const filePath = stringValue(info.filePath)
    if (!filePath) return []
    return [
      {
        filePath,
        relativePath: stringValue(info.relativePath),
        movePath: stringValue(info.movePath),
        patch: stringValue(info.patch),
      },
    ]
  })
}

export * as ACPPermission from "./permission"

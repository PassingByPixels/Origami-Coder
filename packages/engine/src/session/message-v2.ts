import { SessionID, MessageID } from "./schema"
import { SessionV1 } from "@origami/core/v1/session"
import { ProviderV2 } from "@origami/core/provider"
import {
  APIError,
  AbortedError,
  Assistant,
  AuthError,
  CompactionPart,
  ContextOverflowError,
  Info,
  OutputLengthError,
  Part,
  SubtaskPart,
  User,
  WithParts,
} from "@origami/core/v1/session"

import { NamedError } from "@origami/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { max } from "drizzle-orm"
import { or } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "@origami/core/session/sql"
import { ProviderError } from "@/provider/error"
import { LLMError } from "@origami/llm"
import { SessionStreamDrop } from "./stream-drop"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import { isRecord } from "@/util/record"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

/**
 * Wall-clock elapsed, formatted for a model reading it as plain prose: one
 * decimal under a minute, "m s" above. Codex prefixes every tool result with
 * this so the model has time as a construct from its environment; this is
 * the engine's equivalent.
 */
function formatElapsed(ms: number) {
  const clamped = Math.max(0, ms)
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)} s`
  const totalSeconds = Math.floor(clamped / 1000)
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}

/**
 * The ONE place an elapsed marker is added to a tool result's model-facing
 * text. Deliberately separate from `part.state.output`, which the tool cards
 * (BashCard.svelte, ReadFileCard.svelte, GenericCard.svelte, ...) render
 * verbatim via the `result` prop — this function only shapes the ephemeral
 * string built for the provider request, so the stored part, and every card
 * reading it, is untouched.
 */
function withElapsedMarker(text: string, time: { start: number; end: number }) {
  return `[took ${formatElapsed(time.end - time.start)}]\n${text}`
}

export const Event = {
  Updated: SessionV1.Event.MessageUpdated,
  Removed: SessionV1.Event.MessageRemoved,
  PartUpdated: SessionV1.Event.PartUpdated,
  PartDelta: SessionV1.Event.PartDelta,
  PartRemoved: SessionV1.Event.PartRemoved,
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

function hydrate(db: Database.Interface["db"], rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  return Effect.gen(function* () {
    if (ids.length > 0) {
      const partRows = yield* db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all()
        .pipe(Effect.orDie)
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  })
}

/**
 * Stored part metadata mixes two unrelated things: provider-owned records the
 * model must get back (`{anthropic:{signature}}`, `{openrouter:{...}}`) and the
 * engine's own flat markers (`origami_retry`, `origami_degraded`, and the rest).
 *
 * The AI SDK requires providerOptions to be a two-level
 * `Record<providerId, Record<string, JSONValue>>`. A one-level marker replayed
 * verbatim fails `standardizePrompt`'s schema check, which rejects the entire
 * messages array — so one stored retry notice would make every later turn in that
 * session fail permanently. Keep only the entries that are provider-shaped.
 */
function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  const result = Object.fromEntries(Object.entries(rest).filter(([, value]) => isRecord(value)))
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * What to send instead of what a tool part stores, keyed by `part.id`.
 *
 * Decided in `session/tool-aging.ts` and applied here because this is the one
 * place the stored parts become the outgoing array. Nothing on this path writes:
 * the map is read, the part is not edited, and turning the feature off restores
 * the previous wire byte for byte.
 */
export type ToolRewrites = ReadonlyMap<string, { readonly output?: string; readonly input?: Record<string, unknown> }>

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number; toolRewrites?: ToolRewrites },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // Media from tool results that has to be injected as a user message instead:
  // OpenAI-compatible APIs only accept string content in a tool result, and some
  // SDKs accept only a subset (Bedrock takes images there but not PDFs). Only
  // when the model supports that media as input at all — otherwise
  // unsupportedParts() turns it into a user-visible error.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      for (const part of msg.parts) {
        // User message parts should never be empty
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      // Anthropic adaptive thinking can persist assistant turns holding an empty
      // text part between signed reasoning blocks. It is a structural separator:
      // dropping it shifts signed thinking positions after step-start splitting,
      // and keeping it as "" is filtered by the AI SDK and rejected by Anthropic.
      // A single space survives replay without changing the neighbouring blocks.
      const hasSignedReasoning = msg.parts.some((part) => {
        if (part.type !== "reasoning") return false
        return part.metadata?.anthropic?.signature != null
      })
      for (const part of msg.parts) {
        if (part.type === "text") {
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          assistantMessage.parts.push({
            type: "text",
            text,
            ...(differentModel ? {} : { providerMetadata: providerMeta(part.metadata) }),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            // Aging (session/tool-aging.ts) applies to completed results only,
            // which makes "error results are never aged" structural rather than a
            // rule to remember. `time.compacted` still wins: that part's output is
            // already gone from the record.
            const rewrite = part.state.time.compacted ? undefined : options?.toolRewrites?.get(part.id)
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : (rewrite?.output ??
                withElapsedMarker(
                  truncateToolOutput(part.state.output, options?.toolOutputMaxChars),
                  part.state.time,
                ))
            const attachments =
              part.state.time.compacted || rewrite?.output !== undefined || options?.stripMedia
                ? []
                : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
            if (extractedMedia.length > 0) {
              media.push(...extractedMedia)
            }
            const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: rewrite?.input ?? part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          if (differentModel) {
            if (part.text.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: part.text,
              })
            continue
          }
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            providerMetadata: providerMeta(part.metadata),
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number; toolRewrites?: ToolRewrites },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options))
}

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const { db } = yield* Database.Service
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(where)
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = yield* hydrate(db, slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

/** A newest-first page walk that can be stopped and resumed. `step` reads one
 *  page and hands its messages to `visit`, newest first; the walk is `done`
 *  when `visit` returns true or no older page is left.
 *
 *  t-u54x6w: every page after the first is read after a yield to the event
 *  loop. A page is one synchronous SQLite read plus a JSON parse of its parts;
 *  without the yield all pages of a long window ran as ONE block of the JS
 *  thread, which every other chat in the process waited for. */
function walker(sessionID: SessionID, visit: (msg: WithParts) => boolean) {
  const size = 50
  const state = { done: false, before: undefined as string | undefined, pages: 0 }
  const step = Effect.gen(function* () {
    if (state.done) return
    if (state.pages > 0) yield* Effect.yieldNow
    state.pages++
    const next = yield* page({ sessionID, limit: size, before: state.before }).pipe(
      Effect.catchIf(NotFoundError.isInstance, () =>
        Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
      ),
    )
    if (next.items.length === 0) {
      state.done = true
      return
    }
    for (let i = next.items.length - 1; i >= 0; i--) {
      const item = next.items[i]
      if (item && visit(item)) {
        state.done = true
        return
      }
    }
    if (!next.more || !next.cursor) {
      state.done = true
      return
    }
    state.before = next.cursor
  })
  const rest = Effect.gen(function* () {
    while (!state.done) yield* step
  })
  return { state, step, rest }
}

/** Visit the session's messages newest first, one page at a time. The walk
 *  stops, and reads no older page, when `visit` returns true. */
function walk(sessionID: SessionID, visit: (msg: WithParts) => boolean) {
  return walker(sessionID, visit).rest
}

export function stream(sessionID: SessionID) {
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    yield* walk(sessionID, (msg) => {
      result.push(msg)
      return false
    })
    return result
  })
}

/** One turn: the user message `messageID` and every message after it, oldest
 *  first. Reads back from the newest page only as far as that message, not
 *  the whole session. If the message is missing, this reads everything. */
export function turn(sessionID: SessionID, messageID: MessageID) {
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    yield* walk(sessionID, (msg) => {
      result.push(msg)
      return msg.info.id === messageID
    })
    return result.reverse()
  })
}

export function parts(messageID: MessageID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.message_id, messageID))
      .orderBy(PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return rows.map(part)
  })
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: yield* parts(input.messageID),
  }
})

/** The newest-first walk that finds where the model's history starts. `push`
 *  takes one message and returns true when no older message is needed. */
function compactionCut() {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  const push = (msg: WithParts): boolean => {
    result.push(msg)
    if (retain) return msg.info.id === retain
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) return false
      if (!part.tail_start_id) return true
      retain = part.tail_start_id
      return msg.info.id === retain
    }
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
    return false
  }
  return { result, push }
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  const cut = compactionCut()
  for (const msg of msgs) if (cut.push(msg)) break
  return arrange(cut.result)
}

function arrange(result: WithParts[]) {
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ]
  }
  return result
}

// t-tc1mhl: the same cut as filterCompacted(stream(...)), but the page walk
// stops at the cut, so history from before a compaction is not read and
// parsed at every step.
export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  const cut = compactionCut()
  yield* walk(sessionID, cut.push)
  return arrange(cut.result)
})

/** The largest message id of the session older than the page cursor `before`:
 *  an id-only read, no part and no message JSON. */
const olderMaxID = Effect.fnUntraced(function* (sessionID: SessionID, before: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ id: max(MessageTable.id) })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, sessionID), older(cursor.decode(before))))
    .get()
    .pipe(Effect.orDie)
  return row?.id ?? undefined
})

/**
 * t-u54x6w: the loop's read at the top of a step, in two halves.
 *
 * The pass that ENDS a turn reads the window only to learn that the last reply
 * finished. Only a pass that sends a request needs the whole window since the
 * compaction cut (80 MB of stored parts in the owner's largest chat). So the
 * walk reads newest pages only until `latest` is settled, and `all` finishes
 * the SAME walk (same pages, same cut, same objects) when the pass goes on.
 *
 * Settled: the pages read hold a user message and a finished assistant, and
 * every unread row of the session has a smaller id than both (one id-only
 * query; ids are what `latest` compares). Then no unread message can change
 * `latest`, `tasks` (they come only from messages newer than the finished
 * reply) or the last assistant's parts. Otherwise the walk reads to the cut,
 * as `filterCompactedEffect` does.
 */
export const window = Effect.fnUntraced(function* (sessionID: SessionID) {
  const cut = compactionCut()
  const walk = walker(sessionID, cut.push)
  let found = latest(cut.result)
  while (!walk.state.done) {
    yield* walk.step
    if (walk.state.done || !walk.state.before) break
    found = latest(cut.result)
    if (!found.user || !found.finished) continue
    const floor = found.user.id < found.finished.id ? found.user.id : found.finished.id
    const unread = yield* olderMaxID(sessionID, walk.state.before)
    if (unread === undefined || unread < floor) break
    yield* walk.rest
  }
  if (walk.state.done) found = latest(cut.result)
  // Read before `all` reorders the array in place.
  const head = [...cut.result]
  let arranged: WithParts[] | undefined
  const all = Effect.gen(function* () {
    if (arranged) return arranged
    yield* walk.rest
    arranged = arrange(cut.result)
    return arranged
  })
  return { latest: found, head, all }
})

// filterCompacted reorders messages for model consumption, so array position is
// not chronological. Derive each binding by max id (MessageID is monotonic) so a
// pre-compaction overflowing tail assistant is not mistaken for the most recent
// turn. Tasks are compaction/subtask parts attached to user messages newer than
// the latest finished assistant — unprocessed work.
export function latest(msgs: WithParts[]) {
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (info.role === "user" && (!user || info.id > user.id)) user = info
    if (info.role === "assistant" && (!assistant || info.id > assistant.id)) assistant = info
    if (info.role === "assistant" && info.finish && (!finished || info.id > finished.id)) finished = info
  }
  const tasks = msgs.flatMap((m) =>
    finished && m.info.id <= finished.id
      ? []
      : m.parts.filter((p): p is CompactionPart | SubtaskPart => p.type === "compaction" || p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

function dropError(e: unknown, aborted?: boolean) {
  const drop = SessionStreamDrop.detect(e, aborted)
  if (!drop) return undefined
  return new APIError(
    {
      message: drop.message,
      isRetryable: true,
      metadata: { code: SessionStreamDrop.CODE, reason: drop.why },
    },
    { cause: e },
  ).toObject()
}

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderV2.ID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.HeaderTimeoutError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
            timeoutMs: String(e.ms),
          },
        },
        { cause: e },
      ).toObject()
    // A provider-written error frame the engine could read (t-h8s3xg): an
    // uninformative sentence made specific, or a mid-stream rate limit read as
    // the 429 it is. Ahead of the drop detector because the fields are already
    // decided - `session/provider-error-frame.ts` asks the drop classifier
    // FIRST and leaves a drop's own words untouched.
    case e instanceof ProviderError.StreamFrameError:
      return new APIError(
        {
          message: e.message,
          statusCode: e.api.statusCode,
          isRetryable: e.api.isRetryable,
          responseBody: e.api.responseBody,
          metadata: e.api.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.ResponseStreamError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
          },
        },
        { cause: e },
      ).toObject()
    // The native runtime's typed failure. A transport fault or unreadable stream
    // is left to the drop detector below; everything with an HTTP exchange is read
    // into the same APIError the AI SDK path produces. An error frame the protocol
    // could not decode carries the frame verbatim, and when it is not a transport
    // drop it is read with `parseStreamError` like the AI SDK path, so a
    // mid-stream context overflow or quota refusal keeps its meaning.
    case e instanceof LLMError && e.reason._tag === "InvalidProviderOutput" && !SessionStreamDrop.detect(e, ctx.aborted): {
      const raw = e.reason.raw
      const frame = raw === undefined ? undefined : ProviderError.parseStreamError(raw)
      if (frame?.type === "context_overflow")
        return new ContextOverflowError({ message: frame.message, responseBody: frame.responseBody }, { cause: e }).toObject()
      if (frame)
        return new APIError(
          { message: frame.message, isRetryable: frame.isRetryable, responseBody: frame.responseBody },
          { cause: e },
        ).toObject()
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    }
    case e instanceof LLMError && e.reason._tag !== "Transport" && e.reason._tag !== "InvalidProviderOutput": {
      const native = ProviderError.parseLLMError({ providerID: ctx.providerID, error: e })
      if (native.type === "context_overflow") {
        return new ContextOverflowError(
          { message: native.message, responseBody: native.responseBody },
          { cause: e },
        ).toObject()
      }
      return new APIError(
        {
          message: native.message,
          statusCode: native.statusCode,
          isRetryable: native.isRetryable,
          responseHeaders: native.responseHeaders,
          responseBody: native.responseBody,
          metadata: native.metadata,
        },
        { cause: e },
      ).toObject()
    }
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    // A stream that died after the request was accepted. The AI SDK retries only
    // `doStream`, so anything that goes wrong once the body is flowing arrives
    // here raw — no status, no headers, no APICallError. Typed as a retryable
    // APIError so the retry ladder can carry it, and marked so `SessionRetry` can
    // spend the family's own tighter budget on it.
    case SessionStreamDrop.detect(e, ctx.aborted) !== undefined:
      return dropError(e, ctx.aborted) ?? new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
export const node = LayerNode.group([Database.node])

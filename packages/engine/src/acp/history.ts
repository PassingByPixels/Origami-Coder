export * as ACPHistory from "./history"

import type { Message, SessionMessageResponse } from "@origami/sdk/v2"
import type { ModelV2 } from "@origami/core/model"
import type { ProviderV2 } from "@origami/core/provider"
import { MessageV2 } from "@/session/message-v2"
import type { MessageID } from "@/session/schema"
import { peerMessage } from "@/session/peer-message"

/**
 * t-ucnjwp (lazy loading L4). The pure half of the bounded restore and of the
 * three history calls: page cutting, the model/variant/mode walk, and the
 * global find. The wire shapes are fixed by
 * `reports/lazy_loading_plan_2026-09-24/wire_contract.md`.
 */

export const PAGE_SIZE = 50
/** Safety net under the 50-message page (owner answer Q1): a page of screenshots stops early. */
export const PAGE_BYTE_CAP = 16 * 1024 * 1024
export const PAGE_ID_MAX = 128
const LATEST_USER_MAX = 2_000
/** t-ugrezs. Once the model answer is known, how many pages (counted from the newest)
 *  the walk still reads to find the human's last message. A chat with no human
 *  message at all (only task and shell results) then costs this many pages, not
 *  its whole length. */
export const LATEST_USER_MAX_PAGES = 20

export const SEARCH_QUERY_MAX = 200
export const SEARCH_LIMIT_DEFAULT = 50
export const SEARCH_LIMIT_MAX = 200
/** Messages one `history_search` call reads before it answers with a cursor. */
export const SEARCH_SCAN_BUDGET = 2_000
const SNIPPET_MAX = 200
const MATCH_COUNT_MAX = 1_000

export type MessageInfo = {
  readonly role?: Message["role"]
  readonly model?: Extract<Message, { role: "user" }>["model"]
  readonly providerID?: Extract<Message, { role: "assistant" }>["providerID"]
  readonly modelID?: Extract<Message, { role: "assistant" }>["modelID"]
  readonly variant?: Extract<Message, { role: "assistant" }>["variant"]
  readonly mode?: Extract<Message, { role: "assistant" }>["mode"]
  readonly agent?: Message["agent"]
}

const userPick = (message: MessageInfo) => message.role === "user" && !!message.model?.providerID && !!message.model.modelID
const assistantPick = (message: MessageInfo) => !!message.providerID && !!message.modelID

/** Model, variant and mode of a chat, read off its messages: the LAST user message with a
 *  model wins; only when there is none does the last message with a provider/model win. */
export function restoreFromMessages(messages: readonly MessageInfo[]) {
  const user = messages.findLast(userPick)
  if (user?.model?.providerID && user.model.modelID) {
    return {
      model: { providerID: user.model.providerID as ProviderV2.ID, modelID: user.model.modelID as ModelV2.ID },
      variant: user.model.variant,
      modeId: user.agent,
    }
  }

  const assistant = messages.findLast(assistantPick)
  if (assistant?.providerID && assistant.modelID) {
    return {
      model: { providerID: assistant.providerID as ProviderV2.ID, modelID: assistant.modelID as ModelV2.ID },
      variant: assistant.variant,
      modeId: assistant.mode ?? assistant.agent,
    }
  }

  return {}
}

/**
 * The same answer as `restoreFromMessages(all messages)`, fed one page at a time,
 * NEWEST page first, plus the human's last message for the pin. `visit` returns true
 * when the caller may stop reading older pages: the model answer is known (a user
 * message with a model was seen - it must not stop at an assistant, an older user
 * message with a model still beats it) AND the human's last message was found, or
 * `LATEST_USER_MAX_PAGES` pages were read. t-ugrezs: a task or shell RESULT is a user
 * message with a model and no human text, so the model answer alone is not enough.
 */
export function restoreScan() {
  let user: MessageInfo | undefined
  let assistant: MessageInfo | undefined
  let latestUser: { messageId: string; text: string } | undefined
  let pages = 0
  return {
    /** `messages` oldest first, as a page comes off the store. */
    visit(messages: readonly SessionMessageResponse[]) {
      pages++
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        const info = message?.info as MessageInfo | undefined
        if (!message || !info) continue
        if (!latestUser && info.role === "user") {
          const text = userText(message)
          if (text) latestUser = { messageId: String(message.info.id), text }
        }
        if (!assistant && assistantPick(info)) assistant = info
        if (!user && userPick(info)) user = info
        if (user && latestUser) return true
      }
      return user !== undefined && pages >= LATEST_USER_MAX_PAGES
    },
    result() {
      return {
        restored: restoreFromMessages(user ? [user] : assistant ? [assistant] : []),
        latestUser: latestUser ?? null,
      }
    },
  }
}

/**
 * The pinned text of a user message: its LAST text part that the client draws as a
 * user row, which is the row 0.4.172's whole replay pinned. The rule is the one the
 * replay already applies: a `synthetic` part goes out with audience ['assistant']
 * (acp/content.ts `partAudience`) and the client does not draw it; a peer handoff
 * (`peerMessage`) is drawn as a peer row; an `ignored` part goes out with audience
 * ['user'] and IS drawn. Each text part is its own row. '' = no user row.
 */
function userText(message: SessionMessageResponse) {
  const text =
    message.parts
      .flatMap((part) =>
        part.type === "text" && part.synthetic !== true && part.text && !peerMessage(part.metadata) ? [part.text] : [],
      )
      .at(-1) ?? ""
  return text.length > LATEST_USER_MAX ? text.slice(0, LATEST_USER_MAX) : text
}

export type Page = {
  /** Oldest first. */
  readonly kept: readonly SessionMessageResponse[]
  readonly hasMore: boolean
  readonly cursor: string | null
  readonly capped: boolean
}

/** Serialized size of one stored message, the unit of the byte cap. */
function sizeOf(message: SessionMessageResponse) {
  try {
    return JSON.stringify(message).length
  } catch {
    return 0
  }
}

/**
 * Cut an over-fetched read (`limit + 1` rows, oldest first, as `MessageV2.page`
 * answers) into one page: the newest `limit` rows, then fewer if their size would
 * pass `byteCap`. The newest message is always kept, whatever its size. The cursor
 * names the OLDEST kept row, because `before` selects rows strictly older than it.
 */
export function cutPage(
  rows: readonly SessionMessageResponse[],
  limit: number,
  byteCap: number = PAGE_BYTE_CAP,
): Page {
  const over = rows.length > limit
  const newest = over ? rows.slice(rows.length - limit) : rows
  let start = newest.length
  let bytes = 0
  let capped = false
  for (let index = newest.length - 1; index >= 0; index--) {
    const size = byteCap === Number.POSITIVE_INFINITY ? 0 : sizeOf(newest[index]!)
    if (start < newest.length && bytes + size > byteCap) {
      capped = true
      break
    }
    bytes += size
    start = index
  }
  const kept = newest.slice(start)
  const hasMore = over || capped
  return { kept, hasMore, cursor: hasMore ? cursorOf(kept[0]) : null, capped }
}

/** The store cursor that selects the rows older than `message`, or null without both halves. */
export function cursorOf(message: SessionMessageResponse | undefined): string | null {
  const info = message?.info as { id?: unknown; time?: { created?: unknown } } | undefined
  if (typeof info?.id !== "string" || typeof info.time?.created !== "number") return null
  return MessageV2.cursor.encode({ id: info.id as MessageID, time: info.time.created })
}

/** True when `value` decodes as a store cursor. */
export function validCursor(value: string) {
  try {
    MessageV2.cursor.decode(value)
    return true
  } catch {
    return false
  }
}

export function messageIds(messages: readonly SessionMessageResponse[]) {
  return messages.map((message) => String(message.info.id))
}

// --- wire shapes (wire_contract.md) ---

export type HistoryWindow = {
  readonly sessionId: string
  readonly cursor: string | null
  readonly hasMore: boolean
  readonly messageIds: readonly string[]
  readonly totalMessages: number | null
  readonly latestUser: { readonly messageId: string; readonly text: string } | null
  readonly pageSize: typeof PAGE_SIZE
  readonly byteCap: typeof PAGE_BYTE_CAP
  readonly capped: boolean
}

export function historyWindow(input: {
  sessionId: string
  page: Page
  totalMessages: number | null
  latestUser: HistoryWindow["latestUser"]
}): HistoryWindow {
  return {
    sessionId: input.sessionId,
    cursor: input.page.cursor,
    hasMore: input.page.hasMore,
    messageIds: messageIds(input.page.kept),
    totalMessages: input.totalMessages,
    latestUser: input.latestUser,
    pageSize: PAGE_SIZE,
    byteCap: PAGE_BYTE_CAP,
    capped: input.page.capped,
  }
}

export type HistoryPageRequest = {
  readonly sessionId: string
  readonly before?: string
  readonly limit?: number
  readonly pageId?: string
  readonly cwd?: string
}

export type HistoryPageResult = {
  readonly sessionId: string
  readonly pageId: string
  readonly cursor: string | null
  readonly hasMore: boolean
  readonly messageIds: readonly string[]
  readonly messages: number
  readonly totalMessages: number | null
  readonly capped: boolean
}

export type HistorySearchRequest = {
  readonly sessionId: string
  readonly query: string
  readonly limit?: number
  readonly cursor?: string
  readonly cwd?: string
}

export type HistorySearchResult = {
  readonly sessionId: string
  readonly query: string
  readonly hits: readonly SearchHit[]
  readonly scanned: number
  readonly done: boolean
  readonly cursor: string | null
}

export type SubagentRosterRequest = { readonly sessionId: string; readonly cwd?: string }

export type RosterRow = {
  readonly id: string
  readonly parentId: string
  readonly depth: number
  readonly title: string
  readonly agent: string | null
  readonly status: "running" | "idle"
  readonly created: number
  readonly updated: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly cost: number
  readonly steps: number | null
  readonly context: number | null
}

export type SubagentRoster = {
  readonly sessionId: string
  readonly rows: readonly RosterRow[]
  readonly truncated: boolean
}

/**
 * A task marker's `origami_task_tokens` rider, from a child's ROW. The same keys and
 * the same "nothing measured yet" gate as `childSpend` (acp/event.ts); `steps` and
 * `context` are left out when unknown, which the client already reads as "not told".
 */
export function riderOf(row: Pick<RosterRow, "tokens" | "cost" | "steps" | "context">) {
  if (!(row.tokens.input > 0 || row.tokens.output > 0)) return undefined
  return {
    input: row.tokens.input,
    output: row.tokens.output,
    reasoning: row.tokens.reasoning,
    cacheRead: row.tokens.cacheRead,
    cacheWrite: row.tokens.cacheWrite,
    cost: row.cost,
    ...(row.steps === null ? {} : { steps: row.steps }),
    ...(row.context === null ? {} : { context: row.context }),
  }
}

// --- global find ---

export type SearchHit = {
  readonly messageId: string
  readonly partId: string
  readonly role: "user" | "assistant"
  readonly kind: "text" | "reasoning" | "tool"
  readonly toolCallId: string | null
  readonly time: number
  readonly fromEnd: number
  readonly snippet: string
  readonly matchStart: number
  readonly matchLength: number
  readonly matchesInPart: number
}

/** Where a search stopped: the store cursor to read older than, and how many
 *  messages were newer than that point (so `fromEnd` keeps counting). */
type SearchPosition = { readonly b: string; readonly n: number }

export function encodeSearchCursor(position: SearchPosition) {
  return Buffer.from(JSON.stringify(position)).toString("base64url")
}

export function decodeSearchCursor(value: string): SearchPosition | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SearchPosition>
    if (typeof parsed?.b !== "string" || !validCursor(parsed.b)) return undefined
    if (typeof parsed.n !== "number" || !Number.isInteger(parsed.n) || parsed.n < 0) return undefined
    return { b: parsed.b, n: parsed.n }
  } catch {
    return undefined
  }
}

/** Plain text, any case: the query is escaped, never read as a pattern. */
export function searchPattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu")
}

/** The searchable text of one part, or undefined for a part the find does not cover. */
function searchable(part: SessionMessageResponse["parts"][number]) {
  if (part.type === "text") return part.ignored === true ? undefined : { kind: "text" as const, text: part.text }
  if (part.type === "reasoning") return { kind: "reasoning" as const, text: part.text }
  if (part.type !== "tool") return undefined
  const state = part.state as { title?: unknown; output?: unknown; error?: unknown }
  const text = [state.title, state.output, state.error].filter((item): item is string => typeof item === "string")
  return { kind: "tool" as const, text: text.join("\n"), toolCallId: part.callID }
}

/** The hits of one message: one per matching part, at its first match. */
export function searchMessage(message: SessionMessageResponse, pattern: RegExp, fromEnd: number): SearchHit[] {
  const role = message.info.role
  if (role !== "user" && role !== "assistant") return []
  const hits: SearchHit[] = []
  for (const part of message.parts ?? []) {
    const field = searchable(part)
    if (!field?.text) continue
    pattern.lastIndex = 0
    const first = pattern.exec(field.text)
    if (!first) continue
    let count = 1
    while (count < MATCH_COUNT_MAX && pattern.exec(field.text)) count++
    const length = first[0].length
    const context = Math.max(0, Math.floor((SNIPPET_MAX - length) / 2))
    const start = Math.max(0, first.index - context)
    const end = Math.min(field.text.length, start + SNIPPET_MAX)
    hits.push({
      messageId: String(message.info.id),
      partId: String(part.id),
      role,
      kind: field.kind,
      toolCallId: ("toolCallId" in field ? field.toolCallId : undefined) ?? null,
      time: message.info.time.created,
      fromEnd,
      snippet: field.text.slice(start, end),
      matchStart: first.index - start,
      matchLength: Math.min(length, end - first.index),
      matchesInPart: count,
    })
  }
  return hits
}

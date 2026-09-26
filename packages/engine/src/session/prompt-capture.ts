import { createHash } from "node:crypto"
import { asSchema, type ModelMessage, type Tool } from "ai"
import type { StoppedHalf } from "./cache-policy"

/**
 * What the engine actually sent the model, beyond the user's own messages. A
 * capture, not a re-derivation: the labeled parts are recorded where the prompt
 * is assembled and the final joined system after the
 * `experimental.chat.system.transform` plugin hook, because re-running the
 * assembly would report what the engine intended to send, which a plugin can
 * make false. Process-local, in memory, never persisted.
 */

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/**
 * Which source a system-prompt block came from. `base-or-agent-prompt` covers
 * the built-in base prompt, an agent's own prompt where it replaces it, or both
 * (a bot's persona composes on top of the base prompt). `collab-agent-base` and
 * `collab-state` exist only on a collab turn, where the room's base replaces
 * the chat one and `base-or-agent-prompt` narrows to the persona alone — see
 * `record()`. `instructions` is absent on a collab turn and a bot session:
 * workspace instruction files are not delivered to a character at all.
 */
export type PartLabel =
  | "base-or-agent-prompt"
  | "collab-agent-base"
  | "collab-state"
  | "env"
  | "instructions"
  | "mcp"
  | "skills"
  /** The agent's own memory index. Labeled apart from `instructions` because
   *  it is agent-owned, and because the `remember` tool rewrites it
   *  mid-conversation — which is why it rides the tail, not the system prompt. */
  | "memory"
  /** A bot's own persistent memory, injected only on a bot's turn. Sent at the
   *  tail with `memory`, and labeled apart so a reader sees what it costs. */
  | "bot-memory"
  | "flock"
  /** Present only on a turn where the vision profile fired: the profile is set,
   *  the model cannot see, and an image is attached. */
  | "vision"
  | "structured-output"
  | "user-system"

/**
 * Where a captured part was actually delivered. The memory blocks are prompt
 * content the engine sent, so they stay captured, but they ride the message
 * tail and are genuinely not in the system text. Recording the destination is
 * what keeps the loop test's guard meaningful: a `system` part must appear in
 * what was sent, a `tail` part must not.
 */
export type PartDelivery = "system" | "tail"

export type Part = {
  readonly label: PartLabel
  readonly chars: number
  readonly tokensApprox: number
  readonly text: string
  readonly delivery: PartDelivery
}

/** One entry of the final `system` array, after the plugin transform. */
export type Block = {
  readonly chars: number
  readonly tokensApprox: number
  readonly text: string
}

export type CapturedTool = {
  readonly name: string
  readonly descriptionChars: number
  /**
   * Bytes of the tool's JSON schema as the provider would receive it. Zero means
   * NOT MEASURED, never "an empty schema" — an empty schema still serialises to
   * at least `{}`. A schema is unmeasurable when it resolves asynchronously.
   */
  readonly schemaBytes: number
  readonly description: string
}

/** One outbound message, measured rather than kept: the full array of a long
 *  session is megabytes and this store lives for the life of the process. */
export type MessageDigest = {
  readonly role: string
  /** Bytes of this message's serialised form, UTF-8. */
  readonly bytes: number
  /** First 16 hex characters of the SHA-256 of that same serialised form. */
  readonly hash: string
}

/**
 * What one model step sent, and where it first differs from the step before it.
 * A prefix cache is an exact match from byte 0, so the question that matters
 * for cache cost is whether this step rewrote anything already sent: the higher
 * `divergenceOffset` climbs step over step, the more the provider reads from
 * its cache.
 *
 * A session with a memory store never reports `prefixPreserved`, because the
 * memory block is the last message - a moving tail, not a rewritten head. The
 * defect to look for is a `divergenceOffset` that does NOT climb.
 */
export type StepCapture = {
  /** 1-based, counted per session over the life of the process. */
  readonly step: number
  readonly capturedAt: string
  readonly bytes: number
  readonly messages: readonly MessageDigest[]
  /**
   * Byte offset of the first difference against the previous step's array, or
   * null on a session's first step. Exact when the diverging message's previous
   * text was still inside the retained window (`sample` is then non-null);
   * otherwise the offset at which that message starts, which is a lower bound.
   */
  readonly divergenceOffset: number | null
  /** Index into `messages` of the first message that differs. Null on step 1. */
  readonly divergenceMessage: number | null
  /**
   * Whether the previous step's whole array survived as a byte-identical prefix
   * of this one. Null on step 1. False means content already sent came back
   * different, which is the defect this capture exists to name.
   */
  readonly prefixPreserved: boolean | null
  /** The two texts around the divergence, capped. Null past the retained window. */
  readonly sample: { readonly previous: string; readonly current: string } | null
}

export type Capture = {
  /** ISO timestamp, supplied by the caller so the store holds no clock. */
  readonly capturedAt: string
  /** `providerID/modelID` — the model this exact prompt went to. */
  readonly model: string
  readonly labeledParts: readonly Part[]
  readonly finalSystem: readonly Block[]
  readonly tools: readonly CapturedTool[]
  /**
   * The last `STEP_HISTORY` model steps, oldest first, so a reader can always
   * diff two consecutive steps. Empty when the caller did not hand `record` the
   * outbound array.
   */
  readonly steps: readonly StepCapture[]
  /** Names the estimator so a caller never mistakes it for a measurement. */
  readonly tokensApproxMethod: "chars/4"
}

export function part(label: PartLabel, text: string, delivery: PartDelivery = "system"): Part {
  return { label, chars: text.length, tokensApprox: estimateTokens(text.length), text, delivery }
}

export function block(text: string): Block {
  return { chars: text.length, tokensApprox: estimateTokens(text.length), text }
}

/**
 * The labeled blocks of the system prompt, in the order the model receives
 * them. The caller derives its `system` array from THIS list rather than
 * building a second one, so the capture and the real prompt cannot disagree.
 * The memory blocks are not here — see `memoryParts`.
 */
export function parts(input: {
  readonly env: readonly string[]
  readonly instructions: readonly string[]
  readonly mcp?: string | undefined
  readonly skills?: string | undefined
  readonly flock?: string | undefined
  readonly vision?: string | undefined
  readonly structuredOutput?: string | undefined
}): Part[] {
  return [
    ...input.env.map((text) => part("env", text)),
    ...input.instructions.map((text) => part("instructions", text)),
    ...(input.mcp ? [part("mcp", input.mcp)] : []),
    ...(input.skills ? [part("skills", input.skills)] : []),
    ...(input.flock ? [part("flock", input.flock)] : []),
    ...(input.vision ? [part("vision", input.vision)] : []),
    ...(input.structuredOutput ? [part("structured-output", input.structuredOutput)] : []),
  ]
}

/**
 * The labeled blocks sent at the tail of the message list instead of in the
 * system prompt. These are the only prompt content the agent rewrites
 * mid-conversation (the `remember` tool), and every provider caches on an exact
 * prefix match, so in the system prompt a single remembered fact would
 * invalidate the whole conversation's cache. At the tail they sit past every
 * cache breakpoint, so a write costs only itself. Still captured, but NOT part
 * of the caller's `system` array - so `parts` and this stay separate.
 */
export function memoryParts(input: {
  readonly memory?: readonly string[] | undefined
  readonly botMemory?: string | undefined
}): Part[] {
  return [
    ...(input.memory ?? []).map((text) => part("memory", text, "tail")),
    ...(input.botMemory ? [part("bot-memory", input.botMemory, "tail")] : []),
  ]
}

/**
 * How many sessions keep a capture. Each holds the full prompt text and a run
 * can open a session per sub-agent, so this is bounded. Oldest evicted first.
 */
export const LIMIT = 16

/** How many steps of one session are reported. Two is the minimum that lets a
 *  reader diff two consecutive steps. */
export const STEP_HISTORY = 2

/**
 * How much of one step's serialised array is kept as text, for the next step to
 * diff against. The digests above cover the whole array whatever its size; this
 * window only decides how far in `divergenceOffset` stays exact.
 */
export const DIFF_WINDOW_BYTES = 256 * 1024

/** Characters of context either side of a divergence in `sample`. */
const SAMPLE_CHARS = 600

/**
 * One message as bytes. `JSON.stringify` is the measure, not the wire format:
 * what is needed is a function stable for an unchanged message and different
 * for a changed one. Binary parts are replaced by their length.
 */
function serialize(message: ModelMessage): string {
  return (
    JSON.stringify(message, (_key, value) => {
      if (value instanceof Uint8Array) return `[bytes ${value.byteLength}]`
      if (value instanceof ArrayBuffer) return `[bytes ${value.byteLength}]`
      return value
    }) ?? "null"
  )
}

function digest(role: string, text: string): MessageDigest {
  return {
    role,
    bytes: Buffer.byteLength(text, "utf8"),
    hash: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16),
  }
}

/**
 * t-u54x6w: a string this long (a screenshot's base64, mostly) is not copied
 * into the text that is hashed. It stands there as a marker that carries its
 * length and a 128-bit fast hash of its content, so a changed string still
 * changes the message digest. The request of a long chat holds many
 * screenshots (79 MB in the owner's largest one), and stringifying and SHA-256
 * hashing all of them cost about 1 ms per MB on the JS thread at every step.
 */
export const BIG_STRING = 64 * 1024

function fingerprint(value: string) {
  return `${value.length}:${Bun.hash.wyhash(value, 1n).toString(16)}${Bun.hash.wyhash(value, 2n).toString(16)}`
}

/**
 * The serialised byte length of a big string, by fingerprint. Computed with a
 * real `JSON.stringify` once, the first time a string is seen: a screenshot
 * is re-sent unchanged on every later step, and the length is what keeps
 * `bytes` and `divergenceOffset` exact.
 */
const bigBytes = new Map<string, number>()
const BIG_BYTES_LIMIT = 4096

function jsonBytes(value: string, key: string) {
  const known = bigBytes.get(key)
  if (known !== undefined) return known
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
  bigBytes.set(key, bytes)
  for (const old of bigBytes.keys()) {
    if (bigBytes.size <= BIG_BYTES_LIMIT) break
    bigBytes.delete(old)
  }
  return bytes
}

/**
 * The digest of one message without copying its big strings. A message with
 * none gets exactly `digest(role, serialize(message))`. With some, the hash is
 * over the serialised text with each big string replaced by its marker, and
 * `bytes` is still the byte length of the real serialised text.
 */
function lightDigest(message: ModelMessage): MessageDigest {
  let delta = 0
  const text =
    JSON.stringify(message, (_key, value) => {
      if (value instanceof Uint8Array) return `[bytes ${value.byteLength}]`
      if (value instanceof ArrayBuffer) return `[bytes ${value.byteLength}]`
      if (typeof value === "string" && value.length >= BIG_STRING) {
        const key = fingerprint(value)
        const marker = `\u0000[big ${key}]`
        delta += jsonBytes(value, key) - Buffer.byteLength(JSON.stringify(marker), "utf8")
        return marker
      }
      return value
    }) ?? "null"
  const result = digest(message.role, text)
  return delta === 0 ? result : { ...result, bytes: result.bytes + delta }
}

/** Bytes shared by the front of two strings — the exact divergence point. */
function commonPrefixBytes(a: string, b: string): number {
  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index++
  return Buffer.byteLength(a.slice(0, index), "utf8")
}

/** The previous step of one session, kept only until the next step diffs it. */
type StepState = {
  count: number
  digests: readonly MessageDigest[]
  /** Serialised text per message, or null once past `DIFF_WINDOW_BYTES`. */
  texts: readonly (string | null)[]
  steps: StepCapture[]
}

/**
 * The two halves of the cached prefix of one prepared request, each the first
 * 16 hex characters of a SHA-256. Two hashes rather than one because the system
 * text and the tool block move for different reasons, and a reader has to be
 * able to tell which one moved.
 */
export type PrefixDigest = {
  /** SHA-256 of the final system text, exactly as the request layer joins it. */
  readonly system: string
  readonly tools: string
  /**
   * SHA-256 over the per-message digest list of the outbound array. The third
   * half of the prefix: system and tools can both hold still while an
   * already-sent message comes back rewritten. Absent when the caller handed
   * `record` no message array.
   */
  readonly history?: string
}

/** Who rewrote an already-sent message. `plugin` is inferred rather than
 *  marked - see `requestFacts`. */
export type RewriteSource = "tool-aging" | "reminder" | "plugin" | "unknown"

export type Divergence = {
  readonly message: number
  readonly role: string
  readonly offset: number
  readonly source?: RewriteSource
}

/**
 * What one prepared request measured about its own cached prefix, against the
 * previous request of the same session. Held per session for the step-finish
 * path to read: deriving it there would need the previous outbound array, which
 * only this module keeps, and re-reading the database on every step is the one
 * cost a per-step instrument may not add.
 *
 * Every member is a measurement. `first` means "no previous request of this
 * session, in this process or persisted before it" - after a restart the last
 * persisted request stands in for the previous one (`seed`, t-w2txb2).
 */
export type RequestFacts = {
  /** Epoch ms the request was prepared. */
  readonly at: number
  /** `providerID/modelID`. */
  readonly model: string
  readonly prefix: PrefixDigest
  readonly first: boolean
  readonly compacted: boolean
  readonly modelChanged: boolean
  readonly systemChanged: boolean
  readonly toolsChanged: boolean
  readonly preserved?: boolean
  readonly divergence?: Divergence
  readonly idleMs?: number
  readonly ttlSeconds?: number
  readonly warmed?: boolean
  /**
   * Only on the first request after a restore (t-w2txb2): the halves that moved
   * against the last PERSISTED request of the session - see `seed`.
   */
  readonly stopped?: readonly StoppedHalf[]
  /**
   * Digest of the engine's OWN labeled parts. Kept so a moved `system` digest
   * can be attributed: when the final system text moved and these did not, the
   * `experimental.chat.system.transform` plugin hook moved it.
   */
  readonly labeled: string
  /**
   * t-wdyp7r: the system digest with the date line masked. The date moves at
   * midnight whether or not the engine stopped, so a restore compares this one
   * to decide whether the system half changed WHILE STOPPED.
   */
  readonly stable: string
  /** t-wdyp7r: the agent the request ran under, when the request layer said. */
  readonly agent?: string
}

/**
 * The last request of a session as the database holds it: the prefix digests
 * its step-finish part persisted, when that part was written, and the model.
 * The seed of the comparison for the first request a new process sends.
 */
export type Seed = {
  readonly prefix: PrefixDigest
  /** Epoch ms the step-finish part was written: the END of that request, so
   *  an idle gap measured from it is never longer than the real one. */
  readonly at: number
  /** `providerID/modelID`. */
  readonly model: string
  /** t-wdyp7r: `RequestFacts.stable` of that request. Absent: compare the full system digest. */
  readonly stable?: string | undefined
  /** t-wdyp7r: the agent that request ran under. Absent: not compared. */
  readonly agent?: string | undefined
}

/** How many sessions keep a seed entry (see `restored`). */
const SEED_LIMIT = LIMIT * 16

const drafts = new Map<string, readonly Part[]>()
const captures = new Map<string, Capture>()
const history = new Map<string, StepState>()
const prefixes = new Map<string, PrefixDigest>()
const requests = new Map<string, RequestFacts>()
/** Set between two requests, consumed by the next `record`. */
const rewrites = new Map<string, RewriteSource>()
const compactions = new Set<string>()
/**
 * t-w2txb2: the last PERSISTED request of a session this process has not sent
 * one for yet, read once from the database (`needsSeed`, `seed`). `null` means
 * "read, and nothing to compare with": either none was stored or the seed was
 * used. Bounded more loosely than the other maps because an entry is a few
 * short strings, and a session evicted from here AND from `requests` is read
 * again, which would name an in-process change as a change while stopped.
 */
const restored = new Map<string, Seed | null>()
/** t-vs5p1y: recorded requests whose digests are not computed yet, in order.
 *  Tagged by session so a closed chat's record can be dropped (t-w2u5vf). */
const pending: { readonly sessionID: string; readonly run: () => void }[] = []
let settleScheduled = false

/**
 * Fold one step's outbound array into the session's rolling step history and
 * answer the entries a reader diffs. Exported for the unit tests.
 */
export function recordStep(input: {
  readonly sessionID: string
  readonly capturedAt: string
  readonly messages: readonly ModelMessage[]
}): readonly StepCapture[] {
  const digests = input.messages.map(lightDigest)
  // The real text only for the messages the diff window keeps (the head, up
  // to DIFF_WINDOW_BYTES): the same messages as before, chosen by the same
  // exact byte counts, so `divergenceOffset` and `sample` are unchanged.
  let retained = 0
  const texts = input.messages.map((message, index) => {
    if (retained >= DIFF_WINDOW_BYTES) return null
    retained += digests[index]!.bytes
    return serialize(message)
  })
  const previous = history.get(input.sessionID)

  let divergenceMessage: number | null = null
  let divergenceOffset: number | null = null
  let prefixPreserved: boolean | null = null
  let sample: StepCapture["sample"] = null

  if (previous) {
    let index = 0
    let offset = 0
    while (index < previous.digests.length && index < digests.length) {
      if (previous.digests[index]!.hash !== digests[index]!.hash) break
      offset += digests[index]!.bytes
      index++
    }
    prefixPreserved = index === previous.digests.length
    if (index < previous.digests.length || index < digests.length) {
      divergenceMessage = index
      divergenceOffset = offset
      const before = previous.texts[index] ?? null
      const after = texts[index] ?? null
      if (before !== null && after !== null) {
        const at = commonPrefixBytes(before, after)
        divergenceOffset = offset + at
        sample = { previous: before.slice(0, SAMPLE_CHARS), current: after.slice(0, SAMPLE_CHARS) }
      }
    }
  }

  const step: StepCapture = {
    step: (previous?.count ?? 0) + 1,
    capturedAt: input.capturedAt,
    bytes: digests.reduce((total, item) => total + item.bytes, 0),
    messages: digests,
    divergenceOffset,
    divergenceMessage,
    prefixPreserved,
    sample,
  }

  // Text is retained only while the window lasts (`texts` above). The head is
  // what a prefix cache matches on, so the head is what is kept when a
  // conversation outgrows it.
  const kept = texts

  const steps = [...(previous?.steps ?? []), step].slice(-STEP_HISTORY)
  history.delete(input.sessionID)
  history.set(input.sessionID, { count: step.step, digests, texts: kept, steps })
  for (const key of history.keys()) {
    if (history.size <= LIMIT) break
    history.delete(key)
  }
  return steps
}

/**
 * Stage the labeled parts for the next prepared request of this session; the
 * final joined text is only known one layer down, after the plugin transform.
 * `record` consumes the draft, so a request that never staged one (compaction,
 * summarisation) records nothing rather than overwriting the turn the user is
 * looking at.
 */
export function draft(sessionID: string, staged: readonly Part[]): void {
  // Bounded like `captures`: a turn aborted before the request layer runs
  // leaves a draft behind, holding a whole prompt's text for the life of the
  // process. Re-insert so iteration order is write order, then trim front.
  drafts.delete(sessionID)
  drafts.set(sessionID, staged)
  for (const key of drafts.keys()) {
    if (drafts.size <= LIMIT) break
    drafts.delete(key)
  }
}

/**
 * A tool's JSON schema as the provider would receive it, or the empty string
 * when it cannot be read synchronously (see `CapturedTool.schemaBytes`). One
 * source of truth for both the size report and the prefix digest.
 */
function schemaText(tool: Tool): string {
  try {
    const schema = asSchema(tool.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema
    if (!schema || typeof (schema as PromiseLike<unknown>).then === "function") return ""
    return JSON.stringify(schema) ?? ""
  } catch {
    return ""
  }
}

export function schemaBytes(tool: Tool): number {
  return Buffer.byteLength(schemaText(tool), "utf8")
}

/**
 * Tools that are registered but never offered to the model. `activeTools` in
 * session/llm.ts excludes them by reading this same set, so a capture cannot
 * claim the model saw a tool it never did.
 */
export const REPAIR_ONLY_TOOLS: ReadonlySet<string> = new Set(["invalid"])

/** The tool names the model is really offered, in the order given. */
export function offeredToolNames(tools: Record<string, Tool>): string[] {
  return Object.keys(tools).filter((name) => !REPAIR_ONLY_TOOLS.has(name))
}

/**
 * The prefix digest of one prepared request. `system` hashes the final system
 * text after the plugin transform, so a plugin that rewrites the prompt moves
 * the hash - the instrument exists to name a self-inflicted cache drop.
 *
 * `tools` hashes the offered tools only, in the order the request layer sends
 * them, as `name NUL description NUL schema` per tool, one per line. NUL
 * separates the fields so no description can impersonate a field boundary.
 * Order is part of the hash on purpose: a reordered tool block is a
 * byte-different prefix and a real cache miss, so it must not hash equal.
 */
function digestPrefix(
  finalSystem: readonly string[],
  tools: Record<string, Tool>,
  messages: readonly MessageDigest[] | undefined,
): PrefixDigest {
  const toolText = offeredToolNames(tools)
    .map((name) => {
      const tool = tools[name]
      const description = typeof tool.description === "string" ? tool.description : ""
      return [name, description, schemaText(tool)].join("\u0000")
    })
    .join("\n")
  return {
    system: createHash("sha256").update(finalSystem.join("\n"), "utf8").digest("hex").slice(0, 16),
    tools: createHash("sha256").update(toolText, "utf8").digest("hex").slice(0, 16),
    // Over the per-message digests rather than the text: the array is
    // megabytes and its digest list is already the exact-match fact a prefix
    // cache turns on. Absent, not empty, when no array was handed over.
    ...(messages
      ? {
          history: createHash("sha256").update(messages.map(historyLine).join("\n"), "utf8").digest("hex").slice(0, 16),
        }
      : {}),
  }
}

/** The line the engine writes the date on (session/system.ts `environment`). */
const DATE_LINE = /^([ \t]*Today's date:).*$/gm

/**
 * t-wdyp7r: the system digest with the date line masked, the way the request
 * goldens mask it. Hashed over the same text as `PrefixDigest.system`.
 */
function stableDigest(finalSystem: readonly string[]): string {
  return createHash("sha256")
    .update(finalSystem.join("\n").replace(DATE_LINE, "$1 <DATE>"), "utf8")
    .digest("hex")
    .slice(0, 16)
}

function historyLine(item: MessageDigest): string {
  return `${item.role}:${item.hash}`
}

/**
 * Whether `history` (a `PrefixDigest.history`) is the history digest of some
 * leading run of `messages`: the previous array survived as a prefix of this
 * one. One incremental SHA-256 over the same text `digestPrefix` hashes, read
 * after each message, so the cost is linear in the array.
 */
function historyPrefix(history: string, messages: readonly MessageDigest[]): boolean {
  const hash = createHash("sha256")
  const matches = () => hash.copy().digest("hex").slice(0, 16) === history
  if (matches()) return true
  for (const [index, item] of messages.entries()) {
    hash.update((index === 0 ? "" : "\n") + historyLine(item), "utf8")
    if (matches()) return true
  }
  return false
}

export function toolEntries(tools: Record<string, Tool>): CapturedTool[] {
  return offeredToolNames(tools).map((name) => {
    const tool = tools[name]!
    const description = typeof tool.description === "string" ? tool.description : ""
    return { name, descriptionChars: description.length, schemaBytes: schemaBytes(tool), description }
  })
}

/**
 * Record what was prepared for the model. No-op unless this session staged a
 * draft, so only a real conversational turn is captured. Sizes and text are
 * taken eagerly: the live `Tool` objects hold execution closures.
 */
export function record(input: {
  readonly sessionID: string
  readonly capturedAt: string
  readonly model: string
  /**
   * The base slot, in the order the request layer chose it: the base prompt,
   * the agent's own prompt, or the base prompt followed by a bot's persona.
   * Never the collab base.
   */
  readonly base: readonly string[]
  /** Only on a collab turn: the room's base above the persona, room state below. */
  readonly collab?: { readonly base: string; readonly state: string }
  readonly userSystem?: string | undefined
  readonly finalSystem: readonly string[]
  readonly tools: Record<string, Tool>
  /**
   * The outbound message array as the request layer settled it, one layer above
   * the per-provider `ProviderTransform.message` rewrite. That rewrite is a pure
   * function of this array and the model, so a divergence here is a divergence
   * on the wire; the reverse does not follow. Optional, but when absent `steps`
   * is empty and the end-to-end loop test asserts it is NOT - a request layer
   * that stopped passing the array would otherwise degrade this in silence.
   */
  readonly messages?: readonly ModelMessage[] | undefined
  /**
   * The window the engine believes for this request's provider, in seconds, as
   * `SessionCachePolicy.windowSeconds` answers it. Absent where the provider
   * publishes none, and `idle` is then never claimed for these steps.
   */
  readonly ttlSeconds?: number | undefined
  /** Epoch ms of this session's last SUCCESSFUL cache warm, if any. */
  readonly warmedAt?: number | undefined
  /** t-wdyp7r: the agent the request runs under (`RequestFacts.agent`). */
  readonly agent?: string | undefined
}): Capture | undefined {
  settle()
  const taken = take(input.sessionID)
  return taken ? commit(input, taken) : undefined
}

/**
 * t-vs5p1y: `record`, with the digests computed after the request is sent.
 *
 * Hashing every message of a big chat costs 23-43 ms per step, all of it on the
 * path from the step start to the request leaving. Everything that can change
 * between now and the deferred work is taken now: the draft and this session's
 * rewrite and compaction marks. The messages and tools are not written after the
 * request is prepared. Pending work runs in order: before the next record, before
 * any reader (`get`, `lastRequest`, `prefixDigest`), or when the request layer
 * calls `settleSoon` after the send. So every reader sees the values `record`
 * would have given.
 */
export function recordAfterSend(input: Parameters<typeof record>[0]): void {
  settle()
  const taken = take(input.sessionID)
  if (!taken) return
  pending.push({ sessionID: input.sessionID, run: () => commit(input, taken) })
}

/** Run every deferred record now, in order. */
export function settle(): void {
  while (pending.length > 0) {
    const next = pending.shift()!
    // A capture that cannot be computed is dropped, as the stream it measures
    // has already left; it must not stop the records queued behind it.
    try {
      next.run()
    } catch {}
  }
}

/** Run the deferred records from the next turn of the event loop, ONE per turn:
 *  with several big chats busy, their records must not add up to one block. */
export function settleSoon(): void {
  if (settleScheduled || pending.length === 0) return
  settleScheduled = true
  setImmediate(() => {
    settleScheduled = false
    const next = pending.shift()
    try {
      next?.run()
    } catch {}
    settleSoon()
  })
}

/** What must be read when the request is prepared: the draft and the marks.
 *  Undefined for a request that staged no draft. */
function take(sessionID: string) {
  const staged = drafts.get(sessionID)
  if (!staged) {
    // A prepared request that staged no draft is compaction or summarisation,
    // whose prompt is its own. Leaving the last turn's digest in place would let
    // that call's `step-finish` parts claim a prefix they never carried, so the
    // reading is dropped rather than reused.
    prefixes.delete(sessionID)
    return undefined
  }
  drafts.delete(sessionID)
  const marked = rewrites.get(sessionID)
  rewrites.delete(sessionID)
  const compacted = compactions.delete(sessionID)
  return { staged, marked, compacted }
}

function commit(
  input: Parameters<typeof record>[0],
  taken: { readonly staged: readonly Part[]; readonly marked: RewriteSource | undefined; readonly compacted: boolean },
): Capture {
  const { staged } = taken
  const steps = input.messages
    ? recordStep({ sessionID: input.sessionID, capturedAt: input.capturedAt, messages: input.messages })
    : []

  // Recorded per prepared request, the granularity a prefix has: every step the
  // stream then emits belongs to this request and reads back this digest.
  // Re-inserted so iteration order is write order, then trimmed from the front.
  const prefix = digestPrefix(input.finalSystem, input.tools, steps.at(-1)?.messages)
  prefixes.delete(input.sessionID)
  prefixes.set(input.sessionID, prefix)
  for (const key of prefixes.keys()) {
    if (prefixes.size <= LIMIT) break
    prefixes.delete(key)
  }

  // Computed BEFORE the map is rewritten: the facts are a comparison against
  // this session's previous request, which the re-insert below evicts.
  const facts = requestFacts({ ...input, ...taken, prefix, stable: stableDigest(input.finalSystem), step: steps.at(-1) })
  // A seed is compared with once: from here on the previous request is in
  // this process. Kept as `null` so the database is not read again.
  if (restored.get(input.sessionID)) restored.set(input.sessionID, null)
  requests.delete(input.sessionID)
  requests.set(input.sessionID, facts)
  for (const key of requests.keys()) {
    if (requests.size <= LIMIT) break
    requests.delete(key)
  }

  const capture: Capture = {
    capturedAt: input.capturedAt,
    model: input.model,
    // Same order the request layer joins them in: base, the assembled middle,
    // then the message's own system text. No reordering happens here.
    labeledParts: [
      ...(input.collab ? [part("collab-agent-base", input.collab.base)] : []),
      ...input.base.map((text) => part("base-or-agent-prompt", text)),
      ...(input.collab ? [part("collab-state", input.collab.state)] : []),
      ...staged,
      ...(input.userSystem ? [part("user-system", input.userSystem)] : []),
    ],
    finalSystem: input.finalSystem.map(block),
    tools: toolEntries(input.tools),
    steps,
    tokensApproxMethod: "chars/4",
  }
  // Re-insert so the map's iteration order is write order, then trim the front.
  captures.delete(input.sessionID)
  captures.set(input.sessionID, capture)
  for (const key of captures.keys()) {
    if (captures.size <= LIMIT) break
    captures.delete(key)
    // The step history is keyed the same way and is the larger of the two, so
    // it is evicted with its capture rather than left behind holding text.
    history.delete(key)
    prefixes.delete(key)
    requests.delete(key)
  }
  return capture
}

/**
 * This request's cached-prefix facts, against the previous one. Pure apart from
 * the two marks it consumes (`markRewrite`, `markCompacted`), which are how the
 * engine's own rewriters name themselves: nothing downstream can tell a tool
 * result that aged from a reminder that was pushed into an earlier message.
 */
function requestFacts(input: {
  readonly sessionID: string
  readonly capturedAt: string
  readonly model: string
  readonly prefix: PrefixDigest
  readonly staged: readonly Part[]
  readonly step: StepCapture | undefined
  readonly ttlSeconds?: number | undefined
  readonly warmedAt?: number | undefined
  /** The marks, consumed when the request was prepared (`take`). */
  readonly marked: RewriteSource | undefined
  readonly compacted: boolean
  readonly stable: string
  readonly agent?: string | undefined
}): RequestFacts {
  const previous = requests.get(input.sessionID)
  // t-w2txb2: with no previous request in this process, the last PERSISTED one
  // (`seed`) stands in for it, so a restore that changed nothing reads as a
  // continuation and one that changed the prefix says which half moved.
  const seeded = previous === undefined ? (restored.get(input.sessionID) ?? undefined) : undefined
  const before = previous ?? seeded
  const at = Date.parse(input.capturedAt)
  const { marked, compacted } = input
  const labeled = createHash("sha256")
    .update(input.staged.map((item) => `${item.label}\u0000${item.text}`).join("\n"), "utf8")
    .digest("hex")
    .slice(0, 16)
  const systemChanged = before !== undefined && before.prefix.system !== input.prefix.system
  const toolsChanged = before !== undefined && before.prefix.tools !== input.prefix.tools
  // t-wdyp7r: a half moved WHILE STOPPED only if the same move cannot happen
  // without a stop. The date line moves at midnight either way, so the system
  // half is judged on the date-masked digest. An agent switch sent with the
  // message that woke the chat moves the persona and the tool set either way,
  // so it leaves those halves to the ordinary causes, as it would without a stop.
  const switched = seeded?.agent !== undefined && input.agent !== undefined && seeded.agent !== input.agent
  const systemStopped =
    seeded !== undefined && !switched && (seeded.stable === undefined ? systemChanged : seeded.stable !== input.stable)
  const toolsStopped = seeded !== undefined && !switched && toolsChanged
  // No previous array in this process, so the stored history digest is matched
  // against every leading run of this one instead of diffed message by message.
  const preserved =
    seeded === undefined
      ? (input.step?.prefixPreserved ?? undefined)
      : seeded.prefix.history !== undefined && input.step !== undefined
        ? historyPrefix(seeded.prefix.history, input.step.messages)
        : undefined
  // A history rewrite an engine rewriter named is that rewriter's, restart or
  // not; only an unexplained one is put down to the stop. Where the array opens
  // with the system text (the providers that take it as a message), a changed
  // system prompt moves the history digest too, so that move is the system's.
  const historyMoved =
    preserved === false && marked === undefined && !(systemChanged && input.step?.messages[0]?.role === "system")
  const stopped: StoppedHalf[] =
    seeded === undefined
      ? []
      : [
          ...(systemStopped ? (["system"] as const) : []),
          ...(toolsStopped ? (["tools"] as const) : []),
          ...(historyMoved ? (["history"] as const) : []),
        ]
  // Only where content already SENT came back different. `recordStep` also
  // reports the index where a grown array starts, which is an append: the
  // prefix held, nothing was rewritten, and calling that a divergence would put
  // a source on every ordinary tool-loop step.
  const divergence =
    input.step?.prefixPreserved === false &&
    input.step.divergenceMessage !== null &&
    input.step.divergenceOffset !== null
      ? {
          message: input.step.divergenceMessage,
          role: input.step.messages[input.step.divergenceMessage]?.role ?? "unknown",
          offset: input.step.divergenceOffset,
          // A rewriter that named itself wins. Otherwise: the final system text
          // moved while the engine's own blocks held still, which only the
          // system-transform plugin hook can do. Everything else is `unknown`
          // rather than a guess.
          source:
            marked ??
            ((systemChanged && previous !== undefined && previous.labeled === labeled
              ? "plugin"
              : "unknown") as RewriteSource),
        }
      : undefined
  return {
    at,
    model: input.model,
    prefix: input.prefix,
    labeled,
    first: before === undefined,
    compacted,
    modelChanged: before !== undefined && before.model !== input.model,
    systemChanged,
    toolsChanged,
    ...(preserved === undefined ? {} : { preserved }),
    ...(divergence ? { divergence } : {}),
    ...(before === undefined || !Number.isFinite(at) ? {} : { idleMs: Math.max(0, at - before.at) }),
    ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    ...(before === undefined || input.warmedAt === undefined ? {} : { warmed: input.warmedAt > before.at }),
    ...(stopped.length > 0 ? { stopped } : {}),
    stable: input.stable,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  }
}

/**
 * An engine-side rewriter is about to change a message this session has already
 * sent. Consumed by the next `record`, which is the only thing that can pair it
 * with the divergence it caused; a mark left by a turn that never reached the
 * request layer is overwritten by the next one rather than accumulating.
 */
export function markRewrite(sessionID: string, source: RewriteSource): void {
  rewrites.delete(sessionID)
  rewrites.set(sessionID, source)
  for (const key of rewrites.keys()) {
    if (rewrites.size <= LIMIT) break
    rewrites.delete(key)
  }
}

/**
 * A compaction ran: the history this session had sent is gone, so the next
 * request's miss is explained by the compaction and not by whatever the diff
 * then reports. Cleared by the next recorded request.
 */
export function markCompacted(sessionID: string): void {
  compactions.add(sessionID)
  for (const key of compactions) {
    if (compactions.size <= LIMIT) break
    compactions.delete(key)
  }
}

/**
 * t-w2txb2: whether the request path must read this session's last persisted
 * request from the database before its next request - true only while this
 * process has neither sent a request for the session nor read it already. So
 * the read happens once per session per process, off every later request.
 */
export function needsSeed(sessionID: string): boolean {
  if (restored.has(sessionID)) return false
  settle()
  return !requests.has(sessionID)
}

/**
 * Hand over what the database holds for `sessionID` (see `Seed`), or undefined
 * when it holds nothing or could not be read. The next recorded request of the
 * session is compared with it as if it were the previous request.
 */
export function seed(sessionID: string, value: Seed | undefined): void {
  restored.delete(sessionID)
  restored.set(sessionID, value ?? null)
  for (const key of restored.keys()) {
    if (restored.size <= SEED_LIMIT) break
    restored.delete(key)
  }
}

/**
 * The cached-prefix facts of this session's last prepared request, or undefined
 * when it has prepared none (or only a compaction). Absent means UNMEASURED:
 * the step-finish part then carries no `cache` block at all.
 */
export function lastRequest(sessionID: string): RequestFacts | undefined {
  settle()
  return requests.get(sessionID)
}

/** The latest capture for a session, or null when it has not sent a turn yet. */
export function get(sessionID: string): Capture | null {
  settle()
  return captures.get(sessionID) ?? null
}

/**
 * The prefix digest of this session's last prepared request, or undefined when
 * it has prepared none (or only a compaction). The `step-finish` part omits the
 * field rather than writing a placeholder, so a reader is never told the prefix
 * was measured when it was not.
 */
export function prefixDigest(sessionID: string): PrefixDigest | undefined {
  settle()
  return prefixes.get(sessionID)
}

/**
 * The chat closed (t-w2u5vf): drop everything held for it, the full prompt
 * text and the step history included, and its records not computed yet (their
 * closures hold the whole outbound array). Diagnostics only: a reopened chat's
 * first request is compared with the last one it persisted (`seed`), as after
 * a restart, so it reads as a continuation or as `stopped`, not as `first`.
 */
export function evict(sessionID: string): void {
  for (let index = pending.length - 1; index >= 0; index--)
    if (pending[index]!.sessionID === sessionID) pending.splice(index, 1)
  drafts.delete(sessionID)
  captures.delete(sessionID)
  history.delete(sessionID)
  prefixes.delete(sessionID)
  requests.delete(sessionID)
  rewrites.delete(sessionID)
  compactions.delete(sessionID)
  restored.delete(sessionID) // t-w2txb2 seed: a reopened chat compares with what it last persisted, like a restore
}

/** Test seam — the store is module state, so a test must be able to empty it. */
export function reset(): void {
  pending.length = 0
  drafts.clear()
  captures.clear()
  history.clear()
  prefixes.clear()
  requests.clear()
  rewrites.clear()
  compactions.clear()
  restored.clear()
}

export * as SessionPromptCapture from "./prompt-capture"

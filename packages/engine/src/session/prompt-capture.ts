import { createHash } from "node:crypto"
import { asSchema, type ModelMessage, type Tool } from "ai"

/**
 * What the engine ACTUALLY sent the model, beyond the user's own messages.
 *
 * The point is transparency about hidden instructions: a user who is told the
 * system prompt is bloated can only check it if the engine reports the REAL
 * prepared output. So this is a CAPTURE, not a re-derivation — the labeled
 * parts are recorded where the prompt is assembled, and the final joined
 * system is recorded AFTER the `experimental.chat.system.transform` plugin
 * hook has had its chance to reshape it. Re-running the assembly to answer a
 * query would report what the engine INTENDED to send, which a plugin can make
 * false.
 *
 * Process-local, in memory, never persisted. The ACP process boots the engine
 * in-process (cli/cmd/acp.ts starts the server AND the ACP agent), so the
 * `prompt_capture` ext method reads the very map the prompt loop writes.
 */

/** The estimator, stated plainly: 4 characters per token, rounded up. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/**
 * Which source a system-prompt block came from. `base-or-agent-prompt` is the
 * one the reader is usually hunting: the built-in base prompt, an agent's own
 * prompt where it replaces it, or BOTH — a bot's persona composes on top of the
 * base prompt, so a bot session shows two parts under this one label, the base
 * first and the persona second.
 *
 * `collab-agent-base` and `collab-state` exist only on a COLLAB turn, where the
 * ROOM's base replaces the chat one and `base-or-agent-prompt` narrows to the
 * persona alone — see `record()`.
 *
 * `instructions` is ABSENT on both a collab turn and a bot session: the
 * workspace's own instruction files are not delivered to a character at all
 * (session/prompt.ts), so there is nothing to label.
 */
export type PartLabel =
  | "base-or-agent-prompt"
  | "collab-agent-base"
  | "collab-state"
  | "env"
  | "instructions"
  | "mcp"
  | "skills"
  /** The agent's own memory index (`<origami>/memory/MEMORY.md`, or the legacy
   *  flat store). Labeled apart from `instructions` because it is agent-owned
   *  rather than human-authored — and because the `remember` tool rewrites it
   *  mid-conversation, which is why it is delivered at the TAIL of the message
   *  list rather than in the system prompt. It is still text the engine sent
   *  the model on top of the user's own messages, so it is still captured. */
  | "memory"
  /** A BOT's own persistent memory, injected only on a bot's turn. Labeled
   *  apart from `instructions` because it is agent-owned rather than
   *  human-authored, and a reader has to be able to see what it costs. Sent at
   *  the tail with `memory`, and for the same reason. */
  | "bot-memory"
  | "flock"
  /** Present only on a turn where the vision profile fired (t-kgtr6c): the
   *  profile is set, the model cannot see, and an image is attached. Labeled
   *  separately so a user reading the capture can tell this block apart from
   *  the base prompt and see exactly what the feature costs them. */
  | "vision"
  | "structured-output"
  | "user-system"

/**
 * WHERE a captured part was actually delivered.
 *
 * Until the memory blocks moved out of the prefix, every captured part was in
 * the system prompt and `labeledParts ⊆ finalSystem` held as an invariant — the
 * loop test asserts exactly that. The memory blocks broke it: they are still
 * prompt content the engine sent, so they must stay captured, but they ride the
 * message TAIL and are genuinely NOT in the system text.
 *
 * Recording the destination is what keeps that guard meaningful instead of
 * vacuous: a `system` part must appear in what was sent, a `tail` part must not.
 * A reader of the capture needs the same distinction — otherwise the memory
 * blocks show up under "Assembled parts" and are missing from "Final assembled
 * system", which reads as a bug rather than as the design.
 */
export type PartDelivery = "system" | "tail"

export type Part = {
  readonly label: PartLabel
  readonly chars: number
  readonly tokensApprox: number
  readonly text: string
  readonly delivery: PartDelivery
}

/** One entry of the FINAL `system` array, after the plugin transform. */
export type Block = {
  readonly chars: number
  readonly tokensApprox: number
  readonly text: string
}

export type CapturedTool = {
  readonly name: string
  readonly descriptionChars: number
  /**
   * Bytes of the tool's JSON schema as the provider would receive it. ZERO
   * means NOT MEASURED, never "an empty schema" — an empty schema still
   * serialises to at least `{}`. A schema is unmeasurable here when it
   * resolves asynchronously (`jsonSchema()` accepts a PromiseLike), which no
   * tool in this engine does today; awaiting one would put I/O on the send
   * path for a debug view.
   */
  readonly schemaBytes: number
  readonly description: string
}

/**
 * One outbound message, measured rather than kept.
 *
 * The full array of a long session is megabytes, and this store lives for the
 * life of the process, so the digest is what is retained: enough to say WHICH
 * message changed and by how much, without holding the conversation twice.
 */
export type MessageDigest = {
  readonly role: string
  /** Bytes of this message's serialised form, UTF-8. */
  readonly bytes: number
  /** First 16 hex characters of the SHA-256 of that same serialised form. */
  readonly hash: string
}

/**
 * What ONE model step sent, and where it first differs from the step before it.
 *
 * A prefix cache is an exact match from byte 0. So the only question that
 * matters for cache cost is: did this step rewrite anything the last step had
 * already sent? `divergenceOffset` answers it as a number: the higher it
 * climbs step over step, the more of the conversation the provider can read
 * from its cache.
 *
 * READ `prefixPreserved` WITH THAT IN MIND. A session with a memory store never
 * reports true, and that is not a defect: the memory block is delivered as the
 * LAST message, so the position it held on one step carries the model's real
 * reply on the next. That is a moving tail, not a rewritten head, and no cache
 * could have held it either way. The defect this instrument was built for looks
 * different — `divergenceOffset` that does NOT climb, and a
 * `divergenceMessage` pointing at a message the conversation had already sent.
 */
export type StepCapture = {
  /** 1-based, counted per session over the life of the process. */
  readonly step: number
  readonly capturedAt: string
  /** Total bytes of the serialised outbound array. */
  readonly bytes: number
  readonly messages: readonly MessageDigest[]
  /**
   * Byte offset of the first difference against the previous step's array, or
   * null on a session's first step.
   *
   * EXACT when the previous step's text for the diverging message was still
   * inside the retained window (`sample` is then non-null). Otherwise it is the
   * offset at which that message STARTS, which is a lower bound.
   */
  readonly divergenceOffset: number | null
  /** Index into `messages` of the first message that differs. Null on step 1. */
  readonly divergenceMessage: number | null
  /**
   * Whether the previous step's whole array survived as a byte-identical prefix
   * of this one. Null on step 1. False is the defect this capture exists to
   * name: content that was already sent came back different.
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
   * The last `STEP_HISTORY` model steps of this session, oldest first, so a
   * reader can always diff two CONSECUTIVE steps. Empty when the caller did not
   * hand `record` the outbound array.
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
 * The labeled blocks of the SYSTEM PROMPT, in the order the model receives
 * them. The caller derives its `system` array from THIS list rather than
 * building a second one, so the capture and the real prompt cannot disagree
 * about what was sent.
 *
 * The memory blocks are NOT here — they no longer travel in the system prompt.
 * See `memoryParts`.
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
 * The labeled blocks sent at the TAIL of the message list instead of in the
 * system prompt.
 *
 * These are the only prompt content the agent REWRITES mid-conversation (the
 * `remember` tool), and every provider caches on an exact prefix match — so a
 * single remembered fact used to invalidate the whole conversation's cache and
 * cost a full re-read of the context. Delivered after the last message they sit
 * past every cache breakpoint, so a write costs only itself.
 *
 * Staged into the capture alongside the system parts: they are still text the
 * engine sent the model beyond the user's own messages, and a reader auditing
 * prompt bloat has to see them. They are NOT part of the caller's `system`
 * array, so `parts` and this stay separate functions.
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
 * How many sessions keep a capture. Each one holds the full prompt text, and a
 * single run can open a session per sub-agent, so this is bounded rather than
 * left to grow with the process. Oldest write is evicted first.
 */
export const LIMIT = 16

/** How many steps of one session are reported. Two is the minimum that lets a
 *  reader diff two CONSECUTIVE steps, and one more than that buys nothing. */
export const STEP_HISTORY = 2

/**
 * How much of one step's serialised array is kept as TEXT, for the next step to
 * diff against. The digests above cover the whole array whatever its size; this
 * window only decides how far in `divergenceOffset` stays exact and a `sample`
 * is available. A 225k-token conversation serialises to about a megabyte, and
 * the store holds `LIMIT` sessions, so keeping all of it would be tens of
 * megabytes of debug state for the life of the process.
 */
export const DIFF_WINDOW_BYTES = 256 * 1024

/** Characters of context either side of a divergence in `sample`. */
const SAMPLE_CHARS = 600

/**
 * One message as bytes.
 *
 * `JSON.stringify` is the measure, not the wire format — the provider does its
 * own encoding one layer down. What is needed here is a function that is STABLE
 * for an unchanged message and different for a changed one, and this is that.
 * Binary parts are replaced by their length: an image would otherwise expand to
 * a JSON object per byte, which is neither cheap nor more informative.
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

const drafts = new Map<string, readonly Part[]>()
const captures = new Map<string, Capture>()
const history = new Map<string, StepState>()

/**
 * Fold one step's outbound array into the session's rolling step history and
 * answer the two entries a reader diffs.
 *
 * Exported for the unit tests: the divergence maths is the whole value of the
 * instrument, and a full prompt loop is an expensive way to check arithmetic.
 */
export function recordStep(input: {
  readonly sessionID: string
  readonly capturedAt: string
  readonly messages: readonly ModelMessage[]
}): readonly StepCapture[] {
  const texts = input.messages.map(serialize)
  const digests = texts.map((text, index) => digest(input.messages[index]!.role, text))
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

  // Retain text only while the window lasts. The head is what a prefix cache
  // matches on, so the head is what is kept when a conversation outgrows it.
  let retained = 0
  const kept = texts.map((text) => {
    if (retained >= DIFF_WINDOW_BYTES) return null
    retained += Buffer.byteLength(text, "utf8")
    return text
  })

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
 * Stage the labeled parts for the NEXT prepared request of this session.
 *
 * The draft exists because the labeled sources are known where the prompt is
 * assembled, while the final joined text is only known after the plugin
 * transform, one layer down. `record` consumes the draft, so a request that
 * never staged one — compaction and summarisation both call the model with
 * their own `system: []` — records nothing rather than overwriting the turn
 * the user is looking at.
 */
export function draft(sessionID: string, staged: readonly Part[]): void {
  // Bounded like `captures`, and for a reason of its own: a draft is normally
  // spent by the next `record`, but a turn that is aborted before the request
  // layer runs leaves one behind, holding a whole prompt's text for the life of
  // the process. Re-insert so iteration order is write order, then trim front.
  drafts.delete(sessionID)
  drafts.set(sessionID, staged)
  for (const key of drafts.keys()) {
    if (drafts.size <= LIMIT) break
    drafts.delete(key)
  }
}

/** The size of a tool's JSON schema, or 0 when it cannot be read synchronously. */
export function schemaBytes(tool: Tool): number {
  try {
    const schema = asSchema(tool.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema
    if (!schema || typeof (schema as PromiseLike<unknown>).then === "function") return 0
    return Buffer.byteLength(JSON.stringify(schema), "utf8")
  } catch {
    return 0
  }
}

/**
 * Tools that are registered but NEVER offered to the model. `invalid` exists
 * only so `experimental_repairToolCall` has somewhere to send a malformed call
 * (session/llm.ts), and it is excluded from `activeTools` there — which reads
 * this same set, so a capture cannot claim the model saw a tool it never did.
 */
export const REPAIR_ONLY_TOOLS: ReadonlySet<string> = new Set(["invalid"])

/** The tool names the model is really offered, in the order given. */
export function offeredToolNames(tools: Record<string, Tool>): string[] {
  return Object.keys(tools).filter((name) => !REPAIR_ONLY_TOOLS.has(name))
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
 * taken eagerly — the live `Tool` objects hold execution closures and must not
 * be retained past the send.
 */
export function record(input: {
  readonly sessionID: string
  readonly capturedAt: string
  readonly model: string
  /**
   * The base slot, exactly as the request layer chose it and in its order:
   * the base prompt, the agent's own prompt, or the base prompt followed by a
   * bot's persona. Never the collab base.
   */
  readonly base: readonly string[]
  /**
   * Present only on a COLLAB turn: the two layers the request layer wraps the
   * persona in - the room's base above it and the live room state below it.
   */
  readonly collab?: { readonly base: string; readonly state: string }
  /** This message's own system text, when the caller set one. */
  readonly userSystem?: string | undefined
  readonly finalSystem: readonly string[]
  readonly tools: Record<string, Tool>
  /**
   * The outbound message array, exactly as the request layer settled it — one
   * layer above the per-provider `ProviderTransform.message` rewrite, which is
   * applied inside the stream middleware. That rewrite is a pure function of
   * this array and the model, so a divergence here is a divergence on the wire;
   * the reverse does not follow, and a provider-specific rewrite is out of this
   * instrument's view.
   *
   * Optional so a caller that only wants the labelled parts is not made to
   * carry the conversation. When it is absent `steps` is empty, and the
   * end-to-end loop test asserts it is NOT — a request layer that stopped
   * passing the array would otherwise degrade the instrument in silence.
   */
  readonly messages?: readonly ModelMessage[] | undefined
}): Capture | undefined {
  const staged = drafts.get(input.sessionID)
  if (!staged) return undefined
  drafts.delete(input.sessionID)

  const steps = input.messages
    ? recordStep({ sessionID: input.sessionID, capturedAt: input.capturedAt, messages: input.messages })
    : []

  const capture: Capture = {
    capturedAt: input.capturedAt,
    model: input.model,
    // Same order the request layer joins them in: base, the assembled middle,
    // then the message's own system text. No reordering happens here - a
    // composed turn stages no `instructions` part at all (session/prompt.ts),
    // so what the caller staged is already the order that went to the model.
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
  }
  return capture
}

/** The latest capture for a session, or null when it has not sent a turn yet. */
export function get(sessionID: string): Capture | null {
  return captures.get(sessionID) ?? null
}

/** Test seam — the store is module state, so a test must be able to empty it. */
export function reset(): void {
  drafts.clear()
  captures.clear()
  history.clear()
}

export * as SessionPromptCapture from "./prompt-capture"

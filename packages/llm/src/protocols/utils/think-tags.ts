// Local OpenAI-compatible servers (vLLM, LM Studio) leak a reasoning model's
// `<think>…</think>` markup onto `delta.content` instead of `delta.reasoning_content`.
// Untouched it renders as prose, is PERSISTED into the transcript, and is replayed to
// the model as prior-turn context. This scanner reclassifies those spans into the
// reasoning lifecycle at the shared OpenAI Chat adapter, so every provider speaking
// that protocol is covered.
//
// It is a streaming scanner: a tag can be split across SSE deltas, so a trailing
// partial tag is HELD BACK (`pending`) rather than emitted, and released as soon as
// the next chunk proves it was not a tag. `flush` drains whatever is still held when
// the stream ends, which is what keeps tag-free content byte-identical — content that
// legitimately ends in `<` (a comparison, a JSX fragment) is emitted, not swallowed.

const OPEN = "<think>"
const CLOSE = "</think>"
const MAX_TAG = Math.max(OPEN.length, CLOSE.length)

export interface State {
  /** Inside an open `<think>` span: content routes to reasoning until the closer. */
  readonly inside: boolean
  /** A trailing byte-run that could still turn out to be the head of a tag. */
  readonly pending: string
}

export interface Segment {
  readonly kind: "text" | "reasoning"
  readonly text: string
}

export const initial = (): State => ({ inside: false, pending: "" })

/** The longest suffix of `buf` that is a proper prefix of a tag we are still
 *  watching for — the part that must wait for the next chunk before we can tell
 *  prose from markup. */
function heldLength(buf: string, inside: boolean): number {
  const tags = inside ? [CLOSE] : [OPEN, CLOSE]
  for (let take = Math.min(buf.length, MAX_TAG - 1); take > 0; take--) {
    const tail = buf.slice(buf.length - take)
    if (tags.some((tag) => tag.startsWith(tail))) return take
  }
  return 0
}

/** Split one `delta.content` chunk into reasoning/text segments, carrying the
 *  scanner state forward. Emits no empty segments. */
export function scan(state: State, chunk: string): { state: State; segments: Segment[] } {
  const segments: Segment[] = []
  const push = (kind: Segment["kind"], text: string) => {
    if (text) segments.push({ kind, text })
  }

  let buf = state.pending + chunk
  let inside = state.inside

  for (;;) {
    if (inside) {
      const close = buf.indexOf(CLOSE)
      if (close < 0) break
      push("reasoning", buf.slice(0, close))
      buf = buf.slice(close + CLOSE.length)
      inside = false
      continue
    }
    const open = buf.indexOf(OPEN)
    const orphan = buf.indexOf(CLOSE)
    // An ORPHAN closer (the server consumed the opener but leaked the closer — the
    // observed shape, including a doubled `</think></think>`) is DROPPED. Prose
    // already emitted cannot be reclassified after the fact, but a stray tag must
    // never reach the transcript as text.
    if (open < 0 && orphan < 0) break
    const isOpen = open >= 0 && (orphan < 0 || open < orphan)
    const at = isOpen ? open : orphan
    push("text", buf.slice(0, at))
    buf = buf.slice(at + (isOpen ? OPEN.length : CLOSE.length))
    inside = isOpen
  }

  const held = heldLength(buf, inside)
  push(inside ? "reasoning" : "text", buf.slice(0, buf.length - held))
  return { state: { inside, pending: buf.slice(buf.length - held) }, segments }
}

/** Whatever is still held back when the stream ends. A partial tag that never
 *  completed was ordinary content all along. */
export function flush(state: State): Segment | undefined {
  if (!state.pending) return undefined
  return { kind: state.inside ? "reasoning" : "text", text: state.pending }
}

export * as ThinkTags from "./think-tags"

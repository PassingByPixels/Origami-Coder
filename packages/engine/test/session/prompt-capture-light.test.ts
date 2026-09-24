// t-u54x6w: `recordStep` no longer copies big strings (screenshots) into the
// text it hashes. The diagnosis it feeds (cache-loss cause, t-rylleg) must
// give the same answers as before on the same steps: the same divergence
// message, byte offset, sample, "prefix preserved" and byte counts, and the
// same pattern of equal and unequal message digests. `referenceStep` below is
// the digest part of `recordStep` as it was at dff7520381, copied.
import { describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import type { ModelMessage } from "ai"
import { SessionPromptCapture } from "@/session/prompt-capture"

type RefState = { digests: { role: string; bytes: number; hash: string }[]; texts: (string | null)[] } | undefined

function serialize(message: ModelMessage): string {
  return (
    JSON.stringify(message, (_key, value) => {
      if (value instanceof Uint8Array) return `[bytes ${value.byteLength}]`
      if (value instanceof ArrayBuffer) return `[bytes ${value.byteLength}]`
      return value
    }) ?? "null"
  )
}

function referenceStep(previous: RefState, messages: ModelMessage[]) {
  const texts = messages.map(serialize)
  const digests = texts.map((text, i) => ({
    role: messages[i]!.role,
    bytes: Buffer.byteLength(text, "utf8"),
    hash: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16),
  }))
  let divergenceMessage: number | null = null
  let divergenceOffset: number | null = null
  let prefixPreserved: boolean | null = null
  let sample: { previous: string; current: string } | null = null
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
        let at = 0
        while (at < before.length && at < after.length && before[at] === after[at]) at++
        divergenceOffset = offset + Buffer.byteLength(before.slice(0, at), "utf8")
        sample = { previous: before.slice(0, 600), current: after.slice(0, 600) }
      }
    }
  }
  let retained = 0
  const kept = texts.map((text) => {
    if (retained >= SessionPromptCapture.DIFF_WINDOW_BYTES) return null
    retained += Buffer.byteLength(text, "utf8")
    return text
  })
  return {
    answer: { bytes: digests.reduce((a, d) => a + d.bytes, 0), divergenceOffset, divergenceMessage, prefixPreserved, sample },
    state: { digests, texts: kept },
  }
}

const image = (seed: number, size = 400_000) => {
  const bytes = randomBytes(size)
  bytes[0] = seed
  return `data:image/png;base64,${bytes.toString("base64")}`
}
const text = (n: number, tag: string) => `${tag} ✓ ünï "quoted" \\ back\n`.repeat(Math.ceil(n / 30)).slice(0, n)

const user = (content: string, img?: string): ModelMessage => ({
  role: "user",
  content: img ? [{ type: "text", text: content }, { type: "file", data: img, mediaType: "image/png" }] : content,
})
const assistant = (content: string): ModelMessage => ({ role: "assistant", content })
const toolImage = (id: string, img: string): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "read",
      output: { type: "content", value: [{ type: "text", text: "Image read" }, { type: "media", data: img.slice(22), mediaType: "image/png" }] },
    },
  ],
})

/** Deep copy, so every step hands over fresh objects and strings, as a real
 *  step (built from a fresh database read) does. */
const fresh = (messages: ModelMessage[]) => JSON.parse(JSON.stringify(messages)) as ModelMessage[]

function run(session: string, steps: ModelMessage[][]) {
  let ref: RefState
  for (const [i, messages] of steps.entries()) {
    const expected = referenceStep(ref, fresh(messages))
    const got = SessionPromptCapture.recordStep({ sessionID: session, capturedAt: "t", messages: fresh(messages) }).at(-1)!
    expect({ step: i, ...{ bytes: got.bytes, divergenceOffset: got.divergenceOffset, divergenceMessage: got.divergenceMessage, prefixPreserved: got.prefixPreserved, sample: got.sample } }).toEqual({ step: i, ...expected.answer })
    expect(got.messages.map((m) => [m.role, m.bytes])).toEqual(expected.state.digests.map((d) => [d.role, d.bytes]))
    ref = expected.state
  }
}

describe("SessionPromptCapture.recordStep with big strings", () => {
  const imgA = image(1)
  const imgB = image(2)
  const imgC = image(3)
  // Same length as imgA, one byte different in the middle.
  const imgA2 = imgA.slice(0, 200_000) + (imgA[200_000] === "A" ? "B" : "A") + imgA.slice(200_001)
  const head = [
    { role: "system", content: "You are Origami." } as ModelMessage,
    user("look at this", imgA),
    assistant(text(3000, "a1")),
    toolImage("c1", imgB),
    assistant(text(80_000, "big prose")),
  ]

  test("appends, and a rewrite in the head, a rewrite past the window, and a changed screenshot", () => {
    SessionPromptCapture.reset()
    run("s1", [
      head,
      [...head, user("next")],
      [...head, user("next"), assistant("ok"), toolImage("c2", imgC)],
      // a rewrite of an early text message (inside the retained window)
      [head[0]!, user("look at THIS", imgA), ...head.slice(2), user("next")],
      // the screenshot swapped for one of the same length
      [head[0]!, user("look at THIS", imgA2), ...head.slice(2), user("next")],
      // a rewrite far past the retained window
      [head[0]!, user("look at THIS", imgA2), ...head.slice(2), user("next!")],
      // a message removed from the middle
      [head[0]!, user("look at THIS", imgA2), head[2]!, head[4]!, user("next!")],
    ])
  })

  test("a message with no big string keeps its old digest exactly", () => {
    SessionPromptCapture.reset()
    const messages = [{ role: "system", content: "sys" } as ModelMessage, user(text(5000, "u")), assistant(text(60_000, "a"))]
    const got = SessionPromptCapture.recordStep({ sessionID: "s2", capturedAt: "t", messages })
    const expected = referenceStep(undefined, messages)
    expect(got.at(-1)!.messages).toEqual(expected.state.digests)
  })

  test("bytes stay exact for binary parts and for big text that needs escaping", () => {
    SessionPromptCapture.reset()
    const messages = [
      user("bytes", undefined),
      { role: "user", content: [{ type: "file", data: new Uint8Array(100_000), mediaType: "image/png" }] } as ModelMessage,
      assistant(text(200_000, 'esc "\t\u0001')),
    ]
    run("s3", [messages, [...messages, user("more")]])
  })
})

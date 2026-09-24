// t-u54x6w: a chat re-sends its screenshots on every request, and the base64
// pattern test cost about 37 ms per 1.5 MB image on the JS thread. A valid
// image now takes a decode/re-encode round trip instead. The answer must be
// the same for every input, valid or not: same result, same refusal message.
// `reference` below is `validateMedia` as it was at dff7520381, copied.
import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { ProviderShared } from "../src/protocols/shared"

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const { MAX_MEDIA_DECODED_BYTES, MAX_MEDIA_ENCODED_BYTES } = ProviderShared

function reference(route: string, part: { mediaType: string; data: string | Uint8Array }, mimes: ReadonlySet<string>) {
  const mime = part.mediaType.toLowerCase()
  if (!mimes.has(mime)) return `${route} does not support media type ${part.mediaType}`
  let base64: string
  if (typeof part.data !== "string") {
    if (part.data.byteLength > MAX_MEDIA_DECODED_BYTES)
      return `${route} media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`
    base64 = Buffer.from(part.data).toString("base64")
  } else if (part.data.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/s.exec(part.data)
    if (!match) return `${route} media data URL must contain valid base64`
    if (match[1]!.toLowerCase() !== mime)
      return `${route} media type ${part.mediaType} does not match data URL type ${match[1]}`
    base64 = match[2]!
  } else {
    base64 = part.data
  }
  if (Buffer.byteLength(base64, "utf8") > MAX_MEDIA_ENCODED_BYTES)
    return `${route} media exceeds the ${MAX_MEDIA_ENCODED_BYTES} byte encoded limit`
  if (!base64 || base64.length % 4 !== 0 || !base64Pattern.test(base64)) return `${route} media must contain valid base64`
  const bytes = Buffer.from(base64, "base64")
  if (bytes.byteLength > MAX_MEDIA_DECODED_BYTES) return `${route} media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`
  if (bytes.toString("base64") !== base64) return `${route} media must contain canonical base64`
  return { mime, base64, dataUrl: `data:${mime};base64,${base64}`, bytes: Buffer.from(bytes).toString("hex") }
}

const current = (part: { mediaType: string; data: string | Uint8Array }, mimes: ReadonlySet<string>) =>
  Effect.runPromise(
    ProviderShared.validateMedia("Test", { type: "media", mediaType: part.mediaType, data: part.data }, mimes).pipe(
      Effect.match({
        onFailure: (error) => error.reason.message,
        onSuccess: (value) => ({
          mime: value.mime,
          base64: value.base64,
          dataUrl: value.dataUrl,
          bytes: Buffer.from(value.bytes).toString("hex"),
        }),
      }),
    ),
  )

const PNG = new Set(["image/png"])
const BOTH = new Set(["image/png", "image/jpeg"])
const good = randomBytes(3000).toString("base64")
const padded1 = randomBytes(3001).toString("base64") // ends "=="
const padded2 = randomBytes(3002).toString("base64") // ends "="

const cases: { name: string; part: { mediaType: string; data: string | Uint8Array }; mimes: ReadonlySet<string> }[] = [
  { name: "data URL", part: { mediaType: "image/png", data: `data:image/png;base64,${good}` }, mimes: PNG },
  { name: "data URL, == padding", part: { mediaType: "image/png", data: `data:image/png;base64,${padded1}` }, mimes: PNG },
  { name: "data URL, = padding", part: { mediaType: "image/png", data: `data:image/png;base64,${padded2}` }, mimes: PNG },
  { name: "bare base64", part: { mediaType: "image/png", data: good }, mimes: PNG },
  { name: "upper-case declared type", part: { mediaType: "IMAGE/PNG", data: `data:image/png;base64,${good}` }, mimes: PNG },
  { name: "upper-case data URL type", part: { mediaType: "image/png", data: `data:IMAGE/PNG;base64,${good}` }, mimes: PNG },
  { name: "type mismatch", part: { mediaType: "image/jpeg", data: `data:image/png;base64,${good}` }, mimes: BOTH },
  { name: "unsupported type", part: { mediaType: "image/jpeg", data: `data:image/jpeg;base64,${good}` }, mimes: PNG },
  { name: "bad character", part: { mediaType: "image/png", data: `data:image/png;base64,${good.slice(0, -4)}@@@@` }, mimes: PNG },
  { name: "bad character, bare", part: { mediaType: "image/png", data: `${good.slice(0, -4)}ab!=` }, mimes: PNG },
  { name: "length not a multiple of 4", part: { mediaType: "image/png", data: `${good}A` }, mimes: PNG },
  { name: "non-canonical padding bits", part: { mediaType: "image/png", data: `${padded1.slice(0, -3)}B==` }, mimes: PNG },
  { name: "empty payload", part: { mediaType: "image/png", data: "data:image/png;base64," }, mimes: PNG },
  { name: "empty string", part: { mediaType: "image/png", data: "" }, mimes: PNG },
  { name: "not base64 data URL", part: { mediaType: "image/png", data: `data:image/png,${good}` }, mimes: PNG },
  { name: "no type in data URL", part: { mediaType: "image/png", data: `data:;base64,${good}` }, mimes: PNG },
  { name: "newline in payload", part: { mediaType: "image/png", data: `data:image/png;base64,${good.slice(0, 8)}\n${good.slice(8)}` }, mimes: PNG },
  { name: "bytes", part: { mediaType: "image/png", data: randomBytes(500) }, mimes: PNG },
]

describe("ProviderShared.validateMedia", () => {
  for (const item of cases)
    test(`same answer as before: ${item.name}`, async () => {
      expect(await current(item.part, item.mimes)).toEqual(reference("Test", item.part, item.mimes))
    })

  test("a large valid image below the old pattern's size failure gets the same answer as before", async () => {
    const part = { mediaType: "image/png", data: `data:image/png;base64,${randomBytes(2_900_000).toString("base64")}` }
    expect(await current(part, PNG)).toEqual(reference("Test", part, PNG))
  })

  // t-ub95jp: the old pattern answers false for ANY input from 5,505,020
  // characters (bun 1.3.14), so a valid screenshot that large was refused as
  // "invalid base64" and the request was never sent.
  const bigBase64 = randomBytes(4_128_768).toString("base64") // 5,505,024 characters
  test("a valid image of 5,505,020 or more base64 characters is accepted", async () => {
    expect(bigBase64.length).toBeGreaterThanOrEqual(5_505_020)
    for (const data of [bigBase64, `data:image/png;base64,${bigBase64}`]) {
      const result = await current({ mediaType: "image/png", data }, PNG)
      expect(typeof result).toBe("object")
      if (typeof result === "string") return
      expect(result.base64).toBe(bigBase64)
      expect(result.dataUrl).toBe(`data:image/png;base64,${bigBase64}`)
      expect(result.bytes).toBe(Buffer.from(bigBase64, "base64").toString("hex"))
    }
  })

  test("an invalid image of that size is still refused, with the message a small one gets", async () => {
    const small = randomBytes(3000).toString("base64")
    const pairs = [
      [`${bigBase64.slice(0, -4)}ab!=`, `${small.slice(0, -4)}ab!=`],
      [`data:image/png;base64,${bigBase64.slice(0, -4)}@@@@`, `data:image/png;base64,${small.slice(0, -4)}@@@@`],
      [`${bigBase64}A`, `${small}A`],
      // Valid characters, non-canonical padding bits.
      [`${bigBase64.slice(0, -4)}AB==`, `${small.slice(0, -4)}AB==`],
    ] as const
    for (const [big, little] of pairs) {
      const expected = reference("Test", { mediaType: "image/png", data: little }, PNG)
      expect(typeof expected).toBe("string")
      expect(await current({ mediaType: "image/png", data: big }, PNG)).toEqual(expected)
    }
  })

  test("every short string gets the same answer as the original pattern gave", async () => {
    // The refusal path no longer uses the original pattern (it fails on long
    // input). Check the replacement accepts exactly the same short strings.
    const strings = (alphabet: string[], length: number): string[] =>
      length === 0 ? [""] : strings(alphabet, length - 1).flatMap((head) => alphabet.map((c) => head + c))
    const inputs = [...strings(["A", "B", "Q", "=", "!"], 4), ...strings(["A", "Q", "=", "!"], 8)]
    const mismatches: string[] = []
    for (const data of inputs) {
      const part = { mediaType: "image/png", data }
      if (!Bun.deepEquals(await current(part, PNG), reference("Test", part, PNG))) mismatches.push(data)
    }
    expect(mismatches).toEqual([])
  })

  test("a decoded payload over the limit is still refused, now with the decoded-limit message", async () => {
    // `reference` answers "must contain valid base64" here only because its
    // pattern fails at this length (t-ub95jp); the data is valid base64.
    const part = { mediaType: "image/png", data: Buffer.alloc(MAX_MEDIA_DECODED_BYTES + 3).toString("base64") }
    expect(await current(part, PNG)).toBe(`Test media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`)
  })

  test("an encoded payload over the limit is refused with the encoded-limit message", async () => {
    const part = { mediaType: "image/png", data: `data:image/png;base64,${"A".repeat(MAX_MEDIA_ENCODED_BYTES + 4)}` }
    expect(await current(part, PNG)).toEqual(reference("Test", part, PNG))
    expect(await current(part, PNG)).toBe(`Test media exceeds the ${MAX_MEDIA_ENCODED_BYTES} byte encoded limit`)
  })
})

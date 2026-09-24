import { cachedInvalidateForever } from "@origami/core/effect/cached"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Config } from "@/config/config"
import { SessionV1 } from "@origami/core/v1/session"
import type { MessageV2 } from "@/session/message-v2"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { Context, Effect, Layer, Schema } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * How large a picture may be, as base64, once the resizer has finished with it.
 *
 * t-4aqhjb, measured. This was 5 MB, and on 2026-09-09 a `read` of a 9.2 MB
 * screenshot came out at 3.75 MB — legal here, and refused by the ChatGPT
 * backend. Every later step of that sub-agent replayed the same bytes and died
 * the same way, nine turns running, because the recent-image window bounds how
 * MANY pictures a request carries and never how big they are.
 *
 * 2 MB matches `MAX_IMAGE_BASE64_BYTES` in
 * `packages/llm/src/protocols/openai-responses.ts`, so the resizer's ceiling
 * and the wire's ceiling are the same number: a picture that gets this far is
 * one the provider will accept. It is a floor, not a vendor limit — override
 * it with `attachment.image.max_base64_bytes` in the config.
 *
 * Note this is a RESIZE target, not a refusal: a bigger picture is scaled and
 * re-encoded until it fits, and only a picture that cannot be brought under it
 * at any size is refused.
 */
const MAX_BASE64_BYTES = 2 * 1024 * 1024
const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000
const AUTO_RESIZE = true
const JPEG_QUALITIES = [80, 85, 70, 55, 40]
export class ResizerUnavailableError extends Schema.TaggedErrorClass<ResizerUnavailableError>()(
  "ImageResizerUnavailableError",
  {},
) {
  override get message() {
    return "Image resizer is unavailable"
  }
}

export class InvalidDataUrlError extends Schema.TaggedErrorClass<InvalidDataUrlError>()("ImageInvalidDataUrlError", {
  url: Schema.String,
}) {
  override get message() {
    return "Image URL must be a base64 data URL"
  }
}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("ImageDecodeError", {}) {
  override get message() {
    return "Image could not be decoded"
  }
}

export class SizeError extends Schema.TaggedErrorClass<SizeError>()("ImageSizeError", {
  bytes: Schema.Number,
  max: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  max_width: Schema.Number,
  max_height: Schema.Number,
}) {
  override get message() {
    return `Image ${this.width}x${this.height} is ${megabytes(this.bytes)} as base64 and could not be resized below ${this.max_width}x${this.max_height} / ${megabytes(this.max)}`
  }
}

/** Sizes in the text a MODEL reads have to be numbers it can act on. */
export const megabytes = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

export type Error = ResizerUnavailableError | InvalidDataUrlError | DecodeError | SizeError

export interface Interface {
  readonly normalize: (input: SessionV1.FilePart) => Effect.Effect<SessionV1.FilePart, Error>
  /**
   * The resize target in force, after any config override. Exposed so the note
   * a caller writes when a picture was refused can name the real limit rather
   * than say "the image size limit" and leave the model guessing.
   */
  readonly maxBase64Bytes: Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@origami/Image") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    // Not a bare `Effect.cached`: a turn cancelled during the first load must
    // not leave its interrupt as the loader for the process (t-tc1tnk).
    const [loadPhoton] = yield* cachedInvalidateForever(
      Effect.sync(() => {
        // Patched photon-node reads this during module init so Bun compiled binaries use the embedded wasm path.
        ;(globalThis as typeof globalThis & { __ORIGAMI_PHOTON_WASM_PATH?: string }).__ORIGAMI_PHOTON_WASM_PATH =
          path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
      }).pipe(
        Effect.andThen(() => Effect.tryPromise(() => import("@silvia-odwyer/photon-node"))),
        Effect.tapError((error) => Effect.logWarning("failed to load photon", { error })),
        Effect.mapError(() => new ResizerUnavailableError()),
      ),
    )

    const normalize = Effect.fn("Image.normalize")(function* (input: SessionV1.FilePart) {
      const image = (yield* config.get()).attachment?.image
      const info = {
        autoResize: image?.auto_resize ?? AUTO_RESIZE,
        maxWidth: image?.max_width ?? MAX_WIDTH,
        maxHeight: image?.max_height ?? MAX_HEIGHT,
        maxBase64Bytes: image?.max_base64_bytes ?? MAX_BASE64_BYTES,
      }
      if (!input.url.startsWith("data:") || !input.url.includes(";base64,"))
        return yield* new InvalidDataUrlError({ url: input.url })

      const base64 = input.url.slice(input.url.indexOf(";base64,") + ";base64,".length)
      const bytes = Buffer.byteLength(base64, "utf8")

      const photon = yield* loadPhoton

      const decoded = yield* Effect.try({
        try: () => photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64")),
        catch: () => new DecodeError(),
      }).pipe(Effect.tapError((error) => Effect.logWarning("failed to decode image", { error })))

      try {
        const originalWidth = decoded.get_width()
        const originalHeight = decoded.get_height()
        if (originalWidth <= info.maxWidth && originalHeight <= info.maxHeight && bytes <= info.maxBase64Bytes)
          return input
        if (!info.autoResize)
          return yield* new SizeError({
            bytes,
            max: info.maxBase64Bytes,
            width: originalWidth,
            height: originalHeight,
            max_width: info.maxWidth,
            max_height: info.maxHeight,
          })

        const scale = Math.min(1, info.maxWidth / originalWidth, info.maxHeight / originalHeight)
        for (const size of Array.from({ length: 32 }).reduce<Array<{ width: number; height: number }>>((acc) => {
          const previous = acc.at(-1) ?? {
            width: Math.max(1, Math.round(originalWidth * scale)),
            height: Math.max(1, Math.round(originalHeight * scale)),
          }
          const next =
            acc.length === 0
              ? previous
              : {
                  width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
                  height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
                }
          return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
        }, [])) {
          const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
          const candidate = [
            { data: Buffer.from(resized.get_bytes()).toString("base64"), mime: "image/png" },
            ...JPEG_QUALITIES.map((quality) => ({
              data: Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64"),
              mime: "image/jpeg",
            })),
          ]
            .map((item) => ({ ...item, bytes: Buffer.byteLength(item.data, "utf8") }))
            .find((item) => item.bytes <= info.maxBase64Bytes)
          resized.free()

          if (candidate) {
            yield* Effect.logInfo("using resized image", {
              from_mime: input.mime,
              to_mime: candidate.mime,
              from: `${originalWidth}x${originalHeight}`,
              to: `${size.width}x${size.height}`,
            })
            return {
              ...input,
              mime: candidate.mime,
              url: `data:${candidate.mime};base64,${candidate.data}`,
            }
          }
        }

        return yield* new SizeError({
          bytes,
          max: info.maxBase64Bytes,
          width: originalWidth,
          height: originalHeight,
          max_width: info.maxWidth,
          max_height: info.maxHeight,
        })
      } finally {
        decoded.free()
      }
    })

    const maxBase64Bytes = Effect.gen(function* () {
      return (yield* config.get()).attachment?.image?.max_base64_bytes ?? MAX_BASE64_BYTES
    })

    return Service.of({ normalize, maxBase64Bytes })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node] })

export * as Image from "./image"

import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { Image } from "@/image/image"
import { Config } from "@/config/config"
import { MessageID, PartID, SessionID } from "@/session/schema"
import path from "node:path"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Image.node, [[Config.node, TestConfig.layer()]]))
const tiny = testEffect(
  LayerNode.compile(Image.node, [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ attachment: { image: { max_base64_bytes: 1 } } }) })],
  ]),
)

function part(mime: string, data: string) {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make("ses_test"),
    type: "file" as const,
    mime,
    url: `data:${mime};base64,${data}`,
  }
}

describe("Image", () => {
  it.effect("normalizes generated png and jpeg attachments", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(
        new Uint8Array(Array.from({ length: 64 * 64 * 4 }, (_, index) => (index % 4 === 3 ? 255 : index % 251))),
        64,
        64,
      )
      const image = yield* Image.Service
      const results = yield* Effect.all([
        image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64"))),
        image.normalize(part("image/jpeg", Buffer.from(source.get_bytes_jpeg(90)).toString("base64"))),
      ])

      source.free()
      expect(results.map((result) => result.url.startsWith(`data:${result.mime};base64,`))).toEqual([true, true])
      expect(results.every((result) => result.mime === "image/png" || result.mime === "image/jpeg")).toBe(true)
    }),
  )

  it.effect("accepts webp attachments that are already within limits", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const input = part("image/webp", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")

      expect(yield* image.normalize(input)).toEqual(input)
    }),
  )

  it.effect("resizes images that fit the byte limit but exceed dimension limits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 9_000 * 4 }, () => 255)), 9_000, 1)
      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
      const resized = photon.PhotonImage.new_from_byteslice(
        Buffer.from(result.url.slice(result.url.indexOf(";base64,") + ";base64,".length), "base64"),
      )

      source.free()
      expect(resized.get_width()).toBeLessThanOrEqual(2_000)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  it.effect("resizes the 5MB base64 picture fixture", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const data = Buffer.from(
        yield* Effect.promise(() =>
          Bun.file(path.join(import.meta.dir, "fixtures", "picture-5mb-base64.png")).arrayBuffer(),
        ),
      )
      const input = part("image/png", data.toString("base64"))
      const image = yield* Image.Service
      const result = yield* image.normalize(input)
      const base64 = result.url.slice(result.url.indexOf(";base64,") + ";base64,".length)
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))

      expect(input.url.slice(input.url.indexOf(";base64,") + ";base64,".length).length).toBe(5 * 1024 * 1024)
      expect(result.url).not.toBe(input.url)
      expect(base64.length).toBeLessThan(5 * 1024 * 1024)
      expect(resized.get_width()).toBeLessThanOrEqual(2_000)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  // t-4aqhjb. The resizer's ceiling and the wire's ceiling have to be the SAME
  // number, or the engine hands the provider a picture it will refuse. 3.75 MB
  // was legal here and refused by the ChatGPT backend, and the session could
  // never send a request without those bytes again.
  it.effect("keeps the default ceiling at the 2 MB the OpenAI Responses route sends", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      expect(yield* image.maxBase64Bytes).toBe(2 * 1024 * 1024)
    }),
  )

  tiny.effect("reports the configured ceiling rather than the default", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      expect(yield* image.maxBase64Bytes).toBe(1)
    }),
  )

  it.effect("brings the 5MB fixture under the 2MB ceiling the provider accepts", () =>
    Effect.gen(function* () {
      const data = Buffer.from(
        yield* Effect.promise(() =>
          Bun.file(path.join(import.meta.dir, "fixtures", "picture-5mb-base64.png")).arrayBuffer(),
        ),
      )
      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", data.toString("base64")))
      const base64 = result.url.slice(result.url.indexOf(";base64,") + ";base64,".length)

      // The exact number the 2026-09-09 failure turned on: 3.75 MB got through
      // the old 5 MB ceiling and died on the wire. It cannot get through now.
      expect(base64.length).toBeLessThanOrEqual(2 * 1024 * 1024)
      expect(base64.length).toBeLessThan(3_753_798)
    }),
  )

  tiny.effect("names the size and the limit when a picture cannot be brought under it", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 4 }, () => 255)), 1, 1)
      const image = yield* Image.Service
      const exit = yield* image
        .normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
        .pipe(Effect.exit)

      source.free()
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(Image.SizeError)
      // Sizes a reader (or a model) can act on, not a raw byte count.
      expect((error as Image.SizeError).message).toContain("as base64 and could not be resized below")
      expect((error as Image.SizeError).message).toContain("0 KB")
    }),
  )

  it.effect("formats sizes the way the omitted-image note reads them", () =>
    Effect.sync(() => {
      expect(Image.megabytes(2 * 1024 * 1024)).toBe("2.0 MB")
      expect(Image.megabytes(3_753_798)).toBe("3.6 MB")
      expect(Image.megabytes(600)).toBe("1 KB")
    }),
  )

  tiny.effect("fails with a typed size error when no resized candidate fits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 4 }, () => 255)), 1, 1)
      const image = yield* Image.Service
      const exit = yield* image
        .normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
        .pipe(Effect.exit)

      source.free()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Image.SizeError)
        if (error instanceof Image.SizeError) {
          expect(error.width).toBe(1)
          expect(error.height).toBe(1)
          expect(error.max).toBe(1)
        }
      }
    }),
  )
})

// What these can fail on, in the order they are written:
//  1. the card gets nothing to draw — `display` half-filled, or the path left as
//     the model's relative argument, which no webview can resolve;
//  2. a refusal that is silent or unexplained: the user sees no picture and the
//     model cannot say why;
//  3. a file typed by its EXTENSION — a .png holding something else reaching a
//     webview `<img>` as a trusted picture.

import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { FSUtil } from "@origami/core/fs-util"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@origami/core/ripgrep"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { MAX_BYTES, ShowImageTool } from "@/tool/show-image"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    Config.node,
    RuntimeFlags.node,
    Agent.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Ripgrep.node,
    Truncate.node,
  ]),
)

const it = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

/** A real 1x1 PNG, so the magic-byte sniff is exercised on a file that truly is
 *  the type it claims. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

const put = Effect.fn("ShowImageTest.put")(function* (p: string, content: Buffer | string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const exec = Effect.fn("ShowImageTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ShowImageTool>,
) {
  const info = yield* ShowImageTool
  const tool = yield* info.init()
  return yield* provideInstance(dir)(tool.execute(args, ctx))
})

const fail = Effect.fn("ShowImageTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ShowImageTool>,
) {
  const exit = yield* exec(dir, args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected show_image to refuse")
})

describe("show_image — the picture the card draws", () => {
  it.live("answers a workspace-relative png with the facts the read-image card needs", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "shots", "hero.png"), PNG)

      const result = yield* exec(dir, { path: "shots/hero.png" })

      expect(result.metadata.display).toBeDefined()
      expect(result.metadata.display!.type).toBe("image")
      expect(result.metadata.display!.mime).toBe("image/png")
      expect(result.metadata.display!.bytes).toBe(PNG.length)
      // ABSOLUTE: the card resolves this against a webview's resource roots, and
      // the model's own argument was relative.
      expect(path.isAbsolute(result.metadata.display!.path)).toBe(true)
      expect(result.metadata.display!.path.endsWith("hero.png")).toBe(true)
      // The model's copy still rides along, as an image attachment, once.
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments![0]!.url.startsWith("data:image/png;base64,")).toBe(true)
    }),
  )

  it.live("titles the card with the caption, and with the file name without one", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "hero.png"), PNG)

      const captioned = yield* exec(dir, { path: "hero.png", caption: "  The new hero shot  " })
      expect(captioned.title).toBe("The new hero shot")
      expect(captioned.output).toBe("The new hero shot")

      const plain = yield* exec(dir, { path: "hero.png" })
      expect(plain.title).toBe("hero.png")
    }),
  )
})

describe("show_image — every refusal says which file and why", () => {
  // The reach rule. A path outside BOTH the workspace and the user's home is
  // refused outright — and refused before the file is opened.
  it.live("refuses a path outside the workspace and outside home", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const outside = path.join(path.parse(dir).root, "origami-show-image-outside", "hero.png")

      const err = yield* fail(dir, { path: outside })
      expect(err.message).toContain("show_image refused")
      expect(err.message).toContain("outside the workspace")
      expect(err.message).toContain("origami-show-image-outside")
    }),
  )

  it.live("refuses a file whose BYTES are not an image, whatever the extension says", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "not-really.png"), "#!/bin/sh\necho hello\n")

      const err = yield* fail(dir, { path: "not-really.png" })
      expect(err.message).toContain("not a png, jpg, gif or webp image")
      expect(err.message).toContain("not-really.png")
    }),
  )

  it.live("refuses a missing file and a directory, each by name", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "shots", "hero.png"), PNG)

      const missing = yield* fail(dir, { path: "nope.png" })
      expect(missing.message).toContain("does not exist")

      const isDir = yield* fail(dir, { path: "shots" })
      expect(isDir.message).toContain("is a directory")
    }),
  )

  it.live("refuses a file over the size cap, naming the limit", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const big = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES + 1 - PNG.length)])
      yield* put(path.join(dir, "huge.png"), big)

      const err = yield* fail(dir, { path: "huge.png" })
      expect(err.message).toContain("over the 8 MB limit")
    }),
  )
})

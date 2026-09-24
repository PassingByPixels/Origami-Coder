// show-image.ts — PUT A PICTURE IN THE CHAT, for the user's eyes.
//
// `read` of an image exists for the MODEL: it answers "Image read successfully"
// plus a base64 attachment so the model can look. This tool is the other
// direction — the model has a file the USER should see — and it deliberately
// emits the SAME shape: `metadata.display = { type: "image", path, mime, bytes }`
// plus one image attachment. That is what makes the existing read-image card
// (packages/vscode/src/dashboard/toolImageCard.ts) draw it with no new webview
// card: `acp/tool.ts` maps this tool's name onto the ACP kind `read`, so the
// dashboard's KIND_REGISTRY picks ReadFileCard, and the host's `readImage`
// stamp carries the file path rather than the bytes (desktop `src`, phone
// `thumb`) exactly as it does for a read.
//
// Read-only: it stats and reads one file and asks on the `read` permission.

import * as path from "path"
import * as os from "os"
import { Effect, Schema } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { sniffAttachmentMime } from "@/util/media"
import DESCRIPTION from "./show-image.txt"
import * as Tool from "./tool"
import { assertExternalDirectoryEffect } from "./external-directory"
import { containsPath } from "../project/instance-context"

/** What the read-image card can actually draw. Decided by MAGIC BYTES, never by
 *  the extension: a `.png` holding an SVG or an executable would otherwise reach
 *  a webview `<img>` as a trusted picture. */
export const SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** Ceiling for one shown file. Matches the screenshot tool's inline cap: past
 *  this the base64 copy costs more prompt text than the rest of the turn. */
export const MAX_BYTES = 8 * 1024 * 1024

/** Enough bytes for every signature `sniffAttachmentMime` knows (WebP needs 12). */
const SAMPLE_BYTES = 16

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description: "Path to the image file, workspace-relative or absolute (png, jpg, gif, webp).",
  }),
  caption: Schema.optional(Schema.String).annotate({
    description: "One short line shown as the card title. Defaults to the file name.",
  }),
})

type Metadata = {
  caption: string
  display?: {
    type: "image"
    path: string
    mime: string
    bytes: number
  }
}

/** Every refusal names the file and the reason, because the model has to be able
 *  to tell the user WHY nothing appeared. */
const refuse = (reason: string) => Effect.fail(new Error(`show_image refused: ${reason}`))

export const ShowImageTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service>(
  "show_image",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const run = Effect.fn("ShowImageTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      let filepath = path.isAbsolute(params.path) ? params.path : path.resolve(instance.directory, params.path)
      if (process.platform === "win32") filepath = FSUtil.normalizePath(filepath)

      // The reach check runs BEFORE the file is opened, so a refused path is
      // never read. Inside the workspace: allowed. Elsewhere under the user's
      // home: allowed, but it goes through the same external-directory question
      // `read` asks. Anywhere else: refused outright, with no question, because
      // a picture the user did not ask for is not a prompt they can judge.
      const home = os.homedir()
      const reachable = containsPath(filepath, instance) || (home ? FSUtil.contains(home, filepath) : false)
      if (!reachable) {
        return yield* refuse(`${filepath} is outside the workspace and outside your home directory`)
      }
      yield* assertExternalDirectoryEffect(ctx, filepath, { kind: "file" })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )
      if (!stat) return yield* refuse(`${filepath} does not exist`)
      if (stat.type === "Directory") return yield* refuse(`${filepath} is a directory, not an image file`)

      const bytes = Number(stat.size)
      if (bytes > MAX_BYTES) {
        return yield* refuse(
          `${filepath} is ${Math.round(bytes / 1024 / 1024)} MB, over the ${MAX_BYTES / 1024 / 1024} MB limit`,
        )
      }

      const data = yield* fs.readFile(filepath)
      const mime = sniffAttachmentMime(data.subarray(0, SAMPLE_BYTES), "")
      if (!SUPPORTED_MIMES.has(mime)) {
        return yield* refuse(`${filepath} is not a png, jpg, gif or webp image (its bytes say ${mime || "unknown"})`)
      }

      const caption = params.caption?.trim() || path.basename(filepath)
      return {
        title: caption,
        output: caption,
        metadata: {
          caption,
          display: { type: "image" as const, path: filepath, mime, bytes },
        },
        attachments: [
          {
            type: "file" as const,
            mime,
            url: `data:${mime};base64,${Buffer.from(data).toString("base64")}`,
          },
        ],
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // Always in the prompt: a tool the model must find through tool_search is a tool it does not use.
      deferrable: false,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

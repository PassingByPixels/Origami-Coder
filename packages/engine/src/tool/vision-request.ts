// t-kgtr6c — `vision_request`: the one tool a blind model gets so an image on
// the turn is not simply lost.
//
// ROUND 4 CHANGED WHAT IT IS. Rounds 1-3 built it as a stripped-down task tool:
// it created a child session and drove the profile through `ops.prompt`, which
// meant resolving the profile against the live AGENT REGISTRY. That registry is
// built once at engine start and rebuilt only by the collab paths (`rescan()`
// is called from collab/acp.ts and collab/runner.ts, nowhere else), so a
// profile file written AFTER the engine started was invisible to it. That is
// exactly what the round-4 session export shows: `vision-qwen.md` present on
// disk, and the tool answering "there is no agent by that name any more".
//
// It is now a DIRECT ONE-SHOT COMPLETION - the image parts plus the question,
// sent once to the model the profile pins, over the same provider layer a bare
// completion uses. Every thing it does not do is the point:
//
//  - no SESSION and no ops.prompt. There is no child session to create, no
//    agent definition to resolve into permissions, tools and a step budget, and
//    nothing for the user to be shown. A description is worth nothing after the
//    turn that needed it.
//  - no TOOLS on the call, so the deny-all floor rounds 1-3 had to pin on the
//    child session is not a floor that has to be maintained any more: a bare
//    completion has nothing to deny.
//  - the profile is read from its DEFINITION FILE, fresh, on every call - the
//    model ref and the instruction body, and nothing else off it. Fresh is the
//    fix: a profile created a minute ago answers, where the registry snapshot
//    did not.
//  - the TARGET is fixed. It comes from the chat's vision profile, not from a
//    tool argument, so the model cannot redirect the image at a model the user
//    never opted into.
//  - the parent model NEVER receives pixels. The images go on THIS request; the
//    tool result is TEXT and carries no `attachments`, which is what keeps a
//    picture out of a context that cannot read one and would be billed for it
//    anyway.
//
// It exists only for the turns `session/vision.ts` says it should: the profile
// is set, the model cannot see, and an image is actually here.

import * as Tool from "./tool"
import { Agent } from "@/agent/agent"
import { ConfigMarkdown } from "@/config/markdown"
import { Provider } from "@/provider/provider"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@origami/core/fs-util"
import type { SessionV1 } from "@origami/core/v1/session"
import { generateText, type ModelMessage } from "ai"
import { Effect, Schema } from "effect"
import fs from "fs/promises"
import path from "path"

export const TOOL_ID = "vision_request"

const Parameters = Schema.Struct({
  question: Schema.String.annotate({
    description:
      "What you need read out of the image, in words. Be specific — 'what error does the dialog show, verbatim' gets you the error; 'describe this' gets you a paragraph about a screenshot. The agent sees the picture and this sentence, nothing else of your conversation.",
  }),
  paths: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description:
        "Absolute paths to image files to look at, when no image is attached to the message. Ignored when the turn already carries an attached image. Reading a path outside this project asks the user first.",
    }),
  ),
})

const DESCRIPTION = [
  "Ask a vision-capable agent what an image shows, and get its description back as text.",
  "Use it when your answer depends on an image and you cannot see it yourself.",
  "It looks at the image attached to the message; if there is none, pass `paths` to point it at image files on disk.",
  "The image is sent to the agent the user configured for this chat; you receive words only, never the picture.",
].join(" ")

/** The image mime types a vision model is offered. Same set `tool/read.ts`
 *  attaches, so a picture this tool refuses is a picture `read` would not have
 *  attached either. */
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

/** Everything `buildRequest` reads off an image. Loosened from
 *  `SessionV1.FilePart` because a path loaded here has no part identity - no
 *  id, no session, no message - and inventing one would put a fake part id in
 *  the request. */
type Image = Pick<SessionV1.FilePart, "url" | "mime"> & { filename?: string | undefined }

const result = (output: string, metadata: Record<string, unknown> = {}): Tool.ExecuteResult => ({
  title: "Vision request",
  metadata,
  output,
})

/** A refusal the model can act on: it is a tool RESULT, not a thrown error, so
 *  the turn survives and the model can answer with what it has. */
const refuse = (output: string): Tool.ExecuteResult => result(output, { refused: true })

/**
 * The DESCRIBE FLOOR, and the whole of it (t-kgtr6c round 3).
 *
 * It is a floor, not a persona. A profile's own instruction is a file the user
 * owns: it can be edited to anything, and every profile created before round 3
 * was seeded from the collab OBSERVER text, which instructs the agent to review
 * rather than to look. This rides every request underneath that instruction, so
 * the one behaviour the feature depends on does not depend on what is in that
 * file.
 *
 * Deliberately SHORT — the detail belongs in the profile's own instruction
 * (webview/dashboard/components/visionPersonaSeed.ts); repeating a paragraph of
 * it here would spend the vision model's context saying the same thing twice.
 *
 * It carries no question: round 4 puts the question in the USER message, beside
 * the pixels, which is where a model looks for the thing it is being asked.
 */
export const DESCRIBE_PERSONA = [
  "Another agent cannot see images and has asked you to look at an attached image for it.",
  "Answer the question in the message from the image alone.",
  "Then set out what the image contains in full — layout, any text spelled out verbatim, colours, counts, and where things sit in relation to each other. Say which parts are unreadable rather than guessing at them.",
  "Report what is there; do not judge it and do not propose changes to it.",
  "Reply as plain text. Do not use tools, and do not ask follow-up questions — this is a single exchange and there is nobody to answer you.",
].join("\n")

/**
 * The one request the tool sends, as a pure value.
 *
 * SYSTEM is the profile's own instruction with the describe floor under it, in
 * that order: the user's words first, then the guarantee that survives whatever
 * they wrote. USER is the question and the pixels TOGETHER in one message —
 * splitting them across two messages is how a model ends up answering about the
 * wrong image when more than one is attached.
 *
 * The image part is built in the shape `convertToModelMessages` produces for a
 * user file part (`{ type: "file", data: <url>, mediaType }`, ai@6), so the
 * pixels take the same route to the provider as they would on an ordinary turn
 * with a seeing model. No `ProviderTransform.message` is applied on the way:
 * its `unsupportedParts` step swaps an image out for an ERROR line whenever the
 * registry does not declare `input.image`, and a locally served model (LM
 * Studio, Ollama) usually has no registry entry at all — running it here would
 * blind the exact profiles this feature exists for.
 */
export function buildRequest(input: {
  question: string
  instruction: string | undefined
  images: readonly Image[]
}): { system: string; messages: ModelMessage[] } {
  const instruction = (input.instruction ?? "").trim()
  return {
    system: [instruction, DESCRIBE_PERSONA].filter((block) => block.length > 0).join("\n\n"),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: input.question.trim() },
          ...input.images.map((image) => ({
            type: "file" as const,
            data: image.url,
            mediaType: image.mime,
            ...(image.filename ? { filename: image.filename } : {}),
          })),
        ],
      },
    ],
  }
}

/**
 * The images named by `paths`, loaded here, or the refusal text to answer with.
 *
 * THE ASK RUNS ON THE PARENT'S ctx, and that is the whole reason this loads
 * files rather than handing the paths to the profile to read. The profile is a
 * bare completion with no session and no tools; a permission prompt raised
 * inside it would surface in a session the user is not looking at, or nowhere
 * at all. `ctx` here is the PARENT's tool context, so the external-directory
 * bar appears in the chat the user is typing in — the same bar `read` raises.
 *
 * A PATH CHOOSES WHICH PICTURE, NEVER WHICH MODEL. The fixed-target invariant
 * (the profile comes from the chat, not from a tool argument) is untouched: the
 * model can point this at any file it is allowed to read, and the answer still
 * comes from the one agent the user opted into.
 *
 * Every failure is a string, not a throw: a bad path should cost the model a
 * sentence telling it what went wrong, not the turn.
 */
function loadPaths(paths: readonly string[], ctx: Tool.Context) {
  return Effect.gen(function* () {
    const images: Image[] = []
    for (const raw of paths) {
      const filepath = raw.trim()
      if (!filepath) continue
      if (!path.isAbsolute(filepath)) {
        return { ok: false as const, message: `"${filepath}" is not an absolute path. Give the full path to the file.` }
      }
      yield* assertExternalDirectoryEffect(ctx, filepath)
      const mime = FSUtil.mimeType(filepath)
      if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
        return {
          ok: false as const,
          message: `"${filepath}" is not an image this can send (${mime}). Only JPEG, PNG, GIF and WebP files can be looked at.`,
        }
      }
      const bytes = yield* Effect.tryPromise({
        try: () => fs.readFile(filepath),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(Effect.catch((message) => Effect.succeed({ failed: message })))
      if (!Buffer.isBuffer(bytes)) {
        return { ok: false as const, message: `"${filepath}" could not be read (${bytes.failed}).` }
      }
      images.push({
        mime,
        url: `data:${mime};base64,${bytes.toString("base64")}`,
        filename: path.basename(filepath),
      })
    }
    return { ok: true as const, images }
  })
}

/**
 * The tool, built for ONE turn against the images that turn carries.
 *
 * `images` is passed in rather than re-derived from `ctx.messages` inside
 * `execute` for one reason: the caller has already decided this turn qualifies
 * (session/vision.ts), and re-deriving would let the two answers drift — a tool
 * that was registered because an image was present, then finds none.
 *
 * Round 5: the list may now be EMPTY. Arming no longer requires an attachment,
 * so an armed turn with no picture is the ordinary case and `paths` is what
 * fills it.
 */
export const defs = (input: { profile: string; images: readonly SessionV1.FilePart[] }) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    // A provider retry can re-drive a finished stream and re-execute a tool
    // call that already ran (the same guard flock-tools.ts's `ask` carries).
    // Without it the user pays for a second vision call to be told the same
    // thing.
    const memo = new Map<string, Tool.ExecuteResult>()

    return [
      yield* Tool.init(
        yield* Tool.define(
          TOOL_ID,
          Effect.succeed({
            description: DESCRIPTION,
            parameters: Parameters,
            execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
              Effect.gen(function* () {
                const memoized = ctx.callID ? memo.get(ctx.callID) : undefined
                if (memoized) return memoized

                const answer = yield* run(args, ctx)
                if (ctx.callID) memo.set(ctx.callID, answer)
                return answer
              }),
          }),
        ),
      ),
    ]

    function run(args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) {
      return Effect.gen(function* () {
        // Resolved HERE, not when the option was set, and off the FILE rather
        // than the agent registry: `definitionFile` re-scans the config
        // directories on every call, so a profile written since the engine
        // started is found. Nothing else is read off the def — no permissions,
        // no step budget, no tools — because none of them apply to a single
        // completion.
        const file = yield* agents.definitionFile(input.profile)
        if (!file) {
          return refuse(
            `This chat's vision profile is "@${input.profile}", and there is no profile by that name any more. Tell the user to pick a vision profile again, and answer without the image.`,
          )
        }
        const def = yield* Effect.tryPromise({
          try: () => ConfigMarkdown.parse(file),
          catch: (cause) => cause,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!def) {
          return refuse(
            `The vision profile "@${input.profile}" could not be read (${file}). Tell the user to check that file, and answer without the image.`,
          )
        }

        // A profile with no pinned model would have nothing to send the image
        // to. Rounds 1-3 fell back to the chat's own model here, which returned
        // a confident description of an image it never received — worse than no
        // description at all — so this is a refusal, not a fallback.
        const ref = typeof def.data?.["model"] === "string" ? def.data["model"].trim() : ""
        if (!ref) {
          return refuse(
            `The vision profile "@${input.profile}" has no model pinned, so there is nothing to send the image to. Tell the user to pin a vision-capable model on that profile, and answer without the image.`,
          )
        }
        // THE ATTACHMENT WINS. An image already on the turn is the one the user
        // put there; `paths` is the fallback for the turn that carries none, so
        // a model that passes both cannot redirect the question away from what
        // the user actually attached.
        const loaded =
          input.images.length > 0
            ? { ok: true as const, images: input.images as readonly Image[] }
            : yield* loadPaths(args.paths ?? [], ctx)
        if (!loaded.ok) return refuse(`${loaded.message} Answer without the image, and say so.`)
        const images = loaded.images
        if (images.length === 0) {
          return refuse(
            "There is no image on this message and no `paths` were given, so there is nothing to look at. Ask the user for the file path, or answer without an image.",
          )
        }

        // catchCause, not catch: only `NoSuchModelError` is refined into a typed
        // `ModelNotFoundError` by `EffectPromise.refineRejection`
        // (provider.ts:2072) — a provider that is simply not configured, or an
        // SDK that will not load, arrives as a DEFECT. That is the everyday case
        // here (LM Studio not running, a model renamed in the server), and a
        // defect would kill the parent turn instead of letting it answer
        // without the image.
        const parsed = Provider.parseModel(ref)
        const model = yield* provider
          .getModel(parsed.providerID, parsed.modelID)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        const language = model
          ? yield* provider.getLanguage(model).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
        if (!language) {
          return refuse(
            `The vision profile "@${input.profile}" points at "${ref}", which this install has no connection for. Tell the user to pick a model that is configured, and answer without the image.`,
          )
        }

        const request = buildRequest({
          question: args.question,
          instruction: def.content,
          images,
        })
        const reply = yield* Effect.tryPromise({
          try: () =>
            generateText({
              model: language,
              system: request.system,
              messages: request.messages,
              // ONE request. A retry here is a second image upload the user
              // pays for, to be told the same thing; the model can simply call
              // the tool again if it wants another look.
              maxRetries: 0,
              abortSignal: ctx.abort,
            }).then((generated) => ({ ok: true as const, text: generated.text })),
          catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
        }).pipe(Effect.catch((message) => Effect.succeed({ ok: false as const, message })))
        // A provider failure is a REFUSAL, not a thrown error: the parent turn
        // has already spent its own request, and killing it here would lose the
        // answer the model could still give without the image.
        if (!reply.ok) {
          return refuse(`The vision model could not look at the image: ${reply.message}. Answer without it, and say so.`)
        }

        const text = reply.text.trim()
        if (!text) {
          return refuse(`The vision model returned nothing. Answer without the image, and say so.`)
        }
        // METADATA carries the facts a card would want to show; the OUTPUT is
        // the description alone. No `attachments` on either — that field is the
        // only route pixels have back into the parent's context.
        return result(text, {
          profile: input.profile,
          images: images.length,
          model: ref,
        })
      })
    }
  })

export * as VisionRequest from "./vision-request"

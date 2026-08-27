// t-kgtr6c — the VISION PROFILE gate, as one pure function.
//
// Two things consume it and they MUST agree: `session/prompt.ts` decides
// whether to register the `vision_request` tool, and `SystemPrompt.vision`
// decides whether to spend prompt on telling the model the tool exists. A tool
// with no instructions is a tool the model never reaches for; instructions with
// no tool are an instruction the model cannot follow and will apologise about.
// So the predicate lives here once, and both callers read the SAME answer for
// the same turn.
//
// Pure - no services, no `fs`, no model call - so every branch is exercised on
// plain objects.

import type { Provider } from "@/provider/provider"
import type { SessionV1 } from "@origami/core/v1/session"

/**
 * Whether this model can be handed image pixels directly.
 *
 * Read off the registry's declared INPUT MODALITY, not `capabilities.attachment`:
 * `attachment` is also true for a model that only takes PDFs, and a PDF reader
 * handed a PNG is exactly the failure this feature exists to route around.
 *
 * The default when a model's registry entry says nothing is FALSE, which reads
 * as "offer the vision route". That direction is deliberate. A locally served
 * model (LM Studio, Ollama) usually has no models.dev entry at all, so guessing
 * generously would mean the one case this feature was built for - an image
 * reaching a text-only local model - is the case it stays silent on. The cost of
 * being wrong the other way is an extra tool offered to a model that could have
 * looked itself, on the turns where an image is present and the user has already
 * opted in.
 */
export function modelSeesImages(model: Pick<Provider.Model, "capabilities">): boolean {
  return model.capabilities.input.image === true
}

/** True when a part is real picture data rather than a note about one. */
function isImagePart(part: SessionV1.Part): boolean {
  return part.type === "file" && part.mime.startsWith("image/")
}

/**
 * Whether an image is in play for THIS turn.
 *
 * Derived from `turnImages` rather than repeating its scan, so "is there a
 * picture" and "which pictures" can never disagree - the two are spent on the
 * same turn, one to decide whether to strip media and one to hand the tool its
 * pixels.
 */
export function turnHasImage(messages: readonly SessionV1.WithParts[]): boolean {
  return turnImages(messages).length > 0
}

/**
 * The images of the CURRENT turn, in order, or an empty list.
 *
 * TWO SOURCES, and the second one is the fix (round 5). The obvious source is
 * the last USER message - the file the human attached. The other is a TOOL
 * RESULT produced since then: `read` on a .png, a browser screenshot, an MCP
 * resource, all of which come back as `attachments` on a completed tool part
 * (session/message-v2.ts:296-305 is where those same attachments are read on
 * the way to the model). Collecting only the first meant the model could fetch
 * a picture and then have no way to look at it - `vision_request` was built
 * for the turn and handed an empty list.
 *
 * Scoped to the LAST user message on purpose, in both directions. An image
 * three turns back has already been described (or already failed), and
 * treating the whole history as "an image is present" would arm the strip and
 * the tool for the rest of the conversation - paying for both on every later
 * turn about something else.
 */
export function turnImages(messages: readonly SessionV1.WithParts[]): SessionV1.FilePart[] {
  const lastUserIndex = messages.findLastIndex((msg) => msg.info.role === "user")
  if (lastUserIndex < 0) return []
  const images: SessionV1.FilePart[] = []
  for (const part of messages[lastUserIndex]!.parts) {
    if (isImagePart(part)) images.push(part as SessionV1.FilePart)
  }
  for (const msg of messages.slice(lastUserIndex + 1)) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      for (const attachment of part.state.attachments ?? []) {
        if (attachment.mime.startsWith("image/")) images.push(attachment)
      }
    }
  }
  return images
}

/**
 * The vision profile this turn should use, or undefined for "do nothing".
 *
 * TWO conditions, and each one is a real refusal:
 *  - no profile: the user has not opted in, and this feature costs a tool
 *    schema plus a prompt block on the turns it is armed for.
 *  - the model sees images: routing round a model that can already look is
 *    strictly worse - a second model call, a second bill, and a description
 *    where the pixels would have been.
 *
 * WHAT IS NO LONGER A CONDITION (round 5, owner ruling): "an image is attached
 * to this turn". Arming on the attachment made the feature answer a question
 * nobody asked. The user turns a profile ON, then types `look at
 * C:\shots\err.png` - no attachment, no tool, and a model that cannot see is
 * told nothing about the profile it can see switched on in its own input bar.
 * The toggle is the opt-in; the tool now takes `paths` as well as attachments,
 * so an armed turn with no picture is not a tool that can only fail - it is a
 * tool that can go and fetch one.
 *
 * The cost of arming wider is one tool schema plus one short prompt block on
 * every turn of a chat whose owner deliberately switched the profile on. The
 * cost of arming narrower was the feature being invisible exactly when a user
 * reached for it.
 */
export function activeProfile(input: {
  profile: string | undefined
  model: Pick<Provider.Model, "capabilities">
}): string | undefined {
  if (!input.profile) return undefined
  if (modelSeesImages(input.model)) return undefined
  return input.profile
}

/**
 * The `toModelMessages` options for the BLIND PARENT'S OWN request this turn.
 *
 * ## What happens to an image today, with this feature off
 *
 * Nothing in `session/prompt.ts` or `session/message-v2.ts` checks whether the
 * model can read a picture: `message-v2.ts:212` forwards any non-text user file
 * part as a `type:"file"` model part. The check lives one layer lower, in
 * `provider/transform.ts:408` (`unsupportedParts`), which BOTH request paths run
 * - `session/llm.ts:365` for the AI-SDK route and
 * `session/llm/native-runtime.ts:95` for the native one. It replaces the part
 * with:
 *
 *   `ERROR: Cannot read "shot.png" (this model does not support image input).
 *    Inform the user.`
 *
 * It reads `capabilities.input.image` - the SAME field `modelSeesImages` reads,
 * defaulted to `false` at `provider/provider.ts:1657` - so every model this
 * feature arms for is a model whose image part is already dropped there. The
 * pixels do not reach the wire and are not billed, and no provider is handed an
 * unsupported part. The one case that escapes is a model whose registry entry
 * WRONGLY claims image input: nothing intervenes, the base64 goes out, and the
 * outcome is provider-dependent. `activeProfile` does not arm for that case
 * either, by the same field, so it is outside this gate's reach in both
 * directions.
 *
 * ## Why the armed turn still has to change
 *
 * That ERROR line tells the model to inform the user it cannot read the image.
 * The `guidance()` block below tells the same model, on the same turn, to call
 * `vision_request` instead. Left alone, the turn carries both, and the cheaper
 * instruction - apologise and stop - is the one a small local model tends to
 * follow. So an armed turn takes `stripMedia` (`message-v2.ts:213`, the
 * codebase's own degrade mechanism, until now passed only by
 * `compaction.ts:369`) and the part becomes a neutral `[Attached image/png:
 * shot.png]` note, which contradicts nothing.
 *
 * Unarmed returns `undefined`, not `{ stripMedia: false }`: the option is
 * absent exactly as before, so a chat with no vision profile produces the same
 * request it did yesterday.
 *
 * `hasImage` IS A SEPARATE ARGUMENT because round 5 split the two questions
 * apart. `activeProfile` now arms on the toggle alone, but stripping media is
 * only ever right when there is media to strip: a profile switched on for a
 * chat that then attaches a PDF to a PDF-reading model must not have that PDF
 * noted out for nothing. The strip stays tied to a picture actually being on
 * the turn (`turnHasImage`), which is the condition that used to be baked into
 * arming.
 *
 * Known trade: `stripMedia` is media-WIDE (`util/media.ts:8` - images and PDFs),
 * so an armed turn also notes-out a PDF that an image-blind, PDF-reading model
 * could have read. Accepted rather than widening `message-v2`'s option set for
 * it: the arming conditions already require an image on this turn and a user
 * who opted in, and the note names the file, so the model can say what it is
 * missing rather than inventing its contents.
 */
export function blindOptions(
  profile: string | undefined,
  hasImage: boolean,
): { stripMedia: true } | undefined {
  return profile && hasImage ? { stripMedia: true } : undefined
}

/**
 * What the model is told, and the whole of it.
 *
 * It names the tool, states the one fact the model cannot work out for itself
 * (it cannot see pictures), and stops. It does NOT tell the model to always
 * call the tool: an image attached beside "ignore the screenshot, just fix the
 * typo" is a turn where the right number of vision calls is zero.
 *
 * ROUND 5 DROPPED THE OPENING CLAIM. It used to open "An image is attached to
 * this message", which was true only because arming required one. Now that the
 * toggle arms the turn, that sentence would be a plain falsehood on most turns
 * of an armed chat - and a model told a picture is attached when none is will
 * go looking for it. The replacement says the durable fact instead, and names
 * the second input the tool grew: a PATH the user typed.
 */
export function guidance(profile: string): string {
  return [
    "You cannot see images.",
    "When the answer depends on one — attached, or at a path the user gave you — call vision_request and say exactly what to read out of it.",
    `The \`vision_request\` tool sends the image to @${profile}, an agent whose model can see, and returns a written description.`,
    "A general request gets a general description, so ask for the specific thing you need.",
    "You receive text only; the picture itself never reaches you.",
    "If the request does not actually depend on an image, do not call it.",
  ].join(" ")
}

export * as SessionVision from "./vision"

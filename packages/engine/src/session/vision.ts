// The vision profile gate, as one pure function.
//
// Two things consume it and they must agree: `session/prompt.ts` decides
// whether to register the `vision_request` tool, and `SystemPrompt.vision`
// decides whether to spend prompt on telling the model the tool exists. A tool
// with no instructions is a tool the model never reaches for; instructions with
// no tool are an instruction the model cannot follow and will apologise about.
// So the predicate lives here once, and both callers read the same answer for
// the same turn.

import type { Provider } from "@/provider/provider"
import type { SessionV1 } from "@origami/core/v1/session"

/**
 * Whether this model can be handed image pixels directly.
 *
 * Read off the registry's declared input modality, not `capabilities.attachment`:
 * `attachment` is also true for a model that only takes PDFs, and a PDF reader
 * handed a PNG is exactly the failure this feature exists to route around.
 *
 * The default when a model's registry entry says nothing is false, which reads
 * as "offer the vision route". Deliberate: a locally served model (LM Studio,
 * Ollama) usually has no models.dev entry at all, so guessing generously would
 * stay silent on the one case this feature was built for - an image reaching a
 * text-only local model.
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
 * picture" and "which pictures" can never disagree.
 */
export function turnHasImage(messages: readonly SessionV1.WithParts[]): boolean {
  return turnImages(messages).length > 0
}

/**
 * The images of the CURRENT turn, in order, or an empty list.
 *
 * TWO SOURCES. The last USER message - the file the human attached - and any
 * TOOL RESULT produced since then: `read` on a .png, a browser screenshot, an
 * MCP resource, all of which arrive as `attachments` on a completed tool part
 * (session/message-v2.ts reads those same attachments on the way to the model).
 * Without the second, a model could fetch a picture and have no way to look at
 * it.
 *
 * Scoped to the LAST user message on purpose. An image three turns back has
 * already been described (or already failed), and treating the whole history as
 * "an image is present" would arm the strip and the tool for the rest of the
 * conversation.
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
 * "An image is attached to this turn" is deliberately NOT a condition. The
 * toggle is the opt-in, and the tool takes `paths` as well as attachments, so an
 * armed turn with no picture can still go and fetch one - `look at
 * C:\shots\err.png` has to work.
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
 * An armed turn must strip its media, because `provider/transform.ts`
 * (`unsupportedParts`) already replaces an image part bound for an image-blind
 * model with an `ERROR: Cannot read "shot.png" ... Inform the user.` line. That
 * contradicts the `guidance()` block telling the same model to call
 * `vision_request`, and the cheaper instruction - apologise and stop - is the one
 * a small local model tends to follow. `stripMedia` turns the part into a
 * neutral `[Attached image/png: shot.png]` note instead, which contradicts
 * nothing.
 *
 * Unarmed returns `undefined`, not `{ stripMedia: false }`, so a chat with no
 * vision profile produces byte-identical requests to before.
 *
 * `hasImage` is a separate argument from the profile: `activeProfile` arms on
 * the toggle alone, but stripping is only right when there IS media to strip -
 * a profile switched on for a chat that then attaches a PDF to a PDF-reading
 * model must not have that PDF noted out for nothing.
 *
 * Known trade: `stripMedia` is media-WIDE (`util/media.ts` - images and PDFs),
 * so an armed turn also notes-out a PDF an image-blind, PDF-reading model could
 * have read. Accepted rather than widening `message-v2`'s option set; the note
 * names the file, so the model can say what it is missing rather than inventing
 * its contents.
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
 * It must not claim an image IS attached - the toggle arms the turn, so that
 * would be false on most turns of an armed chat, and a model told a picture is
 * there when none is will go looking for it.
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

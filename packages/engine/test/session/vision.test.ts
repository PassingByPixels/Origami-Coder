// t-kgtr6c — the vision-profile gate.
//
// The thing under test is a DECISION, not a rendering: whether this turn gets a
// `vision_request` tool and a block of system prompt at all. Every assertion
// below is about a turn that must NOT arm it, because arming it wrongly is the
// failure that costs money silently — a second model call and a second bill on
// every turn that happens to carry a picture.

import { describe, expect, test } from "bun:test"
import path from "path"
import { SessionV1 } from "@origami/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "@/provider/transform"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { SessionVision } from "../../src/session/vision"

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")

/** Only `capabilities` is read, so only `capabilities` is built. */
function modelWith(image: boolean, attachment = false): Pick<Provider.Model, "capabilities"> {
  return {
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment,
      toolcall: true,
      input: { text: true, audio: false, image, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
  } as Pick<Provider.Model, "capabilities">
}

function message(role: "user" | "assistant", id: string, parts: SessionV1.Part[]): SessionV1.WithParts {
  return {
    info: { id, sessionID, role, time: { created: 0 } } as unknown as SessionV1.WithParts["info"],
    parts,
  } as SessionV1.WithParts
}

function filePart(id: string, messageID: string, mime: string): SessionV1.Part {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make(`msg_${messageID}`),
    type: "file",
    mime,
    url: `data:${mime};base64,AAAA`,
    filename: `${id}.bin`,
  } as unknown as SessionV1.Part
}

function textPart(id: string, messageID: string, text: string): SessionV1.Part {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make(`msg_${messageID}`),
    type: "text",
    text,
  } as unknown as SessionV1.Part
}

const withImage = [message("user", "msg_a", [textPart("t", "a", "look"), filePart("i", "a", "image/png")])]

/**
 * A FULL model, not the `capabilities` sliver above, because the request-path
 * tests at the bottom run the real conversion and the real provider transform.
 * Shape copied from `message-v2.test.ts`'s fixture so the two agree on what a
 * blind model looks like. `input.image: false` is the field BOTH
 * `modelSeesImages` and `provider/transform.ts:408` read.
 */
const blindModel: Provider.Model = {
  id: ModelV2.ID.make("blind-model"),
  providerID,
  api: { id: "blind-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Blind Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

describe("modelSeesImages reads the declared INPUT modality, not `attachment`", () => {
  test("a model that declares image input can see", () => {
    expect(SessionVision.modelSeesImages(modelWith(true))).toBe(true)
  })

  // The real trap: `attachment: true` is also set for a model that only takes
  // PDFs. Treating it as "can see" would suppress the vision route for exactly
  // the model that needs it.
  test("attachment: true without image input is NOT sight", () => {
    expect(SessionVision.modelSeesImages(modelWith(false, true))).toBe(false)
  })

  // A locally served model usually has no registry entry at all. Defaulting it
  // to "blind" is what makes the feature fire for the case it was built for.
  test("a model that declares nothing is treated as blind", () => {
    expect(SessionVision.modelSeesImages(modelWith(false))).toBe(false)
  })
})

/** A completed tool part carrying attachments, as `read` on a .png produces
 *  one (tool/read.ts:317) and as message-v2.ts:297 reads them back. */
function toolPart(id: string, messageID: string, attachments: SessionV1.Part[]): SessionV1.Part {
  return {
    id: PartID.make(`prt_${id}`),
    sessionID,
    messageID: MessageID.make(`msg_${messageID}`),
    type: "tool",
    tool: "read",
    callID: `call_${id}`,
    state: {
      status: "completed",
      input: {},
      output: "Image read successfully",
      metadata: {},
      title: "read",
      time: { start: 0, end: 1 },
      attachments,
    },
  } as unknown as SessionV1.Part
}

describe("turnHasImage is scoped to the CURRENT turn", () => {
  test("an image on the last user message counts", () => {
    expect(SessionVision.turnHasImage(withImage)).toBe(true)
  })

  // Without this scoping the tool and the prompt block would stay armed for the
  // rest of the conversation, paid for on every later turn about something else.
  test("an image on an EARLIER user message does not", () => {
    const messages = [
      message("user", "msg_a", [filePart("i", "a", "image/png")]),
      message("assistant", "msg_b", [textPart("r", "b", "ok")]),
      message("user", "msg_c", [textPart("t", "c", "and now the typo")]),
    ]
    expect(SessionVision.turnHasImage(messages)).toBe(false)
  })

  test("a non-image file attachment is not an image", () => {
    expect(SessionVision.turnHasImage([message("user", "msg_a", [filePart("d", "a", "application/pdf")])])).toBe(false)
  })

  test("no messages at all is not an image", () => {
    expect(SessionVision.turnHasImage([])).toBe(false)
  })
})

describe("activeProfile arms on the TOGGLE, not on an attachment", () => {
  test("profile set + blind model → the profile slug", () => {
    expect(SessionVision.activeProfile({ profile: "vision-eye", model: modelWith(false) })).toBe("vision-eye")
  })

  test("no profile → off, whatever else is true", () => {
    expect(SessionVision.activeProfile({ profile: undefined, model: modelWith(false) })).toBeUndefined()
  })

  // Routing round a model that can already look is strictly worse: a second
  // call, a second bill, and a description where the pixels would have been.
  test("a model that sees images → off", () => {
    expect(SessionVision.activeProfile({ profile: "vision-eye", model: modelWith(true) })).toBeUndefined()
  })

  // ROUND 5, and the whole point of the change. "look at C:\shots\err.png" is
  // the turn the feature was reached for and the turn it used to sit out: no
  // attachment, so no tool and no prompt block, and the model apologised for
  // being unable to see a file it was never offered a way to open.
  test("NO image on the turn still arms — the tool can go and fetch one", () => {
    expect(SessionVision.activeProfile({ profile: "vision-eye", model: modelWith(false) })).toBe("vision-eye")
  })
})

describe("turnImages hands the tool the pixels, in order", () => {
  test("every image part of the current turn, and nothing else", () => {
    const images = SessionVision.turnImages([
      message("user", "msg_a", [
        textPart("t", "a", "compare these"),
        filePart("one", "a", "image/png"),
        filePart("doc", "a", "application/pdf"),
        filePart("two", "a", "image/jpeg"),
      ]),
    ])
    expect(images.map((item) => item.mime)).toEqual(["image/png", "image/jpeg"])
  })

  // FIX-A. A picture the MODEL fetched this turn is as present as one the user
  // attached: `read` on a .png, a browser screenshot and an MCP resource all
  // come back as attachments on a completed tool part. Collecting only the user
  // message meant the model could fetch an image and then be handed an empty
  // list by the very tool that exists to look at it.
  test("an image attached to a TOOL RESULT since the last user message counts", () => {
    const images = SessionVision.turnImages([
      message("user", "msg_a", [textPart("t", "a", "read shot.png and tell me the error")]),
      message("assistant", "msg_b", [toolPart("r", "b", [filePart("shot", "b", "image/png")])]),
    ])
    expect(images.map((item) => item.mime)).toEqual(["image/png"])
  })

  test("a non-image tool attachment is not collected", () => {
    const images = SessionVision.turnImages([
      message("user", "msg_a", [textPart("t", "a", "read the spec")]),
      message("assistant", "msg_b", [toolPart("r", "b", [filePart("doc", "b", "application/pdf")])]),
    ])
    expect(images).toEqual([])
  })

  // The scoping still holds in the new direction: a tool image from BEFORE the
  // last user message is last turn's business.
  test("a tool image from an EARLIER turn does not count", () => {
    const images = SessionVision.turnImages([
      message("assistant", "msg_a", [toolPart("r", "a", [filePart("old", "a", "image/png")])]),
      message("user", "msg_b", [textPart("t", "b", "now the typo")]),
    ])
    expect(images).toEqual([])
  })

  test("user attachments come before tool attachments, in message order", () => {
    const images = SessionVision.turnImages([
      message("user", "msg_a", [filePart("attached", "a", "image/png")]),
      message("assistant", "msg_b", [toolPart("r", "b", [filePart("fetched", "b", "image/jpeg")])]),
    ])
    expect(images.map((item) => item.mime)).toEqual(["image/png", "image/jpeg"])
  })
})

// The gate decides; this is what the decision DOES to the request the blind
// parent itself sends. Run through the two real functions the request path
// runs - `MessageV2.toModelMessages` (session/prompt.ts:1403) and then
// `ProviderTransform.message` (session/llm.ts:365, llm/native-runtime.ts:95) -
// because the failure being guarded against is not "the wrong flag was set", it
// is "the model was handed an instruction that fights the vision guidance".
describe("the blind parent's OWN request, armed vs off", () => {
  const armed = SessionVision.activeProfile({ profile: "vision-eye", model: blindModel })

  const parts = (msgs: Awaited<ReturnType<typeof MessageV2.toModelMessages>>) =>
    (Array.isArray(msgs[0]?.content) ? msgs[0].content : []) as Array<{ type: string; text?: string }>

  test("armed: no image part survives into the model request", async () => {
    const msgs = await MessageV2.toModelMessages(withImage, blindModel, SessionVision.blindOptions(armed, true))
    expect(parts(msgs).some((part) => part.type === "file" || part.type === "image")).toBe(false)
    expect(parts(msgs).map((part) => part.text ?? "").join("\n")).toContain("[Attached image/png: i.bin]")
  })

  // The whole point. An armed turn must not carry "tell the user you cannot
  // read it" alongside a tool that exists to read it.
  test("armed: the request carries no 'Cannot read' order to fight the guidance", async () => {
    const msgs = await MessageV2.toModelMessages(withImage, blindModel, SessionVision.blindOptions(armed, true))
    const wire = JSON.stringify(ProviderTransform.message(msgs, blindModel, {}))
    expect(wire).not.toContain("Cannot read")
    expect(wire).toContain("[Attached image/png: i.bin]")
  })

  // Today's behaviour, pinned: with no profile the conversion is untouched, and
  // the image is dropped one layer down by `unsupportedParts` instead. A chat
  // that never opted in must produce the request it produced yesterday.
  test("off: the file part survives conversion, and transform turns it into the ERROR line", async () => {
    const msgs = await MessageV2.toModelMessages(withImage, blindModel, SessionVision.blindOptions(undefined, true))
    expect(parts(msgs).some((part) => part.type === "file" || part.type === "image")).toBe(true)
    const wire = JSON.stringify(ProviderTransform.message(msgs, blindModel, {}))
    expect(wire).toContain("this model does not support image input")
  })

  test("off is byte-identical to passing no options at all", async () => {
    const withGate = await MessageV2.toModelMessages(withImage, blindModel, SessionVision.blindOptions(undefined, true))
    const before = await MessageV2.toModelMessages(withImage, blindModel)
    expect(JSON.stringify(withGate)).toBe(JSON.stringify(before))
  })

  // The known cost of reusing `stripMedia`, pinned rather than left to be
  // discovered live: it is media-WIDE, so an armed turn also notes-out a PDF
  // that an image-blind but PDF-reading model could have read. Pinned because
  // the degrade's SCOPE is `util/media.ts:isMedia` - widen that (audio, video)
  // and an armed chat silently starts losing more than it did, which this test
  // turns into a decision instead of a surprise.
  test("armed: a PDF the model COULD read is noted out too — the cost of a media-wide strip", async () => {
    const pdfReader: Provider.Model = {
      ...blindModel,
      capabilities: { ...blindModel.capabilities, input: { ...blindModel.capabilities.input, pdf: true } },
    }
    const both = [
      message("user", "msg_a", [filePart("i", "a", "image/png"), filePart("d", "a", "application/pdf")]),
    ]
    const profile = SessionVision.activeProfile({ profile: "vision-eye", model: pdfReader })
    const armedMsgs = await MessageV2.toModelMessages(both, pdfReader, SessionVision.blindOptions(profile, SessionVision.turnHasImage(both)))
    expect(parts(armedMsgs).map((part) => part.text ?? "").join("\n")).toContain("[Attached application/pdf: d.bin]")

    // ...and with the feature off it is still a real file part, so this is a
    // cost of ARMING, not a change to every chat.
    const offMsgs = await MessageV2.toModelMessages(both, pdfReader, SessionVision.blindOptions(undefined, true))
    expect(parts(offMsgs).some((part) => part.type === "file" || part.type === "image")).toBe(true)
  })

  // The one line the tests above cannot see: that the loop actually SPENDS the
  // gate here. Dropping the third argument would leave every assertion above
  // green while the shipped turn went back to carrying the ERROR line.
  test("session/prompt.ts spends the gate on its toModelMessagesEffect call", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "../../src/session/prompt.ts")).text()
    const call = src.match(/MessageV2\.toModelMessagesEffect\(msgs, model[^;]*/)
    expect(call?.[0]).toContain("SessionVision.blindOptions(visionProfile, turnHasImage)")
  })

  // Round 5's regression risk, stated as a test. Arming no longer needs an
  // image, so a `blindOptions` that ignored the second argument would strip
  // media on every turn of an armed chat - including a PDF a PDF-reading model
  // was about to read perfectly well.
  test("armed but NO image on the turn: nothing is stripped", async () => {
    const pdfReader: Provider.Model = {
      ...blindModel,
      capabilities: { ...blindModel.capabilities, input: { ...blindModel.capabilities.input, pdf: true } },
    }
    const pdfOnly = [message("user", "msg_a", [filePart("d", "a", "application/pdf")])]
    const profile = SessionVision.activeProfile({ profile: "vision-eye", model: pdfReader })
    expect(profile).toBe("vision-eye")
    const msgs = await MessageV2.toModelMessages(
      pdfOnly,
      pdfReader,
      SessionVision.blindOptions(profile, SessionVision.turnHasImage(pdfOnly)),
    )
    expect(parts(msgs).some((part) => part.type === "file" || part.type === "image")).toBe(true)
  })
})

describe("guidance names the tool and the target", () => {
  test("the model is told which agent it is asking and that it gets text back", () => {
    const text = SessionVision.guidance("vision-eye")
    expect(text).toContain("vision_request")
    expect(text).toContain("@vision-eye")
    // The one promise the feature makes about the parent's context.
    expect(text).toContain("never reaches you")
  })

  // Round 5. The block is now on turns that carry no attachment at all, so the
  // old opening — "An image is attached to this message" — would be a plain
  // falsehood most of the time, and a model told a picture is attached goes
  // looking for one. The replacement has to name the PATH route instead.
  test("it does NOT claim an image is attached, and it names the path route", () => {
    const text = SessionVision.guidance("vision-eye")
    expect(text).not.toContain("An image is attached")
    expect(text).toContain("You cannot see images")
    expect(text).toContain("at a path the user gave you")
  })
})

// The two one-line WIRES the tests above cannot see. Each is a single argument,
// and dropping either leaves every assertion in this file green while the
// shipped behaviour reverts: the roster stops naming the profile, or the
// arming gate stops being read off the session at all.
describe("the wires the shipped turn depends on", () => {
  test("session/tools.ts hands the chat's vision profile to the tool registry", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "../../src/session/tools.ts")).text()
    expect(src).toContain("visionProfile: Session.visionProfile(input.session)")
  })

  test("session/prompt.ts arms on the profile and the model, and no longer on the messages", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "../../src/session/prompt.ts")).text()
    const call = src.match(/SessionVision\.activeProfile\(\{[\s\S]*?\}\)/)
    expect(call?.[0]).toContain("Session.visionProfile(session)")
    expect(call?.[0]).not.toContain("messages")
  })
})

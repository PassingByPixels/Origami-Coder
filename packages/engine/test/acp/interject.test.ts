// `interject` — a message the user pushed INTO a running turn, instead of
// cancelling the turn to be heard. The bugs worth catching at this seam are the
// dispatch ones: a wire name the client prefixes with `_` that never reaches
// the handler, and params accepted loosely enough that an empty or absent
// message is admitted into somebody's transcript.

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"

describe("interject ext dispatch", () => {
  const seen: Array<{ sessionId: string; text: string; images?: unknown }> = []
  const service = {
    interject: (input: { sessionId: string; text: string; images?: unknown }) =>
      Effect.sync(() => {
        seen.push(input)
        return { delivered: true as const, busy: true, promoted: 1 }
      }),
  } as unknown as ACPService.Interface

  it("accepts the `_` wire prefix clients put on extension methods", async () => {
    const agent = new Agent(service)

    const prefixed = await agent.extMethod("_interject", { sessionId: "ses_1", text: "use pnpm" })
    const bare = await agent.extMethod("interject", { sessionId: "ses_1", text: "use pnpm" })

    expect(prefixed).toEqual(bare)
    expect(prefixed).toMatchObject({ delivered: true, busy: true, promoted: 1 })
  })

  it("passes the message through verbatim rather than reshaping it", async () => {
    seen.length = 0
    const agent = new Agent(service)

    await agent.extMethod("_interject", { sessionId: "ses_2", text: "  stop and read the spec  " })

    // Trimming belongs to the service, which has the session to reject against.
    // The dispatch layer forwarding a changed message would be a silent edit of
    // something the user typed.
    expect(seen).toEqual([{ sessionId: "ses_2", text: "  stop and read the spec  " }])
  })

  it("refuses a call missing either half rather than admitting a blank message", () => {
    const agent = new Agent(service)

    expect(() => agent.extMethod("_interject", {})).toThrow()
    expect(() => agent.extMethod("_interject", { sessionId: "ses_1" })).toThrow()
    expect(() => agent.extMethod("_interject", { text: "orphaned" })).toThrow()
    expect(() => agent.extMethod("_interject", { sessionId: 7, text: "wrong type" })).toThrow()
    expect(() => agent.extMethod("_interject", { sessionId: "ses_1", text: 7 })).toThrow()
  })

  // t-4ahs3u: the attachments. A picture could not go into a running turn at
  // all, and this dispatch is the first place that was true - there was nowhere
  // to put one.
  it("forwards the image blocks alongside the text", async () => {
    seen.length = 0
    const agent = new Agent(service)

    await agent.extMethod("_interject", {
      sessionId: "ses_3",
      text: "this bit",
      images: [{ mimeType: "image/png", data: "AAA" }],
    })

    expect(seen).toEqual([{ sessionId: "ses_3", text: "this bit", images: [{ mimeType: "image/png", data: "AAA" }] }])
  })

  it("takes a picture with NO text - the words are not what makes it a message", async () => {
    seen.length = 0
    const agent = new Agent(service)

    await agent.extMethod("_interject", {
      sessionId: "ses_4",
      text: "",
      images: [{ mimeType: "image/png", data: "AAA" }],
    })

    expect(seen).toEqual([{ sessionId: "ses_4", text: "", images: [{ mimeType: "image/png", data: "AAA" }] }])
  })

  it("leaves a text-only call's params exactly as they were - no empty images key", async () => {
    seen.length = 0
    const agent = new Agent(service)

    await agent.extMethod("_interject", { sessionId: "ses_5", text: "unchanged" })
    await agent.extMethod("_interject", { sessionId: "ses_5", text: "unchanged", images: [] })

    expect(seen).toEqual([
      { sessionId: "ses_5", text: "unchanged" },
      { sessionId: "ses_5", text: "unchanged" },
    ])
  })

  it("REFUSES a malformed image rather than delivering the message without it", () => {
    // Dropping the bad entry would hand the model an interjection about a
    // picture that is not there, and say nothing about it - the same silence
    // t-4ahs3u is about, one layer down.
    const agent = new Agent(service)

    expect(() => agent.extMethod("_interject", { sessionId: "ses_6", text: "look", images: "png" })).toThrow()
    expect(() => agent.extMethod("_interject", { sessionId: "ses_6", text: "look", images: [null] })).toThrow()
    expect(() => agent.extMethod("_interject", { sessionId: "ses_6", text: "look", images: [{ data: "AAA" }] })).toThrow()
    expect(() =>
      agent.extMethod("_interject", { sessionId: "ses_6", text: "look", images: [{ mimeType: "image/png", data: 7 }] }),
    ).toThrow()
    expect(() => agent.extMethod("_interject", { sessionId: "ses_6", text: "", images: [] })).toThrow()
  })
})

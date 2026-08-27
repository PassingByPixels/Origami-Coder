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
  const seen: Array<{ sessionId: string; text: string }> = []
  const service = {
    interject: (input: { sessionId: string; text: string }) =>
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
})

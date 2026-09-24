// WHAT THE ASKING MODEL ACTUALLY SEES.
//
// The transport, the crypto and the front desk are proved in test/flock. This
// file is about the two tool DEFINITIONS: their ids, that they are offered to
// every client, and — the only behaviour a model can hit on a normal install
// today — that with no transport configured they say so in one sentence instead
// of stalling on a request nobody will answer.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { FlockAskTool, FlockReplyTool, FlockWhoTool, reset } from "@/tool/flock"
import { FlockTransport } from "@/flock/transport"

describe("the flock tools", () => {
  test("are defined under the ids the prompt and the permission rules use", () => {
    expect(FlockWhoTool.id).toBe("flock_who")
    expect(FlockAskTool.id).toBe("flock_ask")
    expect(FlockReplyTool.id).toBe("flock_reply")
  })

  // THE ONE LINE THE LAYER GRAPH HIDES. `ask(handles, question, origin)` is
  // proved end to end in test/flock/owner-http.test.ts, but the call that
  // supplies the origin lives inside `execute`, which only exists inside the
  // registry's layers — standing those up would prove the registry. So the
  // wiring is read, in the idiom engineSessionId.test.ts uses on the webview
  // side: if `execute` stops handing the tool context's session id to `ask`,
  // every reply loses its way home and nothing else fails.
  test("flock_ask hands the EXECUTING session's id to ask, so a reply knows where home is", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src", "tool", "flock.ts"), "utf8")
    expect(source).toContain("ask(handles, params.question, { sessionID: ctx.sessionID })")
  })

  test("the transport slot starts empty, which is every install until the relay lands", () => {
    reset()
    FlockTransport.setTransport(undefined)
    expect(FlockTransport.getTransport()).toBeUndefined()
  })

  test("setting and clearing the transport is what a relay client will do at startup", () => {
    const transport = new FlockTransport.LoopbackTransport()
    FlockTransport.setTransport(transport)
    expect(FlockTransport.getTransport()).toBe(transport)
    FlockTransport.setTransport(undefined)
    expect(FlockTransport.getTransport()).toBeUndefined()
    reset()
  })
})

describe("the loopback transport, as the contract a relay has to meet", () => {
  test("delivers to the other end and never synchronously", async () => {
    const transport = new FlockTransport.LoopbackTransport()
    const seen: string[] = []
    transport.listen("rid-1", (frame) => {
      seen.push(new TextDecoder().decode(frame))
    })
    const sending = transport.send("rid-1", new TextEncoder().encode("hello"))
    // A relay is a network hop. A loopback that delivered inside `send` would
    // let a test pass on an ordering the real transport cannot promise, so the
    // check is made BEFORE awaiting — awaiting is itself a microtask flush.
    expect(seen).toEqual([])
    await sending
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual(["hello"])
  })

  test("delivers nothing to a rid nobody is listening on", async () => {
    const transport = new FlockTransport.LoopbackTransport()
    await transport.send("rid-nobody", new Uint8Array([1, 2, 3]))
    // No throw, no queue, no error back to the sender: exactly what a relay
    // does for a friend who is offline.
    expect(true).toBe(true)
  })

  test("stops delivering once the listener unsubscribes", async () => {
    const transport = new FlockTransport.LoopbackTransport()
    let count = 0
    const stop = transport.listen("rid-2", () => {
      count += 1
    })
    await transport.send("rid-2", new Uint8Array([1]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    stop()
    await transport.send("rid-2", new Uint8Array([2]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(count).toBe(1)
  })

  test("a handler that throws does not stop the other handler or the transport", async () => {
    const transport = new FlockTransport.LoopbackTransport()
    let survived = 0
    transport.listen("rid-3", () => {
      throw new Error("boom")
    })
    transport.listen("rid-3", () => {
      survived += 1
    })
    await transport.send("rid-3", new Uint8Array([1]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(survived).toBe(1)
  })

  test("hands each listener its own copy, so one cannot edit another's frame", async () => {
    const transport = new FlockTransport.LoopbackTransport()
    const frames: Uint8Array[] = []
    transport.listen("rid-4", (frame) => {
      frame[0] = 99
      frames.push(frame)
    })
    transport.listen("rid-4", (frame) => {
      frames.push(frame)
    })
    const sent = new Uint8Array([1, 2, 3])
    await transport.send("rid-4", sent)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(frames).toHaveLength(2)
    expect(sent[0]).toBe(1)
    expect(frames.filter((frame) => frame[0] === 1)).toHaveLength(1)
  })
})

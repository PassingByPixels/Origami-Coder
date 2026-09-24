import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()

/**
 * t-tc2rlo #8. Tracks how many REMOTE peers are actually connected to the
 * `/global/event` SSE endpoint (the only real consumer of the "sync" twin a
 * durable event gets — see `event-v2-bridge.ts` and
 * `control-plane/workspace.ts`). ACP no longer counts: it now reads
 * `GlobalBus` in-process (see `acp/event.ts`) instead of looping its own
 * events back through this engine's own HTTP server, so a normal window with
 * no Nests/workspace peer attached has zero subscribers here, and the sync
 * twin — a second full stringify of every durable event, doubled again for a
 * multi-MB row — is skipped entirely rather than built for nobody.
 */
let sseSubscribers = 0
export const GlobalSSE = {
  attach(): () => void {
    sseSubscribers++
    let released = false
    return () => {
      if (released) return
      released = true
      sseSubscribers--
    }
  },
  hasSubscribers(): boolean {
    return sseSubscribers > 0
  },
}

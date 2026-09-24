import type { OrigamiClient } from "@origami/sdk/v2"
import { Effect } from "effect"
import type { ACPSession } from "./session"

// Subagent sessions are created by the task tool through the DOMAIN session store
// only (Session.Service.create) and are NEVER registered in the ACP-layer session
// store, which holds client-created sessions only. So an ACP-layer `tryGet` misses
// anything a subagent produces, and an early return would drop it at the boundary.
//
// Walk the DOMAIN session's parent chain (Session.get -> parentID) for the nearest
// ancestor already registered in the ACP session store - the only id the client
// knows. Bounded and cycle-safe. Returns that ancestor's ACP session, or undefined.
const MAX_HOPS = 5

export async function resolveRegisteredAncestor(input: {
  readonly sdk: OrigamiClient
  readonly session: ACPSession.Interface
  readonly sessionID: string
}): Promise<ACPSession.Info | undefined> {
  const seen = new Set<string>([input.sessionID])
  let current = input.sessionID
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const parentID = await domainParentID(input.sdk, current)
    if (!parentID || seen.has(parentID)) return undefined
    seen.add(parentID)
    const ancestor = await Effect.runPromise(input.session.tryGet(parentID))
    if (ancestor) return ancestor
    current = parentID
  }
  return undefined
}

async function domainParentID(sdk: OrigamiClient, sessionID: string): Promise<string | undefined> {
  const info = await sdk.session
    .get({ sessionID }, { throwOnError: true })
    .then((response) => response.data)
    .catch(() => undefined)
  return info?.parentID
}

export * as ACPAncestor from "./ancestor"

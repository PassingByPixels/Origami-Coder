import { AgentBroker } from "@/origami/agent-broker"
import { ServerAuth } from "@/server/auth"

/**
 * PUTTING A USER PART INTO SOMEBODY ELSE'S SESSION — the two steps every sender
 * on this wire performs, in one place.
 *
 * `tool/agents.ts` (a peer handoff), `flock/deliver.ts` (a contact's reply) and
 * `session/subagent-question.ts` (a child's question) all post to
 * `/session/:id/prompt_async`, and all three must find the engine first. The
 * finding rule is subtle enough that a second copy of it would drift: OUR OWN
 * broker entry is asked first and asked DIFFERENTLY, because `attached()` judges
 * a peer by the freshness of a FILE while `self()` carries the boot timestamp —
 * that gate would reject a session this very process has open.
 *
 * Extracted rather than copied when the sub-agent question path landed: a forked
 * locator would have been a second answer to "who can read this session".
 */

/** Same bound everywhere: these are loopback calls on one machine. */
export const POST_TIMEOUT_MS = 2_000

/** The seams a test replaces. Both default to the real machine. */
export interface PostDeps {
  /** The engine holding `sessionID` with a chat attached to it, or nothing. */
  readonly locate?: (sessionID: string) => Promise<AgentBroker.Entry | undefined>
  /** POST the prompt. `true` when the engine accepted it. */
  readonly post?: (input: { readonly url: string; readonly body: string }) => Promise<boolean>
}

export async function locateSession(sessionID: string): Promise<AgentBroker.Entry | undefined> {
  const me = AgentBroker.self()
  if (me?.sessionIds.includes(sessionID)) return me
  const peers = await AgentBroker.readPeers({ includeBackground: true })
  return peers.find((entry) => AgentBroker.attached(entry, sessionID))
}

export async function postPrompt(input: { url: string; body: string }): Promise<boolean> {
  const response = await fetch(input.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ServerAuth.headers() },
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    body: input.body,
  }).catch(() => undefined)
  return !!response && response.ok
}

/** The prompt_async URL for one session on one engine. */
export function promptUrl(entry: AgentBroker.Entry, sessionID: string): string {
  return `${entry.httpBase}/session/${encodeURIComponent(sessionID)}/prompt_async`
}

export * as AgentPost from "./agent-post"

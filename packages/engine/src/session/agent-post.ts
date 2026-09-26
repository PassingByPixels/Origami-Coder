import { AgentBroker } from "@/origami/agent-broker"
import { AgentMailbox } from "@/origami/agent-mailbox"
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
  /** t-w2txb2: the stand-in of a PARKED chat for `sessionID`, or nothing. */
  readonly parked?: (sessionID: string) => Promise<AgentBroker.Parked | undefined>
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

export async function locateParked(sessionID: string): Promise<AgentBroker.Parked | undefined> {
  return (await AgentBroker.readParked()).find((standIn) => standIn.sessionId === sessionID)
}

export type Sent =
  | { readonly ok: true; readonly parked: boolean }
  | { readonly ok: false; readonly reason: "unattached" | "not-loopback" | "rejected" }

/**
 * Put one prompt_async `body` into `sessionID`, wherever that chat is. A live
 * engine always wins; when none holds the session but its chat is PARKED
 * (t-w2txb2), the body is kept in the chat's mailbox and counts as delivered -
 * the extension starts the chat again to read it (agent-mailbox.ts).
 *
 * origami_change (t-wdybz9): a POST the engine did not accept tries the
 * stand-in next - the engine can park and exit between our read of its entry
 * and the POST, and its stand-in is the chat's address then. A kept body is
 * checked once more after the write: a chat closed meanwhile gets it taken
 * back, and the answer is "unattached", not "delivered".
 */
export async function send(
  input: { readonly sessionID: string; readonly body: string; readonly messageId?: string },
  deps: PostDeps = {},
): Promise<Sent> {
  const locate = deps.locate ?? locateSession
  const parked = deps.parked ?? locateParked
  const entry = await locate(input.sessionID)
  if (entry) {
    if (!AgentBroker.isLoopback(entry.httpBase)) return { ok: false, reason: "not-loopback" }
    const posted = await (deps.post ?? postPrompt)({ url: promptUrl(entry, input.sessionID), body: input.body })
    if (posted) return { ok: true, parked: false }
  }
  const standIn = await parked(input.sessionID)
  if (!standIn) return { ok: false, reason: entry ? "rejected" : "unattached" }
  const stillThere = async () => !!(await parked(input.sessionID)) || !!(await locate(input.sessionID))
  const kept = await AgentMailbox.keep(input.sessionID, input.body, input.messageId, stillThere).then(
    (result) => result,
    () => "failed" as const,
  )
  if (kept === "kept") return { ok: true, parked: true }
  return { ok: false, reason: kept === "withdrawn" ? "unattached" : "rejected" }
}

export * as AgentPost from "./agent-post"

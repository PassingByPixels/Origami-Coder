import { AgentPost } from "@/session/agent-post"
import { peerMessageId, peerMessageMetadata } from "@/session/peer-message"
import { FlockEnvelopeText } from "./envelope-text"
import type { Store, Thread } from "./store"

/**
 * HOW A FLOCK MESSAGE REACHES A CHAT — the one path, used by both doors. Door
 * one is AUTOMATIC: a reply lands on a thread whose `origin` names the session
 * that asked, and it goes there without the owner clicking. Door two is the
 * owner's own "send to chat" click. Both end here, so a message reads the same.
 *
 * IT IS THE SAME WIRE `tool/agents.ts` USES: a user part POSTed to
 * `/session/:id/prompt_async` with provenance on its metadata, so an idle session
 * starts a turn on it, a busy one picks it up at its next tool boundary, and the
 * client badges it from the rider rather than by parsing prose.
 *
 * THE SESSION IS ROUTINELY IN ANOTHER PROCESS — the engine holding the relay
 * socket is usually not the one serving the chat that asked — so the target is
 * resolved through the agent broker's files, not this process's session store.
 *
 * ATTACHMENT IS CHECKED BEFORE THE POST: an engine accepts a prompt for any
 * session it holds whether or not a chat is rendering it, so a 200 proves storage
 * and nothing about anybody reading it. A reply that cannot be seen stays UNREAD
 * in the mailbox rather than being marked delivered into a window nobody has open.
 */

/** Same bound as a peer handoff: this is a loopback call on one machine. */
export const DELIVER_TIMEOUT_MS = AgentPost.POST_TIMEOUT_MS

export type Outcome = { readonly ok: true; readonly sessionID: string } | { readonly ok: false; readonly reason: string }

/** The seams a test replaces. Both default to the real machine — the finding
 *  rule and the POST are shared with every other sender on this wire
 *  (`session/agent-post.ts`). */
export type Deps = AgentPost.PostDeps

/** The contact as the OWNER names them, and their sigil. A revoked contact
 *  keeps its handle, which is the truth about it. */
function contactOf(store: Store, handle: string): { name: string; icon?: string } {
  const friend = store.find(handle)
  if (!friend) return { name: handle }
  const icon = friend.icon
  return { name: friend.displayName?.trim() || friend.name, ...(icon ? { icon } : {}) }
}

/** What the model reads, for one thread. Exported so a caller can show it. */
export function textFor(store: Store, thread: Thread, askedFrom?: string): string {
  const kind = FlockEnvelopeText.kindOf(thread)
  const contact = contactOf(store, thread.contact).name
  const body =
    kind === "question" ? thread.question.text : (thread.reply?.declined?.reason ?? thread.reply?.text ?? "")
  return FlockEnvelopeText.renderFlockMessage({
    kind,
    contact,
    thread: thread.id,
    question: thread.question.text,
    text: body,
    ...(askedFrom ? { askedFrom } : {}),
  })
}

/** PUT ONE THREAD INTO ONE SESSION. Refuses rather than duplicates: a thread
 *  already recorded as delivered into this session is not sent again, whichever
 *  door asked, or the owner clicking "send to chat" on a row the automatic landing
 *  already placed would put the same answer in one transcript twice. */
export async function deliver(
  input: { readonly store: Store; readonly thread: Thread; readonly sessionID: string; readonly askedFrom?: string },
  deps: Deps = {},
): Promise<Outcome> {
  const { store, thread, sessionID } = input
  if (!sessionID) return { ok: false, reason: "no session was named to deliver into" }
  if ((thread.deliveredTo ?? []).includes(sessionID)) {
    return { ok: false, reason: `thread ${thread.id} is already in session ${sessionID}` }
  }
  const contact = contactOf(store, thread.contact)
  const text = textFor(store, thread, input.askedFrom)
  // Derived, not random, for the reason `peer-message.ts` gives: the id has to be
  // recognisable as the SAME message when one thread is delivered twice.
  const id = peerMessageId({ from: `flock:${thread.contact}`, to: sessionID, text })
  const body = JSON.stringify({
    parts: [
      {
        type: "text",
        text,
        // The peer rider is what an existing client already badges from; the
        // `flock` field beside it says WHICH contact and which thread. The shape
        // is extended rather than replaced, so an older client still renders it.
        metadata: peerMessageMetadata({
          from: contact.name,
          replyTo: thread.contact,
          id,
          flock: {
            contact: contact.name,
            thread: thread.id,
            kind: FlockEnvelopeText.kindOf(thread),
            ...(contact.icon ? { icon: contact.icon } : {}),
          },
        }),
      },
    ],
  })
  // t-w2txb2: a live engine first; a PARKED chat keeps it in its mailbox.
  const sent = await AgentPost.send({ sessionID, messageId: id, body }, deps)
  if (!sent.ok) {
    if (sent.reason === "unattached") {
      return { ok: false, reason: `session ${sessionID} is not attached to an open chat, so nobody would read it` }
    }
    if (sent.reason === "not-loopback")
      return { ok: false, reason: `session ${sessionID} is not on a loopback address` }
    return { ok: false, reason: `session ${sessionID} did not accept the message` }
  }
  store.noteDelivered(thread.id, sessionID)
  return { ok: true, sessionID }
}

/** The owner's own click: the thread by id, into the session they picked. */
export async function deliverTo(
  input: { readonly store: Store; readonly thread: string; readonly sessionID: string; readonly askedFrom?: string },
  deps: Deps = {},
): Promise<Outcome> {
  const thread = input.store.thread(input.thread)
  if (!thread) return { ok: false, reason: `thread ${input.thread} is not in this mailbox` }
  // "The question you sent from this chat" is false in any chat but the origin,
  // so a pick that lands elsewhere names the chat that really asked.
  const elsewhere = thread.origin && thread.origin.sessionID !== input.sessionID
  const askedFrom = input.askedFrom ?? (elsewhere ? thread.origin?.title?.trim() || "another chat" : undefined)
  return deliver({ store: input.store, thread, sessionID: input.sessionID, ...(askedFrom ? { askedFrom } : {}) }, deps)
}

/** THE AUTOMATIC LANDING: a reply goes back to the chat that asked, first — and
 *  only when that chat is still open. An origin session nobody is looking at
 *  leaves the row unread in the mailbox; the landing is a shortcut past a click,
 *  never a new place for an answer to be lost. */
export async function land(store: Store, thread: Thread, deps: Deps = {}): Promise<Outcome> {
  if (thread.direction !== "out") return { ok: false, reason: `thread ${thread.id} is not one you asked` }
  const sessionID = thread.origin?.sessionID
  if (!sessionID) return { ok: false, reason: `thread ${thread.id} carries no origin session` }
  return deliver({ store, thread, sessionID }, deps)
}

export * as FlockDeliver from "./deliver"

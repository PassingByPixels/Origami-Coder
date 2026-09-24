import { FlockFrontDesk } from "./frontdesk"
import { FlockOwnerHttp } from "./owner-http"
import { FlockOwnerLease } from "./owner-lease"
import { FlockPolicy } from "./policy"
import { FlockService } from "./service"
import type { Store, Thread } from "./store"

/**
 * WHAT HAPPENS AFTER THE OWNER CLICKS A ROW: the three transitions an owner
 * drives — Answer, Answer with guidance, Decline — and the Send that puts a
 * signed answer on the wire.
 *
 * ITS OWN MODULE BECAUSE IT SPANS TWO ENGINES. The pane is served by whichever
 * engine owns the chat the owner has open, routinely NOT the engine holding the
 * relay sockets (`owner-lease.ts`). The STORE write happens wherever the click
 * landed; the SEND is resolved separately — this engine's peer, else a loopback
 * forward to the one that holds the flock, and both end in `Peer.reply`.
 *
 * NOTHING HERE SENDS ON ITS OWN: a desk turn produces a DRAFT, left in
 * `answering` until {@link send} is called, so the owner reads it first.
 */

/** What a decision or a send produced. `message` is shown verbatim by the pane. */
export type Result = { readonly ok: true; readonly thread: Thread } | { readonly ok: false; readonly message: string }

export type Action = "answer" | "decline"

export interface DecideInput {
  readonly thread: string
  readonly action: Action
  /** Answer with guidance. Leads the desk's turn; see `FlockFrontDesk.turnText`. */
  readonly guidance?: string
  /** Decline with a reason, signed back so the asker reads it rather than a blank refusal. */
  readonly reason?: string
}

export interface SendInput {
  readonly thread: string
  /** The owner's edit of the draft. Absent means send the draft as it stands. */
  readonly text?: string
}

/** Puts one signed answer on the wire. Injected so a test needs no relay. */
export interface Sender {
  (input: { thread: string; ok: boolean; text: string; tokens: number; reason?: string }): Promise<void>
}

export interface Deps {
  readonly store: Store
  readonly config?: FlockPolicy.FrontDeskConfig
  readonly runner: FlockFrontDesk.Runner
  readonly send: Sender
  /** The owner's worktree, for the cage this desk turn runs under. `frontdesk.ts
   *  cageFor` says why an absolute shared folder needs it. */
  readonly worktree?: string
  readonly now?: () => Date
}

function failed(message: string): Result {
  return { ok: false, message }
}

/** The sentence a refused desk turn reads as: which model, then its own error. */
export function deskFailure(model: string, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return `the front desk turn failed — ${model}: ${text || "no reason given"}`
}

/** The inbound thread this action names, or the sentence saying why there is none. */
function inbound(store: Store, id: string, states: readonly string[]): Thread | string {
  const thread = store.thread(id)
  if (!thread) return `thread ${id} is not in this mailbox`
  if (thread.direction !== "in") return `thread ${id} is a question you asked, not one asked of you`
  if (!states.includes(thread.state)) return `thread ${id} is ${thread.state}, not ${states.join(" or ")}`
  return thread
}

/** ANSWER, ANSWER WITH GUIDANCE, OR DECLINE one inbound question. Decline goes
 *  straight out — a refusal costs no model turn and the asker has been waiting
 *  since the question was sent. Answer runs the Front Desk in a child session the
 *  owner can watch, and stops at the draft. */
export async function decide(deps: Deps, input: DecideInput): Promise<Result> {
  const found = inbound(deps.store, input.thread, ["pending", "answering"])
  if (typeof found === "string") return failed(found)
  const thread = found

  if (input.action === "decline") {
    const reason = input.reason?.trim()
    const text = reason || FlockFrontDesk.DECLINED
    try {
      await deps.send({ thread: thread.id, ok: false, text, tokens: 0, ...(reason ? { reason } : {}) })
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
    log(deps, thread, { ok: false, tokens: 0 })
    return { ok: true, thread: deps.store.thread(thread.id) ?? thread }
  }

  const contact = deps.store.find(thread.contact)
  if (!contact) return failed(`${thread.contact} is no longer a contact`)
  const policy = FlockFrontDesk.policyFor({ ...(deps.config ? { config: deps.config } : {}), friend: contact })
  const now = deps.now?.() ?? new Date()
  const today = FlockPolicy.day(now)
  const decision = FlockPolicy.decide({ policy, spentToday: deps.store.spent(contact.handle, today), now })
  if (decision.kind === "refuse") return failed(decision.reason)

  const guidance = input.guidance?.trim()
  // MARKED BEFORE THE TURN, not after: a row that still read `pending` for as
  // long as a model takes is a row the owner clicks Answer on twice.
  deps.store.patchThread(thread.id, {
    state: "answering",
    unread: false,
    ...(guidance ? { guidance } : {}),
  })

  let drafted: { text: string; tokens: number }
  try {
    drafted = await deps.runner({
      question: thread.question.text,
      from: contact.handle,
      model: decision.model,
      agent: FlockFrontDesk.AGENT,
      permission: FlockFrontDesk.cageFor({
        friend: contact,
        policy,
        ...(deps.worktree ? { worktree: deps.worktree } : {}),
      }),
      ...(guidance ? { guidance } : {}),
    })
  } catch (error) {
    // Back to `pending`, deliberately: the question is still unanswered and the
    // owner must be able to try again or decline. `answering` would strand it.
    deps.store.patchThread(thread.id, { state: "pending", unread: true })
    // NAMED, because "the front desk turn failed: APIError" is unactionable. The
    // owner has to know WHICH model refused, and the provider's own words are the
    // only thing that says whether to change it, top it up or answer by hand.
    return failed(deskFailure(decision.model, error))
  }

  // CHARGED NOW, against what it actually cost: the tokens are spent whether or
  // not the owner sends, and debiting only on Send would let drafts run free.
  if (drafted.tokens > 0) deps.store.charge(contact.handle, drafted.tokens, today)

  const updated = deps.store.patchThread(thread.id, {
    state: "answering",
    unread: true,
    reply: { text: drafted.text, at: now.toISOString(), tokens: drafted.tokens, signatureOk: true },
  })
  return { ok: true, thread: updated ?? thread }
}

/** SIGN AND SEND the draft on an `answering` thread, with the owner's edit if
 *  they made one. This is the only path an answer leaves by. */
export async function send(deps: Deps, input: SendInput): Promise<Result> {
  const found = inbound(deps.store, input.thread, ["answering"])
  if (typeof found === "string") return failed(found)
  const thread = found
  const text = (input.text ?? thread.reply?.text ?? "").trim()
  if (!text) return failed("there is nothing drafted to send — answer it again, or decline")
  const tokens = thread.reply?.tokens ?? 0
  try {
    await deps.send({ thread: thread.id, ok: true, text, tokens })
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
  log(deps, thread, { ok: true, tokens })
  return { ok: true, thread: deps.store.thread(thread.id) ?? thread }
}

/** The Inbox cost log line. The thread is the record; this is the running total
 *  the owner reads chronologically, and it predates the mailbox. */
function log(deps: Deps, thread: Thread, result: { ok: boolean; tokens: number }): void {
  deps.store.logAnswer({
    at: (deps.now?.() ?? new Date()).toISOString(),
    from: thread.contact,
    question: thread.question.text,
    tokens: result.tokens,
    ok: result.ok,
  })
}

/** ASK A CONTACT FROM THE PANE — the Follow up button. The model's `flock_ask`
 *  goes through `tool/flock.ts`; this is the owner's own hand on the same wire,
 *  resolved the same two ways. Here rather than in the tool because a tool carries
 *  a permission ask, a description written for a model, and a rendered result. */
export async function post(input: {
  to: string
  question: string
  followUpOf?: string
}): Promise<{ readonly thread?: string; readonly contact: string; readonly error?: string }> {
  const question = input.question.trim()
  if (!question) return { contact: input.to, error: "a follow-up needs a question" }
  const peer = FlockService.peer()
  if (peer) {
    const posted = await peer.postMany([input.to], question, input.followUpOf)
    return posted[0] ?? { contact: input.to, error: "nothing was sent" }
  }
  const lease = FlockOwnerLease.read(FlockService.leaseDirectory())
  if (!lease || !FlockOwnerHttp.reachable(lease.httpBase)) {
    return { contact: input.to, error: "no engine on this machine is holding the flock connection right now" }
  }
  const forwarded = await FlockOwnerHttp.askOwner({
    httpBase: lease.httpBase,
    to: [input.to],
    question,
    ...(input.followUpOf ? { followUpOf: input.followUpOf } : {}),
  })
  if ("error" in forwarded) return { contact: input.to, error: forwarded.error }
  return forwarded.value.sent[0] ?? { contact: input.to, error: "nothing was sent" }
}

/** THE PRODUCTION SENDER: this engine's peer, else the engine holding the lease.
 *  The same two-way resolution `tool/flock.ts` makes for an ask, needed here too
 *  because an ANSWER is a frame: the owner clicks in the window they have open,
 *  routinely not the one that won the lease. A failure to resolve is THROWN, never
 *  swallowed — an answer believed sent that never left is the worst outcome. */
export function sender(): Sender {
  return async (input) => {
    const peer = FlockService.peer()
    if (peer) {
      await peer.reply(input)
      return
    }
    const lease = FlockOwnerLease.read(FlockService.leaseDirectory())
    if (!lease) throw new Error("no engine on this machine is holding the flock connection right now")
    if (!FlockOwnerHttp.reachable(lease.httpBase)) {
      throw new Error(`the engine holding the flock (pid ${lease.pid}) published no loopback address to forward to`)
    }
    const forwarded = await FlockOwnerHttp.replyOwner({ httpBase: lease.httpBase, ...input })
    if ("error" in forwarded) throw new Error(forwarded.error)
  }
}

export * as FlockMailbox from "./mailbox"

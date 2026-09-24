import { FlockCard } from "./card"
import { FlockEnvelope } from "./envelope"
import { FlockIdentity } from "./identity"
import { ambiguous, type Store, type Friend, type Thread, type ThreadOrigin } from "./store"
import type { Transport } from "./transport"

/**
 * The two sides of one contact link, over any {@link Transport}. `frontdesk.ts`
 * decides WHAT to answer; this file moves the bytes. It is the only place that
 * knows a request and its answer share an id, and that a peer listens on the
 * same rendezvous id it sends on.
 *
 * The rid is derived from the pair secret, so it is a property of the FRIENDSHIP
 * and not of a direction — a relay holds one ring per friendship. On a loopback
 * both peers hear every frame including their own; no "not me" flag is needed,
 * because the Ed25519 signature answers it. A peer verifies an inbound payload
 * against the FRIEND's stored key, so its own frame fails and is dropped. Replay
 * state advances only for a frame that verified, so a peer's own echo cannot
 * burn a sequence number its friend still needs.
 */

export const REQUEST_TIMEOUT_MS = 60_000

/**
 * What we say about ourselves on every frame, so a rename reaches a contact
 * without either side fetching anything: two optional payload fields, not a new
 * message type, so the `envelope.ts` frame layout is unchanged and a peer on
 * either build ignores what it does not know.
 *
 * They are trustworthy only because they sit inside the SIGNED payload
 * (`signPayload` covers every key), so a relay that edited one would fail
 * `verifyPayload`. {@link Peer.receive} therefore writes them after the
 * verification, never before.
 */
export interface Declared {
  /** The sender's current display name. */
  readonly name?: string
  /** The sender's current sigil variant id. */
  readonly icon?: string
}

export interface AskRequest extends Declared {
  readonly type: "flock/ask"
  readonly v: 1
  readonly id: string
  readonly from: string
  readonly question: string
  readonly at: string
}

export interface WhoRequest extends Declared {
  readonly type: "flock/who"
  readonly v: 1
  readonly id: string
  readonly from: string
  readonly at: string
}

export interface AnswerResponse extends Declared {
  readonly type: "flock/answer"
  readonly v: 1
  readonly id: string
  readonly from: string
  readonly ok: boolean
  readonly text: string
  readonly tokens: number
  readonly at: string
}

export interface CardResponse extends Declared {
  readonly type: "flock/card"
  readonly v: 1
  readonly id: string
  readonly from: string
  readonly card: FlockCard.Card
  readonly at: string
}

type Request = AskRequest | WhoRequest
type Response = AnswerResponse | CardResponse

/** What `flock_ask` hands back to the asking model. */
export interface Answer {
  readonly from: string
  readonly ok: boolean
  readonly text: string
  readonly tokens: number
  /** Whether the answer verified against the friend's stored key. False is never a usable answer. */
  readonly signatureOk: boolean
}

/** A deferred question looks like nothing on the wire, yet. A question the owner
 *  must decide on has no deadline — they may be asleep — so the serve side files
 *  it in the mailbox and answers with this instead of a frame; `handleRequest`
 *  then sends nothing, and the answer goes out later via {@link Peer.reply}. */
export interface Deferred {
  readonly deferred: true
}

export type Served = { ok: boolean; text: string; tokens: number } | Deferred

/** What the answering side supplies; `frontdesk.ts` builds one, a test its own.
 *  A thrown error becomes a refusal rather than a dropped frame — an asker whose
 *  friend's engine failed deserves a sentence, not a timeout. */
export interface Serve {
  /** `id` is the envelope id, which is also the mailbox thread id. */
  ask(input: { friend: Friend; question: string; id: string }): Promise<Served>
  card(input: { friend: Friend }): Promise<FlockCard.Card>
}

interface Pending {
  resolve(response: Response): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface Channel {
  readonly friend: Friend
  readonly keys: FlockEnvelope.Keys
  /** The highest sequence accepted from this friend, in EITHER direction. One
   *  counter, not one per role: `send` draws from a single per-friend counter, so
   *  every frame a friend sends is higher than every frame before it, whatever its
   *  role byte says. It is also the number the relay's `?after=` takes — two
   *  counters would leave the resume value ambiguous. */
  lastRecvSeq: number
  unlisten: () => void
}

let counter = 0
const nextID = () => `flq_${Date.now().toString(36)}_${(counter++).toString(36)}`

/** The sealing key and rendezvous id for one friendship. Exported because
 *  `service.ts` needs a friend's rid BEFORE any channel exists — it registers the
 *  relay route against it — and a second copy of the X25519 agreement plus HKDF
 *  would end with two rids and a friendship that never connects. */
export function keysFor(identity: FlockIdentity.Info, friend: Friend): FlockEnvelope.Keys {
  return FlockEnvelope.derive(
    FlockIdentity.pairSecret({ boxPrivateKey: identity.box.privateKey, peerBoxPublicKey: friend.boxPublicKey }),
  )
}

export class Peer {
  private readonly channels = new Map<string, Channel>()
  private readonly pending = new Map<string, Pending>()
  /** Question ids being served RIGHT NOW. A parked approval has no deadline while
   *  the asker's request times out in sixty seconds and re-sends the same id on the
   *  next connect; without this, that resend would park a SECOND approval for a
   *  question already sitting on the owner's Inbox. `answeredFor` cannot cover it,
   *  because the first one has not been answered yet. */
  private readonly inflight = new Set<string>()

  /** Told when an answer arrives for a question nobody is waiting on any more —
   *  a resend from the 24-hour pending list, answered after the asker restarted.
   *  Optional because the loopback path has no such case. */
  onLateAnswer?: (answer: AnswerResponse) => void

  /** Told the moment an `out` thread settles, with the row as it now stands. A
   *  hook rather than a call so this class stays testable with no HTTP:
   *  `flock/deliver.ts` POSTs into the engine holding the chat that asked. */
  onReplyLanded?: (thread: Thread) => void

  constructor(
    private readonly store: Store,
    private readonly transport: Transport,
    private readonly serve?: Serve,
  ) {}

  /** Every contact's full handle, and the full handle for one name or handle. For
   *  a caller that holds a peer but no store — `owner-http.ts` must not open one,
   *  because `Store.open()` mints a keypair on first use. */
  contacts(): readonly string[] {
    return this.store.friends().map((friend) => friend.handle)
  }

  resolve(handle: string): string | undefined {
    return this.store.find(handle)?.handle
  }

  /** The same question as {@link resolve}, with the AMBIGUITY kept. `owner-http.ts`
   *  must be able to say "you named three people" rather than silently dropping the
   *  name — a forwarded ask that quietly asked nobody is the failure to end. */
  lookup(handle: string): ReturnType<Store["resolve"]> {
    return this.store.resolve(handle)
  }

  /** Open a channel per friend in the store. Idempotent; call it again after `accept`. */
  start(): void {
    for (const friend of this.store.friends()) {
      if (this.channels.has(friend.handle)) continue
      this.open(friend)
    }
    // A friend revoked while we were listening keeps no channel: their frames
    // then arrive on a rid nobody is on, which is the "unknown sender" the
    // revoke was for.
    for (const [handle, channel] of this.channels) {
      if (this.store.find(handle)) continue
      channel.unlisten()
      this.channels.delete(handle)
    }
  }

  stop(): void {
    for (const channel of this.channels.values()) channel.unlisten()
    this.channels.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("flock peer stopped"))
    }
    this.pending.clear()
  }

  private open(friend: Friend): void {
    const keys = keysFor(this.store.identity(), friend)
    const channel: Channel = {
      friend,
      keys,
      // FROM DISK, not from zero. A fresh `Peer` that started its replay window
      // at zero would accept a frame the previous process had already accepted.
      lastRecvSeq: this.store.seq(friend.handle).recv,
      unlisten: () => {},
    }
    channel.unlisten = this.transport.listen(keys.rid, (frame) => this.receive(channel, frame))
    this.channels.set(friend.handle, channel)
  }

  private async receive(channel: Channel, frame: Uint8Array): Promise<void> {
    let opened: FlockEnvelope.Opened
    try {
      opened = FlockEnvelope.open({ keys: channel.keys, frame })
    } catch {
      return
    }
    const payload = opened.payload as FlockEnvelope.Signed<Record<string, unknown>>
    // Is this frame mine or theirs, answered once: an unverified payload is our
    // own echo or a forgery, and both drop without advancing replay state.
    if (!payload || typeof payload !== "object") return
    // REVOKE TAKES EFFECT NOW, not at the next `start()`. A channel holds its own
    // copy of the friend it opened on, so a revoked friend would keep being
    // answered by an already-open channel — the whole window a revoke closes.
    // FROM DISK, not the cache: the pane and the CLI each open their OWN `Store`
    // to revoke, so this object's copy is stale by exactly one revoke. The re-read
    // sits here because a frame that failed to open must not cost a file read.
    this.store.reload()
    if (!this.store.findByKey(channel.friend.signPublicKey)) return
    if (!FlockEnvelope.verifyPayload(payload, channel.friend.signPublicKey)) return
    if (opened.seq <= channel.lastRecvSeq) return
    channel.lastRecvSeq = opened.seq
    // A rename arrives here and only here: the signature has passed and the
    // sequence is ahead of everything already accepted, so a frame replayed off
    // the ring cannot walk the row backwards. Keyed on the SIGNING KEY the frame
    // verified against, never on the `from` handle in the payload, which is just a
    // string the sender wrote. Skipped when nothing moved, so a frame costs no write.
    this.store.noteDeclared(channel.friend.signPublicKey, { name: payload["name"], icon: payload["icon"] })
    // Persisted BEFORE the payload is acted on. This number is also the
    // relay's `?after=`, so a crash between accepting a frame and recording it
    // would have the ring replay a frame this peer has already answered.
    this.store.noteRecvSeq(channel.friend.handle, opened.seq)

    if (opened.role === FlockEnvelope.ROLE_ASK) return this.handleRequest(channel, payload as unknown as Request)
    const id = String(payload.id)
    const waiting = this.pending.get(id)
    // The answer lands in the mailbox and nowhere else. Nobody is waiting on it in
    // the ordinary case — `flock_ask` returned the moment the question went out —
    // so this is the ONLY place it is recorded, as an unread row. `onLateAnswer`
    // stays for the log line; it does not deliver anything.
    if (this.store.thread(id)?.direction === "out") {
      const answer = payload as unknown as AnswerResponse
      const settled = this.store.settleOut(id, {
        ok: answer.ok === true,
        text: String(answer.text ?? ""),
        tokens: Number(answer.tokens ?? 0),
        signatureOk: true,
        ...(answer.ok === true ? {} : { reason: String(answer.text ?? "") }),
      })
      // The chat that asked gets it first, when still open. Fired after the store
      // write and never awaited: the row is the record, and a closed chat must not
      // hold up the frame this peer is in the middle of accepting.
      if (settled) this.onReplyLanded?.(settled)
      if (!waiting) this.onLateAnswer?.(answer)
    }
    if (!waiting) return
    this.pending.delete(id)
    clearTimeout(waiting.timer)
    waiting.resolve(payload as unknown as Response)
  }

  private async handleRequest(channel: Channel, request: Request): Promise<void> {
    if (!this.serve) return
    const identity = this.store.identity()
    const now = new Date().toISOString()
    let response: Response
    // A RESEND IS NOT A SECOND QUESTION. The asking side re-sends an unanswered
    // question under its original id for up to 24 hours, so a friend back online
    // after the relay's ring expired sees the same id again. Answering twice would
    // cost a second Front Desk turn and a second approval. The record is re-sent.
    const already = request.type === "flock/ask" ? this.store.answeredFor(request.id) : undefined
    if (already) {
      await this.send(channel, FlockEnvelope.ROLE_ANSWER, {
        type: "flock/answer",
        v: 1,
        id: already.id,
        from: identity.handle,
        ok: already.ok,
        text: already.text,
        tokens: already.tokens,
        at: already.at,
      } satisfies AnswerResponse).catch(() => {})
      return
    }
    if (this.inflight.has(request.id)) return
    this.inflight.add(request.id)
    try {
      if (request.type === "flock/who") {
        response = {
          type: "flock/card",
          v: 1,
          id: request.id,
          from: identity.handle,
          card: await this.serve.card({ friend: channel.friend }),
          at: now,
        }
      } else {
        const answered = await this.serve.ask({
          friend: channel.friend,
          question: request.question,
          id: request.id,
        })
        // PARKED, NOT ANSWERED. The question is now a row in the owner's
        // mailbox and there is nothing to send: see {@link Deferred}.
        if ("deferred" in answered) return
        response = { type: "flock/answer", v: 1, id: request.id, from: identity.handle, ...answered, at: now }
      }
    } catch (error) {
      response = {
        type: "flock/answer",
        v: 1,
        id: request.id,
        from: identity.handle,
        ok: false,
        text: `the front desk failed: ${error instanceof Error ? error.message : String(error)}`,
        tokens: 0,
        at: now,
      }
    } finally {
      this.inflight.delete(request.id)
    }
    if (response.type === "flock/answer") {
      this.store.settleIn({
        id: response.id,
        contact: channel.friend.handle,
        question: request.type === "flock/ask" ? request.question : "",
        ok: response.ok,
        text: response.text,
        tokens: response.tokens,
        at: response.at,
      })
    }
    try {
      await this.send(channel, FlockEnvelope.ROLE_ANSWER, response)
    } catch {
      // The answer would not FIT. A frame is capped at 65,536 bytes
      // (`envelope.ts`), so a desk that quoted a long file produces a seal that
      // throws. Without this the asker times out and reads it as "your friend is
      // offline" rather than "your friend said too much". A refusal is honest.
      const refusal: AnswerResponse = {
        type: "flock/answer",
        v: 1,
        id: request.id,
        from: identity.handle,
        ok: false,
        text: "the answer was too large to send; ask a narrower question",
        tokens: response.type === "flock/answer" ? response.tokens : 0,
        at: now,
      }
      // Recorded over the answer that would not fit, so a resend gets the
      // refusal back rather than paying for the same oversized turn again.
      this.store.settleIn({
        id: refusal.id,
        contact: channel.friend.handle,
        question: request.type === "flock/ask" ? request.question : "",
        ok: false,
        text: refusal.text,
        tokens: refusal.tokens,
        at: refusal.at,
      })
      await this.send(channel, FlockEnvelope.ROLE_ANSWER, refusal).catch(() => {})
    }
  }

  /** Every frame this peer writes leaves through here. The sequence comes from
   *  `flock.json` and is reserved before the frame goes out (`Store.nextSendSeq`):
   *  a counter that restarted at 1 with a new `Peer` would look like a replay to
   *  the friend and be dropped for ever, every later frame being lower still. */
  private async send(channel: Channel, role: number, payload: object): Promise<void> {
    const seq = this.store.nextSendSeq(channel.friend.handle)
    const identity = this.store.identity()
    // Stamped here and nowhere else: every frame leaves through this method, so
    // one line covers ask, who, answer, card and the resend of a recorded answer,
    // and no future message type can forget it. {@link Declared} says why signed.
    const declared: Declared = { name: identity.name, icon: FlockIdentity.normaliseIcon(identity.icon) }
    const signed = FlockEnvelope.signPayload({ ...payload, ...declared }, identity.sign.privateKey)
    await this.transport.send(channel.keys.rid, FlockEnvelope.seal({ keys: channel.keys, role, seq, payload: signed }))
  }

  private channelFor(handle: string): Channel {
    const found = this.store.resolve(handle)
    // Ambiguity is named, never guessed. `postMany` turns this throw into the
    // per-contact `error` the model and the pane both print, so an owner who typed
    // half a name reads which halves it could have been.
    if (found.kind === "many") throw new Error(ambiguous(handle, found.candidates))
    if (found.kind === "none") throw new Error(`${handle} is not in this flock`)
    const friend = found.friend
    const existing = this.channels.get(friend.handle)
    if (existing) return existing
    this.open(friend)
    return this.channels.get(friend.handle)!
  }

  private request<T extends Response>(channel: Channel, payload: object, timeoutMs: number): Promise<T> {
    const id = (payload as { id: string }).id
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${channel.friend.handle} did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (r: Response) => void, reject, timer })
      void this.send(channel, FlockEnvelope.ROLE_ASK, payload).catch((error: unknown) => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Ask one friend. Resolves with their refusal as readily as with their answer — both are results. */
  async ask(handle: string, question: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Answer> {
    const channel = this.channelFor(handle)
    const request: AskRequest = {
      type: "flock/ask",
      v: 1,
      id: nextID(),
      from: this.store.identity().handle,
      question,
      at: new Date().toISOString(),
    }
    // RECORDED BEFORE IT IS SENT. The relay's ring holds a frame for ten minutes;
    // a friend away longer never sees the question. The entry is what
    // `flushPending` re-sends on the next connect, retired the moment an answer
    // for the id arrives — including after a restart, with no caller left.
    this.store.openOut({ id: request.id, contact: channel.friend.handle, question })
    const response = await this.request<AnswerResponse>(channel, request, timeoutMs)
    return {
      from: channel.friend.handle,
      ok: response.ok,
      text: response.text,
      tokens: response.tokens,
      // The frame already verified in `receive`; saying so on the result is
      // what lets a tool print "signature ok" without the caller re-deriving it.
      signatureOk: true,
    }
  }

  /** Send a question and return — the whole of `flock_ask`. Nothing waits for an
   *  answer: the owner runs many chats, the contact's owner may be asleep, and a
   *  tool call that blocked sixty seconds to end in a timeout taught the model the
   *  flock was broken. The thread is filed before the frame goes out, so a failed
   *  send still leaves a row `flushPending` re-sends. Returns the thread id, which
   *  is the envelope id and the id the ANSWERING side files its own row under. */
  async post(
    handle: string,
    question: string,
    followUpOf?: string,
    origin?: ThreadOrigin,
  ): Promise<{ thread: string; contact: string }> {
    const channel = this.channelFor(handle)
    const request: AskRequest = {
      type: "flock/ask",
      v: 1,
      id: nextID(),
      from: this.store.identity().handle,
      question,
      at: new Date().toISOString(),
    }
    this.store.openOut({
      id: request.id,
      contact: channel.friend.handle,
      question,
      ...(followUpOf ? { followUpOf } : {}),
      ...(origin?.sessionID ? { origin } : {}),
    })
    await this.send(channel, FlockEnvelope.ROLE_ASK, request).catch(() => {})
    return { thread: request.id, contact: channel.friend.handle }
  }

  /** Council, fire-and-return: one thread per contact, all sent, none waited on. A
   *  contact that could not be reached still gets a thread — the row is what
   *  `flushPending` retries against, and a question that vanished with a dead
   *  socket is one the owner never learns was not asked. */
  async postMany(
    handles: readonly string[],
    question: string,
    followUpOf?: string,
    origin?: ThreadOrigin,
  ): Promise<{ thread?: string; contact: string; error?: string }[]> {
    const settled = await Promise.allSettled(handles.map((handle) => this.post(handle, question, followUpOf, origin)))
    return settled.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : {
            contact: handles[index] ?? "unknown",
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          },
    )
  }

  /** Send the answer the owner decided on, long after the question arrived — the
   *  other half of {@link Deferred}. The thread is closed in the store FIRST and the
   *  frame goes out second, for the reason `nextSendSeq` is reserved before a send:
   *  a crash between the two must leave the resend served from the record. */
  async reply(input: { thread: string; ok: boolean; text: string; tokens: number; reason?: string }): Promise<void> {
    const thread = this.store.thread(input.thread)
    if (!thread || thread.direction !== "in") throw new Error(`${input.thread} is not an inbound thread`)
    const channel = this.channelFor(thread.contact)
    const at = new Date().toISOString()
    this.store.settleIn({
      id: thread.id,
      contact: thread.contact,
      ok: input.ok,
      text: input.text,
      tokens: input.tokens,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      at,
    })
    const response: AnswerResponse = {
      type: "flock/answer",
      v: 1,
      id: thread.id,
      from: this.store.identity().handle,
      ok: input.ok,
      text: input.text,
      tokens: input.tokens,
      at,
    }
    await this.send(channel, FlockEnvelope.ROLE_ANSWER, response)
  }

  /** Re-send every question this friend has not answered yet, under its ORIGINAL
   *  id, so their side serves it from `answeredFor` if they answered while we were
   *  away and we missed the reply. Called by `service.ts` when a friend's socket
   *  opens, the only moment a resend can do anything. Nothing waits on these; the
   *  answer arrives on `onLateAnswer`. Returns how many were re-sent, for the log. */
  async flushPending(handle: string): Promise<number> {
    const friend = this.store.find(handle)
    if (!friend) return 0
    const queued = this.store.pending(friend.handle)
    if (queued.length === 0) return 0
    const channel = this.channelFor(friend.handle)
    let sent = 0
    for (const entry of queued) {
      const request: AskRequest = {
        type: "flock/ask",
        v: 1,
        id: entry.id,
        from: this.store.identity().handle,
        question: entry.question,
        at: new Date().toISOString(),
      }
      try {
        await this.send(channel, FlockEnvelope.ROLE_ASK, request)
        sent++
      } catch {
        // The wire went down again between the open and this send. The entry
        // stays pending and the next open tries again.
      }
    }
    return sent
  }

  /** Council as a fan-out, not as `CollabCouncil`: that class owns its members'
   *  turn order, room log and seal (`collab/seal.ts`), none of which exists across
   *  a network — a friend's engine runs its own turn and applies its own cage. What
   *  is wanted here is "one question, N attributed answers" = `Promise.allSettled`. */
  async askMany(handles: readonly string[], question: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Answer[]> {
    const settled = await Promise.allSettled(handles.map((handle) => this.ask(handle, question, timeoutMs)))
    return settled.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : {
            from: handles[index] ?? "unknown",
            ok: false,
            text: result.reason instanceof Error ? result.reason.message : String(result.reason),
            tokens: 0,
            signatureOk: false,
          },
    )
  }

  /** A friend's signed card, verified against the key this store holds for them. */
  async who(handle: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<FlockCard.Card> {
    const channel = this.channelFor(handle)
    const request: WhoRequest = {
      type: "flock/who",
      v: 1,
      id: nextID(),
      from: this.store.identity().handle,
      at: new Date().toISOString(),
    }
    const response = await this.request<CardResponse>(channel, request, timeoutMs)
    if (!FlockCard.verify(response.card, channel.friend.signPublicKey)) {
      throw new Error(`${channel.friend.handle} sent a card that does not verify against their key`)
    }
    // The card is signed over its own body, so the name and icon ON THE CARD are
    // the ones the check above covered. Taken from there rather than the enclosing
    // frame because a caller may hold a card long after that frame is gone.
    this.store.noteDeclared(channel.friend.signPublicKey, { name: response.card.name, icon: response.card.icon })
    return response.card
  }
}

export * as FlockPeer from "./peer"

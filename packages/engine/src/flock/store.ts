import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@origami/core/global"
import { FlockIdentity } from "./identity"
import { FlockPolicy } from "./policy"

/** `flock.json`, IN THE GLOBAL CONFIG DIRECTORY AND NOWHERE ELSE.
 *  A project-local file must never be able to introduce a trusted party: clone a repo with
 *  a `.origami/flock.json` in it and you would have inherited its author's friends list.
 *  So the path is `Global.Path.config/flock.json`, only overridable by a caller that
 *  passes a directory (tests), and nothing in the load path consults the worktree.
 *  The file holds the owner's PRIVATE keys. It is written 0600 where the mode is honoured;
 *  on Windows the directory ACL protects it, as it already does for `auth.json` next door. */

export const FILE = "flock.json"
export const VERSION = 1

/** A contact as stored: their public identity, how to reach them, and the policy for them. */
export interface Friend {
  /** `name@fingerprint`, MINTED ONCE from the invite and never rewritten. It carries the
   *  name they declared at the time, so a later rename does not move it: this string is
   *  what `find` matches, what a pending question is filed under, and what an answer is
   *  attributed to. */
  readonly handle: string
  /** THE NAME THEY CALL THEMSELVES, as of the last frame of theirs that verified.
   *  `noteDeclared` refreshes it; nothing else may write it, because a name that could be
   *  set without a signature is a name anyone could set. */
  readonly name: string
  /** The sigil variant they picked, refreshed the same way `name` is. Absent on
   *  a record written before icons, which reads as the default. */
  readonly icon?: string
  readonly signPublicKey: string
  readonly boxPublicKey: string
  /** Where their engine listens, when the invite carried one. Unused by the loopback transport. */
  readonly relay?: string
  readonly addedAt: string
  /** THE NAME THIS OWNER GAVE THEM, not the name they gave themselves. `name` above is
   *  self-declared and only its owner can change it, so three contacts may all call
   *  themselves "dana". This label is kept beside the contact rather than inside `policy`
   *  because it decides nothing - a label that could change what a front desk answers
   *  would be a permission. Absent means "use their declared name". */
  readonly displayName?: string
  /** The invite's one-time token, kept so a later transport can match a first contact. */
  readonly token?: string
  readonly policy?: FlockPolicy.Overrides
  /** Today's spend against this friend's budget. Reset lazily on the first ask of a new UTC day. */
  readonly usage?: { readonly day: string; readonly tokens: number }
  /** THE COUNTERS THAT MAKE A RECONNECT SURVIVABLE. `sendSeq` is the highest sequence WE
   *  have sent this friend; `lastRecvSeq` the highest we have ACCEPTED from them. Both are
   *  on disk because a pair secret is permanent: an in-memory counter restarting at 1 with
   *  a new process produces frames the friend reads as replays. `lastRecvSeq` is also the
   *  relay's `?after=` value, which makes a reconnect resume from the ring. */
  readonly sendSeq?: number
  readonly lastRecvSeq?: number
}

/** A question that left this Origami and has not been answered. The relay's ring holds a
 *  frame for ten minutes, and the asker's 60-second timeout gives up long before a friend
 *  whose machine is off comes back. So the question is kept here and re-sent on the next
 *  successful connect under the SAME envelope id, which makes the resend idempotent. */
export interface PendingOut {
  readonly id: string
  readonly handle: string
  readonly question: string
  readonly at: string
  /** Epoch ms past which the question is abandoned. See {@link PENDING_TTL_MS}. */
  readonly expiresAt: number
}

/** One inbound question already answered, kept by envelope id. A resent question must not
 *  cost the owner a second Front Desk turn; a repeat of an id here is answered from this
 *  record instead. */
export interface Answered {
  readonly id: string
  readonly from: string
  readonly ok: boolean
  readonly text: string
  readonly tokens: number
  readonly at: string
}

/** HOW LONG AN UNANSWERED QUESTION IS RETRIED. A day: long enough to cover a friend who
 *  was away overnight, short enough that a question nobody waits on stops being re-asked. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000

// -------------------------------- the mailbox --------------------------------

/** ONE MAILBOX PER ORIGAMI, belonging to the Front Desk pane rather than to any chat
 *  session. An answer arriving INTO one of the owner's many chats would interrupt a turn
 *  nobody asked it to, and a question that parked a permission prompt blocked whichever
 *  session it was raised on. The only way anything reaches a session now is an explicit
 *  click on a row. A THREAD ID IS THE ENVELOPE ID, minted by the asker in `peer.ts` and
 *  filed under the same string by the answering side, so a resend is recognised. */
export type ThreadDirection = "out" | "in"

/** WHERE A THREAD HAS GOT TO. Seven states, four of them terminal.
 *  `out`: `sent` (on the wire, re-sent on reconnect) -> `answered` | `declined` |
 *  `expired`. `delivered` is `answered` plus "the owner has put it into a chat" - a state
 *  and not a flag, because a row already acted on must not read like one still waiting.
 *  `in`: `pending` -> `answering` (drafting, or waiting on Send) -> `answered` |
 *  `declined`. A draft lives on an `answering` thread's `reply`, unsent. */
export type ThreadState = "sent" | "delivered" | "answered" | "declined" | "expired" | "pending" | "answering"

export interface ThreadQuestion {
  readonly text: string
  readonly sentAt: string
  /** What answering it cost, when the answering side reported a figure. */
  readonly tokens?: number
}

export interface ThreadReply {
  readonly text: string
  readonly at: string
  readonly tokens: number
  /** Whether the frame verified against the contact's stored key. False is never usable. */
  readonly signatureOk: boolean
  /** Present only on a refusal, carrying the reason the other side gave. */
  readonly declined?: { readonly reason?: string }
}

/** THE CHAT A QUESTION WAS SENT FROM, carried so the answer can go back to it. Without it
 *  the session that called `flock_ask` never got the answer, and a fresh chat got an answer
 *  to a question it never asked. The id is the ENGINE's session id, which survives a window
 *  reload. OPTIONAL: no origin means the owner places the reply themselves. */
export interface ThreadOrigin {
  readonly sessionID: string
  /** What that chat was called when the question went out, for the picker. */
  readonly title?: string
}

export interface Thread {
  /** The envelope id. See the module note above for why the two sides share it. */
  readonly id: string
  /** The contact's FULL handle. */
  readonly contact: string
  readonly direction: ThreadDirection
  readonly question: ThreadQuestion
  readonly state: ThreadState
  readonly reply?: ThreadReply
  /** What the owner told their Front Desk before it drafted. `in` threads only. */
  readonly guidance?: string
  /** Sessions this row was explicitly delivered into. Append-only; never automatic. */
  readonly deliveredTo?: readonly string[]
  /** Whether the owner still has to look at it. The badge counts these. */
  readonly unread: boolean
  /** The thread this one follows up on, so a pane can show them together. */
  readonly followUpOf?: string
  /** The chat that asked. `out` threads only; see {@link ThreadOrigin}. */
  readonly origin?: ThreadOrigin
}

/** HOW MANY THREADS THE FILE KEEPS. The mailbox is a working surface, not an archive.
 *  CLOSED threads are dropped first, oldest first, so a cap reached in a busy hour never
 *  discards a live question. */
export const MAILBOX_MAX = 200

/** How many times {@link Store} retries the rename that publishes a write. */
export const RENAME_TRIES = 3

/** The states nothing further happens in. */
export const CLOSED_STATES = ["answered", "declined", "expired", "delivered"] as const

export function isClosed(thread: Thread): boolean {
  return (CLOSED_STATES as readonly string[]).includes(thread.state)
}

/** THE OWNER'S OWN DESK SETTINGS THAT HAVE NO CONFIG HOME. `flock.frontDesk` in
 *  `origami.json` holds the three that cost money or open files - model, daily budget,
 *  scope. These two do not: the specialties are prose on this Origami's card and
 *  `autoAnswer` is the DEFAULT for a friend with no override, both identity-shaped and
 *  global by the same argument that keeps the friends list global. */
export interface Desk {
  readonly specialties?: readonly string[]
  /** The default `autoAnswer` for a friend with no override of their own. Off unless set. */
  readonly autoAnswer?: boolean
}

/** One answered (or refused) inbound question, for the owner's Inbox log. */
export interface Answer {
  readonly at: string
  readonly from: string
  readonly question: string
  readonly tokens: number
  readonly ok: boolean
}

/** The log is a ring, not an archive: it exists so the owner can see what their desk has
 *  been doing lately and what it cost, inside a file re-read on every budget debit. */
export const ANSWER_LOG_MAX = 50

/** An invite token this Origami has already spent, and when. See {@link TOKEN_TTL_MS}. */
export interface UsedToken {
  readonly token: string
  readonly usedAt: string
}

export interface Data {
  readonly version: number
  readonly identity: FlockIdentity.Info
  readonly friends: readonly Friend[]
  readonly desk?: Desk
  readonly answers?: readonly Answer[]
  /** Tokens `accept` has consumed. Absent on a file written before 0.4.82. */
  readonly used?: readonly UsedToken[]
  /** EVERY exchange with a contact, in both directions. The one source of truth for a
   *  thread; {@link Store.pending} and {@link Store.answeredFor} are views over it. */
  readonly mailbox?: readonly Thread[]
  /** LEGACY, read by {@link migrate} and never written again: questions sent and not yet
   *  answered, before the mailbox held them. Its rows become `out` threads. */
  readonly pending?: readonly PendingOut[]
  /** LEGACY, as {@link Data.pending}: inbound ids already answered. Becomes `in` threads. */
  readonly answered?: readonly Answered[]
}

/** What {@link Store.resolve} found. `many` carries the rows rather than a count, because
 *  a caller reporting an ambiguity has to NAME the contacts - a number tells the owner
 *  they were unclear and nothing about how to be clear. */
export type Resolution =
  | { readonly kind: "one"; readonly friend: Friend }
  | { readonly kind: "none" }
  | { readonly kind: "many"; readonly candidates: readonly Friend[] }

/** The sentence an ambiguity reads as, in one place because three surfaces print it. Each
 *  candidate is given by its FULL handle, which can be typed back unambiguously. */
export function ambiguous(query: string, candidates: readonly Friend[]): string {
  const named = candidates.map((friend) => `${friend.displayName?.trim() || friend.name} (${friend.handle})`)
  return `"${query}" matches ${candidates.length} contacts in this flock: ${named.join(", ")}. Ask again using one of those handles.`
}

export const INVITE_SCHEME = "origami://flock/invite#"

/**
 * The invite string.
 *   origami://flock/invite#v2.<signPub>.<boxPub>.<name>.<token>.<issuedAtMs>[.<relay>]
 *
 * Dotted base64url segments. A version leads, so a later shape is distinguishable rather
 * than silently mis-parsed. There are TWO keys: signing and key agreement cannot share an
 * Ed25519 key (see `identity.ts`), so both public halves ride. v2 carries WHEN it was
 * issued, which is what lets an invite expire; v1 IS REFUSED, not decoded, because
 * accepting one would be a standing way round that rule. Every segment is base64url, so
 * the dot is an unambiguous separator even for a name with a dot in it.
 * The secret is in the FRAGMENT, like the Remote pairing QR, so a relay ever handed one
 * of these in a URL never receives the part that matters.
 */
export const INVITE_VERSION = "v2"

export function encodeInvite(input: {
  identity: FlockIdentity.Public
  token: string
  relay?: string
  issuedAt?: number
}): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url")
  const parts = [
    INVITE_VERSION,
    input.identity.signPublicKey,
    input.identity.boxPublicKey,
    b64(input.identity.name),
    input.token,
    b64(String(input.issuedAt ?? Date.now())),
  ]
  // THE ICON IS A TRAILING SEGMENT, AND v2 DID NOT MOVE: a version bump would make every
  // invite this build writes unreadable to a shipped build, for one cosmetic field. So the
  // icon takes segment 8 and the relay slot is written EMPTY when there is no relay but
  // there is an icon - an older reader reads "" as absent and ignores segment 8.
  const icon = FlockIdentity.normaliseIcon(input.identity.icon)
  const named = icon === FlockIdentity.ICON_DEFAULT ? "" : b64(icon)
  if (input.relay || named) parts.push(input.relay ? b64(input.relay) : "")
  if (named) parts.push(named)
  return INVITE_SCHEME + parts.map((part) => part.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")).join(".")
}

export class InviteError extends Error {
  constructor(reason: string) {
    super(`not a valid flock invite: ${reason}`)
    this.name = "FlockInviteError"
  }
}

export function decodeInvite(invite: string): {
  identity: FlockIdentity.Public
  token: string
  /** Epoch ms the invite was made. What {@link TOKEN_TTL_MS} is measured from. */
  issuedAt: number
  relay?: string
} {
  const trimmed = invite.trim()
  if (!trimmed.startsWith(INVITE_SCHEME)) throw new InviteError("wrong scheme")
  const parts = trimmed.slice(INVITE_SCHEME.length).split(".")
  if (parts[0] === "v1") throw new InviteError("it was made by an older Origami and carries no expiry - ask for a new one")
  if (parts[0] !== INVITE_VERSION) throw new InviteError(`unsupported invite version "${parts[0] ?? ""}"`)
  if (parts.length < 6) throw new InviteError("too few segments")
  const [, signUrl, boxUrl, nameB64, token, issuedB64, relayB64, iconB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string?,
    string?,
  ]
  // base64url back to base64, PADDING RESTORED. The keys are compared as strings against
  // the ones the identity holds (standard base64, padded) and `encodeInvite` drops the
  // padding to keep the invite URL-safe. Dropping it on the way in too produced a key
  // differing by one "=", which changed the fingerprint and made every lookup miss.
  const std = (value: string) => {
    const swapped = value.replaceAll("-", "+").replaceAll("_", "/")
    return swapped + "=".repeat((4 - (swapped.length % 4)) % 4)
  }
  const signPublicKey = std(signUrl)
  const boxPublicKey = std(boxUrl)
  const name = Buffer.from(nameB64, "base64url").toString("utf8")
  if (!signPublicKey || !boxPublicKey || !name || !token) throw new InviteError("an empty segment")
  const issuedAt = Number(Buffer.from(issuedB64, "base64url").toString("utf8"))
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) throw new InviteError("an unreadable issue time")
  const icon = FlockIdentity.normaliseIcon(iconB64 ? Buffer.from(iconB64, "base64url").toString("utf8") : undefined)
  return {
    identity: {
      handle: `${name}@${FlockIdentity.fingerprint(signPublicKey)}`,
      name,
      icon,
      signPublicKey,
      boxPublicKey,
    },
    token,
    issuedAt,
    ...(relayB64 ? { relay: Buffer.from(relayB64, "base64url").toString("utf8") } : {}),
  }
}

/** INVITE TOKEN ENTROPY. Sixteen bytes = 128 bits, the floor for a bearer secret that
 *  travels in a link: it is a value someone may paste into a chat window. */
export const TOKEN_BYTES = 16

/** HOW LONG AN INVITE LIVES. Forty-eight hours: long enough to send one and be answered
 *  across a weekend, short enough that one left in a message thread is dead by the time
 *  anyone finds it. Paired with SINGLE USE (see {@link Store.accept}). */
export const TOKEN_TTL_MS = 48 * 60 * 60 * 1000

/** Tolerated clock skew AHEAD of this box. An invite dated further into the
 *  future than this is refused rather than granted an unbounded life. */
export const TOKEN_FUTURE_SKEW_MS = 60 * 60 * 1000

export function newToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url")
}

/** Whether a sanitised scope is the same three lists the stored one already had. */
function sameScope(next: FlockPolicy.Scope, stored: FlockPolicy.Scope | undefined): boolean {
  if (!stored) return false
  if (Object.keys(stored).length !== Object.keys(next).length) return false
  for (const key of ["repos", "wiki", "folders"] as const) {
    const a = next[key]
    const b = stored[key]
    if (a === undefined && b === undefined) continue
    if (a === undefined || b === undefined) return false
    if (a.length !== b.length || a.some((entry, i) => entry !== b[i])) return false
  }
  return true
}

/** A HANDLE ON DISK, RECOMPUTED FROM THE KEY BESIDE IT.
 *  The fingerprint grew from 32 bits to the full 256 (`identity.ts`), so a `flock.json`
 *  written by 0.4.81 or earlier holds eight-character handles. The handle was never the
 *  identity - every record already carries the public key it was derived from - so the
 *  new handle is a pure function of data already there, and the match is by key. ONLY THE
 *  FINGERPRINT HALF IS REBUILT: the name half comes from the handle already on disk,
 *  never from the current display name, or a rename would re-mint every label.
 *  Returns `undefined` when nothing changed, so a load that needs no rewrite does not
 *  touch the file. */
export function migrate(data: Data): Data | undefined {
  const named = (handle: string, fallback: string) => FlockIdentity.handleName(handle, fallback)
  const fp = FlockIdentity.fingerprint
  const handle = `${named(data.identity.handle, data.identity.name)}@${fp(data.identity.signPublicKey)}`
  const icon = FlockIdentity.normaliseIcon(data.identity.icon)
  const friends = data.friends.map((friend) => {
    const upgraded = `${named(friend.handle, friend.name)}@${fp(friend.signPublicKey)}`
    // A PER-CONTACT `skills` LIST IS DROPPED, the same way `origami.json`'s is
    // (`config-write.ts read`). A skill is instructions, not a secret, and a stale list
    // would go on adding read globs to that contact's cage with no control to remove them.
    const scope = friend.policy?.scope === undefined ? undefined : FlockPolicy.sanitiseScope(friend.policy.scope)
    const policy =
      scope === undefined || sameScope(scope, friend.policy?.scope)
        ? friend.policy
        : ({ ...friend.policy, scope } as FlockPolicy.Overrides)
    if (friend.handle === upgraded && policy === friend.policy) return friend
    return { ...friend, handle: upgraded, ...(policy === undefined ? {} : { policy }) }
  })
  const folded = foldLegacy(data)
  const changed =
    data.identity.handle !== handle ||
    data.identity.icon !== icon ||
    friends.some((friend, i) => friend !== data.friends[i]) ||
    folded !== undefined
  if (!changed) return undefined
  const migrated: Data = { ...data, identity: { ...data.identity, handle, icon }, friends }
  if (!folded) return migrated
  const { pending: _p, answered: _a, ...rest } = migrated
  return { ...rest, mailbox: folded }
}

/** THE TWO LEGACY LISTS, FOLDED INTO THREADS. Undefined when there is nothing to fold, so
 *  an already-migrated file costs no rewrite. `pending` becomes `out`/`sent` - the exact
 *  rows `flushPending` re-sends. `answered` becomes `in`/`answered`|`declined` so a RESEND
 *  is served from the record instead of costing a second desk turn; it carried no question
 *  text, so the thread's question is empty and says so. The `answers` LOG is deliberately
 *  not folded: it has no envelope id to join on. */
function foldLegacy(data: Data): readonly Thread[] | undefined {
  if (data.mailbox) return undefined
  if (!data.pending?.length && !data.answered?.length) return undefined
  const out: Thread[] = (data.pending ?? []).map((entry) => ({
    id: entry.id,
    contact: entry.handle,
    direction: "out",
    question: { text: entry.question, sentAt: entry.at },
    state: "sent",
    unread: false,
  }))
  const inbound: Thread[] = (data.answered ?? []).map((entry) => ({
    id: entry.id,
    contact: entry.from,
    direction: "in",
    question: { text: "", sentAt: entry.at },
    state: entry.ok ? "answered" : "declined",
    reply: {
      text: entry.text,
      at: entry.at,
      tokens: entry.tokens,
      signatureOk: true,
      ...(entry.ok ? {} : { declined: {} }),
    },
    unread: false,
  }))
  return [...out, ...inbound]
}

/** Where this box's `flock.json` is. Exported because `watch.ts` and
 *  `diagnose.ts` both need the path without opening the store — `Store.open`
 *  mints a keypair on first use, which neither of them has any business doing. */
export function file(directory: string = Global.Path.config): string {
  return path.join(directory, FILE)
}

/** Whether this box has a flock at all, WITHOUT creating one. `Store.open` mints an
 *  identity on first use, which is right for a person who typed `origami flock invite`
 *  and wrong for a service that starts with every engine - `boot.ts` asks this first. */
export function exists(directory: string = Global.Path.config): boolean {
  return fs.existsSync(file(directory))
}

/** The friends list and the identity behind it. Every mutation RE-READS the file, applies
 *  the change and writes it all back: a terminal `origami flock accept` and an engine
 *  debiting a budget are two processes, and a cached copy would overwrite the other's. */
export class Store {
  private constructor(
    readonly file: string,
    private data: Data,
  ) {}

  /** Load the store, generating an identity on first use. `name` seeds the handle and is
   *  only consulted when there is no identity yet, so it can never mint a second identity
   *  and orphan every contact. Renaming later is {@link setIdentity}. */
  static open(input?: { directory?: string; name?: string }): Store {
    const directory = input?.directory ?? Global.Path.config
    const file = path.join(directory, FILE)
    const existing = Store.read(file)
    if (existing) {
      const upgraded = migrate(existing)
      const store = new Store(file, upgraded ?? existing)
      if (upgraded) store.write()
      return store
    }
    const identity = FlockIdentity.generate(input?.name ?? "origami")
    const store = new Store(file, { version: VERSION, identity, friends: [] })
    store.write()
    return store
  }

  /** The file, or `undefined` ONLY when there is genuinely no file. A `catch` that swallowed
   *  every read error alike is a way to lose a whole flock: `Store.open` reads `undefined`
   *  as "first use", mints a fresh identity and writes an empty contacts list over the file
   *  it could not read. One transient EPERM/EBUSY on Windows and the owner's identity and
   *  every contact are gone, so only "it is not there" is `undefined`. */
  private static read(file: string): Data | undefined {
    let raw: string
    try {
      raw = fs.readFileSync(file, "utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "ENOENT" || code === "ENOTDIR") return undefined
      throw error
    }
    const parsed = JSON.parse(raw) as Data
    if (parsed.version !== VERSION) {
      throw new Error(`${file} is version ${parsed.version}, this build reads version ${VERSION}`)
    }
    return parsed
  }

  /** WRITE A WHOLE FILE OR NONE OF ONE. A plain `writeFileSync` onto the live path is a
   *  torn read waiting to happen: the engine holding the flock writes a thread when a frame
   *  lands, the engine serving the pane writes one when the owner clicks, and both re-read
   *  this file first. Temp-then-rename makes the swap atomic on both platforms, the temp
   *  name carries the pid so two processes never collide, and the mode rides on the temp
   *  file, which is what the rename preserves. */
  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    // RETRIED, because a rename over a live path is the one step Windows can refuse for a
    // reason that is gone a millisecond later: a process reading the file holds a handle
    // without FILE_SHARE_DELETE and the rename comes back EPERM/EBUSY. Three tries, then
    // the error is real.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, this.file)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES"
        if (!transient || attempt >= RENAME_TRIES - 1) {
          fs.rmSync(temp, { force: true })
          throw error
        }
      }
    }
  }

  /** Re-read from disk, then apply and persist. See the class comment for why. */
  private update(change: (data: Data) => Data): void {
    this.data = change(Store.read(this.file) ?? this.data)
    this.write()
  }

  /** Re-read `flock.json`, discarding this object's cached copy. EVERY WRITER OPENS ITS OWN
   *  STORE - `acp/flock.ts` and `cli/cmd/flock.ts` both call `Store.open` per request - so
   *  a revoke made from either lands in the FILE and not in the object a running
   *  `FlockService` holds. A read that fails leaves the cached copy alone: a half-written
   *  file must not empty a live friends list. */
  reload(): void {
    let fresh: Data | undefined
    try {
      fresh = Store.read(this.file)
    } catch {
      return
    }
    if (!fresh) return
    this.data = migrate(fresh) ?? fresh
  }

  identity(): FlockIdentity.Info {
    return this.data.identity
  }

  /**
   * Change what this owner is CALLED and which sigil they show as. The handle does not
   * move.
   *
   * The handle is `name@fingerprint`; every contact holds the string as it was when they
   * accepted the invite, and it is what their `find`, their pending questions and their
   * answer log are keyed on. So renaming rewrites the LABEL people read and leaves the
   * LABEL people match on alone. `migrate` is written to the same rule.
   * A blank name is ignored rather than stored: an Origami with no name renders an empty
   * row on every contact's address book, with no way back except another rename.
   */
  setIdentity(patch: { name?: string; icon?: string }): FlockIdentity.Info {
    const name = patch.name?.trim()
    this.update((data) => ({
      ...data,
      identity: {
        ...data.identity,
        ...(name ? { name } : {}),
        ...(patch.icon === undefined ? {} : { icon: FlockIdentity.normaliseIcon(patch.icon) }),
      },
    }))
    return this.data.identity
  }

  /**
   * Record what a contact now calls themselves, FROM A FRAME THAT VERIFIED.
   *
   * The caller passes the signing key the frame was checked against, not a handle: a name
   * is the one field on a row a stranger supplies, so the only safe key for it is the one
   * thing a stranger cannot forge. `peer.ts` calls this after `verifyPayload` /
   * `FlockCard.verify` has passed, and nowhere else.
   * The HANDLE is untouched, so a contact renaming themselves cannot silently become a
   * different row. Returns whether anything changed, so an unchanged name costs no write.
   */
  noteDeclared(signPublicKey: string, declared: { name?: unknown; icon?: unknown }): boolean {
    const target = this.findByKey(signPublicKey)
    if (!target) return false
    const trimmed = typeof declared.name === "string" ? declared.name.trim() : ""
    const name = trimmed || target.name
    const icon = FlockIdentity.normaliseIcon(declared.icon ?? target.icon)
    if (name === target.name && icon === FlockIdentity.normaliseIcon(target.icon)) return false
    this.update((data) => ({
      ...data,
      friends: data.friends.map((friend) =>
        friend.signPublicKey === signPublicKey ? { ...friend, name, icon } : friend,
      ),
    }))
    return true
  }

  friends(): readonly Friend[] {
    return this.data.friends
  }

  desk(): Desk {
    return this.data.desk ?? {}
  }

  /** Merge a patch into the desk block. A field set to `undefined` is left
   *  alone; clearing the specialties is an empty array, not an absent key. */
  setDesk(patch: Desk): void {
    this.update((data) => ({
      ...data,
      desk: {
        ...data.desk,
        ...(patch.specialties === undefined ? {} : { specialties: [...patch.specialties] }),
        ...(patch.autoAnswer === undefined ? {} : { autoAnswer: patch.autoAnswer }),
      },
    }))
  }

  /** Replace one friend's policy overrides. Throws when nobody holds that handle,
   *  so a stale row in a UI cannot silently write a policy nobody reads. */
  setPolicy(handle: string, overrides: FlockPolicy.Overrides): Friend {
    const target = this.find(handle)
    if (!target) throw new Error(`${handle} is not in this flock`)
    this.update((data) => ({
      ...data,
      friends: data.friends.map((friend) => (friend.handle === target.handle ? { ...friend, policy: overrides } : friend)),
    }))
    return this.find(target.handle)!
  }

  /** Set (or clear) the owner's own label for one friend.
   *  Separate from {@link setPolicy} because a policy write REPLACES the whole overrides
   *  block, and folding a rename into it would make renaming somebody a way to silently
   *  drop their budget. An empty or blank name CLEARS the label rather than storing "". */
  setDisplayName(handle: string, displayName: string | undefined): Friend {
    const target = this.find(handle)
    if (!target) throw new Error(`${handle} is not in this flock`)
    const trimmed = displayName?.trim()
    this.update((data) => ({
      ...data,
      friends: data.friends.map((friend) => {
        if (friend.handle !== target.handle) return friend
        const { displayName: _dropped, ...rest } = friend
        return trimmed ? { ...rest, displayName: trimmed } : rest
      }),
    }))
    return this.find(target.handle)!
  }

  answers(): readonly Answer[] {
    return this.data.answers ?? []
  }

  /** Append to the answer ring, newest LAST (the file reads chronologically). */
  logAnswer(entry: Answer): void {
    this.update((data) => ({ ...data, answers: [...(data.answers ?? []), entry].slice(-ANSWER_LOG_MAX) }))
  }

  /**
   * ONE CONTACT, BY WHATEVER THE CALLER CALLS THEM - or nothing.
   *
   * `undefined` for both "nobody" and "more than one" on purpose: there is no Friend to
   * return for an ambiguous name. A caller that has to TELL somebody which of the two it
   * was calls {@link resolve}.
   */
  find(handle: string): Friend | undefined {
    const found = this.resolve(handle)
    return found.kind === "one" ? found.friend : undefined
  }

  /**
   * WHO THE OWNER MEANT, and - when that cannot be answered - who they might have meant.
   * Everything a person can read off the pane has to be something they can type back, and
   * case is not a thing anybody re-types correctly from a sigil-sized label.
   *
   * FOUR TIERS, TRIED IN ORDER, and the first tier that matches ANYTHING is the answer - a
   * later tier never rescues an earlier one. That is what keeps an exact name from being
   * buried by a prefix: with `bob@...` and `bobby@...` in the flock, `bob` is Bob.
   *
   *  1. the FULL handle, the only identifier that is not a nickname;
   *  2. the owner's own display name for them, if they set one;
   *  3. the name the contact declares, refreshed by every frame that verifies;
   *  4. a PREFIX of the handle - `mac@9f3a` for `mac@9f3a1c2e...`.
   *
   * TWO MATCHES ARE NEVER A GUESS: picking one would put the owner's question, and their
   * contact's tokens, on whoever happened to sort first.
   */
  resolve(query: string): Resolution {
    const wanted = query.trim().toLowerCase()
    if (!wanted) return { kind: "none" }
    const friends = this.data.friends
    const tiers: Array<readonly Friend[]> = [
      friends.filter((friend) => friend.handle.toLowerCase() === wanted),
      friends.filter((friend) => (friend.displayName ?? "").trim().toLowerCase() === wanted),
      friends.filter((friend) => friend.name.trim().toLowerCase() === wanted),
      friends.filter((friend) => friend.handle.toLowerCase().startsWith(wanted)),
    ]
    for (const tier of tiers) {
      if (tier.length === 1) return { kind: "one", friend: tier[0]! }
      if (tier.length > 1) return { kind: "many", candidates: tier }
    }
    return { kind: "none" }
  }

  /** A friend by the key that signed something, which is the only identity that is not a nickname. */
  findByKey(signPublicKey: string): Friend | undefined {
    return this.data.friends.find((friend) => friend.signPublicKey === signPublicKey)
  }

  /** An invite string for this identity, and the token it carries. */
  invite(relay?: string): { invite: string; token: string } {
    const token = newToken()
    return {
      invite: encodeInvite({ identity: FlockIdentity.toPublic(this.data.identity), token, ...(relay ? { relay } : {}) }),
      token,
    }
  }

  /** The tokens already spent, with the expired ones dropped: an expired token can never
   *  be accepted anyway, so keeping it would grow the file to guard a shut door. */
  private static live(used: readonly UsedToken[] | undefined, now: number): UsedToken[] {
    return (used ?? []).filter((entry) => now - Date.parse(entry.usedAt) < TOKEN_TTL_MS)
  }

  /**
   * Store the friend an invite describes. THREE REFUSALS, each closing a different door.
   *
   * 1. AN EXPIRED INVITE. A token lives {@link TOKEN_TTL_MS}, so an invite left in a chat
   *    thread is not a standing key. One dated into the future beyond
   *    {@link TOKEN_FUTURE_SKEW_MS} is refused too, or a bad clock buys unbounded life.
   * 2. A TOKEN ALREADY SPENT. Single use, tracked separately from the friends list so that
   *    revoking somebody does NOT hand their old invite back its power.
   * 3. A HANDLE ALREADY HELD, even when the KEY differs: silently keeping both would make
   *    `find` pick one of two people by nickname.
   */
  accept(invite: string, policy?: FlockPolicy.Overrides, now = Date.now()): Friend {
    const decoded = decodeInvite(invite)
    if (decoded.identity.signPublicKey === this.data.identity.signPublicKey) {
      throw new InviteError("that is this Origami's own invite")
    }
    const age = now - decoded.issuedAt
    if (age > TOKEN_TTL_MS) throw new InviteError("it expired — invites last 48 hours; ask for a new one")
    if (age < -TOKEN_FUTURE_SKEW_MS) throw new InviteError("it is dated in the future — check the clocks on both machines")
    const friend: Friend = {
      handle: decoded.identity.handle,
      name: decoded.identity.name,
      icon: decoded.identity.icon,
      signPublicKey: decoded.identity.signPublicKey,
      boxPublicKey: decoded.identity.boxPublicKey,
      addedAt: new Date().toISOString(),
      token: decoded.token,
      ...(decoded.relay ? { relay: decoded.relay } : {}),
      ...(policy ? { policy } : {}),
    }
    this.update((data) => {
      const used = Store.live(data.used, now)
      if (used.some((entry) => entry.token === decoded.token)) {
        throw new InviteError("that invite has already been used — invites work once; ask for a new one")
      }
      if (data.friends.some((existing) => existing.handle === friend.handle)) {
        throw new InviteError(`${friend.handle} is already in this flock — revoke them first`)
      }
      return {
        ...data,
        friends: [...data.friends, friend],
        used: [...used, { token: decoded.token, usedAt: new Date(now).toISOString() }],
      }
    })
    return friend
  }

  /** Whether anyone was removed. A revoked friend's later envelopes are an unknown sender. */
  revoke(handle: string): boolean {
    const target = this.find(handle)
    if (!target) return false
    this.update((data) => ({ ...data, friends: data.friends.filter((friend) => friend.handle !== target.handle) }))
    return true
  }

  /** Add `tokens` to a friend's spend for `day` (UTC), resetting when the day rolled over. */
  charge(handle: string, tokens: number, day: string): void {
    this.update((data) => ({
      ...data,
      friends: data.friends.map((friend) =>
        friend.handle === handle
          ? {
              ...friend,
              usage: {
                day,
                tokens: (friend.usage?.day === day ? friend.usage.tokens : 0) + tokens,
              },
            }
          : friend,
      ),
    }))
  }

  /** What a friend has spent on `day`. Zero once the day has rolled over. */
  spent(handle: string, day: string): number {
    const friend = this.find(handle)
    if (!friend?.usage || friend.usage.day !== day) return 0
    return friend.usage.tokens
  }

  // --------------------------- sequence counters ---------------------------

  /** The persisted pair of counters for a friend. Zeroes for one never talked to. */
  seq(handle: string): { send: number; recv: number } {
    const friend = this.find(handle)
    return { send: friend?.sendSeq ?? 0, recv: friend?.lastRecvSeq ?? 0 }
  }

  /**
   * Reserve the next outbound sequence, on disk, BEFORE the frame goes out.
   *
   * Reserved rather than recorded: a number written after a send that then crashed would
   * be handed out twice, and a duplicate sequence is a frame the friend drops as a replay.
   * Burning a number on a send that never happened costs nothing - the check is `>`.
   */
  nextSendSeq(handle: string): number {
    const target = this.find(handle)
    if (!target) throw new Error(`${handle} is not in this flock`)
    let next = 0
    this.update((data) => ({
      ...data,
      friends: data.friends.map((friend) => {
        if (friend.handle !== target.handle) return friend
        next = (friend.sendSeq ?? 0) + 1
        return { ...friend, sendSeq: next }
      }),
    }))
    // The friend was revoked between the read above and the re-read inside
    // `update`. Nothing is sent to them, so nothing needs a number.
    if (next === 0) throw new Error(`${handle} is not in this flock`)
    return next
  }

  /** Record the highest sequence accepted from a friend. Never moves backwards. */
  noteRecvSeq(handle: string, seq: number): void {
    const target = this.find(handle)
    if (!target || (target.lastRecvSeq ?? 0) >= seq) return
    this.update((data) => ({
      ...data,
      friends: data.friends.map((friend) =>
        friend.handle === target.handle && (friend.lastRecvSeq ?? 0) < seq ? { ...friend, lastRecvSeq: seq } : friend,
      ),
    }))
  }

  // --------------------------------- mailbox ---------------------------------

  /** Every thread, oldest first, with overdue `sent` ones already retired. The expiry runs
   *  HERE rather than on a timer because the only moment that matters is the next read;
   *  the write is skipped when nothing moved, so an ordinary read costs none. */
  mailbox(now = Date.now()): readonly Thread[] {
    // FRESH FIRST. Several `Store` objects read this one file, so the rows this object last
    // wrote are not the rows on disk. See {@link Store.reload}.
    this.reload()
    const current = this.data.mailbox ?? []
    if (!current.some((thread) => Store.overdue(thread, now))) return current
    this.update((data) => ({
      ...data,
      mailbox: (data.mailbox ?? []).map((thread) =>
        Store.overdue(thread, now) ? { ...thread, state: "expired" as const } : thread,
      ),
    }))
    return this.data.mailbox ?? []
  }

  /** A question we sent that nobody can still be waiting on. See {@link PENDING_TTL_MS}. */
  private static overdue(thread: Thread, now: number): boolean {
    if (thread.direction !== "out" || thread.state !== "sent") return false
    return Date.parse(thread.question.sentAt) + PENDING_TTL_MS <= now
  }

  /** One thread, re-read from disk for the reason {@link Store.mailbox} gives: a frame
   *  filed by another engine's store is a row this object has never seen. */
  thread(id: string): Thread | undefined {
    this.reload()
    return (this.data.mailbox ?? []).find((entry) => entry.id === id)
  }

  /** File a thread, replacing any row already under that id. The cap drops CLOSED threads
   *  first, oldest first: a mailbox that hit its ceiling in a busy hour must not discard a
   *  question a contact is still waiting on. */
  private put(thread: Thread): void {
    this.update((data) => {
      const kept = (data.mailbox ?? []).filter((entry) => entry.id !== thread.id)
      const all = [...kept, thread]
      if (all.length <= MAILBOX_MAX) return { ...data, mailbox: all }
      let excess = all.length - MAILBOX_MAX
      const trimmed = all.filter((entry) => {
        if (excess === 0 || !isClosed(entry)) return true
        excess--
        return false
      })
      return { ...data, mailbox: excess === 0 ? trimmed : trimmed.slice(excess) }
    })
  }

  /** Apply a patch to one thread. Returns the new row, or undefined when the id is unknown. */
  patchThread(id: string, patch: Partial<Omit<Thread, "id" | "direction">>): Thread | undefined {
    const current = this.thread(id)
    if (!current) return undefined
    const next: Thread = { ...current, ...patch }
    this.put(next)
    return next
  }

  /** Record a question we have just sent. Called before the frame goes out. */
  openOut(
    entry: { id: string; contact: string; question: string; followUpOf?: string; origin?: ThreadOrigin },
    now = Date.now(),
  ): Thread {
    const thread: Thread = {
      id: entry.id,
      contact: entry.contact,
      direction: "out",
      question: { text: entry.question, sentAt: new Date(now).toISOString() },
      state: "sent",
      unread: false,
      ...(entry.followUpOf ? { followUpOf: entry.followUpOf } : {}),
      ...(entry.origin?.sessionID ? { origin: entry.origin } : {}),
    }
    this.put(thread)
    return thread
  }

  /** Record a question asked OF us, or return the row a resend already has. A resend under
   *  an id still being decided must not become a second row: the asking side re-sends for
   *  24 hours, and two rows would be two decisions for one question. */
  openIn(entry: { id: string; contact: string; question: string }, now = Date.now()): Thread {
    const existing = this.thread(entry.id)
    if (existing) return existing
    const thread: Thread = {
      id: entry.id,
      contact: entry.contact,
      direction: "in",
      question: { text: entry.question, sentAt: new Date(now).toISOString() },
      state: "pending",
      unread: true,
    }
    this.put(thread)
    return thread
  }

  /** A contact answered (or refused) one of OUR questions. `unread` is set for the same
   *  reason no session is touched: the owner decides where this goes, and a row nobody was
   *  told about never gets decided. */
  settleOut(id: string, reply: { ok: boolean; text: string; tokens: number; signatureOk: boolean; reason?: string }, now = Date.now()): Thread | undefined {
    const current = this.thread(id)
    if (!current || current.direction !== "out") return undefined
    return this.patchThread(id, {
      state: reply.ok ? "answered" : "declined",
      unread: true,
      question: { ...current.question, tokens: reply.tokens },
      reply: {
        text: reply.text,
        at: new Date(now).toISOString(),
        tokens: reply.tokens,
        signatureOk: reply.signatureOk,
        ...(reply.ok ? {} : { declined: reply.reason === undefined ? {} : { reason: reply.reason } }),
      },
    })
  }

  /**
   * Close an inbound thread with what we sent back. Creates the row when a refusal beat
   * the question to the mailbox (a policy refusal is decided before anything is filed).
   *
   * `unread` CARRIES OVER from a row that already exists: an answered question is read by
   * definition, but a question the desk refused on its own is one the owner never saw, and
   * `frontdesk.ts` files exactly one of those as unread. `peer.ts` settles the same thread
   * again a moment later, and that second write must not clear the badge.
   */
  settleIn(entry: { id: string; contact: string; question?: string; ok: boolean; text: string; tokens: number; reason?: string; at?: string; unread?: boolean }): Thread {
    const at = entry.at ?? new Date().toISOString()
    const current = this.thread(entry.id)
    const question = current?.question ?? { text: entry.question ?? "", sentAt: at }
    const thread: Thread = {
      id: entry.id,
      contact: entry.contact,
      direction: "in",
      question: { ...question, tokens: entry.tokens },
      state: entry.ok ? "answered" : "declined",
      unread: entry.unread ?? (current?.state === "declined" ? current.unread : false),
      ...(current?.guidance ? { guidance: current.guidance } : {}),
      reply: {
        text: entry.text,
        at,
        tokens: entry.tokens,
        signatureOk: true,
        ...(entry.ok ? {} : { declined: entry.reason === undefined ? {} : { reason: entry.reason } }),
      },
    }
    this.put(thread)
    return thread
  }

  /** Mark a row read. The badge counts unread rows, so this is what clears it. */
  markRead(id: string): Thread | undefined {
    return this.patchThread(id, { unread: false })
  }

  /** Record that the owner put this row into a session. Append-only, never automatic. */
  noteDelivered(id: string, sessionID: string): Thread | undefined {
    const current = this.thread(id)
    if (!current) return undefined
    const already = current.deliveredTo ?? []
    return this.patchThread(id, {
      deliveredTo: already.includes(sessionID) ? already : [...already, sessionID],
      unread: false,
      ...(current.direction === "out" && current.state === "answered" ? { state: "delivered" as const } : {}),
    })
  }

  // ------------------- views the wire still asks for by name -------------------

  /** Live questions we sent and have had no answer to, in the shape `peer.flushPending`
   *  re-sends. A VIEW over the mailbox, not a list of its own: two lists would be two
   *  truths about one question. */
  pending(handle?: string, now = Date.now()): readonly PendingOut[] {
    return this.mailbox(now)
      .filter((thread) => thread.direction === "out" && thread.state === "sent")
      .filter((thread) => !handle || thread.contact === handle)
      .map((thread) => ({
        id: thread.id,
        handle: thread.contact,
        question: thread.question.text,
        at: thread.question.sentAt,
        expiresAt: Date.parse(thread.question.sentAt) + PENDING_TTL_MS,
      }))
  }

  /** Every inbound question already dealt with, oldest first. The dedup ring, as a view. */
  answered(): readonly Answered[] {
    return (this.data.mailbox ?? [])
      .filter((thread) => thread.direction === "in" && thread.reply && isClosed(thread))
      .map((thread) => Store.asAnswered(thread))
  }

  /** The answer already sent for this question id, if one was. A thread still `pending` or
   *  `answering` deliberately returns nothing: the owner has not decided yet, so a resend
   *  must NOT be served an answer, and `peer.ts` files it against the existing row. */
  answeredFor(id: string): Answered | undefined {
    const thread = this.thread(id)
    if (!thread || thread.direction !== "in" || !thread.reply || !isClosed(thread)) return undefined
    return Store.asAnswered(thread)
  }

  private static asAnswered(thread: Thread): Answered {
    return {
      id: thread.id,
      from: thread.contact,
      ok: thread.state === "answered",
      text: thread.reply?.text ?? "",
      tokens: thread.reply?.tokens ?? 0,
      at: thread.reply?.at ?? thread.question.sentAt,
    }
  }
}

export * as FlockStore from "./store"

export * as ACPFlock from "./flock"

import { FlockCard } from "@/flock/card"
import { FlockConfigWrite } from "@/flock/config-write"
import { FlockDeliver } from "@/flock/deliver"
import { FlockDiagnose } from "@/flock/diagnose"
import { FlockFrontDesk } from "@/flock/frontdesk"
import { FlockIdentity } from "@/flock/identity"
import { FlockMailbox } from "@/flock/mailbox"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockPolicy } from "@/flock/policy"
import path from "node:path"
import { FlockScopeFolders } from "@/flock/scope-folders"
import { FlockService } from "@/flock/service"
import { FlockStore } from "@/flock/store"

/**
 * THE FLOCK PANE'S ACP SURFACE - the fork-owned ext methods, dispatched from
 * `acp/agent.ts` and proxied by `acp/service.ts`. The reads are `flock_mailbox`
 * (every thread) and `flock_pending` (the ones waiting on a decision, which the
 * sidebar badge reads); the writes are `flock_decide`, `flock_send`, `flock_mark`.
 *
 * SETTINGS LIVE IN TWO FILES, deliberately. `flock.json` (global config dir)
 * holds identity, contacts, their per-contact policy, the specialties and the
 * desk-wide auto-answer default. `origami.json` (global config dir) holds
 * `flock.frontDesk.{model, dailyBudgetTokens, scope}` - the three that spend
 * money or open files, in the file a person reviews. `config-write.ts` says why
 * neither is ever read from a project folder.
 *
 * `directory` is threaded through every function and defaulted so a test never
 * touches the owner's real config directory; production callers pass nothing.
 *
 * EVERY WRITE ENDS IN `FlockService.refresh()`: the running service builds its
 * relay routes once, out of the friends list as it stood when the engine booted,
 * so without the call a contact accepted from the pane has no route until a
 * restart. It is a no-op in a process with no published service.
 */

/** Every request shape lives HERE, not in `service.ts`: the panel-side module is
 *  the one that has to know them. */
export type DirRequest = { readonly directory?: string }
export type InviteRequest = DirRequest & { readonly relay?: string }
export type AcceptRequest = DirRequest & {
  readonly invite: string
  readonly autoAnswer?: boolean
  readonly dailyBudgetTokens?: number
}
export type HandleRequest = DirRequest & { readonly handle: string }
export type SetPolicyRequest = HandleRequest & {
  /** `null` REVOKES the override and puts this friend back on the desk default. */
  readonly autoAnswer?: boolean | null
  /** `null` clears the per-friend cap back to the desk default. */
  readonly dailyBudgetTokens?: number | null
  readonly model?: string | null
  readonly scope?: FlockPolicy.Scope | null
  /** The owner's own label for this friend. `null` clears it back to the name they
   *  declared. It is NOT a policy override: `store.setDisplayName` keeps it beside
   *  the friend, and nothing in `FlockPolicy.resolve` reads it. */
  readonly displayName?: string | null
}
export type FrontDeskRequest = DirRequest & {
  readonly model?: string | null
  readonly dailyBudgetTokens?: number | null
  readonly scope?: FlockPolicy.Scope | null
  readonly autoAnswer?: boolean
}
export type SpecialtiesRequest = DirRequest & { readonly specialties: readonly string[] }
/**
 * The owner's own display name and sigil, either or both. One form with one Save,
 * so one method: a pane that had to post twice could leave the name saved and the
 * icon not. Absent means "leave it as it is" - there is no `null`, because neither
 * field has an unset state to return to.
 */
export type SetIdentityRequest = DirRequest & { readonly name?: string; readonly icon?: string }

/**
 * THE OWNER'S DECISION ON ONE INBOUND QUESTION.
 *
 * Answer and Answer-with-guidance differ only by whether `guidance` is present -
 * one code path, not two. `reason` rides on Decline and is signed back, so the
 * asker reads why rather than a blank refusal.
 */
export type DecideRequest = DirRequest & {
  readonly thread: string
  readonly action: FlockMailbox.Action
  readonly guidance?: string
  readonly reason?: string
}

/** Send the draft on an `answering` thread. `text` is the owner's edit of it. */
export type SendRequest = DirRequest & { readonly thread: string; readonly text?: string }

/** The owner's own follow-up, from a reply row. `followUpOf` keeps the pair threaded. */
export type PostRequest = DirRequest & { readonly to: string; readonly question: string; readonly followUpOf?: string }

/**
 * PUT ONE ROW INTO ONE CHAT - the owner's "send to chat", and the only way a
 * flock message reaches a session by hand.
 *
 * `sessionID` is the ENGINE's session id, never the webview's own `session-3`:
 * `flock/deliver.ts` addresses a chat through the agent broker, and the broker
 * publishes what the ACP store holds. The engine writes the envelope, so a
 * delivered message is a delivered message whichever door opened it.
 */
export type DeliverRequest = DirRequest & { readonly thread: string; readonly sessionID: string }

/** A row-level mark. `read` clears the badge; `delivered` records that the owner put this reply
 *  into a session - never automatic, which is the rule the mailbox exists to keep. */
export type MarkRequest = DirRequest & {
  readonly thread: string
  readonly mark: "read" | "delivered"
  readonly sessionID?: string
}

export type Identity = {
  /** `name@fingerprint` IN FULL. What anything that matches must match on. */
  readonly handle: string
  /** `name@` + the first 8 characters. A LABEL for a narrow column, never a key. */
  readonly handleShort: string
  /** The display name, which the owner may change. The handle does not follow. */
  readonly name: string
  /** The sigil variant they show as. A short id, never an image. */
  readonly icon: string
  /** The whole sha256 of the signing key, base64url — 43 characters. */
  readonly fingerprint: string
  readonly signPublicKey: string
  readonly boxPublicKey: string
}

export type FriendRow = {
  readonly handle: string
  readonly handleShort: string
  /** What they call themselves NOW - from their invite, then refreshed by every frame of theirs
   *  that verifies. Never editable here. */
  readonly name: string
  readonly icon: string
  /** The owner's own label for them, when they set one. Absent = use `name`. */
  readonly displayName?: string
  readonly addedAt: string
  readonly relay?: string
  readonly policy: FlockPolicy.Overrides
  /** What this friend has already spent of the owner's tokens TODAY (UTC). */
  readonly spentToday: number
  /** The cap that spend is measured against — per-friend override, else the desk's. */
  readonly budget?: number
  /** The policy as it actually applies, desk defaults folded in. */
  readonly effective: { readonly model?: string; readonly autoAnswer: boolean }
}

export type State = {
  readonly identity: Identity
  readonly friends: readonly FriendRow[]
  readonly frontDesk: FlockConfigWrite.FrontDesk & { readonly autoAnswer: boolean }
  /** The config file `flock_front_desk` writes to, so the pane can name it. */
  readonly frontDeskPath: string
  readonly specialties: readonly string[]
  /** The one-line "what asking this Origami gets you" the card publishes. */
  readonly availability: string
  readonly answers: readonly FlockStore.Answer[]
  /**
   * What THIS engine's links are riding on. The only field here that is not a file
   * read: `relay` = this window's engine holds them, `other-engine` = another
   * window's does and this one is deliberately silent, `none` = idle.
   */
  readonly transport: FlockService.Kind
  /**
   * WHICH PROCESS HOLDS THE LINKS, when `flock-owner.json` names one - present
   * even when `transport` is `"relay"` (then it names this very process).
   *
   * `flock-owner.json` is machine-wide, so ANY engine can read it; this is a plain
   * file read, never a forward. A workspace runs one engine PER CHAT, so the
   * "other window" is often a SIBLING CHAT in the same window - the extension
   * compares this pid against its own sessions' engine pids (`pickFlockClient`) to
   * tell the two apart. Absent with no lease file, or with no `httpBase` to dial.
   */
  readonly holder?: { readonly pid: number; readonly httpBase: string }
}

/**
 * One mailbox row, with the two labels a pane cannot work out for itself.
 *
 * `name` and `icon` come from the CONTACT row, not from the thread: a thread holds
 * only the handle that signed the frame. A thread whose contact has since been
 * revoked keeps its handle and gets no name, which is the truth about it.
 */
export type MailRow = FlockStore.Thread & {
  readonly name: string
  readonly icon: string
  readonly handleShort: string
}

export type Mailbox = {
  readonly threads: readonly MailRow[]
  /** Inbound questions waiting on a decision. The sidebar badge's first half. */
  readonly waiting: number
  readonly unread: number
}

export type PendingQuestion = {
  readonly id: string
  readonly sessionID: string
  readonly from: string
  readonly name: string
  readonly question: string
}

export type WriteResult = { readonly ok: true; readonly message?: string } | { readonly ok: false; readonly message: string }

function open(directory?: string): FlockStore.Store {
  return FlockStore.Store.open(directory ? { directory } : undefined)
}

function deskConfig(store: FlockStore.Store, directory?: string): FlockPolicy.FrontDeskConfig {
  const config = FlockConfigWrite.read(directory)
  const autoAnswer = store.desk().autoAnswer
  return { ...config, ...(autoAnswer === undefined ? {} : { autoAnswer }) }
}

/**
 * The lease record, in the shape `flock_state` publishes it - or `undefined` when
 * there is none, or when it has no `httpBase` to route to.
 * `input.directory` doubles as the lease directory so a test can plant a lease
 * beside the store it already sandboxes; a live call carries none and falls back
 * to `FlockService.leaseDirectory()`.
 */
function holderInfo(input: DirRequest): State["holder"] {
  const lease = FlockOwnerLease.read(input.directory ?? FlockService.leaseDirectory())
  if (!lease?.httpBase) return undefined
  return { pid: lease.pid, httpBase: lease.httpBase }
}

/** The one read the pane renders a whole page from. */
export function state(input: DirRequest = {}): State {
  const store = open(input.directory)
  const identity = store.identity()
  const config = deskConfig(store, input.directory)
  const today = FlockPolicy.day()
  const ownPolicy = FlockPolicy.resolve({ config })
  const holder = holderInfo(input)
  return {
    identity: {
      handle: identity.handle,
      handleShort: FlockIdentity.short(identity.handle),
      name: identity.name,
      icon: FlockIdentity.normaliseIcon(identity.icon),
      fingerprint: identity.handle.slice(identity.handle.indexOf("@") + 1),
      signPublicKey: identity.signPublicKey,
      boxPublicKey: identity.boxPublicKey,
    },
    friends: store.friends().map((friend) => {
      const resolved = FlockPolicy.resolve({ config, ...(friend.policy ? { overrides: friend.policy } : {}) })
      return {
        handle: friend.handle,
        handleShort: FlockIdentity.short(friend.handle),
        name: friend.name,
        icon: FlockIdentity.normaliseIcon(friend.icon),
        ...(friend.displayName ? { displayName: friend.displayName } : {}),
        addedAt: friend.addedAt,
        ...(friend.relay ? { relay: friend.relay } : {}),
        policy: friend.policy ?? {},
        spentToday: store.spent(friend.handle, today),
        ...(resolved.dailyBudgetTokens === undefined ? {} : { budget: resolved.dailyBudgetTokens }),
        effective: {
          ...(resolved.model ? { model: resolved.model } : {}),
          autoAnswer: resolved.autoAnswer,
        },
      }
    }),
    frontDesk: { ...FlockConfigWrite.read(input.directory), autoAnswer: config.autoAnswer === true },
    frontDeskPath: FlockConfigWrite.file(input.directory),
    specialties: store.desk().specialties ?? [],
    availability: FlockCard.availability(ownPolicy),
    answers: store.answers(),
    transport: FlockService.kind(),
    ...(holder ? { holder } : {}),
  }
}

/**
 * ONE CALL THAT SAYS WHY THE FLOCK IS NOT WORKING. A thin re-export of
 * `flock/diagnose.ts` with the pane's `directory` seam: the shape belongs beside
 * the code that builds it, and the ACP layer's job is the seam.
 */
export function diagnose(input: DirRequest = {}): FlockDiagnose.Diagnosis {
  return FlockDiagnose.diagnose(input.directory ? { directory: input.directory } : {})
}

function failed(error: unknown): WriteResult {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

export function invite(input: InviteRequest = {}): WriteResult & { readonly invite?: string; readonly token?: string } {
  try {
    const made = open(input.directory).invite(input.relay)
    return { ok: true, invite: made.invite, token: made.token }
  } catch (error) {
    return failed(error)
  }
}

export function accept(input: AcceptRequest): WriteResult {
  const overrides: FlockPolicy.Overrides = {
    ...(input.autoAnswer === undefined ? {} : { autoAnswer: input.autoAnswer }),
    ...(input.dailyBudgetTokens === undefined ? {} : { dailyBudgetTokens: input.dailyBudgetTokens }),
  }
  try {
    const friend = open(input.directory).accept(input.invite, Object.keys(overrides).length ? overrides : undefined)
    FlockService.refresh()
    // Said out loud on the pane, as the CLI says it: an invite is one-way.
    return { ok: true, message: `Added ${friend.handle}. Send them your own invite so they can ask you too.` }
  } catch (error) {
    return failed(error)
  }
}

/**
 * Write the owner's display name, their icon, or both. The HANDLE IS NOT TOUCHED
 * - `store.setIdentity` says why - so the message back names what actually
 * happened. It is the one flock write that changes what every contact sees, and
 * it reaches them on the next frame either side sends.
 */
export function setIdentity(input: SetIdentityRequest): WriteResult {
  try {
    const identity = open(input.directory).setIdentity({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.icon === undefined ? {} : { icon: input.icon }),
    })
    return { ok: true, message: `You are ${identity.name}. Your handle is unchanged: ${identity.handle}` }
  } catch (error) {
    return failed(error)
  }
}

export function revoke(input: HandleRequest): WriteResult {
  try {
    if (!open(input.directory).revoke(input.handle)) return { ok: false, message: `${input.handle} is not in this flock` }
    FlockService.refresh()
    return { ok: true, message: `Revoked ${input.handle}` }
  } catch (error) {
    return failed(error)
  }
}

/**
 * A SCOPE ON ITS WAY TO DISK: skills dropped, folders checked, or a refusal.
 * The check happens HERE, on the write, and in BOTH writers - the desk default and
 * the per-contact override are two doors into one config, and a folder refused at
 * one and stored at the other is a rule that does not exist. `null` is not a
 * scope: it is the caller clearing one, and it passes straight through.
 */
function scopePatch(scope: FlockPolicy.Scope | null | undefined): { scope?: FlockPolicy.Scope | null; message?: string } {
  if (scope === undefined) return {}
  if (scope === null) return { scope: null }
  const clean = FlockPolicy.sanitiseScope(scope)
  // REPO ROOTS ARE RESOLVED TOO, and only resolved. They come from the Folds
  // registry rather than from a picker, so an absolute one sits where a folder
  // does and the gate has already realpathed the target. They are NOT put through
  // the refusals - refusing one here would break a share that worked yesterday.
  const repos = clean.repos?.map((repo) => (path.isAbsolute(repo) ? FlockScopeFolders.normalise(repo) : repo))
  const resolved = { ...clean, ...(repos ? { repos } : {}) }
  if (resolved.folders === undefined) return { scope: resolved }
  const checked = FlockScopeFolders.check(resolved.folders)
  if (!checked.ok) return { message: checked.message }
  return { scope: { ...resolved, folders: checked.folders } }
}

export function setPolicy(input: SetPolicyRequest): WriteResult {
  try {
    const scoped = scopePatch(input.scope)
    if (scoped.message) return { ok: false, message: scoped.message }
    const store = open(input.directory)
    const current = store.find(input.handle)
    if (!current) return { ok: false, message: `${input.handle} is not in this flock` }
    const next: Record<string, unknown> = { ...(current.policy ?? {}) }
    // `null` CLEARS an override back to the desk default; `undefined` means the
    // caller did not touch that switch. Two different intentions, kept apart.
    for (const key of ["dailyBudgetTokens", "model", "scope"] as const) {
      const value = key === "scope" ? scoped.scope : input[key]
      if (value === undefined) continue
      if (value === null) delete next[key]
      else next[key] = value
    }
    // `autoAnswer` clears the same way the other three do. Without a way back to
    // `null`, a friend switched off once could never return to the desk default.
    if (input.autoAnswer === null) delete next["autoAnswer"]
    else if (input.autoAnswer !== undefined) next["autoAnswer"] = input.autoAnswer
    store.setPolicy(input.handle, next as FlockPolicy.Overrides)
    // AFTER the policy write, and only when the caller sent one: the label is
    // stored beside the friend rather than inside the overrides block.
    if (input.displayName !== undefined) {
      store.setDisplayName(input.handle, input.displayName === null ? undefined : input.displayName)
    }
    FlockService.refresh()
    return { ok: true }
  } catch (error) {
    return failed(error)
  }
}

export function frontDesk(input: FrontDeskRequest): WriteResult & { readonly path?: string } {
  try {
    const scoped = scopePatch(input.scope)
    if (scoped.message) return { ok: false, message: scoped.message }
    const path = FlockConfigWrite.write(
      {
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.dailyBudgetTokens === undefined ? {} : { dailyBudgetTokens: input.dailyBudgetTokens }),
        ...(scoped.scope === undefined ? {} : { scope: scoped.scope }),
      },
      input.directory,
    )
    if (input.autoAnswer !== undefined) open(input.directory).setDesk({ autoAnswer: input.autoAnswer })
    FlockService.refresh()
    return { ok: true, path }
  } catch (error) {
    return failed(error)
  }
}

export function setSpecialties(input: SpecialtiesRequest): WriteResult {
  try {
    open(input.directory).setDesk({ specialties: input.specialties.map((s) => s.trim()).filter(Boolean) })
    return { ok: true }
  } catch (error) {
    return failed(error)
  }
}

/**
 * THE WHOLE MAILBOX, newest first, with the contact labels folded in. Newest first
 * because the pane reads top-down; the store keeps them chronologically.
 */
export function mailbox(input: DirRequest = {}): Mailbox {
  const store = open(input.directory)
  const contacts = new Map(store.friends().map((friend) => [friend.handle, friend]))
  const threads = [...store.mailbox()].reverse().map((thread) => {
    const contact = contacts.get(thread.contact)
    return {
      ...thread,
      name: contact ? (contact.displayName?.trim() || contact.name) : "",
      icon: FlockIdentity.normaliseIcon(contact?.icon),
      handleShort: FlockIdentity.short(thread.contact),
    }
  })
  return {
    threads,
    waiting: threads.filter((thread) => thread.direction === "in" && thread.state === "pending").length,
    unread: threads.filter((thread) => thread.unread).length,
  }
}

/**
 * The inbound questions waiting on a decision, in the shape the sidebar's badge
 * and its two buttons already read. A VIEW OVER THE MAILBOX, not over the
 * permission queue: `id` is the thread id, which is what `flock_decide` names.
 *
 * `sessionID` is empty - a question belongs to no session - but stays on the shape
 * because the field is part of the ACP method's published contract.
 */
export function pending(input: DirRequest = {}): { readonly questions: readonly PendingQuestion[] } {
  const rows = mailbox(input)
  return {
    questions: rows.threads
      .filter((thread) => thread.direction === "in" && thread.state === "pending")
      .map((thread) => ({
        id: thread.id,
        sessionID: "",
        from: thread.contact,
        name: thread.name,
        question: thread.question.text,
      })),
  }
}

/**
 * How a decision or a send reaches the flock, with the desk turn it may need.
 * `worktree` rides with the RUNNER rather than with the request because they are
 * one fact: the runner opens its child session in that directory and `tool/read.ts`
 * measures every path against it, so a different one would gate the wrong paths.
 */
function deps(input: DirRequest, desk: Desk): FlockMailbox.Deps {
  const store = open(input.directory)
  return {
    store,
    config: deskConfig(store, input.directory),
    runner: desk.runner,
    send: FlockMailbox.sender(),
    ...(desk.worktree ? { worktree: desk.worktree } : {}),
  }
}

/** The desk turn a decision may need, and the directory it runs in. */
export type Desk = { readonly runner: FlockFrontDesk.Runner; readonly worktree?: string }

function decided(result: FlockMailbox.Result): WriteResult {
  return result.ok ? { ok: true } : { ok: false, message: result.message }
}

/** Answer, Answer with guidance, or Decline. `flock/mailbox.ts` owns what each means. */
export async function decide(input: DecideRequest, desk: Desk): Promise<WriteResult> {
  try {
    return decided(
      await FlockMailbox.decide(deps(input, desk), {
        thread: input.thread,
        action: input.action,
        ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    )
  } catch (error) {
    return failed(error)
  }
}

/** Sign and send the draft, with the owner's edit when they made one. */
export async function send(input: SendRequest, desk: Desk): Promise<WriteResult> {
  try {
    return decided(
      await FlockMailbox.send(deps(input, desk), {
        thread: input.thread,
        ...(input.text === undefined ? {} : { text: input.text }),
      }),
    )
  } catch (error) {
    return failed(error)
  }
}

/** Ask a contact a follow-up. Sends and returns, exactly as `flock_ask` does. */
export async function post(input: PostRequest): Promise<WriteResult> {
  try {
    const sent = await FlockMailbox.post({
      to: input.to,
      question: input.question,
      ...(input.followUpOf ? { followUpOf: input.followUpOf } : {}),
    })
    return sent.thread ? { ok: true, message: `Sent to ${sent.contact}.` } : { ok: false, message: sent.error ?? "it was not sent" }
  } catch (error) {
    return failed(error)
  }
}

/**
 * Deliver one thread into one chat, as the engine's own injected turn.
 * `deliverTo` records `deliveredTo` itself on success, so there is no separate
 * `flock_mark` behind this: a row marked delivered by a POST that never landed is
 * a reply the owner would never look at again.
 */
export async function deliver(input: DeliverRequest): Promise<WriteResult> {
  try {
    const outcome = await FlockDeliver.deliverTo({
      store: open(input.directory),
      thread: input.thread,
      sessionID: input.sessionID,
    })
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.reason }
  } catch (error) {
    return failed(error)
  }
}

/**
 * Mark a row read, or record that the owner delivered it into a session. A pure
 * store write with no wire behind it, so it never needs the lease holder: the
 * mailbox file is shared, and the row belongs to the owner not to a conversation.
 */
export function mark(input: MarkRequest): WriteResult {
  try {
    const store = open(input.directory)
    if (input.mark === "delivered") {
      if (!input.sessionID) return { ok: false, message: "delivering a row needs the session it went to" }
      return store.noteDelivered(input.thread, input.sessionID)
        ? { ok: true }
        : { ok: false, message: `thread ${input.thread} is not in this mailbox` }
    }
    return store.markRead(input.thread) ? { ok: true } : { ok: false, message: `thread ${input.thread} is not in this mailbox` }
  } catch (error) {
    return failed(error)
  }
}

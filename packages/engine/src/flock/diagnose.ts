import { FlockConfigWrite } from "./config-write"
import { FlockIdentity } from "./identity"
import { FlockOwnerHttp } from "./owner-http"
import { FlockOwnerLease } from "./owner-lease"
import { FlockPolicy } from "./policy"
import { FlockService } from "./service"
import { FlockStore } from "./store"

/**
 * "WHY DOES IT NOT WORK", ANSWERED IN ONE CALL. Every fact needed to explain a
 * silent flock was spread across five surfaces, and on the machine this feature
 * is for THREE engines run — the one you are talking to is usually not the one
 * holding the flock, which makes "try it and see" actively misleading.
 *
 * ONE OBJECT, NO SIDE EFFECTS, NO WIRE: a read of the file, the lease and this
 * engine's own state, deliberately safe to call from a CLI, the pane or a model.
 *
 * IT NEVER MINTS AN IDENTITY. `Store.open()` writes a fresh keypair when there is
 * no file, and a diagnostic that created the thing it was asked about would be
 * the worst possible bug. No file, no read — {@link Diagnosis.present} says so.
 */

export interface ContactLine {
  readonly handle: string
  /** `name@` plus eight characters. A LABEL for a narrow column, never a key. */
  readonly handleShort: string
  /** What they call themselves. */
  readonly name: string
  /** The owner's own label for them, when they set one. */
  readonly displayName?: string
  /** Which relay this friendship's frames go over. READ OFF THE LIVE ROUTE when
   *  this engine holds one, and only worked out from the config when it does not:
   *  an engine started before the owner changed `flock.relayUrl` is still dialling
   *  the old host, and this line says where the frames ACTUALLY go. */
  readonly relay: string
  /** The socket, as this engine sees it. `unrouted` is its own answer and is the
   *  common one: it means THIS engine is not the lease holder, so it holds no
   *  socket for anybody — not that the contact is unreachable. */
  readonly route: "unrouted" | "idle" | "connecting" | "open" | "waiting" | "stopped"
  /** Whether this contact can be answered: a per-contact model, else the desk's. */
  readonly canAnswer: boolean
}

export interface LeaseLine {
  /** Where `flock-owner.json` is, so a person can look at it. */
  readonly file: string
  readonly pid?: number
  /** Whether that pid is a live process. False with a pid set = a stale record. */
  readonly alive: boolean
  /** The holder's loopback base, when it published one. */
  readonly httpBase?: string
  /** Whether the lease names THIS process. */
  readonly isHolder: boolean
}

export interface Diagnosis {
  /** False when there is no `flock.json` at all. Everything below is then empty. */
  readonly present: boolean
  readonly file: string
  readonly identity?: { readonly handle: string; readonly handleShort: string; readonly name: string; readonly icon: string }
  readonly contacts: readonly ContactLine[]
  readonly lease: LeaseLine
  /** What this engine's links ride on, and why they are idle when they are. */
  readonly transport: { readonly kind: FlockService.Kind; readonly reason?: string }
  readonly frontDesk: {
    /** THE ONE THAT SURPRISES PEOPLE. Asking works without it; answering does not. */
    readonly modelSet: boolean
    readonly model?: string
    readonly autoAnswer: boolean
    /** The config file the model is written in, so the fix is a path. */
    readonly path: string
  }
  readonly mailbox: { readonly threads: number; readonly waiting: number; readonly unread: number }
  /** The engine's last few lifecycle lines, newest last. */
  readonly log: readonly string[]
}

/** `process.kill(pid, 0)` — the portable "does this pid exist". EPERM means it
 *  exists and belongs to somebody else, which still counts as alive. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function leaseLine(directory: string | undefined): LeaseLine {
  const record = FlockOwnerLease.read(directory)
  if (!record) return { file: FlockOwnerLease.file(directory), alive: false, isHolder: false }
  return {
    file: FlockOwnerLease.file(directory),
    pid: record.pid,
    alive: running(record.pid),
    ...(FlockOwnerHttp.reachable(record.httpBase) ? { httpBase: record.httpBase } : {}),
    isHolder: record.pid === process.pid,
  }
}

/** Everything an owner (or a model, or the FLO pane) needs to explain a flock
 *  that is not doing what they expect. `directory` is threaded for the reason
 *  every other flock read threads it: a test must never touch the owner's real
 *  config directory. Production callers pass nothing. */
export function diagnose(input: { directory?: string; leaseDirectory?: string } = {}): Diagnosis {
  const file = FlockStore.file(input.directory)
  const lease = leaseLine(input.leaseDirectory ?? FlockService.leaseDirectory())
  const transport = { kind: FlockService.kind(), ...(FlockService.reason() ? { reason: FlockService.reason()! } : {}) }
  const config = FlockConfigWrite.read(input.directory)
  const frontDeskPath = FlockConfigWrite.file(input.directory)
  const log = FlockService.recentLog()

  if (!FlockStore.exists(input.directory)) {
    return {
      present: false,
      file,
      contacts: [],
      lease,
      transport,
      frontDesk: {
        modelSet: Boolean(config.model),
        ...(config.model ? { model: config.model } : {}),
        autoAnswer: false,
        path: frontDeskPath,
      },
      mailbox: { threads: 0, waiting: 0, unread: 0 },
      log,
    }
  }

  const store = FlockStore.Store.open(input.directory ? { directory: input.directory } : undefined)
  const identity = store.identity()
  const deskAuto = store.desk().autoAnswer
  const desk: FlockPolicy.FrontDeskConfig = { ...config, ...(deskAuto === undefined ? {} : { autoAnswer: deskAuto }) }
  const relayFallback = FlockConfigWrite.relayUrl()
  const routed = FlockService.links()
  const threads = store.mailbox()

  return {
    present: true,
    file,
    identity: {
      handle: identity.handle,
      handleShort: FlockIdentity.short(identity.handle),
      name: identity.name,
      icon: FlockIdentity.normaliseIcon(identity.icon),
    },
    contacts: store.friends().map((friend) => {
      const resolved = FlockPolicy.resolve({ config: desk, ...(friend.policy ? { overrides: friend.policy } : {}) })
      return {
        handle: friend.handle,
        handleShort: FlockIdentity.short(friend.handle),
        name: friend.name,
        ...(friend.displayName ? { displayName: friend.displayName } : {}),
        relay: routed.get(friend.handle)?.relayUrl ?? FlockService.relayFor(friend, relayFallback),
        route: routed.get(friend.handle)?.status ?? ("unrouted" as const),
        canAnswer: Boolean(resolved.model),
      }
    }),
    lease,
    transport,
    frontDesk: {
      modelSet: FlockService.hasFrontDeskModel(store, desk),
      ...(config.model ? { model: config.model } : {}),
      autoAnswer: desk.autoAnswer === true,
      path: frontDeskPath,
    },
    mailbox: {
      threads: threads.length,
      waiting: threads.filter((thread) => thread.direction === "in" && thread.state === "pending").length,
      unread: threads.filter((thread) => thread.unread).length,
    },
    log,
  }
}

/** The same object as lines a person reads in a terminal. Here rather than in
 *  `cli/cmd/flock.ts` so the CLI and any other caller print the SAME diagnosis —
 *  the one thing worse than no diagnostic is two that disagree. */
export function render(found: Diagnosis): string[] {
  if (!found.present) {
    return [
      `No flock on this box: ${found.file} does not exist.`,
      "Accept an invite (`origami flock accept <invite>`) and one is created.",
    ]
  }
  const lines = [
    `You are ${found.identity!.name} (${found.identity!.handle})`,
    `Links: ${found.transport.kind}${found.transport.reason ? ` — ${found.transport.reason}` : ""}`,
    found.lease.pid === undefined
      ? `Lease: nobody holds it (${found.lease.file})`
      : `Lease: pid ${found.lease.pid}${found.lease.isHolder ? " (this engine)" : ""}, ${
          found.lease.alive ? "alive" : "GONE — a stale record"
        }${found.lease.httpBase ? `, forwards to ${found.lease.httpBase}` : ", published no address"}`,
    found.frontDesk.modelSet
      ? `Front desk: ${found.frontDesk.model ?? "a per-contact model"}, auto-answer ${found.frontDesk.autoAnswer ? "on" : "off"}`
      : `Front desk: NO MODEL SET (${found.frontDesk.path}). You can ask; every question sent to you is refused.`,
    `Mailbox: ${found.mailbox.threads} threads, ${found.mailbox.waiting} waiting on you, ${found.mailbox.unread} unread`,
  ]
  lines.push(found.contacts.length ? `Contacts (${found.contacts.length}):` : "Contacts: none yet.")
  for (const contact of found.contacts) {
    const label = contact.displayName ? `${contact.displayName} (${contact.name})` : contact.name
    lines.push(
      `  ${label} ${contact.handleShort} — route ${contact.route}, relay ${contact.relay}, ${
        contact.canAnswer ? "answerable" : "no model, would refuse"
      }`,
    )
  }
  if (found.log.length) {
    lines.push("Last lines:")
    for (const line of found.log) lines.push(`  ${line}`)
  }
  return lines
}

export * as FlockDiagnose from "./diagnose"

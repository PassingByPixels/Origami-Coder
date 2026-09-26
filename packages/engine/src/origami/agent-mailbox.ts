import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { AgentBroker } from "./agent-broker"

/**
 * THE MAILBOX OF A PARKED CHAT (t-w2txb2).
 *
 * A sender that finds only a stand-in for a session (agent-broker.ts, "parked
 * chats") keeps the exact `prompt_async` body it would have POSTed as one file
 * in `<agentsDir>/mailbox/<sessionId>/<epochms>-<id>.json`. The extension
 * watches that folder and starts the chat's engine again; the engine's ACP
 * `resumeSession` / `loadSession` then calls `restore`, which admits each body
 * through the engine's own prompt_async route and deletes each file only after
 * it was admitted. A body that fails to admit stays for the next load.
 *
 * Plain `node:fs`, like the broker: every caller is a Promise, not an Effect.
 */

/** How long after a restore the mailbox is read a second time. A sender that
 *  read the stand-in just before restore deleted it can deposit after the first
 *  drain; this pass takes that message instead of leaving it for the next load. */
export const LATE_DRAIN_MS = 5_000

export function mailboxDir(sessionId: string, root = AgentBroker.agentsDir()): string {
  return path.join(root, AgentBroker.MAILBOX_DIR, sessionId)
}

/** Keep one body for a parked session. Returns the file written. */
export async function deposit(sessionId: string, body: string, messageId?: string): Promise<string> {
  if (!AgentBroker.safeSessionId(sessionId)) throw new Error(`unsafe session id: ${sessionId}`)
  const id = messageId && /^[A-Za-z0-9_-]{1,64}$/.test(messageId) ? messageId : randomBytes(8).toString("hex")
  const dir = mailboxDir(sessionId)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}-${id}.json`)
  // tmp + rename: the drain must never read a half-written body. The tmp name
  // does not end in `.json`, so a drain skips it.
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, body, "utf8")
  await fs.rename(tmp, file)
  return file
}

/**
 * origami_change (t-wdybz9): keep a body for a parked chat, then look again.
 * The chat can be closed (its stand-in removed) between the sender's lookup
 * and the write; nothing would ever read the body then, and the sender would
 * be told "delivered". `stillThere` is asked after the write: when it says no,
 * the body is taken back and the answer is "withdrawn". When the file is
 * already gone, a reader took it, so it counts as kept.
 */
export async function keep(
  sessionId: string,
  body: string,
  messageId: string | undefined,
  stillThere: () => Promise<boolean>,
): Promise<"kept" | "withdrawn"> {
  const file = await deposit(sessionId, body, messageId)
  if (await stillThere().catch(() => true)) return "kept"
  // Take it back only if no reader has claimed it (a reader admits it now).
  if (!(await claim(file))) return "kept"
  const took = await fs.rm(file).then(
    () => true,
    () => false,
  )
  await unclaim(file)
  return took ? "withdrawn" : "kept"
}

export type Admit = (body: Record<string, unknown>) => Promise<void>
export type Drained = { readonly admitted: number; readonly failed: number }

/**
 * origami_change (t-wdybz9): a reader CLAIMS a body before it admits it, by
 * creating `<body>.claim` exclusively (CREATE_NEW; one winner, also across
 * processes). A rename is not enough: Bun on Windows lets two renames of the
 * same file both succeed. The body is deleted before its claim, so a claim
 * without a body means "already admitted", and a body whose delete failed keeps
 * its claim: no later reader (a late drain, an unpark, the next restore in a
 * new process) admits it again. `sweep` removes both later.
 */
export const CLAIM = ".claim"

async function claim(file: string): Promise<boolean> {
  return fs.writeFile(file + CLAIM, String(process.pid), { flag: "wx" }).then(
    () => true,
    () => false,
  )
}

async function unclaim(file: string): Promise<void> {
  await fs.rm(file + CLAIM, { force: true }).catch(() => {})
}

/** Admit every kept body for `sessionId`, oldest first. Each body is claimed
 *  before it is admitted (see CLAIM): two readers at once admit it once. A
 *  body that fails to admit is released and stays for the next reader. */
export async function drain(sessionId: string, admit: Admit, root = AgentBroker.agentsDir()): Promise<Drained> {
  if (!AgentBroker.safeSessionId(sessionId)) return { admitted: 0, failed: 0 }
  const dir = mailboxDir(sessionId, root)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  let admitted = 0
  let failed = 0
  // File names start with the deposit time in ms, so a numeric sort is the
  // order the messages were sent in.
  const ordered = names
    .filter((name) => name.endsWith(".json"))
    .toSorted((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b))
  for (const name of ordered) {
    const file = path.join(dir, name)
    // Another reader has it, or had it and could not delete it.
    if (!(await claim(file))) continue
    const release = () => unclaim(file)
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) {
      // Admitted and deleted by another reader since our directory read.
      await release()
      continue
    }
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
      body = parsed as Record<string, unknown>
    } catch (error) {
      // A torn or hand-edited file can never be admitted. It stays for a human
      // to see, and is logged, rather than blocking the ones behind it.
      failed++
      console.error(`[peer] mailbox ${sessionId}: ${name} is not a prompt body (${String(error)})`)
      await release()
      continue
    }
    try {
      await admit(body)
    } catch (error) {
      failed++
      console.error(`[peer] mailbox ${sessionId}: ${name} was not admitted, kept for the next load (${String(error)})`)
      await release()
      continue
    }
    admitted++
    const deleted = await fs.rm(file, { force: true }).then(
      () => true,
      (error) => {
        // Its claim stays, so no reader admits it again; `sweep` removes both.
        console.error(`[peer] mailbox ${sessionId}: ${name} admitted but not deleted (${String(error)})`)
        return false
      },
    )
    if (deleted) await release()
  }
  if (admitted || failed) console.error(`[peer] mailbox ${sessionId}: admitted=${admitted} kept=${failed}`)
  return { admitted, failed }
}

// ------------------------------------------------------------------ disposal ---

/**
 * origami_change (t-wdybz9): how long a kept body waits for a chat that NO
 * parked stand-in and NO live engine answers for. That is a chat closed while
 * it was parked, or one whose window went away: a window that opens again
 * loads its chats (`session/load` drains the mailbox), so the wait is long.
 * After it, `sweep` deletes the body. The sender was told "delivered" at the
 * time; nothing can tell it otherwise now.
 */
export const MAIL_TTL_MS = 7 * 24 * 60 * 60_000
/** A claim older than this belongs to a reader that died mid-admit, or to a
 *  body admitted but not deleted. The claim and its body are deleted, never
 *  admitted again: at most once, never twice. */
export const CLAIM_STALE_MS = 10 * 60_000
/** A deposit tmp file this old is the remains of a writer that died. */
const TMP_STALE_MS = 60 * 60_000

/** Delete kept mail no chat will read (see MAIL_TTL_MS), stale claims and
 *  stale tmp files. Run at engine start (cli/cmd/acp.ts). Never rejects. */
export async function sweep(options?: { now?: number; ttlMs?: number }): Promise<{ removed: number }> {
  const now = options?.now ?? Date.now()
  const ttl = options?.ttlMs ?? MAIL_TTL_MS
  const root = path.join(AgentBroker.agentsDir(), AgentBroker.MAILBOX_DIR)
  let removed = 0
  try {
    const ids = (await fs.readdir(root).catch(() => [] as string[])).filter((id) => AgentBroker.safeSessionId(id))
    if (ids.length === 0) return { removed }
    const parked = new Set((await AgentBroker.readParked()).map((standIn) => standIn.sessionId))
    const peers = await AgentBroker.readPeers({ includeBackground: true })
    const held = new Set([...peers.flatMap((entry) => entry.sessionIds), ...(AgentBroker.self()?.sessionIds ?? [])])
    const age = (file: string) =>
      fs.stat(file).then(
        (stat) => now - stat.mtimeMs,
        () => 0,
      )
    const drop = async (file: string, why: string) => {
      const gone = await fs.rm(file, { force: true }).then(
        () => true,
        () => false,
      )
      if (gone) console.error(`[peer] mailbox: ${path.basename(file)} removed (${why})`)
      return gone
    }
    for (const id of ids) {
      const dir = path.join(root, id)
      const reader = parked.has(id) || held.has(id)
      const names = await fs.readdir(dir).catch(() => [] as string[])
      for (const name of names) {
        const file = path.join(dir, name)
        if (name.endsWith(CLAIM)) {
          if ((await age(file)) <= CLAIM_STALE_MS) continue
          const body = file.slice(0, -CLAIM.length)
          if (await drop(body, "claimed by a reader that did not finish")) removed++
          await drop(file, "stale claim")
        } else if (name.endsWith(".json")) {
          if (names.includes(name + CLAIM)) continue // its claim decides
          if (!reader && now - Number.parseInt(name, 10) > ttl && (await drop(file, "no chat will read it"))) removed++
        } else if ((await age(file)) > TMP_STALE_MS) await drop(file, "left by a writer that died")
      }
      // Only an empty folder goes; rmdir refuses one that is not.
      await fs.rmdir(dir).catch(() => {})
    }
  } catch (error) {
    console.error(`[peer] mailbox sweep failed (${String(error)})`)
  }
  return { removed }
}

// ------------------------------------------------------------------ admitter ---

/** origami_change (t-wdybz9): how this engine admits a kept body for one of its
 *  own sessions (acp/service.ts: its own prompt_async route, with the session's
 *  directory). `_elastic_unpark` drains through it. */
let admitter: ((sessionId: string) => Admit | undefined) | undefined

export function attachAdmitter(next: ((sessionId: string) => Admit | undefined) | undefined): void {
  admitter = next
}

export function admitterFor(sessionId: string): Admit | undefined {
  return admitter?.(sessionId)
}

/**
 * The restore step for a session whose engine has just loaded it. Call it
 * AFTER the session is registered in the ACP store: the live heartbeat is
 * flushed first, so there is no moment where neither the live entry nor the
 * stand-in answers for the chat. Then the stand-in goes, then the mailbox is
 * drained, and a second, late drain is scheduled. Never rejects.
 */
export async function restore(sessionId: string, admit: Admit, options?: { lateMs?: number }): Promise<Drained> {
  const root = AgentBroker.agentsDir()
  try {
    await AgentBroker.settled()
    await AgentBroker.removeParked(sessionId)
    const first = await drain(sessionId, admit, root)
    const lateMs = options?.lateMs ?? LATE_DRAIN_MS
    if (lateMs > 0) {
      const timer = setTimeout(() => void drain(sessionId, admit, root).catch(() => {}), lateMs)
      timer.unref?.()
    }
    return first
  } catch (error) {
    console.error(`[peer] mailbox ${sessionId}: restore failed (${String(error)})`)
    return { admitted: 0, failed: 0 }
  }
}

export * as AgentMailbox from "./agent-mailbox"

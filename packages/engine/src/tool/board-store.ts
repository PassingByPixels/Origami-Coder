import path from "path"
import { Effect, Semaphore } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { pathKey } from "@/util/path-key"

/**
 * Folds board store: one markdown file per ticket at
 * `<repoRoot>/.origami/tickets/<id>.md`, with the repo registry at
 * `~/.origami/repos.json`. Humans edit both by hand and the extension renders
 * them, so two rules drive the whole module.
 *
 *  1. A WRITE IS A TARGETED LINE EDIT. Frontmatter is re-emitted line by line
 *     with only the changed key replaced; rebuilding it from a fixed field
 *     list would silently delete every key this module does not know about.
 *  2. A FILE THAT WILL NOT PARSE IS SURFACED, NEVER DROPPED. `readTicket`
 *     returns a ticket carrying `malformed` rather than failing.
 */

/** Registry of repos the board knows about. Shared: the extension writes it,
 *  and so does `board_register` — through `writeRepos`, never wholesale. */
export const REPOS_FILE = "repos.json"

/** Ticket directory inside a repo's `.origami` — MAIN repo root, not a worktree. */
export const TICKETS_DIR = "tickets"

/** Stored ticket status. `blocked` is DERIVED by the board and never stored. */
export const TICKET_STATUSES = ["triage", "todo", "pending", "in_progress", "done", "merged", "closed"] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

/** The statuses an agent may set. The rest are stamped by the fold lifecycle. */
export const AGENT_STATUSES = ["triage", "todo", "closed"] as const

export const PRIORITIES = ["low", "normal", "high"] as const

/** `~/.origami/repos.json`. A getter, so it honours ORIGAMI_TEST_HOME. */
export function reposPath(): string {
  return path.join(Global.Path.origami, REPOS_FILE)
}

export function ticketsDir(root: string): string {
  return path.join(root, ".origami", TICKETS_DIR)
}

export function ticketPath(root: string, id: string): string {
  return path.join(ticketsDir(root), `${id}.md`)
}

export type RepoEntry = {
  readonly root: string
  readonly name: string
  readonly workspace: boolean
  readonly addedAt: number
  /** Board-only display label, never used to resolve a `repo` param — both
   *  sides key by `name` alone, so a rename cannot move where a tool writes. */
  readonly displayName?: string
  /** Absolute path of the checkout that OWNS this repo's tickets, and that
   *  folds branch from and apply into. A repo can have many worktrees; exactly
   *  one holds `.origami/tickets/`. Absent means the registered `root` is it. */
  readonly primary?: string
}

/** Repo identity and the write mutex both key on the shared path rule, so
 *  `C:\Repos\X\` and `c:/repos/x` are one repo and take one lock (t-v47qh6:
 *  the rule moved to util/path-key.ts so the artifact store uses the same one). */
export { pathKey }

/** Parse `repos.json`. Anything unreadable — absent, broken JSON, wrong shape —
 *  reads as NO repos rather than an error, so a tool does not die because the
 *  user has never opened the board. */
export function parseRepos(text: string | undefined): RepoEntry[] {
  if (!text?.trim()) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof data !== "object" || data === null || !("repos" in data)) return []
  const list = data.repos
  if (!Array.isArray(list)) return []
  const out: RepoEntry[] = []
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue
    const root = "root" in item && typeof item.root === "string" ? item.root.trim() : ""
    if (!root) continue
    const name = "name" in item && typeof item.name === "string" ? item.name.trim() : ""
    const addedAt = "addedAt" in item && typeof item.addedAt === "number" ? item.addedAt : 0
    const displayName = "displayName" in item && typeof item.displayName === "string" ? item.displayName.trim() : ""
    const primary = "primary" in item && typeof item.primary === "string" ? item.primary.trim() : ""
    out.push({
      root,
      name: name || path.basename(root),
      workspace: "workspace" in item && item.workspace === true,
      addedAt,
      ...(displayName ? { displayName } : {}),
      ...(primary ? { primary } : {}),
    })
  }
  return out
}

/** The checkout that owns a repo's tickets: `primary` when the entry names one,
 *  the registered root otherwise. Every ticket path resolved BY NAME goes
 *  through here, or one board reads differently from each worktree. */
export function primaryRoot(entry: Pick<RepoEntry, "root" | "primary">): string {
  return entry.primary?.trim() || entry.root
}

export function readRepos(fs: FSUtil.Interface) {
  return Effect.gen(function* () {
    const text = yield* fs.readFileStringSafe(reposPath()).pipe(Effect.catch(() => Effect.succeed(undefined)))
    return parseRepos(text)
  })
}

/** Raised by `writeRepos` when `repos.json` exists but a read of it failed for
 *  a reason other than "does not exist yet". Never caught silently — a caller
 *  that swallowed this would be back to the bug it fixes. */
export class RegistryReadFailedError extends Error {
  constructor(file: string) {
    super(`Refused to write ${file}: it exists but could not be read (a race, EBUSY/EPERM, or similar). Left untouched.`)
    this.name = "RegistryReadFailedError"
  }
}

/** The text a merge may start from. `readFileStringSafe` reads "not found" and
 *  "permission denied" alike as `undefined` -- correct for a display read
 *  (`readRepos`, above), wrong for a write: if `existed` is true and `text` is
 *  still `undefined`, something failed to read a file that is actually there,
 *  and merging from `undefined` would build a fresh `{ repos: [...patch] }`
 *  and overwrite every other entry in it. Only a file that never existed is
 *  safe to start clean from. */
export function registryTextForWrite(file: string, existed: boolean, text: string | undefined) {
  if (existed && text === undefined) return Effect.fail(new RegistryReadFailedError(file))
  return Effect.succeed(text)
}

/** One registry change: the `root` that identifies the entry, plus the fields
 *  to set. Anything the patch does not name keeps the value it had. */
export type RepoPatch = { readonly root: string } & Partial<Omit<RepoEntry, "root">>

/**
 * Merge patches into the TEXT of repos.json and return the new text.
 *
 * The merge works on the RAW parsed JSON, never on the projected `RepoEntry`
 * list: the registry is shared with the extension and each side carries keys
 * the other has never heard of, so projecting and re-emitting would silently
 * delete every unknown field. Same rule as `fmSet` on the ticket side. A
 * readable object whose `repos` is unusable still keeps every other key.
 */
export function mergeReposText(text: string | undefined, patches: readonly RepoPatch[]): string {
  let parsed: unknown
  try {
    parsed = text?.trim() ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  const doc: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {}
  const list = Array.isArray(doc.repos) ? [...doc.repos] : []

  for (const patch of patches) {
    const { root, ...fields } = patch
    // Drop undefined so a patch that simply omits a field cannot write a null
    // over the value already on disk.
    const set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
    const at = list.findIndex((item) => {
      if (typeof item !== "object" || item === null) return false
      const other = (item as { root?: unknown }).root
      return typeof other === "string" && pathKey(other) === pathKey(root)
    })
    if (at === -1) list.push({ root, ...set })
    else list[at] = { ...(list[at] as Record<string, unknown>), ...set }
  }

  // The extension's reader gates on `version`: without it the file reads as "no
  // prior file" there, and every addedAt is re-dated on the next rewrite. Stamp
  // it when missing, never overwrite one already there.
  if (typeof doc.version !== "number") doc.version = 1
  doc.repos = list
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** Merge patches into `~/.origami/repos.json`. The engine's only write path to
 *  the registry: atomic (tmp + rename, as the extension does, so a reader
 *  mid-write never sees half a file) and serialised on the registry's own lock,
 *  or two tools registering two repos at once would lose one entry. */
export function writeRepos(fs: FSUtil.Interface, patches: readonly RepoPatch[]) {
  const file = reposPath()
  return repoLock(file).withPermits(1)(
    Effect.gen(function* () {
      const existed = yield* fs.existsSafe(file)
      const read = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const text = yield* registryTextForWrite(file, existed, read)
      const next = mergeReposText(text, patches)
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(temp, next).pipe(
        Effect.andThen(fs.rename(temp, file)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(temp, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      return parseRepos(next)
    }),
  )
}

/** Resolve the tools' `repo` parameter: by name first, then by absolute root. A
 *  literal "." is the session's own worktree. Everything else must be
 *  REGISTERED — an unregistered absolute path would let an agent scatter ticket
 *  files into any directory it can name. */
export function resolveRepo(repos: readonly RepoEntry[], param: string | undefined, worktree: string) {
  const raw = (param ?? "").trim()
  if (!raw || raw === ".") {
    const hit = repos.find((repo) => pathKey(repo.root) === pathKey(worktree))
    return hit ?? { root: worktree, name: path.basename(worktree), workspace: false, addedAt: 0 }
  }
  const exact = repos.find((repo) => repo.name === raw)
  if (exact) return exact
  const folded = repos.find((repo) => repo.name.toLowerCase() === raw.toLowerCase())
  if (folded) return folded
  return repos.find((repo) => pathKey(repo.root) === pathKey(raw))
}

export type WorktreeRow = {
  /** Path as git printed it, trimmed. The caller resolves it for comparison —
   *  git answers with forward slashes even on Windows. */
  readonly path: string
  /** Short branch name. Absent on a detached or bare checkout. */
  readonly branch?: string
  readonly head?: string
  readonly detached: boolean
  readonly bare: boolean
}

/** Parse `git worktree list --porcelain`: blank-line separated records opening
 *  with `worktree <path>`. Unknown keys are skipped, not an error — git adds
 *  new ones, and a board that stops listing checkouts over one is worse. */
export function parseWorktreeList(text: string): WorktreeRow[] {
  const rows: WorktreeRow[] = []
  let current: { path: string; branch?: string; head?: string; detached: boolean; bare: boolean } | undefined
  const flush = () => {
    if (current) rows.push(current)
    current = undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      continue
    }
    const space = trimmed.indexOf(" ")
    const key = space === -1 ? trimmed : trimmed.slice(0, space)
    const value = space === -1 ? "" : trimmed.slice(space + 1).trim()
    if (key === "worktree") {
      flush()
      current = { path: value, detached: false, bare: false }
      continue
    }
    if (!current) continue
    if (key === "HEAD") current.head = value
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "")
    else if (key === "detached") current.detached = true
    else if (key === "bare") current.bare = true
  }
  flush()
  return rows.filter((row) => row.path)
}

export type TicketDoc = {
  /** Frontmatter lines VERBATIM, fences excluded. Unknown keys live here. */
  readonly fm: readonly string[]
  readonly body: string
  /** The file's own line ending, preserved across a rewrite. */
  readonly eol: "\n" | "\r\n"
}

export function splitDoc(text: string): TicketDoc | undefined {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return undefined
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (close === -1) return undefined
  return { fm: lines.slice(1, close), body: lines.slice(close + 1).join(eol), eol }
}

/** Re-emit a document. Round-trips byte-for-byte when nothing was changed. */
export function joinDoc(doc: TicketDoc): string {
  const head = ["---", ...doc.fm, "---"].join(doc.eol)
  return doc.body ? `${head}${doc.eol}${doc.body}` : `${head}${doc.eol}`
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s?(.*)$/

function keyIndex(fm: readonly string[], key: string): number {
  return fm.findIndex((line) => line.match(KEY_LINE)?.[1] === key)
}

export function fmGet(fm: readonly string[], key: string): string | undefined {
  const index = keyIndex(fm, key)
  return index === -1 ? undefined : (fm[index].match(KEY_LINE)?.[2] ?? "").trim()
}

/** The optional keys the slim template may omit until a stamp gives them their
 *  first real value, in the order the template documents. Any other key still
 *  appends at the absolute end. */
const TAIL_KEYS = ["labels", "assignee", "fold", "branch"]

/** Set one frontmatter key IN PLACE: every other line — unknown keys, comments,
 *  blank lines, ordering — survives untouched. A key already present is updated
 *  on its own line. An ABSENT key is inserted after `updated:`, or after the
 *  last TAIL_KEYS entry that sorts no later than it. */
export function fmSet(fm: readonly string[], key: string, value: string): string[] {
  const next = [...fm]
  const index = keyIndex(next, key)
  const line = `${key}: ${value}`
  if (index !== -1) {
    next[index] = line
    return next
  }
  const order = TAIL_KEYS.indexOf(key)
  if (order === -1) {
    next.push(line)
    return next
  }
  let at = keyIndex(next, "updated") + 1 || next.length
  while (at < next.length && TAIL_KEYS.indexOf(next[at].match(KEY_LINE)?.[1] ?? "") <= order) at++
  next.splice(at, 0, line)
  return next
}

export function unquote(value: string): string {
  const text = value.trim()
  const quoted =
    text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))
  return quoted ? text.slice(1, -1) : text
}

/** First whitespace-delimited token of a value. Only for `status` and
 *  `priority`, single-token enums where dropping the template's trailing
 *  `# low | normal | high` comment is safe. Never on free text like `title`,
 *  where `#` is a legitimate character. */
export function firstToken(value: string): string {
  return unquote(value).split(/\s+/)[0] ?? ""
}

/** `[ui, docs]` (or a bare comma list) -> `["ui", "docs"]`. */
export function parseLabels(value: string | undefined): string[] {
  const inner = (value ?? "").trim().replace(/^\[/, "").replace(/\]$/, "")
  return inner
    .split(",")
    .map((item) => unquote(item))
    .filter(Boolean)
}

export function serializeLabels(labels: readonly string[]): string {
  return `[${labels.join(", ")}]`
}

/** Second-resolution ISO stamp — the format the ticket template documents. */
export function stamp(when: Date = new Date()): string {
  return `${when.toISOString().slice(0, 19)}Z`
}

const HEADING = /^#{1,6}\s/
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/

/** Half-open line range of a `## <name>` section: the heading line, then every
 *  line up to the next heading of any level. */
export function sectionRange(lines: readonly string[], name: string): { start: number; end: number } | undefined {
  const wanted = name.toLowerCase()
  const start = lines.findIndex((line) => {
    const match = line.match(/^#{2,3}\s+(.*?)\s*$/)
    return match?.[1].toLowerCase() === wanted
  })
  if (start === -1) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

export type AcceptanceItem = { readonly done: boolean; readonly text: string }

/** Checkbox lines of the `## Acceptance` section, in file order. */
export function acceptanceItems(body: string): AcceptanceItem[] {
  const lines = body.split(/\r?\n/)
  const range = sectionRange(lines, "acceptance")
  if (!range) return []
  const items: AcceptanceItem[] = []
  for (const line of lines.slice(range.start + 1, range.end)) {
    const match = line.match(CHECKBOX)
    if (match) items.push({ done: match[1] !== " ", text: match[2].trim() })
  }
  return items
}

export function countAcceptance(body: string): { done: number; total: number } {
  const items = acceptanceItems(body)
  return { done: items.filter((item) => item.done).length, total: items.length }
}

function acceptanceLine(item: AcceptanceItem): string {
  return `- [${item.done ? "x" : " "}] ${item.text}`
}

/** Parse a caller-supplied acceptance entry. A leading `[x]` / `[ ]` sets the
 *  state explicitly; plain text leaves it unstated so `setAcceptance` can carry
 *  the existing tick over. */
function parseAcceptanceInput(raw: string): { done?: boolean; text: string } {
  const match = raw.match(CHECKBOX) ?? raw.trim().match(/^\[([ xX])\]\s*(.*)$/)
  if (match) return { done: match[1] !== " ", text: match[2].trim() }
  return { text: raw.replace(/^\s*[-*]\s+/, "").trim() }
}

/** Replace the `## Acceptance` list. An entry whose text is unchanged KEEPS its
 *  tick unless the caller states one, or re-specifying a ticket would untick
 *  everything already done. Created before `## Log` when absent, so the file
 *  keeps the documented order. */
export function setAcceptance(body: string, entries: readonly string[], eol: "\n" | "\r\n"): string {
  const previous = new Map(acceptanceItems(body).map((item) => [item.text, item.done]))
  const rendered = entries
    .map((entry) => parseAcceptanceInput(entry))
    .filter((item) => item.text)
    .map((item) => acceptanceLine({ text: item.text, done: item.done ?? previous.get(item.text) ?? false }))

  const lines = body.split(/\r?\n/)
  const range = sectionRange(lines, "acceptance")
  if (range) {
    const tail = lines.slice(range.end)
    const next = [lines[range.start], "", ...rendered, ""]
    return [...lines.slice(0, range.start), ...next, ...tail].join(eol)
  }

  const section = ["## Acceptance", "", ...rendered, ""]
  const log = sectionRange(lines, "log")
  if (log) return [...lines.slice(0, log.start), ...section, ...lines.slice(log.start)].join(eol)
  const trimmed = [...lines]
  while (trimmed.length && trimmed[trimmed.length - 1].trim() === "") trimmed.pop()
  return [...trimmed, "", ...section].join(eol)
}

/** Append one entry to `## Log`, creating the section when the file has none,
 *  at the END of it so the log stays chronological and anything after it in the
 *  file stays put. */
export function appendLog(body: string, entry: string, eol: "\n" | "\r\n"): string {
  const line = `- ${entry.replace(/\s+/g, " ").trim()}`
  const lines = body.split(/\r?\n/)
  const range = sectionRange(lines, "log")
  if (!range) {
    const trimmed = [...lines]
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === "") trimmed.pop()
    return [...trimmed, "", "## Log", "", line, ""].join(eol)
  }
  let end = range.end
  while (end > range.start + 1 && lines[end - 1].trim() === "") end--
  return [...lines.slice(0, end), line, ...lines.slice(end)].join(eol)
}

/** The exact log entry shape the template documents: `<stamp> <who>: <text>`. */
export function logEntry(who: string, text: string, when: Date = new Date()): string {
  return `${stamp(when)} ${who || "agent"}: ${text}`
}

export type Ticket = {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly priority: string
  readonly labels: readonly string[]
  readonly assignee: string
  readonly created: string
  readonly updated: string
  readonly fold: string
  readonly branch: string
  readonly acceptance: { readonly done: number; readonly total: number }
  readonly body: string
  readonly file: string
  /** Set when the file is not a readable ticket. The row is still returned. */
  readonly malformed?: string
}

function malformedTicket(file: string, reason: string): Ticket {
  return {
    id: path.basename(file, ".md"),
    title: "",
    status: "",
    priority: "",
    labels: [],
    assignee: "",
    created: "",
    updated: "",
    fold: "",
    branch: "",
    acceptance: { done: 0, total: 0 },
    body: "",
    file,
    malformed: reason,
  }
}

export function ticketOf(doc: TicketDoc, file: string): Ticket {
  const title = (fmGet(doc.fm, "title") ?? "").trim()
  const status = firstToken(fmGet(doc.fm, "status") ?? "")
  return {
    id: unquote(fmGet(doc.fm, "id") ?? "") || path.basename(file, ".md"),
    title: unquote(title),
    status,
    priority: firstToken(fmGet(doc.fm, "priority") ?? "") || "normal",
    labels: parseLabels(fmGet(doc.fm, "labels")),
    assignee: unquote(fmGet(doc.fm, "assignee") ?? ""),
    created: unquote(fmGet(doc.fm, "created") ?? ""),
    updated: unquote(fmGet(doc.fm, "updated") ?? ""),
    fold: unquote(fmGet(doc.fm, "fold") ?? ""),
    branch: unquote(fmGet(doc.fm, "branch") ?? ""),
    acceptance: countAcceptance(doc.body),
    body: doc.body,
    file,
    ...(title ? {} : { malformed: "missing title" }),
  }
}

/** Read one ticket file. Never fails — an unusable file comes back malformed. */
export function readTicket(fs: FSUtil.Interface, file: string) {
  return Effect.gen(function* () {
    const text = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (text === undefined) return malformedTicket(file, "unreadable")
    const doc = splitDoc(text)
    if (!doc) return malformedTicket(file, "no frontmatter block")
    return ticketOf(doc, file)
  })
}

/** Every ticket in a repo, id-sorted. A missing tickets directory = none. */
export function listTickets(fs: FSUtil.Interface, root: string) {
  return Effect.gen(function* () {
    const dir = ticketsDir(root)
    const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
    const files = entries
      .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
    const tickets: Ticket[] = []
    for (const name of files) tickets.push(yield* readTicket(fs, path.join(dir, name)))
    return tickets
  })
}

export function countByStatus(tickets: readonly Ticket[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const ticket of tickets) {
    const key = ticket.malformed ? "malformed" : ticket.status || "unknown"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"

/** `t-` + 6 base36: 4 time-derived (whole seconds, so ids sort roughly by age
 *  inside a ~19-day window) + 2 random. The caller still probes for a free
 *  filename, which is what actually guarantees uniqueness. */
export function newTicketId(now: number = Date.now(), random: () => number = Math.random): string {
  const time = Math.floor(now / 1000)
    .toString(36)
    .slice(-4)
    .padStart(4, "0")
  const tail = [0, 0].map(() => BASE36[Math.floor(random() * BASE36.length) % BASE36.length]).join("")
  return `t-${time}${tail}`
}

/** The refusal for a status an agent may not set, or `undefined` when it may. A
 *  refusal string, not an error: the model has to read why and pick a legal
 *  move, and a thrown error reads as a broken tool. */
export function statusRefusal(next: string): string | undefined {
  if ((AGENT_STATUSES as readonly string[]).includes(next)) return undefined
  if ((TICKET_STATUSES as readonly string[]).includes(next))
    return `Refused: "${next}" — that transition is stamped by the fold lifecycle, not by a tool. Agents may set only ${AGENT_STATUSES.join(", ")}.`
  return `Refused: "${next}" is not a ticket status. Agents may set only ${AGENT_STATUSES.join(", ")}.`
}

export function priorityRefusal(next: string): string | undefined {
  if ((PRIORITIES as readonly string[]).includes(next)) return undefined
  return `Refused: "${next}" is not a priority. Use one of ${PRIORITIES.join(", ")}.`
}

/** The refusal for a claim that would steal a ticket, or `undefined`. A
 *  compare-and-set on `assignee`, so two agents racing one ticket cannot both
 *  believe they own it. */
export function claimRefusal(assignee: string, slug: string): string | undefined {
  if (!assignee || assignee === slug) return undefined
  return `Refused: that ticket is already claimed by @${assignee}. Ask them, or pick another ticket.`
}

const locks = new Map<string, Semaphore.Semaphore>()

/** The per-repo write mutex. In-process only, by design: it serialises the
 *  read-modify-write of tools inside ONE engine, which is where the lost-update
 *  risk is. Cross-process safety is the file's own atomicity. */
export function repoLock(root: string): Semaphore.Semaphore {
  const key = pathKey(root)
  const hit = locks.get(key)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(key, next)
  return next
}

/** A fresh ticket file. LF and no trailing blank run — this is authored text. */
export function newTicketFile(input: {
  id: string
  title: string
  status: string
  priority: string
  labels: readonly string[]
  body?: string
  acceptance?: readonly string[]
  who: string
  when?: Date
}): string {
  const when = input.when ?? new Date()
  const created = stamp(when)
  const parts = ["---", `id: ${input.id}`, `title: ${input.title}`, `status: ${input.status}`, `priority: ${input.priority}`]
  // Slim template: assignee/fold/branch are always blank on a brand-new ticket
  // so they are never written, and labels only when the caller gave some. fmSet
  // inserts each one later, in this order, on its first real value.
  if (input.labels.length) parts.push(`labels: ${serializeLabels(input.labels)}`)
  parts.push(`created: ${created}`, `updated: ${created}`, "---", "")
  const body = (input.body ?? "").trim()
  if (body) parts.push(body, "")
  if (input.acceptance?.length) {
    parts.push("## Acceptance", "")
    for (const entry of input.acceptance) {
      const item = parseAcceptanceInput(entry)
      if (item.text) parts.push(acceptanceLine({ text: item.text, done: item.done ?? false }))
    }
    parts.push("")
  }
  parts.push("## Log", "", `- ${logEntry(input.who, "created via board_create", when)}`, "")
  return parts.join("\n")
}

export * as BoardStore from "./board-store"

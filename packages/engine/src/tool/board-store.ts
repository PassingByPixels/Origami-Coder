import path from "path"
import { Effect, Semaphore } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"

/**
 * FOLDS BOARD STORE.
 *
 * The ticket is the entity and the FILE is the truth: every ticket is one
 * markdown file at `<repoRoot>/.origami/tickets/<id>.md`, and the repo registry
 * is `~/.origami/repos.json`. Humans edit both by hand, the extension renders
 * them, and the `board_*` tools read/write them — so the parse and the write
 * live HERE, once, and cannot drift between the readers.
 *
 * Two rules drive the whole module:
 *
 *  1. A WRITE IS A TARGETED LINE EDIT. Frontmatter is re-emitted line by line
 *     with only the changed key replaced. Rebuilding it from a fixed field list
 *     would silently delete every key this module does not know about — the
 *     collab agent-def serializer bug class, which is exactly what a
 *     hand-authored ticket file cannot afford.
 *  2. A FILE THAT WILL NOT PARSE IS SURFACED, NEVER DROPPED. `readTicket`
 *     returns a ticket carrying `malformed` rather than failing, so a typo in
 *     one file cannot make it vanish off the board.
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

/** Ticket priorities, lowest first. */
export const PRIORITIES = ["low", "normal", "high"] as const

/** `~/.origami/repos.json`. A getter, so it honours ORIGAMI_TEST_HOME. */
export function reposPath(): string {
  return path.join(Global.Path.origami, REPOS_FILE)
}

/** `<repoRoot>/.origami/tickets/`. */
export function ticketsDir(root: string): string {
  return path.join(root, ".origami", TICKETS_DIR)
}

/** `<repoRoot>/.origami/tickets/<id>.md`. */
export function ticketPath(root: string, id: string): string {
  return path.join(ticketsDir(root), `${id}.md`)
}

export type RepoEntry = {
  readonly root: string
  readonly name: string
  readonly workspace: boolean
  readonly addedAt: number
  /** Board-only display label (VS Code Folds pill/header), never used to
   *  resolve a `repo` param — the ticket store and this bridge key by `name`
   *  alone, so a rename can never move where a tool writes. Display-only. */
  readonly displayName?: string
  /** Absolute path of the checkout that OWNS this repo's tickets, and that
   *  folds branch from and apply into. A repo can have many worktrees; exactly
   *  one holds `.origami/tickets/`. ABSENT is the normal case and means the
   *  registered `root` is that checkout. */
  readonly primary?: string
}

/**
 * Comparable form of a path: resolved, trailing separator dropped, and
 * case-folded on Windows. Used for repo identity and for the write mutex, so
 * `C:\Repos\X\` and `c:/repos/x` are one repo and take one lock.
 */
export function pathKey(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, "")
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/**
 * Parse `repos.json`. Anything unreadable — absent file, broken JSON, wrong
 * shape — reads as NO repos rather than an error: the registry is written by
 * the extension, and a tool that dies because the user has never opened the
 * board is worse than one that says the board is empty.
 */
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

/**
 * The checkout that owns a repo's tickets: `primary` when the entry names one,
 * the registered root otherwise. Every ticket path for a repo resolved BY NAME
 * goes through here — a repo with three worktrees still has ONE ticket folder,
 * or the same board would read differently from each checkout.
 */
export function primaryRoot(entry: Pick<RepoEntry, "root" | "primary">): string {
  return entry.primary?.trim() || entry.root
}

/** Read and parse the registry. */
export function readRepos(fs: FSUtil.Interface) {
  return Effect.gen(function* () {
    const text = yield* fs.readFileStringSafe(reposPath()).pipe(Effect.catch(() => Effect.succeed(undefined)))
    return parseRepos(text)
  })
}

/**
 * One registry change: the `root` that identifies the entry, plus the fields to
 * set on it. Anything the patch does not name keeps the value it already had.
 */
export type RepoPatch = { readonly root: string } & Partial<Omit<RepoEntry, "root">>

/**
 * Merge patches into the TEXT of repos.json and return the new text.
 *
 * The merge works on the RAW parsed JSON, never on the projected `RepoEntry`
 * list. That is the whole point: the registry is a shared file — the extension
 * writes it too, and each side carries keys the other has never heard of — so
 * projecting and re-emitting would silently delete every unknown field. Same
 * rule as `fmSet` on the ticket side, for the same reason.
 *
 * Unreadable input reads as no repos rather than an error. Broken JSON has
 * nothing left to preserve; a readable object whose `repos` is unusable still
 * keeps every other top-level key.
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

  // `version` is what the extension's reader gates on: a file without it reads
  // as "no prior file" over there, and every addedAt gets re-dated on its next
  // rewrite. Stamp it when it is missing, never overwrite one already there.
  if (typeof doc.version !== "number") doc.version = 1
  doc.repos = list
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * Merge patches into `~/.origami/repos.json`. The engine's only write path to
 * the registry: atomic (tmp + rename, the ritual the extension already uses,
 * so a reader mid-write never sees half a file) and serialised on the
 * registry's own lock, or two tools registering two repos at once would lose
 * one of the entries. Returns the registry as it now stands.
 */
export function writeRepos(fs: FSUtil.Interface, patches: readonly RepoPatch[]) {
  const file = reposPath()
  return repoLock(file).withPermits(1)(
    Effect.gen(function* () {
      const text = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
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

/**
 * Resolve the tools' `repo` parameter against the registry: by name first
 * (that is what the pills show), then by absolute root. A literal "." is the
 * session's own worktree — the one repo a fold session always knows without
 * being told. Everything else must be REGISTERED: an unregistered absolute
 * path would let an agent scatter ticket files into any directory it can name.
 */
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

/**
 * Parse `git worktree list --porcelain`: blank-line separated records, each
 * opening with `worktree <path>`, then zero or more `<key> [value]` lines
 * (`HEAD`, `branch`, `detached`, `bare`, `locked`, `prunable`). Keys this
 * function does not know are skipped, not treated as an error — git adds new
 * ones, and a board that stops listing checkouts because of one is worse than
 * one that lists them without the new detail.
 */
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

// ============================ document shape =============================

export type TicketDoc = {
  /** Frontmatter lines VERBATIM, fences excluded. Unknown keys live here. */
  readonly fm: readonly string[]
  /** Everything after the closing fence, verbatim. */
  readonly body: string
  /** The file's own line ending, preserved across a rewrite. */
  readonly eol: "\n" | "\r\n"
}

/** Split a ticket file into frontmatter lines + body. `undefined` = no fence. */
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

/** Raw value of a frontmatter key, trimmed. `undefined` when the key is absent. */
export function fmGet(fm: readonly string[], key: string): string | undefined {
  const index = keyIndex(fm, key)
  return index === -1 ? undefined : (fm[index].match(KEY_LINE)?.[2] ?? "").trim()
}

/** The optional keys the slim template (§12 item 5) may omit until a stamp
 *  gives them their first real value, in the order the template documents.
 *  Any other key — including one this module has never heard of — still
 *  appends at the absolute end, exactly as before. */
const TAIL_KEYS = ["labels", "assignee", "fold", "branch"]

/**
 * Set one frontmatter key IN PLACE. The whole point of the module: every other
 * line — unknown keys, comments, blank lines, ordering — survives untouched.
 * A key that is already present is updated on its own line, wherever that is
 * (an old-format ticket's blank `assignee: ''` never moves). A key that is
 * ABSENT is inserted right after `updated:` — or, if a TAIL_KEYS entry that
 * sorts no later than it is already there, right after that one instead — so
 * a slim ticket's first claim/labels/fold/branch lands in the documented
 * order rather than tacked onto the very end of the frontmatter.
 */
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

/** Strip one matching pair of surrounding quotes. `''` reads as empty. */
export function unquote(value: string): string {
  const text = value.trim()
  const quoted =
    text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))
  return quoted ? text.slice(1, -1) : text
}

/**
 * First whitespace-delimited token of a value. Used ONLY for `status` and
 * `priority`, which are single-token enums — that is what makes it safe to
 * drop the trailing `# low | normal | high` comment the template ships. Never
 * use it on free text like `title`, where a `#` is a legitimate character.
 */
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

/** The inline-array form the ticket template uses. */
export function serializeLabels(labels: readonly string[]): string {
  return `[${labels.join(", ")}]`
}

/** Second-resolution ISO stamp — the format the ticket template documents. */
export function stamp(when: Date = new Date()): string {
  return `${when.toISOString().slice(0, 19)}Z`
}

// ============================ body sections ==============================

const HEADING = /^#{1,6}\s/
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/

/**
 * Half-open line range of a `## <name>` section: the heading line, then every
 * line up to the next heading of any level. `undefined` when there is no such
 * section.
 */
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

/** Acceptance progress as the board card shows it. */
export function countAcceptance(body: string): { done: number; total: number } {
  const items = acceptanceItems(body)
  return { done: items.filter((item) => item.done).length, total: items.length }
}

/** Render one acceptance line. */
function acceptanceLine(item: AcceptanceItem): string {
  return `- [${item.done ? "x" : " "}] ${item.text}`
}

/**
 * Parse a caller-supplied acceptance entry. A leading `[x]` / `[ ]` (with or
 * without the list dash) sets the state explicitly; plain text leaves it
 * unstated so `setAcceptance` can carry the existing tick over.
 */
function parseAcceptanceInput(raw: string): { done?: boolean; text: string } {
  const match = raw.match(CHECKBOX) ?? raw.trim().match(/^\[([ xX])\]\s*(.*)$/)
  if (match) return { done: match[1] !== " ", text: match[2].trim() }
  return { text: raw.replace(/^\s*[-*]\s+/, "").trim() }
}

/**
 * Replace the `## Acceptance` list. An entry whose text is unchanged KEEPS its
 * tick unless the caller states one — otherwise re-specifying a ticket would
 * quietly untick everything already done. The section is created before
 * `## Log` when absent, so the file keeps the documented order.
 */
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

/**
 * Append one entry to `## Log`, creating the section when the file has none.
 * Appends at the END of the section (blank padding backed over) so the log
 * stays chronological and anything after it in the file stays put.
 */
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

// ================================ tickets ================================

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
  /** Markdown after the frontmatter, verbatim. */
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

/** Project a parsed document into the board's ticket model. */
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

/** Ticket counts keyed by status, malformed rows counted under "malformed". */
export function countByStatus(tickets: readonly Ticket[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const ticket of tickets) {
    const key = ticket.malformed ? "malformed" : ticket.status || "unknown"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"

/**
 * `t-` + 6 base36: 4 time-derived (whole seconds, so ids sort roughly by age
 * inside a ~19-day window) + 2 random. Short enough to read out loud on a card
 * chip; the caller still probes for a free filename, which is what actually
 * guarantees uniqueness.
 */
export function newTicketId(now: number = Date.now(), random: () => number = Math.random): string {
  const time = Math.floor(now / 1000)
    .toString(36)
    .slice(-4)
    .padStart(4, "0")
  const tail = [0, 0].map(() => BASE36[Math.floor(random() * BASE36.length) % BASE36.length]).join("")
  return `t-${time}${tail}`
}

/**
 * The refusal for a status an agent may not set, or `undefined` when it may.
 * A REFUSAL STRING, not an error: the model has to be able to read why and
 * pick a legal move, and a thrown error reads as a broken tool.
 */
export function statusRefusal(next: string): string | undefined {
  if ((AGENT_STATUSES as readonly string[]).includes(next)) return undefined
  if ((TICKET_STATUSES as readonly string[]).includes(next))
    return `Refused: "${next}" — that transition is stamped by the fold lifecycle, not by a tool. Agents may set only ${AGENT_STATUSES.join(", ")}.`
  return `Refused: "${next}" is not a ticket status. Agents may set only ${AGENT_STATUSES.join(", ")}.`
}

/** The refusal for a bad priority, or `undefined`. */
export function priorityRefusal(next: string): string | undefined {
  if ((PRIORITIES as readonly string[]).includes(next)) return undefined
  return `Refused: "${next}" is not a priority. Use one of ${PRIORITIES.join(", ")}.`
}

/**
 * The refusal for a claim that would steal a ticket, or `undefined`. A
 * compare-and-set on `assignee`: an unassigned ticket is claimable, a ticket
 * already claimed by the same slug is a no-op, and anything else is refused so
 * two agents racing one ticket cannot both believe they own it.
 */
export function claimRefusal(assignee: string, slug: string): string | undefined {
  if (!assignee || assignee === slug) return undefined
  return `Refused: that ticket is already claimed by @${assignee}. Ask them, or pick another ticket.`
}

const locks = new Map<string, Semaphore.Semaphore>()

/**
 * The per-repo write mutex. In-process only, by design: it serialises the
 * read-modify-write of the tools running inside ONE engine, which is where the
 * lost-update risk is. Cross-process safety is the file's own atomicity plus
 * the fact that humans edit tickets one at a time.
 */
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
  // Slim template (§12 item 5): assignee/fold/branch are ALWAYS blank on a
  // brand-new ticket, so they are never written; labels is written only when
  // the caller actually gave some. fmSet inserts every one of them later, in
  // this same order, the moment a stamp gives it a first real value.
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

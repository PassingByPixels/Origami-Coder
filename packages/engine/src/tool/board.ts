import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import type { InstanceContext } from "@/project/instance-context"
import {
  AGENT_STATUSES,
  appendLog,
  claimRefusal,
  countAcceptance,
  countByStatus,
  fmGet,
  fmSet,
  joinDoc,
  listTickets,
  logEntry,
  newTicketFile,
  newTicketId,
  parseWorktreeList,
  pathKey,
  primaryRoot,
  priorityRefusal,
  readRepos,
  readTicket,
  repoLock,
  reposPath,
  resolveRepo,
  serializeLabels,
  setAcceptance,
  splitDoc,
  stamp,
  statusRefusal,
  ticketPath,
  ticketsDir,
  unquote,
  writeRepos,
  type RepoEntry,
  type Ticket,
} from "./board-store"
import * as Tool from "./tool"

// Descriptions stay terse: the board tools are meant to be usable by the small
// local models that run fold sessions, and a long description crowds out the
// task in their context.

const REPO_PARAM = Schema.String.annotate({
  description: 'Repo name or absolute root, as listed by board_repos. Use "." for this session\'s own repo.',
})

/**
 * One metadata shape for all six tools. Declared rather than inferred: each
 * execute returns several result shapes (found / refused / empty) and inference
 * would pin the metadata type to whichever branch happens to come first.
 */
type BoardMetadata = {
  registry?: string
  repos?: number
  repo?: string
  root?: string
  primary?: string
  path?: string
  worktrees?: number
  tickets?: number
  id?: string
  file?: string
  status?: string
}

function unknownRepo(raw: string, repos: readonly RepoEntry[]): string {
  const known = repos.length ? repos.map((repo) => repo.name).join(", ") : "(none)"
  return (
    `Refused: no repo "${raw}" is registered on the Folds board. Registered: ${known}.` +
    ` Call board_repos, pass repo:"." for this session's own repo,` +
    ` or board_register to put a new repo on the board.`
  )
}

/**
 * The checkout a tool does ticket IO in.
 *
 * A bare "." is the SESSION's own checkout and never follows `primary`: a fold
 * session runs in its own worktree, writes the ticket there, and the apply step
 * carries the file back. Rerouting it would send the session's writes into a
 * checkout its branch never touches. Every other form of the `repo` param names
 * a repo on the board, and the board's tickets live in that repo's primary.
 */
function boardRoot(repo: RepoEntry, param: string | undefined): string {
  const raw = (param ?? "").trim()
  return !raw || raw === "." ? repo.root : primaryRoot(repo)
}

/** First non-blank line of a git stderr, for a refusal the model can read. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim()) ?? ""
}

/**
 * `git rev-parse <what>` at `cwd`, made absolute. `undefined` when the folder
 * is not a git repo — or when git could not be run at all, which is the same
 * answer for every caller here: treat it as "no repository", never as a crash.
 * `--git-common-dir` may answer relatively, hence the resolve against `cwd`.
 */
function revParse(git: Git.Interface, cwd: string, what: string) {
  return Effect.gen(function* () {
    const result = yield* git.run(["rev-parse", what], { cwd })
    if (result.exitCode !== 0) return undefined
    const text = result.text().trim()
    return text ? path.resolve(cwd, text) : undefined
  })
}

/**
 * The refusal for a bare "." in a workspace that has no VCS, or `undefined`.
 * A non-git workspace resolves its worktree to "/" — the DRIVE ROOT on Windows
 * — so "." there would write tickets to `C:\.origami\tickets\`, shared across
 * every user account and every non-git folder. Refuse rather than scatter
 * files, mirroring the `instance.project.vcs` predicate the remember tool uses
 * against the same hazard.
 */
function rootlessDot(param: string, instance: InstanceContext): string | undefined {
  if (param?.trim() !== "." || instance.project.vcs) return undefined
  return (
    `Refused: repo:"." means this session's own repo, but ${instance.directory} is not a git repo,` +
    ` so there is no repo root to put tickets in. Register the repo on the Folds board and pass its name.`
  )
}

/** One-line ticket head — the same fields the board card shows. */
function headLine(ticket: Ticket): string {
  if (ticket.malformed) return `${ticket.id}  MALFORMED (${ticket.malformed})  ${ticket.file}`
  const bits = [ticket.id, ticket.status || "?", `[${ticket.priority}]`, ticket.title]
  if (ticket.assignee) bits.push(`@${ticket.assignee}`)
  if (ticket.acceptance.total) bits.push(`${ticket.acceptance.done}/${ticket.acceptance.total}`)
  if (ticket.labels.length) bits.push(`labels: ${ticket.labels.join(",")}`)
  if (ticket.fold) bits.push(`fold: ${ticket.fold}`)
  return bits.join("  ")
}

// ============================== board_repos ==============================

export const ReposParameters = Schema.Struct({})

const REPOS_DESCRIPTION = [
  "List the repos registered on the Folds board, with their ticket counts per status.",
  "Call this first when you do not know which repo name to pass to the other board_* tools.",
  "A repo that is not listed is not on the board yet — board_register puts it there.",
].join(" ")

export const BoardReposTool = Tool.define<typeof ReposParameters, BoardMetadata, FSUtil.Service>(
  "board_repos",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description: REPOS_DESCRIPTION,
      parameters: ReposParameters,
      execute: (_params: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const registry = reposPath()
          const repos = yield* readRepos(fs)
          if (!repos.length) {
            return {
              title: "board_repos: none",
              metadata: { registry, repos: 0 },
              output:
                `No repos are registered on the Folds board (${registry}).` +
                ` Call board_register to add one, add it from the Folds view in the editor,` +
                ` or pass repo:"." to work on this session's own repo.`,
            }
          }

          const lines: string[] = []
          for (const repo of repos) {
            // Tickets are counted where they LIVE — the primary checkout, which
            // is the registered root unless the entry names another one.
            const root = primaryRoot(repo)
            const counts = countByStatus(yield* listTickets(fs, root))
            const summary = [...counts].map(([status, count]) => `${status} ${count}`).join(", ")
            const where = pathKey(root) === pathKey(repo.root) ? repo.root : `${repo.root}  primary: ${root}`
            lines.push(`${repo.name}  ${where}  ${summary || "no tickets"}`)
          }
          return {
            title: `board_repos: ${repos.length}`,
            metadata: { registry, repos: repos.length },
            output: [`${repos.length} repo(s) on the Folds board (${registry}):`, ...lines].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ============================= board_tickets =============================

export const TicketsParameters = Schema.Struct({
  repo: REPO_PARAM,
  status: Schema.optional(Schema.String).annotate({
    description: "Only list tickets with this status (triage, todo, pending, in_progress, done, merged, closed).",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "Ticket id, e.g. t-8k2fq1. Returns that one ticket in full instead of the list.",
  }),
})

const TICKETS_DESCRIPTION = [
  "Read a repo's Folds board: one line per ticket (id, status, priority, title, assignee, acceptance progress).",
  "Pass id to get that ticket in full, including its Acceptance section verbatim.",
].join(" ")

export const BoardTicketsTool = Tool.define<typeof TicketsParameters, BoardMetadata, FSUtil.Service>(
  "board_tickets",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description: TICKETS_DESCRIPTION,
      parameters: TicketsParameters,
      execute: (params: Schema.Schema.Type<typeof TicketsParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const rootless = rootlessDot(params.repo, instance)
          if (rootless) {
            return { title: "board_tickets: refused", metadata: { repo: params.repo }, output: rootless }
          }
          const repos = yield* readRepos(fs)
          const repo = resolveRepo(repos, params.repo, instance.worktree)
          if (!repo) {
            return {
              title: "board_tickets: unknown repo",
              metadata: { repo: params.repo },
              output: unknownRepo(params.repo, repos),
            }
          }
          const root = boardRoot(repo, params.repo)

          if (params.id) {
            const file = ticketPath(root, params.id.trim())
            const ticket = yield* readTicket(fs, file)
            if (ticket.malformed === "unreadable") {
              return {
                title: "board_tickets: not found",
                metadata: { repo: repo.name, root, id: params.id },
                output: `No ticket "${params.id}" in ${repo.name} (${file}).`,
              }
            }
            return {
              title: `board_tickets: ${ticket.id}`,
              metadata: { repo: repo.name, root, id: ticket.id, file, status: ticket.status },
              output: [`${repo.name}  ${file}`, headLine(ticket), "", ticket.body.trim()].join("\n"),
            }
          }

          const all = yield* listTickets(fs, root)
          const wanted = params.status?.trim()
          const tickets = wanted ? all.filter((ticket) => ticket.status === wanted) : all
          if (!tickets.length) {
            return {
              title: "board_tickets: none",
              metadata: { repo: repo.name, root, tickets: 0 },
              output:
                `No ${wanted ? `${wanted} ` : ""}tickets in ${repo.name} (${ticketsDir(root)}).` +
                ` Use board_create to add one.`,
            }
          }
          return {
            title: `board_tickets: ${tickets.length}`,
            metadata: { repo: repo.name, root, tickets: tickets.length },
            output: [
              `${repo.name}  ${tickets.length} ticket(s)${wanted ? ` with status ${wanted}` : ""}:`,
              ...tickets.map(headLine),
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ============================= board_create ==============================

export const CreateParameters = Schema.Struct({
  repo: REPO_PARAM,
  title: Schema.String.annotate({ description: "One-line ticket title." }),
  body: Schema.optional(Schema.String).annotate({
    description: "Markdown brief: objective, constraints, notes. Written below the frontmatter.",
  }),
  acceptance: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Acceptance criteria, one per item. Supplying any lands the ticket in Todo instead of Triage.",
  }),
  priority: Schema.optional(Schema.String).annotate({ description: "low, normal or high. Default normal." }),
  labels: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Short labels, e.g. ui, engine." }),
})

const CREATE_DESCRIPTION = [
  "Create a ticket on a repo's Folds board.",
  "With acceptance criteria it lands in Todo (launchable); without them it lands in Triage.",
  "Returns the new ticket id.",
].join(" ")

export const BoardCreateTool = Tool.define<typeof CreateParameters, BoardMetadata, FSUtil.Service>(
  "board_create",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description: CREATE_DESCRIPTION,
      parameters: CreateParameters,
      execute: (params: Schema.Schema.Type<typeof CreateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const rootless = rootlessDot(params.repo, instance)
          if (rootless) {
            return { title: "board_create: refused", metadata: { repo: params.repo }, output: rootless }
          }
          const repos = yield* readRepos(fs)
          const repo = resolveRepo(repos, params.repo, instance.worktree)
          if (!repo) {
            return {
              title: "board_create: unknown repo",
              metadata: { repo: params.repo },
              output: unknownRepo(params.repo, repos),
            }
          }
          const root = boardRoot(repo, params.repo)
          // A `primary` that is not on disk is a typo in the registry, and
          // board_create is the one board tool that CREATES directories: left
          // unchecked it would quietly build a ticket folder at the typo.
          // Only the primary is checked — a missing registered root behaves
          // exactly as it did before.
          if (pathKey(root) !== pathKey(repo.root) && !(yield* fs.isDir(root))) {
            return {
              title: "board_create: refused",
              metadata: { repo: repo.name, root, primary: root },
              output:
                `Refused: ${repo.name} says its tickets live in ${root}, and there is no such folder.` +
                ` Fix the primary checkout for this repo in ${reposPath()}.`,
            }
          }

          const title = params.title?.replace(/\s+/g, " ").trim()
          if (!title) {
            return {
              title: "board_create: refused",
              metadata: { repo: repo.name, root },
              output: "Refused: title is required — a ticket with no title cannot be read off a board card.",
            }
          }

          const priority = params.priority?.trim() || "normal"
          const refusal = priorityRefusal(priority)
          if (refusal) {
            return { title: "board_create: refused", metadata: { repo: repo.name, root }, output: refusal }
          }

          const acceptance = (params.acceptance ?? []).map((item) => item.trim()).filter(Boolean)
          // Spec'd work is launchable, a bare idea is not — that IS the Todo vs
          // Triage split, so derive it here rather than trusting the caller to
          // keep the two params consistent.
          const status = acceptance.length ? "todo" : "triage"
          const labels = (params.labels ?? []).map((item) => item.trim()).filter(Boolean)

          yield* ctx.ask({
            permission: "board",
            patterns: [repo.name],
            always: ["*"],
            metadata: { repo: repo.name, root, title, status },
          })

          const written = yield* repoLock(root).withPermits(1)(
            Effect.gen(function* () {
              // Probe for a free filename. The id carries only 2 random chars,
              // so a same-second collision is rare but possible, and silently
              // overwriting somebody else's ticket is not an acceptable failure.
              let id = newTicketId()
              let file = ticketPath(root, id)
              for (let attempt = 0; attempt < 8 && (yield* fs.existsSafe(file)); attempt++) {
                id = newTicketId()
                file = ticketPath(root, id)
              }
              if (yield* fs.existsSafe(file)) return undefined
              yield* fs.writeWithDirs(
                file,
                newTicketFile({ id, title, status, priority, labels, body: params.body, acceptance, who: ctx.agent }),
              )
              return { id, file }
            }),
          )

          if (!written) {
            return {
              title: "board_create: refused",
              metadata: { repo: repo.name, root },
              output: "Refused: could not allocate a free ticket id after 8 tries. Call board_create again.",
            }
          }

          return {
            title: `board_create: ${written.id}`,
            metadata: { repo: repo.name, root, id: written.id, file: written.file, status },
            output:
              `Created ${written.id} in ${repo.name} with status ${status}` +
              `${acceptance.length ? ` and ${acceptance.length} acceptance criteria` : " (no acceptance criteria yet)"}.` +
              `\n${written.file}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ============================= board_update ==============================

export const UpdateParameters = Schema.Struct({
  repo: REPO_PARAM,
  id: Schema.String.annotate({ description: "Ticket id, e.g. t-8k2fq1." }),
  status: Schema.optional(Schema.String).annotate({
    description: `New status. Agents may set only ${AGENT_STATUSES.join(", ")} — the rest are stamped by the fold lifecycle.`,
  }),
  claim: Schema.optional(Schema.String).annotate({
    description: "Take the ticket under this name. Refused if somebody else already holds it.",
  }),
  comment: Schema.optional(Schema.String).annotate({ description: "One line appended to the ticket's Log section." }),
  title: Schema.optional(Schema.String).annotate({ description: "Replacement title." }),
  priority: Schema.optional(Schema.String).annotate({ description: "low, normal or high." }),
  labels: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Replacement label list." }),
  acceptance: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Replacement acceptance list. Prefix an item with [x] to tick it; unchanged items keep their tick.",
  }),
})

const UPDATE_DESCRIPTION = [
  "Update one ticket on a repo's Folds board: claim it, log a comment, retitle, relabel, re-prioritise,",
  "rewrite or tick the acceptance list, or set the status.",
  `Status may only be set to ${AGENT_STATUSES.join(", ")}; the fold lifecycle stamps the rest.`,
  "Every change bumps the ticket's updated stamp.",
].join(" ")

type UpdateOutcome = { refusal?: string; changes: string[] }

export const BoardUpdateTool = Tool.define<typeof UpdateParameters, BoardMetadata, FSUtil.Service>(
  "board_update",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description: UPDATE_DESCRIPTION,
      parameters: UpdateParameters,
      execute: (params: Schema.Schema.Type<typeof UpdateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const rootless = rootlessDot(params.repo, instance)
          if (rootless) {
            return { title: "board_update: refused", metadata: { repo: params.repo }, output: rootless }
          }
          const repos = yield* readRepos(fs)
          const repo = resolveRepo(repos, params.repo, instance.worktree)
          if (!repo) {
            return {
              title: "board_update: unknown repo",
              metadata: { repo: params.repo },
              output: unknownRepo(params.repo, repos),
            }
          }
          const root = boardRoot(repo, params.repo)
          const id = params.id.trim()
          const file = ticketPath(root, id)
          const refuse = (output: string) => ({
            title: "board_update: refused",
            metadata: { repo: repo.name, root, id, file },
            output,
          })

          const status = params.status?.trim()
          if (status) {
            const refusal = statusRefusal(status)
            if (refusal) return refuse(refusal)
          }
          const priority = params.priority?.trim()
          if (priority) {
            const refusal = priorityRefusal(priority)
            if (refusal) return refuse(refusal)
          }

          const claim = params.claim?.trim()
          const before = yield* readTicket(fs, file)
          if (before.malformed === "unreadable") return refuse(`Refused: no ticket "${id}" in ${repo.name} (${file}).`)
          if (before.malformed) {
            return refuse(
              `Refused: ${file} is malformed (${before.malformed}) — rewriting it would corrupt it further. Fix the file by hand.`,
            )
          }
          // Cheap pre-check, so an obviously doomed claim never costs the user a
          // permission prompt. The authoritative check is re-run under the lock.
          if (claim) {
            const refusal = claimRefusal(before.assignee, claim)
            if (refusal) return refuse(refusal)
          }

          yield* ctx.ask({
            permission: "board",
            patterns: [repo.name],
            always: ["*"],
            metadata: { repo: repo.name, root, id, status, claim, comment: params.comment },
          })

          const result: UpdateOutcome = yield* repoLock(root).withPermits(1)(
            Effect.gen(function* () {
              // Re-read INSIDE the lock: the claim is a compare-and-set, and a
              // CAS against a value read before an interactive prompt is not a
              // CAS at all.
              const text = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (text === undefined)
                return { refusal: `Refused: no ticket "${id}" in ${repo.name} (${file}).`, changes: [] }
              const doc = splitDoc(text)
              if (!doc)
                return { refusal: `Refused: ${file} has no frontmatter block. Fix the file by hand.`, changes: [] }

              if (claim) {
                const refusal = claimRefusal(unquote(fmGet(doc.fm, "assignee") ?? ""), claim)
                if (refusal) return { refusal, changes: [] }
              }

              // Targeted line edits only: every frontmatter key this module does
              // not know about is carried through verbatim.
              const changes: string[] = []
              let fm = doc.fm
              if (claim) {
                fm = fmSet(fm, "assignee", claim)
                changes.push(`claimed by @${claim}`)
              }
              if (status) {
                fm = fmSet(fm, "status", status)
                changes.push(`status ${status}`)
              }
              if (priority) {
                fm = fmSet(fm, "priority", priority)
                changes.push(`priority ${priority}`)
              }
              const title = params.title?.replace(/\s+/g, " ").trim()
              if (title) {
                fm = fmSet(fm, "title", title)
                changes.push("title")
              }
              if (params.labels) {
                const labels = params.labels.map((item) => item.trim()).filter(Boolean)
                fm = fmSet(fm, "labels", serializeLabels(labels))
                changes.push(`labels ${serializeLabels(labels)}`)
              }

              let body = doc.body
              if (params.acceptance) {
                body = setAcceptance(body, params.acceptance, doc.eol)
                const counted = countAcceptance(body)
                changes.push(`acceptance ${counted.done}/${counted.total}`)
              }
              const comment = params.comment?.replace(/\s+/g, " ").trim()
              if (comment) {
                body = appendLog(body, logEntry(ctx.agent, comment), doc.eol)
                changes.push("logged a comment")
              }

              if (!changes.length) return { changes }
              // The stamp is bumped for ANY change, so the extension's poll can
              // spot a touched ticket without diffing whole files.
              fm = fmSet(fm, "updated", stamp())
              yield* fs.writeWithDirs(file, joinDoc({ fm, body, eol: doc.eol }))
              return { changes }
            }),
          )

          if (result.refusal) return refuse(result.refusal)
          if (!result.changes.length) {
            return {
              title: "board_update: no change",
              metadata: { repo: repo.name, root, id, file },
              output: `Nothing to change on ${id} — pass at least one of status, claim, comment, title, priority, labels, acceptance.`,
            }
          }

          const after = yield* readTicket(fs, file)
          return {
            title: `board_update: ${id}`,
            metadata: { repo: repo.name, root, id, file, status: after.status },
            output: [`Updated ${id} in ${repo.name}: ${result.changes.join(", ")}.`, headLine(after), file].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// ============================ board_register =============================

export const RegisterParameters = Schema.Struct({
  path: Schema.String.annotate({
    description: "Folder to put on the board. The repo's ROOT — absolute, or relative to this session's repo.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Board name for the repo, used as the repo param everywhere else. Defaults to the folder name.",
  }),
  init: Schema.optional(Schema.Boolean).annotate({
    description: "Run git init in the folder first. Only for a folder that is not a repo yet. Default false.",
  }),
})

const REGISTER_DESCRIPTION = [
  "Put a repo on the Folds board so the other board_* tools can name it.",
  "Call this when the repo you need is missing from board_repos.",
  "The folder must be a git repo root; pass init true to run git init in an empty folder first.",
].join(" ")

export const BoardRegisterTool = Tool.define<typeof RegisterParameters, BoardMetadata, FSUtil.Service | Git.Service>(
  "board_register",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    return {
      description: REGISTER_DESCRIPTION,
      parameters: RegisterParameters,
      execute: (params: Schema.Schema.Type<typeof RegisterParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const raw = (params.path ?? "").trim()
          if (!raw) {
            return {
              title: "board_register: refused",
              metadata: {},
              output: "Refused: path is required — say which folder to put on the board.",
            }
          }
          const target = path.resolve(instance.worktree, raw)
          const refuse = (output: string) => ({
            title: "board_register: refused",
            metadata: { path: target },
            output,
          })

          if (!(yield* fs.existsSafe(target))) {
            return refuse(`Refused: no folder at ${target}. board_register never creates one — check the path.`)
          }
          if (!(yield* fs.isDir(target))) {
            return refuse(`Refused: ${target} is a file, not a folder. Register the repo's root folder.`)
          }

          // A folder inside a repo is never its own card: two cards over one
          // working tree would give the same file two ticket folders. Compare
          // against the real path too — git resolves symlinks and `resolve`
          // does not, so on macOS a repo at /tmp/x (really /private/tmp/x)
          // would otherwise read as nested inside itself.
          const real = yield* fs.realPath(target).pipe(Effect.catch(() => Effect.succeed(target)))
          let toplevel = yield* revParse(git, target, "--show-toplevel")
          if (toplevel && pathKey(toplevel) !== pathKey(target) && pathKey(toplevel) !== pathKey(real)) {
            return refuse(
              `Refused: ${target} is inside the repo at ${toplevel} — register that root instead.` +
                ` The board never nests one repo card inside another.`,
            )
          }

          const name = (params.name ?? "").trim() || path.basename(target)
          if (!toplevel && params.init !== true) {
            return refuse(
              `Refused: ${target} is not a git repo, and the Folds board is git-only —` +
                ` a ticket is a file in the repo it belongs to and travels with it.` +
                ` Call board_register again with init: true to run git init here first.`,
            )
          }

          const repos = yield* readRepos(fs)
          const already = repos.find((entry) => pathKey(entry.root) === pathKey(target))
          if (already) {
            return {
              title: `board_register: ${already.name}`,
              metadata: { path: target, repo: already.name, root: already.root, repos: repos.length },
              output:
                `${already.root} is already on the board as "${already.name}" — nothing to do.` +
                ` Pass repo:"${already.name}" to the other board_* tools.`,
            }
          }

          // One repository, ONE card. A linked worktree is its own toplevel, so
          // only the common git dir can tell it apart from a new repo.
          if (toplevel) {
            const common = yield* revParse(git, target, "--git-common-dir")
            if (common) {
              for (const entry of repos) {
                const other = yield* revParse(git, entry.root, "--git-common-dir")
                if (other && pathKey(other) === pathKey(common)) {
                  return refuse(
                    `Refused: this repository is already on the board as '${entry.name}' (checkout ${entry.root});` +
                      ` use the primary-checkout setting instead of registering a second card.`,
                  )
                }
              }
            }
          }

          // One ask covers both the optional git init and the registry write —
          // they are one act from the user's side, and every refusal above got
          // here without costing a prompt.
          yield* ctx.ask({
            permission: "board",
            patterns: [name],
            always: ["*"],
            metadata: { path: target, name, init: !toplevel },
          })

          if (!toplevel) {
            const init = yield* git.run(["init"], { cwd: target })
            if (init.exitCode !== 0) {
              return refuse(`Refused: git init failed in ${target}: ${firstLine(init.stderr.toString("utf8"))}`)
            }
            toplevel = yield* revParse(git, target, "--show-toplevel")
            if (!toplevel) {
              return refuse(`Refused: git init ran in ${target}, but the folder still does not read as a repo.`)
            }
          }

          const merged = yield* writeRepos(fs, [{ root: target, name, workspace: false, addedAt: Date.now() }])
          return {
            title: `board_register: ${name}`,
            metadata: { path: target, repo: name, root: target, repos: merged.length, registry: reposPath() },
            output: [
              `Registered "${name}" on the Folds board.`,
              `${target}`,
              `Tickets live in ${ticketsDir(target)} — use board_create to add one.`,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// =========================== board_worktrees =============================

export const WorktreesParameters = Schema.Struct({ repo: REPO_PARAM })

const WORKTREES_DESCRIPTION = [
  "List the git checkouts (worktrees) of a repo on the Folds board: one line each, with the branch,",
  "which one is the registered root, and which one holds the tickets.",
  "Read-only. Call it before you assume a repo has only one working copy.",
].join(" ")

export const BoardWorktreesTool = Tool.define<typeof WorktreesParameters, BoardMetadata, FSUtil.Service | Git.Service>(
  "board_worktrees",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    return {
      description: WORKTREES_DESCRIPTION,
      parameters: WorktreesParameters,
      execute: (params: Schema.Schema.Type<typeof WorktreesParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const rootless = rootlessDot(params.repo, instance)
          if (rootless) {
            return { title: "board_worktrees: refused", metadata: { repo: params.repo }, output: rootless }
          }
          const repos = yield* readRepos(fs)
          const repo = resolveRepo(repos, params.repo, instance.worktree)
          if (!repo) {
            return {
              title: "board_worktrees: unknown repo",
              metadata: { repo: params.repo },
              output: unknownRepo(params.repo, repos),
            }
          }

          const primary = primaryRoot(repo)
          const listed = yield* git.run(["worktree", "list", "--porcelain"], { cwd: primary })
          if (listed.exitCode !== 0) {
            return {
              title: "board_worktrees: refused",
              metadata: { repo: repo.name, root: repo.root, primary },
              output:
                `Refused: ${primary} is not a git repo (git said: ${firstLine(listed.stderr.toString("utf8")) || "the folder is not there"}).` +
                ` The Folds board is git-only — fix the entry in ${reposPath()}.`,
            }
          }

          const rows = parseWorktreeList(listed.text())
          if (!rows.length) {
            return {
              title: "board_worktrees: none",
              metadata: { repo: repo.name, root: repo.root, primary, worktrees: 0 },
              output: `git listed no checkouts for ${repo.name} (${primary}).`,
            }
          }

          const lines = rows.map((row) => {
            const where = path.resolve(row.path)
            const at = row.bare ? "(bare)" : (row.branch ?? `detached ${(row.head ?? "").slice(0, 7)}`)
            const bits = [where, at]
            if (pathKey(where) === pathKey(repo.root)) bits.push("[root]")
            if (pathKey(where) === pathKey(primary)) bits.push("[primary]")
            return bits.join("  ")
          })
          return {
            title: `board_worktrees: ${rows.length}`,
            metadata: { repo: repo.name, root: repo.root, primary, worktrees: rows.length },
            output: [
              `${repo.name}  ${rows.length} checkout(s), [root] = the registered one, [primary] = where the tickets live:`,
              ...lines,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

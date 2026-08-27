import path from "path"
import { Effect, Schema } from "effect"
import { createTwoFilesPatch } from "diff"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { SessionV1 } from "@origami/core/v1/session"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Question } from "../question"
import { CAP, normalizeStore, projectMemoryPath, globalMemoryPath } from "./remember"
import { candidateDir, INBOX_TOPIC, indexPath, memoryDir, readStore } from "./memory-layout"
import {
  applyCandidate,
  diffStore,
  discardCandidate,
  mirrorStore,
  readCandidate,
  rejectReason,
  summaryHeadline,
  summaryText,
} from "./dream-stage"
import * as Tool from "./tool"

// "a dozen is plenty" (matches the dream command copy). Bounded so the thin
// transcripts fit a local model's context: ~12 sessions x ~4k chars ~= 12k tokens.
const N_DEFAULT = 12
const N_MAX = 30
const MSG_FETCH_CAP = 200 // newest N messages pulled per session
const PER_SESSION_CHARS = 4000 // head+tail cap on each projected transcript
const PER_TOPIC_CHARS = 2000 // head+tail cap on each topic file echoed by gather
const SUMMARY_CHARS = 3000 // head+tail cap on the summary carried in the question

const DESCRIPTION = [
  "Memory-curation backend for the /dream command. It handles BOTH memory layouts and tells you which one",
  "you are in.",
  "FOLDERED store (memory/ with MEMORY.md + one file per topic):",
  'action:"gather" returns the index, every topic file and thin transcripts of recent sessions, and SEEDS a',
  "candidate DIRECTORY (memory.candidate/) with a copy of the live store. You then EDIT the files in that",
  "directory — refile every inbox.md bullet into a fitting topic, merge duplicates, rewrite a hook that no",
  'longer describes its file, add topics for unfiled themes — and call action:"review".',
  "FLAT store (a single memory.md):",
  'action:"gather" returns the store plus the same transcripts; you WRITE one reorganised memory.candidate.md',
  '(`# Origami Memory` header + `- [YYYY-MM-DD] fact` bullets, 100 max) and call action:"review".',
  'In both layouts action:"review" shows the user what changed and asks Approve/Revise/Disapprove; on Approve',
  "it backs the old store up and adopts the candidate. The live store is NEVER touched except on an explicit",
  "Approve, and dream CURATES — a fact you remove is reported to the user as a drop, so never delete one",
  "silently.",
].join(" ")

export const Parameters = Schema.Struct({
  action: Schema.Literals(["gather", "review"]).annotate({
    description:
      "gather: return the store + recent sessions to synthesise from. review: diff the staged candidate and ask to adopt.",
  }),
  scope: Schema.optional(Schema.Literals(["project", "global"])).annotate({
    description:
      "Which store: project (<worktree>/.origami/memory.md, default) or global (~/.origami/memory.md, cross-project).",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "gather only: how many recent sessions to mine (default 12, max 30).",
  }),
})

type Meta = {
  action: "gather" | "review"
  scope: "project" | "global"
  layout?: "flat" | "foldered"
  sessions?: number
  storePath?: string
  /** Flat layout only — the single staged file. Deliberately absent in the
   *  foldered layout so no client keys a file-vs-file diff off a directory. */
  candidatePath?: string
  candidateDir?: string
  backupDir?: string
  before?: number
  after?: number
  diff?: string
  summary?: string
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

function capText(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.6)
  const tail = max - head - 16
  return `${s.slice(0, head)}\n  ...[trimmed]...\n${s.slice(-tail)}`
}

// Thin projection: role-tagged user/assistant TEXT + tool NAMES only. Tool
// input/output and non-text parts are dropped — noise for durable-fact mining.
function projectThin(msgs: readonly SessionV1.WithParts[]): string[] {
  const out: string[] = []
  for (const m of msgs) {
    const role = m.info.role
    if (role !== "user" && role !== "assistant") continue
    const texts: string[] = []
    const tools: string[] = []
    for (const p of m.parts) {
      if (p.type === "text" && p.text.trim()) texts.push(oneLine(p.text))
      else if (p.type === "tool") tools.push(p.tool)
    }
    if (role === "user") {
      if (texts.length) out.push(`USER: ${texts.join(" ")}`)
    } else {
      if (texts.length) out.push(`ASSISTANT: ${texts.join(" ")}`)
      if (tools.length) out.push(`  [tools: ${tools.join(", ")}]`)
    }
  }
  return out
}

export const DreamTool = Tool.define(
  "dream",
  Effect.gen(function* () {
    // Capture services at DEFINE time so `execute` stays R=never (the
    // session-search.ts / plan.ts pattern). InstanceState.context is the one
    // exception — it resolves from the ambient instance inside execute.
    const fs = yield* FSUtil.Service
    const session = yield* Session.Service
    const question = yield* Question.Service

    // The memory-layout / dream-stage helpers ask for FSUtil themselves (they
    // are shared with migrateMemory, which has no captured service). Feed them
    // the one captured here so `execute` stays R=never like its siblings.
    const withFs = <A, E>(effect: Effect.Effect<A, E, FSUtil.Service>) =>
      effect.pipe(Effect.provideService(FSUtil.Service, fs))

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: { action: "gather" | "review"; scope?: "project" | "global"; limit?: number },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          // Non-git workspaces resolve worktree to "/" (drive root), so a
          // "project" store there lands in C:\.origami — shared across users.
          // Fall back to the per-user global store, matching the remember tool
          // and plans (session.ts plan(): instance.project.vcs gates it).
          const scopeGlobal = params.scope === "global" || !instance.project.vcs
          const scopeLabel: "project" | "global" = scopeGlobal ? "global" : "project"
          const storePath = scopeGlobal ? globalMemoryPath(Global.Path.origami) : projectMemoryPath(instance.worktree)
          const dir = path.dirname(storePath)
          const candidatePath = path.join(dir, "memory.candidate.md")
          const memdir = memoryDir(dir)
          const n = Math.max(1, Math.min(N_MAX, Math.floor(params.limit ?? N_DEFAULT)))

          // Session mining is layout-independent — the transcripts a foldered
          // curation pass reads are exactly the ones the flat pass reads.
          //
          // list() is auto-scoped to the current project and sorted newest-first
          // (desc time_updated); roots:true drops subagent children. Mining is
          // current-project regardless of store scope (global-across-all-projects
          // is a later refinement via listGlobal).
          const mine = Effect.gen(function* () {
            const sessions = yield* session.list({ limit: n + 8, roots: true })
            const picked = sessions.filter((s) => s.id !== ctx.sessionID && s.parentID === undefined).slice(0, n)

            const blocks: string[] = []
            for (const info of picked) {
              const msgs = yield* session
                .messages({ sessionID: info.id, limit: MSG_FETCH_CAP })
                .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))
              const lines = projectThin(msgs) // messages() already returns oldest-first (chronological)
              if (!lines.length) continue
              const when = new Date(info.time.created).toISOString().slice(0, 10)
              blocks.push(`## ${info.title || "(untitled)"} - ${when}\n${capText(lines.join("\n"), PER_SESSION_CHARS)}`)
            }
            return blocks
          })

          // ======================= FOLDERED LAYOUT ========================
          // memory/ is a tree (MEMORY.md + one file per topic), so the curation
          // is tree-shaped: the candidate is a DIRECTORY seeded by mirroring the
          // live store, the model edits inside the mirror, and review reports a
          // per-topic diff of the mirror against the live store. Seeding by
          // mirror is what makes "curate, never discard silently" enforceable —
          // anything missing from the candidate was actively removed, and
          // diffStore lists every one of those for the user to veto.
          const foldered = yield* fs.existsSafe(indexPath(memdir))
          if (foldered) {
            const cdir = candidateDir(dir)

            if (params.action === "gather") {
              const live = yield* withFs(readStore(memdir))
              const blocks = yield* mine

              // An empty store with nothing to mine has no curation to propose.
              // Staging a mirror of nothing would only invite the model to
              // invent facts, so stage nothing and say why. Any stale candidate
              // from an abandoned pass goes too — gather owns its lifecycle.
              if (live.topics.size === 0 && blocks.length === 0) {
                yield* withFs(discardCandidate(dir))
                const meta: Meta = {
                  action: "gather",
                  scope: scopeLabel,
                  layout: "foldered",
                  sessions: 0,
                  storePath: memdir,
                }
                return {
                  title: "dream: nothing to curate",
                  metadata: meta,
                  output:
                    `The ${scopeLabel} memory store at ${memdir} has no topic files and there are no recent` +
                    ` sessions to mine, so there is nothing to curate. NOTHING was staged and the store is` +
                    ` untouched. Do not call dream action:"review" — report that this dream was a no-op.`,
                }
              }

              const mirror = yield* withFs(mirrorStore(dir))
              const topicBlocks = [...live.topics].map(
                ([name, text]) => `### ${name}.md\n${capText(text, PER_TOPIC_CHARS)}`,
              )
              const hasInbox = live.topics.has(INBOX_TOPIC)

              const meta: Meta = {
                action: "gather",
                scope: scopeLabel,
                layout: "foldered",
                sessions: blocks.length,
                storePath: memdir,
                candidateDir: cdir,
              }
              const output = [
                `SCOPE: ${scopeLabel}   LAYOUT: foldered   STORE: ${memdir}`,
                `--- INDEX (${indexPath(memdir)}) ---`,
                live.index || "(empty index)",
                `--- TOPIC FILES (${live.topics.size}) ---`,
                topicBlocks.join("\n\n") || "(no topic files)",
                `--- RECENT SESSIONS (${blocks.length}) ---`,
                blocks.join("\n\n") || "(none to mine)",
                [
                  `STAGED: ${cdir} now holds a copy of all ${mirror.files} topic file(s) plus the index.`,
                  "CURATE BY EDITING THE FILES IN THAT DIRECTORY (edit/write tools) — never the live store.",
                  hasInbox
                    ? `1. REFILE ${INBOX_TOPIC}.md: move EVERY bullet into a fitting existing topic file, or a new` +
                      ` topic file when none fits. ${INBOX_TOPIC}.md must end up empty (or deleted).`
                    : `1. There is no ${INBOX_TOPIC}.md to refile.`,
                  "2. MERGE duplicates and near-duplicates, within a topic and across topics that cover one subject.",
                  "3. REWRITE the hook in MEMORY.md for any topic whose file has drifted from what its hook claims," +
                    " and add an entry for every topic file you create.",
                  "4. ADD durable new facts from the sessions above, dated `- [YYYY-MM-DD] fact`, to the topic they" +
                    " belong to.",
                  "EVERY EXISTING FACT MUST REMAIN FINDABLE. Move and reword freely; delete only a fact that is" +
                    " stale or contradicted, because review lists every deletion to the user verbatim.",
                  `Then call dream action:"review" scope:"${scopeLabel}".`,
                ].join("\n"),
              ].join("\n\n")
              return {
                title: `dream: gathered ${blocks.length} session(s), staged ${mirror.files} topic file(s)`,
                metadata: meta,
                output,
              }
            }

            // ------------------------ foldered review ---------------------
            const candidate = yield* withFs(readCandidate(dir))
            if (candidate.topics.size === 0 && !candidate.index.trim()) {
              const meta: Meta = { action: "review", scope: scopeLabel, layout: "foldered", candidateDir: cdir }
              return {
                title: "dream: no candidate",
                metadata: meta,
                output: `No staged candidate at ${cdir}. Call dream action:"gather" first — it seeds that directory with a copy of the live store for you to curate.`,
              }
            }

            const live = yield* withFs(readStore(memdir))
            const reason = rejectReason(live, candidate)
            if (reason) {
              const meta: Meta = { action: "review", scope: scopeLabel, layout: "foldered", candidateDir: cdir }
              return {
                title: "dream: candidate rejected",
                metadata: meta,
                output: `Refusing to review the candidate at ${cdir}: ${reason}. The live store is untouched. Restage it (re-run dream action:"gather") and edit the copied files instead of replacing the directory.`,
              }
            }

            const diff = diffStore(live, candidate)
            if (!diff.changed) {
              yield* withFs(discardCandidate(dir))
              const meta: Meta = { action: "review", scope: scopeLabel, layout: "foldered", storePath: memdir }
              return {
                title: "dream: no changes",
                metadata: meta,
                output: `The candidate is identical to the live ${scopeLabel} store — nothing to approve. The candidate was discarded and the store is untouched. Report that this dream proposed no changes.`,
              }
            }

            const summary = summaryText(diff)
            const headline = summaryHeadline(diff)
            const meta: Meta = {
              action: "review",
              scope: scopeLabel,
              layout: "foldered",
              storePath: memdir,
              candidateDir: cdir,
              summary,
            }

            // Same Approve/Revise/Disapprove UX as the flat path. There is no
            // file-vs-file diff to open here, so the per-topic summary travels
            // IN the question — the user approves off the text they can see.
            // Middle option MUST be named "Revise" (clients reveal a free-text
            // box for it).
            const answers = yield* question
              .ask({
                sessionID: ctx.sessionID,
                questions: [
                  {
                    question: `Adopt the curated memory? (${scopeLabel} store — ${headline})\n\n${capText(summary, SUMMARY_CHARS)}`,
                    header: "Dream",
                    custom: false,
                    options: [
                      { label: "Approve", description: "Back up the store, then replace it with the curated version" },
                      { label: "Revise", description: "Keep the store and the draft; type what to change" },
                      { label: "Disapprove", description: "Discard the draft; leave the store exactly as it is" },
                    ],
                  },
                ],
                tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
              })
              // A dismissed/rejected question means "don't adopt" — Disapprove.
              .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ReadonlyArray<string>>)))
            const choice = answers[0]?.[0]

            if (choice === "Approve") {
              const applied = yield* withFs(applyCandidate(dir))
              return {
                title: "dream: adopted",
                metadata: { ...meta, backupDir: applied.backup } satisfies Meta,
                output:
                  `Adopted the curated ${scopeLabel} store at ${memdir} (${applied.written} file(s) written,` +
                  ` ${applied.removed} removed). The previous store was backed up to ${applied.backup} —` +
                  ` nothing was overwritten there.\n\n${summary}`,
              }
            }
            if (choice === "Revise") {
              // The candidate SURVIVES a Revise here, unlike the flat path. A
              // flat candidate is one file the model can regenerate from its own
              // context; a foldered one is a tree built over many edits, and
              // deleting it would throw that away and force a full re-gather.
              return {
                title: "dream: revise",
                metadata: meta,
                output:
                  `Revise chosen — the live store is untouched and your draft is still staged at ${cdir}.` +
                  ` Wait for the user's steer, apply it by editing the files in that directory, then call dream` +
                  ` action:"review" scope:"${scopeLabel}" again.`,
              }
            }
            yield* withFs(discardCandidate(dir))
            return {
              title: "dream: discarded",
              metadata: meta,
              output: `Disapproved (or dismissed) — the ${scopeLabel} store is untouched and the staged draft was deleted.`,
            }
          }

          // ========================= FLAT LAYOUT ==========================
          // ---------------------------- gather ----------------------------
          if (params.action === "gather") {
            const store = (yield* fs.readFileStringSafe(storePath)) ?? ""
            const blocks = yield* mine

            const meta: Meta = {
              action: "gather",
              scope: scopeLabel,
              layout: "flat",
              sessions: blocks.length,
              storePath,
            }
            const output = [
              `SCOPE: ${scopeLabel}   STORE: ${storePath}`,
              "--- CURRENT STORE ---",
              store || "(empty - propose a fresh store)",
              `--- RECENT SESSIONS (${blocks.length}) ---`,
              blocks.join("\n\n") || "(none to mine)",
              `Now synthesise the reorganised store (merge duplicates, drop stale, add durable new facts, <=${CAP} bullets,` +
                ` exact "# Origami Memory" header + "- [YYYY-MM-DD] fact" bullets). Write it to ${candidatePath} with the` +
                ` write tool, then call dream action:"review" scope:"${scopeLabel}".`,
            ].join("\n\n")
            return { title: `dream: gathered ${blocks.length} session(s)`, metadata: meta, output }
          }

          // ---------------------------- review ----------------------------
          const candidateRaw = yield* fs.readFileStringSafe(candidatePath)
          if (candidateRaw === undefined || !candidateRaw.trim()) {
            const meta: Meta = { action: "review", scope: scopeLabel, layout: "flat", candidatePath }
            return {
              title: "dream: no candidate",
              metadata: meta,
              output: `No candidate found at ${candidatePath}. Write the reorganised store there with the write tool first, then call dream action:"review".`,
            }
          }
          // Coerce to the canonical header + capped bullets so the adopted store
          // stays remember-compatible regardless of small formatting slips.
          const candidate = normalizeStore(candidateRaw)
          const store = (yield* fs.readFileStringSafe(storePath)) ?? ""
          const before = (store.match(/^- .*/gm) ?? []).length
          const after = (candidate.match(/^- .*/gm) ?? []).length

          // SAFETY: a non-blank candidate that normalises to zero bullets means
          // the model's facts weren't top-level "- " lines — adopting it would
          // wipe the store. Refuse rather than overwrite good facts with nothing.
          if (after === 0) {
            const meta: Meta = { action: "review", scope: scopeLabel, layout: "flat", before, after, candidatePath }
            return {
              title: "dream: candidate rejected",
              metadata: meta,
              output: `The candidate at ${candidatePath} has no "- " bullets after normalisation, so adopting it would empty the store. Reformat every fact as a top-level "- [YYYY-MM-DD] fact" line (no "*", no indentation, no section headers), rewrite memory.candidate.md, then call dream action:"review" again.`,
            }
          }

          // Rewrite the candidate file with the NORMALISED text BEFORE asking, so
          // the diff the user reviews (the shell opens vscode.diff of this file)
          // is byte-for-byte what Approve adopts — no approve-vs-adopt divergence.
          yield* fs.writeWithDirs(candidatePath, candidate)

          const rel = (path.relative(instance.worktree, storePath) || "memory.md").replaceAll("\\", "/")
          const diff = createTwoFilesPatch(rel, rel, store, candidate, "current", "proposed")
          const meta: Meta = {
            action: "review",
            scope: scopeLabel,
            layout: "flat",
            before,
            after,
            diff,
            storePath,
            candidatePath,
          }

          // The permission title carries "reorganised memory" so the VS Code shell
          // opens a vscode.diff of the live store vs the staged candidate. Middle
          // option MUST be named "Revise" (clients reveal a free-text box for it).
          const answers = yield* question
            .ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  question: `Adopt the reorganised memory? (${scopeLabel} store, ${before} -> ${after} bullets)`,
                  header: "Dream",
                  custom: false,
                  options: [
                    { label: "Approve", description: "Overwrite the live store with the reorganised version" },
                    { label: "Revise", description: "Keep the store; type what to change, then re-run dream" },
                    { label: "Disapprove", description: "Discard the candidate; leave the store exactly as it is" },
                  ],
                },
              ],
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            })
            // A dismissed/rejected question means "don't adopt" — treat as Disapprove.
            .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ReadonlyArray<string>>)))
          const choice = answers[0]?.[0]

          const cleanup = fs.remove(candidatePath).pipe(Effect.catch(() => Effect.void))

          if (choice === "Approve") {
            // Back up the current store first (reversible), then overwrite it in
            // place. A plain overwrite (not tmp+rename) because the vscode.diff
            // view holds memory.md open, and MoveFileEx over an open file fails on
            // Windows — a direct write succeeds and VS Code reloads. The file is a
            // few KB, and memory.bak.md (written first) covers a crash mid-write.
            // No permission prompt (purpose-built, like the remember tool).
            if (store) yield* fs.writeWithDirs(path.join(dir, "memory.bak.md"), store)
            yield* fs.writeWithDirs(storePath, candidate)
            yield* cleanup
            return {
              title: "dream: adopted",
              metadata: meta,
              output: `Adopted the reorganised ${scopeLabel} store (${after} bullets) at ${storePath}. Previous version backed up to memory.bak.md.`,
            }
          }
          if (choice === "Revise") {
            yield* cleanup
            return {
              title: "dream: revise",
              metadata: meta,
              output:
                'Revise chosen — the live store is untouched. Wait for the user\'s steer, then regenerate the candidate (write it to memory.candidate.md) and call dream action:"review" again.',
            }
          }
          yield* cleanup
          return {
            title: "dream: discarded",
            metadata: meta,
            output: `Disapproved (or dismissed) — the ${scopeLabel} store is untouched.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

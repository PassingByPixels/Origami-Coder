// rewrite-tool-titles.ts (t-q90p6v) — ONE-OFF repair of tool-card titles already on disk.
//
// WHY. A card's identity arrives spread across stream frames: the PENDING frame has the bare tool
// name and a partial input (bash carried only `{cwd}`), the RUNNING frame has the real title, the
// COMPLETED frame has the resolved title but no input. The host's session archive kept the PENDING
// title on the call and replaced the result with the LAST frame, so a reopened chat showed `bash`,
// `Edit: edit`, `read` where the live card showed the command and the path. The write side is fixed
// (packages/vscode/src/dashboard/sessionLog.ts + acp/tool.ts completedToolUpdate); this script
// repairs what was written before that.
//
// WHAT IT TOUCHES. Two stores, either or both:
//   --sessions <dir>   the host's chat archives, ~/.origami/sessions/*.json  <- the broken one
//   --db <path>        the engine store, ~/.local/share/origami/origami.db (`part` rows)
// Measured on the owner's live copy 2026-09-21: the archives are the defect; the db's stored parts
// already carry good titles and full inputs, so a db pass is close to a no-op. It is kept because
// the db is the store a future client restores from, and a bare title there is still wrong.
//
// SAFETY. `--dry-run` is the default and writes nothing. `--apply` refuses to run until a backup
// `<file>.bak-YYYY-MM-DD` exists; the script makes it itself and re-checks it on disk before the
// first write. It is idempotent: a row is rewritten only when the derived title differs from the
// stored one, so a second pass rewrites 0.
//
// Usage:
//   bun run script/rewrite-tool-titles.ts --sessions <dir> [--db <path>]        # dry run
//   bun run script/rewrite-tool-titles.ts --sessions <dir> --apply

import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type Counts = {
  scanned: number
  rewritten: number
  skipped: Record<string, number>
}

export function emptyCounts(): Counts {
  return { scanned: 0, rewritten: 0, skipped: {} }
}

function skip(counts: Counts, reason: string) {
  counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1
}

const SHELL_TOOLS = new Set(["bash", "shell"])

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function firstLine(value: string) {
  return value.split(/\r?\n/)[0]?.trim() ?? ""
}

/** The one-file path, or "N files", a patch header carries — the same reading acp/tool.ts does. */
function patchTitle(patchText: unknown): string | undefined {
  const body = text(patchText)
  if (!body) return undefined
  const files = body
    .split(/\r?\n/)
    .map((line) => ["*** Add File:", "*** Delete File:", "*** Update File:"].find((p) => line.startsWith(p)) && line)
    .filter((line): line is string => !!line)
    .map((line) => line.slice(line.indexOf(":") + 1).trim())
    .filter(Boolean)
  if (files.length === 1) return files[0]
  if (files.length > 1) return `${files.length} files`
  return undefined
}

/**
 * The title a live card showed, rebuilt from what is stored. Mirrors acp/tool.ts `toolTitle`:
 * a shell reads `explanation ?? command`, apply_patch reads its patch header, and every other tool
 * already had the right answer on a LATER frame — `stored` is that frame's title (the archive keeps
 * it on the entry's own `text` and on `tool.result.title`).
 *
 * Returns undefined when nothing better than the bare tool name can be derived; the caller then
 * skips the row rather than inventing a title.
 */
export function derivedTitle(
  toolName: string,
  input: Record<string, unknown> | undefined,
  stored: string | undefined,
): string | undefined {
  const key = toolName.toLocaleLowerCase()
  const fields = input ?? {}
  const better = stored && firstLine(stored) && firstLine(stored).toLocaleLowerCase() !== key ? firstLine(stored) : undefined
  if (SHELL_TOOLS.has(key)) return text(fields.explanation) ?? text(fields.command) ?? text(fields.cmd) ?? better
  if (key === "apply_patch") return patchTitle(fields.patchText) ?? better
  return better
}

/** A title that is empty, or only the tool's own name, is the PLACEHOLDER the pending frame wrote. */
export function isPlaceholderTitle(toolName: string, title: unknown): boolean {
  const value = typeof title === "string" ? title.trim() : ""
  return !value || value.toLocaleLowerCase() === toolName.toLocaleLowerCase()
}

type ToolEntry = {
  kind?: string
  text?: string
  tool?: { call?: Record<string, unknown>; result?: Record<string, unknown> }
}

/**
 * Repair one host archive in memory. Returns whether anything changed, so the caller only rewrites
 * files it had to. Idempotent by construction: a call whose title is no longer a placeholder is
 * skipped.
 */
export function rewriteSessionArchive(archive: { messages?: ToolEntry[] }, counts: Counts): boolean {
  let changed = false
  for (const entry of archive.messages ?? []) {
    if (entry.kind !== "tool") continue
    const call = entry.tool?.call
    if (!call) {
      skip(counts, "no-payload (archive written before the card fix)")
      continue
    }
    counts.scanned++
    const toolName = text(call.toolName) ?? ""
    if (!toolName) {
      skip(counts, "no toolName")
      continue
    }
    if (!isPlaceholderTitle(toolName, call.title)) {
      skip(counts, "title already resolved")
      continue
    }
    const input = (call.rawInput ?? entry.tool?.result?.rawInput) as Record<string, unknown> | undefined
    const stored = text(entry.tool?.result?.title) ?? text(entry.text)
    const title = derivedTitle(toolName, input, stored)
    if (!title) {
      skip(counts, "no title derivable from the stored input")
      continue
    }
    call.title = title
    counts.rewritten++
    changed = true
  }
  return changed
}

type ToolPart = { type?: string; tool?: string; state?: { title?: unknown; input?: Record<string, unknown> } }

/** Repair one engine `part` row in memory. Same rules; the part's own `state.input` is the source. */
export function rewriteToolPart(part: ToolPart, counts: Counts): boolean {
  if (part.type !== "tool" || !part.state) return false
  counts.scanned++
  const toolName = text(part.tool) ?? ""
  if (!toolName) {
    skip(counts, "no tool name")
    return false
  }
  if (!isPlaceholderTitle(toolName, part.state.title)) {
    skip(counts, "title already resolved")
    return false
  }
  const title = derivedTitle(toolName, part.state.input, text(part.state.title))
  if (!title) {
    skip(counts, "no title derivable from the stored input")
    return false
  }
  part.state.title = title
  return true
}

function backupPath(target: string) {
  const day = new Date().toISOString().slice(0, 10)
  return `${target}.bak-${day}`
}

/** `--apply` writes nothing until a dated backup of the target exists on disk. */
function ensureBackup(target: string) {
  const backup = backupPath(target)
  if (!existsSync(backup)) copyFileSync(target, backup)
  if (!existsSync(backup)) throw new Error(`refusing to write ${target}: backup ${backup} was not created`)
  return backup
}

async function runSessions(dir: string, apply: boolean): Promise<Counts> {
  const counts = emptyCounts()
  const files = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir, onlyFiles: true }))).toSorted()
  for (const name of files) {
    const path = join(dir, name)
    let archive: { messages?: ToolEntry[] }
    try {
      archive = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      skip(counts, "file is not readable JSON")
      continue
    }
    const changed = rewriteSessionArchive(archive, counts)
    if (changed && apply) {
      ensureBackup(path)
      writeFileSync(path, JSON.stringify(archive), "utf8")
    }
  }
  console.log(`sessions: ${files.length} file(s) in ${dir}`)
  return counts
}

function runDb(path: string, apply: boolean): Counts {
  const counts = emptyCounts()
  if (apply) ensureBackup(path)
  const db = new Database(path, apply ? { readwrite: true } : { readonly: true })
  const update = apply ? db.prepare("update part set data = ? where id = ?") : undefined
  for (const row of db.query<{ id: string; data: string }, []>("select id, data from part").iterate()) {
    let part: ToolPart
    try {
      part = JSON.parse(row.data)
    } catch {
      skip(counts, "part row is not readable JSON")
      continue
    }
    if (part.type !== "tool") continue
    if (!rewriteToolPart(part, counts)) continue
    counts.rewritten++
    update?.run(JSON.stringify(part), row.id)
  }
  db.close()
  return counts
}

function report(label: string, counts: Counts, apply: boolean) {
  console.log(`\n${label} — ${apply ? "APPLIED" : "dry run, nothing written"}`)
  console.log(`  scanned:   ${counts.scanned}`)
  console.log(`  rewritten: ${counts.rewritten}`)
  const skipped = Object.entries(counts.skipped).toSorted((a, b) => b[1] - a[1])
  console.log(`  skipped:   ${skipped.reduce((sum, [, n]) => sum + n, 0)}`)
  for (const [reason, n] of skipped) console.log(`    ${n}  ${reason}`)
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

async function main(argv: string[]) {
  const apply = argv.includes("--apply")
  const db = flag(argv, "--db")
  const sessions = flag(argv, "--sessions")
  if (!db && !sessions) {
    console.error("usage: bun run script/rewrite-tool-titles.ts [--sessions <dir>] [--db <path>] [--dry-run|--apply]")
    process.exitCode = 1
    return
  }
  if (apply) console.log("apply mode: a dated .bak-<date> is made beside each target before it is written")
  if (sessions) report(`sessions ${sessions}`, await runSessions(sessions, apply), apply)
  if (db) report(`db ${db}`, runDb(db, apply), apply)
}

if (import.meta.main) await main(Bun.argv.slice(2))

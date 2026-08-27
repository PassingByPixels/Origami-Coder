import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@origami/core/fs-util"

/**
 * FOLDERED MEMORY LAYOUT.
 *
 * The agent's memory used to be ONE flat file (`.origami/memory.md`) loaded in
 * full on every turn - so every fact the agent ever kept was paid for in tokens
 * on every request, and a 100-bullet cap was the only brake.
 *
 * The layout this module defines instead is:
 *
 *   <memdir>/MEMORY.md    the INDEX - one line per topic file, ALWAYS loaded
 *   <memdir>/<topic>.md   one topic per file, loaded ON DEMAND by the model
 *
 * `<memdir>` is `~/.origami/memory/` (global) or `<worktree>/.origami/memory/`
 * (project). Recall works with the model's EXISTING `read` tool: the index is
 * served with an instruction footer naming the directory, so a hook the model
 * cares about becomes a normal file read. No search index, no new tool.
 *
 * Every path convention lives HERE so the reader (session/instruction.ts) and
 * the writers (tool/remember.ts, tool/dream.ts) cannot drift apart.
 */

/** Index filename. Upper-case so it sorts first and reads as "the catalog". */
export const INDEX_FILE = "MEMORY.md"

/** Directory name holding the index + topic files, inside a `.origami` dir. */
export const MEMORY_DIR = "memory"

/** Header the index is normalised to when this module has to create one. */
export const INDEX_HEADER = "# Memory Index"

/** Section new entries are appended under when the index has no home for them. */
export const INDEX_SECTION = "## Topics"

/** Topic used when the caller does not name one. */
export const DEFAULT_TOPIC = "general"

/** Where a flat-file store is parked after migration. Kept, never deleted. */
export const MIGRATED_FLAT_FILE = "memory.flat-migrated.md"

/** Bullets rescued from the flat file that no topic file already covers. */
export const INBOX_TOPIC = "inbox"

/** Index hook for the inbox — it is a bucket, so it describes itself. */
export const INBOX_HOOK = "Unfiled bullets rescued from the old flat memory file — refile these into topics."

/**
 * Directory a dream curation pass is staged in, a SIBLING of `memory/` inside
 * the same `.origami` dir. A sibling (not a child) so a half-staged candidate
 * can never be read as part of the live store by the index reader.
 */
export const CANDIDATE_DIR = "memory.candidate"

/** Prefix of a pre-approve backup directory: `memory.bak-<stamp>`. */
export const BACKUP_PREFIX = "memory.bak-"

/** Hook text is a one-liner; longer facts are elided in the index only. */
const HOOK_MAX = 160

/** Legacy single-file store: `<origamiDir>/memory.md`. */
export function flatMemoryPath(origamiDir: string): string {
  return path.join(origamiDir, "memory.md")
}

/** Foldered store directory: `<origamiDir>/memory/`. */
export function memoryDir(origamiDir: string): string {
  return path.join(origamiDir, MEMORY_DIR)
}

/** The always-loaded index inside a memory directory. */
export function indexPath(memdir: string): string {
  return path.join(memdir, INDEX_FILE)
}

/** A topic file inside a memory directory. */
export function topicPath(memdir: string, topic: string): string {
  return path.join(memdir, `${topicSlug(topic)}.md`)
}

/** Staged curation directory: `<origamiDir>/memory.candidate/`. */
export function candidateDir(origamiDir: string): string {
  return path.join(origamiDir, CANDIDATE_DIR)
}

/** A pre-approve backup directory: `<origamiDir>/memory.bak-<stamp>/`. */
export function backupDir(origamiDir: string, stamp: string): string {
  return path.join(origamiDir, `${BACKUP_PREFIX}${stamp}`)
}

/**
 * Filesystem-safe stamp for a backup directory name: `20260805-143012`.
 * Colons are illegal in Windows filenames, so the ISO time is stripped rather
 * than used raw. Second resolution only — two approves inside one second
 * collide, which is why the caller must still probe for a free name.
 */
export function backupStamp(when: Date): string {
  const iso = when.toISOString()
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`
}

/**
 * Normalise a free-text topic to a filesystem-safe kebab slug. Everything that
 * is not a letter, digit or underscore collapses to a single "-"; the result is
 * lower-cased and trimmed of leading/trailing separators. Underscores SURVIVE
 * because the existing hand-authored topic files use them
 * (`reference_gitea`, `feedback_edit_chunking`) and re-slugging them would
 * orphan every one. An empty result falls back to `general`.
 */
export function topicSlug(raw: string | undefined): string {
  const slug = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || DEFAULT_TOPIC
}

/**
 * True when this path is a memory INDEX - i.e. `<something>/memory/MEMORY.md`.
 * The reader uses it to decide which loaded file gets the instruction footer.
 * Both segments are checked so an unrelated `MEMORY.md` elsewhere in a repo is
 * never mistaken for the agent's index.
 */
export function isIndexPath(filepath: string): boolean {
  const parsed = path.parse(path.resolve(filepath))
  return parsed.base === INDEX_FILE && path.basename(parsed.dir) === MEMORY_DIR
}

/**
 * The instruction footer appended to the index AS SERVED into the prompt -
 * never written to the file. Without it the model treats the index as the whole
 * memory; with it, a hook is an invitation to read the topic file first.
 */
export function indexFooter(memdir: string): string {
  return [
    "",
    "Read the topic file with the read tool for detail before acting on a hook.",
    `Memory directory: ${memdir}`,
  ].join("\n")
}

/** Collapse a fact to a single line and elide it to index-entry length. */
export function oneLineHook(fact: string, max = HOOK_MAX): string {
  const clean = fact.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

/** The exact index line for a topic file. */
export function indexEntry(name: string, hook: string): string {
  return `- [${name}](${name}.md) - ${oneLineHook(hook)}`
}

/** Topic names an index already links to, in file order. */
export function indexedTopics(index: string): string[] {
  const names: string[] = []
  for (const match of index.matchAll(/^- \[([^\]]+)\]\(([^)]+)\.md\)/gm)) {
    const name = match[2] ?? match[1]
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Hook TEXT per topic, keyed by topic name. The counterpart of `indexedTopics`
 * for a curation pass, which has to tell "this topic gained an entry" from
 * "this topic's hook was rewritten because the file drifted from it".
 */
export function indexHooks(index: string): Map<string, string> {
  const hooks = new Map<string, string>()
  for (const match of index.matchAll(/^- \[([^\]]+)\]\(([^)]+)\.md\)\s*-?\s*(.*)$/gm)) {
    const name = match[2] ?? match[1]
    if (name && !hooks.has(name)) hooks.set(name, (match[3] ?? "").trim())
  }
  return hooks
}

/**
 * Insert an index line for `name` when the index has none.
 *
 * NOT a blind overwrite: an entry that already exists is left BYTE-IDENTICAL,
 * hook and section placement included. The hooks are curated (by hand, or by
 * dream) and describe the topic as a whole - replacing one with whatever fact
 * happened to be remembered last would make the index describe only the newest
 * bullet, which is strictly worse than leaving it be. New entries land under
 * `## Topics` (created at the end if missing) so they are visibly uncategorised
 * until someone files them.
 */
export function upsertIndexEntry(index: string, name: string, hook: string): string {
  if (indexedTopics(index).includes(name)) return index

  const entry = indexEntry(name, hook)
  const base = index.trim() ? index.replace(/\s+$/, "") : INDEX_HEADER
  const lines = base.split("\n")
  const section = lines.findIndex((line) => line.trim() === INDEX_SECTION)

  if (section === -1) return `${base}\n\n${INDEX_SECTION}\n${entry}\n`

  // Append at the END of the Topics section - i.e. just before the next "## "
  // header, or at the end of the file when Topics is last.
  let end = lines.length
  for (let i = section + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i
      break
    }
  }
  while (end > section + 1 && lines[end - 1].trim() === "") end--
  lines.splice(end, 0, entry)
  return `${lines.join("\n").replace(/\s+$/, "")}\n`
}

/** Drop index lines whose topic file is not in `existing`. */
export function pruneIndexEntries(index: string, existing: readonly string[]): string {
  const keep = new Set(existing)
  const lines = index.split("\n").filter((line) => {
    const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\.md\)/)
    if (!match) return true
    return keep.has(match[2] ?? match[1])
  })
  return `${lines.join("\n").replace(/\s+$/, "")}\n`
}

/**
 * Append one dated bullet to a topic file's text.
 *
 * Deliberately NOT `normalizeStore` (the flat-file rule): topic files are
 * hand-authored prose with YAML frontmatter, and normalising to "header + the
 * bullets we could regex out" would delete all of it. Deliberately UNCAPPED
 * too - the cap existed because the flat file was loaded whole on every turn,
 * and a topic file is only read on demand, so length costs nothing until it is
 * asked for.
 */
export function appendTopicFact(existing: string, topic: string, fact: string, date: string): string {
  const clean = fact.replace(/\s+/g, " ").trim()
  const bullet = `- [${date}] ${clean}`
  const body = existing.replace(/\s+$/, "")
  if (!body) return `# ${topic}\n\n${bullet}\n`
  return `${body}\n${bullet}\n`
}

/** Bullet lines (`- ...`) of a store, verbatim. */
export function bulletsOf(text: string): string[] {
  return text.match(/^- .*/gm) ?? []
}

/**
 * Comparable form of a bullet: date prefix dropped, whitespace collapsed,
 * lower-cased. Migration uses it to tell "this flat bullet is already covered
 * by a topic file" from "this one would be lost".
 */
export function bulletKey(line: string): string {
  return line
    .replace(/^-\s*/, "")
    .replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

export type MigrationResult = {
  /** The memory directory the layout now lives in. */
  readonly memdir: string
  /** Topic files present after the migration (index excluded), sorted. */
  readonly topics: readonly string[]
  /** Flat bullets that no topic file covered, parked in `inbox.md`. */
  readonly rescued: number
  /** Flat bullets already covered by a topic file, dropped as duplicates. */
  readonly skipped: number
  /** Where the flat file was renamed to, when there was one. */
  readonly flatArchived?: string
}

/**
 * Turn a `.origami` directory that holds a flat `memory.md` - and possibly a
 * half-finished `memory/` split - into the foldered layout.
 *
 * Rules, in order:
 *  1. Existing topic files are KEPT untouched. A prior split is an asset.
 *  2. Every flat bullet NOT already present in some topic file is appended,
 *     dated, to `<memdir>/inbox.md`. Nothing is silently dropped.
 *  3. The index is rebuilt to list every topic file - curated entries and
 *     their sections survive, entries for vanished files are pruned, missing
 *     files gain an entry hooked off their first meaningful line.
 *  4. The flat file is RENAMED to `memory.flat-migrated.md`. Never deleted:
 *     if step 2's duplicate detection was wrong, the original is right there.
 *
 * Idempotent - a second run finds no flat file, rescues nothing, and rebuilds
 * the same index.
 */
export const migrateMemory = Effect.fn("Memory.migrate")(function* (origamiDir: string) {
  const fs = yield* FSUtil.Service
  const memdir = memoryDir(origamiDir)
  const flat = flatMemoryPath(origamiDir)

  yield* fs.ensureDir(memdir)

  const topicFiles = yield* listTopicFiles(fs, memdir)
  const covered = new Set<string>()
  for (const name of topicFiles) {
    const text = (yield* fs.readFileStringSafe(topicPath(memdir, name))) ?? ""
    for (const bullet of bulletsOf(text)) covered.add(bulletKey(bullet))
  }

  // `undefined` = absent OR unreadable. Either way there is nothing to rescue
  // and nothing to archive, and the flat file must NOT be removed - a
  // permission error must not turn into data loss.
  const flatText = yield* fs.readFileStringSafe(flat)
  let rescued = 0
  let skipped = 0
  if (flatText && flatText.trim()) {
    const missing: string[] = []
    for (const bullet of bulletsOf(flatText)) {
      const key = bulletKey(bullet)
      if (!key) continue
      if (covered.has(key)) {
        skipped++
        continue
      }
      covered.add(key)
      missing.push(bullet)
      rescued++
    }
    if (missing.length > 0) {
      const inboxFile = topicPath(memdir, INBOX_TOPIC)
      const existing = (yield* fs.readFileStringSafe(inboxFile)) ?? ""
      const body = existing.replace(/\s+$/, "")
      const head = body || `# ${INBOX_TOPIC}`
      yield* fs.writeWithDirs(inboxFile, `${head}\n${missing.join("\n")}\n`)
    }
  }

  const finalTopics = yield* listTopicFiles(fs, memdir)
  const indexFile = indexPath(memdir)
  let index = (yield* fs.readFileStringSafe(indexFile)) ?? ""
  index = pruneIndexEntries(index.trim() ? index : INDEX_HEADER, finalTopics)
  for (const name of finalTopics) {
    // inbox is a known bucket, not a subject: hooking it off whatever bullet
    // happened to land first describes one rescued fact instead of the file.
    if (name === INBOX_TOPIC) {
      index = upsertIndexEntry(index, name, INBOX_HOOK)
      continue
    }
    const text = (yield* fs.readFileStringSafe(topicPath(memdir, name))) ?? ""
    index = upsertIndexEntry(index, name, firstHook(text) || name)
  }
  yield* fs.writeWithDirs(indexFile, index)

  let flatArchived: string | undefined
  if (flatText !== undefined) {
    flatArchived = path.join(origamiDir, MIGRATED_FLAT_FILE)
    yield* fs.writeWithDirs(flatArchived, flatText)
    yield* fs.remove(flat).pipe(Effect.catch(() => Effect.void))
  }

  return {
    memdir,
    topics: finalTopics,
    rescued,
    skipped,
    ...(flatArchived ? { flatArchived } : {}),
  } satisfies MigrationResult
})

/** Topic file names in a memory directory (index and non-markdown excluded). */
export function listTopicFiles(fs: FSUtil.Interface, memdir: string) {
  return Effect.gen(function* () {
    const entries = yield* fs.readDirectoryEntries(memdir).pipe(Effect.catch(() => Effect.succeed([])))
    return entries
      .filter((entry) => entry.type === "file" && entry.name.endsWith(".md") && entry.name !== INDEX_FILE)
      .map((entry) => entry.name.slice(0, -3))
      .sort()
  })
}

/** A foldered store read whole: the index text plus every topic file's text. */
export type StoreSnapshot = {
  /** Index text, `""` when the index file is absent or unreadable. */
  readonly index: string
  /** Topic name -> file text, in sorted topic order. */
  readonly topics: ReadonlyMap<string, string>
}

/**
 * Read a foldered store in full — index plus every topic file.
 *
 * A missing directory reads as an EMPTY snapshot rather than an error: the
 * candidate directory legitimately does not exist before the first gather, and
 * the caller distinguishes "empty" from "absent" by checking `topics.size`.
 */
export const readStore = Effect.fn("Memory.readStore")(function* (memdir: string) {
  const fs = yield* FSUtil.Service
  const names = yield* listTopicFiles(fs, memdir)
  const topics = new Map<string, string>()
  for (const name of names) {
    // Join the on-disk basename VERBATIM — `topicPath` re-slugs, which would
    // point at a different file for any name a slug does not round-trip
    // (upper case, spaces). These names came from the directory listing.
    topics.set(name, (yield* fs.readFileStringSafe(path.join(memdir, `${name}.md`))) ?? "")
  }
  return {
    index: (yield* fs.readFileStringSafe(indexPath(memdir))) ?? "",
    topics,
  } satisfies StoreSnapshot
})

/**
 * First line of a topic file worth using as an index hook: the frontmatter
 * `description:` when there is one, else the first non-empty line that is not
 * frontmatter, a heading, or a fence.
 */
export function firstHook(text: string): string {
  const lines = text.split("\n")
  let inFrontmatter = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (i === 0 && line === "---") {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line === "---") {
        inFrontmatter = false
        continue
      }
      const description = line.match(/^description:\s*(.+)$/)
      if (description) return oneLineHook(description[1].replace(/^["']|["']$/g, ""))
      continue
    }
    if (!line || line.startsWith("#") || line.startsWith("```") || line.startsWith("<!--")) continue
    return oneLineHook(line.replace(/^[-*]\s*/, "").replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, ""))
  }
  return ""
}

export * as MemoryLayout from "./memory-layout"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { MemoryLayout } from "@/tool/memory-layout"
import { AgentBot } from "./bot"

/**
 * PER-BOT MEMORY.
 *
 * A bot is a character that keeps working across sessions, so it needs a store
 * of its own — not the project's, not the user's global one, and above all not
 * a chat session's storage, which is thrown away with the chat.
 *
 * WHERE IT LIVES: `<configDir>/bot/<slug>/memory/`, a SIBLING of the `agent/`
 * directory the definition itself sits in. Keyed to the definition, and outside
 * `agent/` on purpose: the definition loader globs `agent/**` for markdown, so a
 * memory file placed under it would be loaded as an agent definition named
 * `crane.memory/general`. A sibling directory cannot collide.
 *
 * WHAT IT IS: the SAME foldered layout the `remember` tool already writes —
 * `MEMORY.md` plus one file per topic (tool/memory-layout.ts). A different root,
 * not a different format, so one set of path rules governs both and a human can
 * read a bot's memory with the same expectations.
 *
 * THE FENCE. Every path this module produces goes through `resolveInRoot`,
 * which resolves the candidate and REFUSES anything that is not strictly inside
 * the root — traversal, absolute paths, and the prefix-sibling trap
 * (`<root>-evil` starts with `<root>` as a string and is not inside it). The
 * writer never joins a caller-supplied name onto a root directly.
 *
 * CROSS-MODE RULE. A MAIN session never reads a bot memory directory: `dirFor`
 * answers `undefined` for a NATIVE agent (build, plan, general, explore, …),
 * which is what a main session runs. A bot session and a collab participation
 * of the same definition resolve to the SAME directory — the bot's own, and
 * only its own — because the directory is derived from the definition file, not
 * from the session.
 */

/** Directory name holding every bot's private state, beside `agent/`. */
export const BOT_DIR = "bot"

/** Newest facts injected at a bot session's start. */
export const DEFAULT_MAX_ENTRIES = 40

/** Byte ceiling on the injected bullets, before the header and footer. */
export const DEFAULT_MAX_BYTES = 4_000

/** One remembered line, and the topic file it came from. */
export type Entry = { readonly topic: string; readonly line: string }

/** A path that would land outside the bot's own directory. */
export class OutsideRootError extends Error {
  constructor(
    readonly root: string,
    readonly requested: string,
  ) {
    super(`refusing a bot-memory path outside its root: ${requested} is not inside ${root}`)
    this.name = "OutsideRootError"
  }
}

/**
 * One filesystem-safe segment for a definition name.
 *
 * A nested definition is named `team/crane` (config/entry-name.ts keeps the
 * directory in the name), so the slash is FLATTENED rather than followed — a
 * bot's directory is always exactly one level under `bot/`, which is what makes
 * the fence's root a fixed, checkable string.
 */
export function slug(agentName: string): string {
  const cleaned = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned || "bot"
}

/**
 * The config directory a definition file belongs to, or undefined when the file
 * is not where a definition lives.
 *
 * Derived from the FILE, so the store follows the definition: a def in the
 * global config directory keeps its memory there, and a project-local def keeps
 * its memory in the project. `agentName` is required and checked against the
 * file's tail — the loader builds the name from the path, so a mismatch means
 * the caller guessed, and guessing is how a store ends up shared between two
 * bots.
 */
export function configDirOfDef(defFile: string, agentName: string): string | undefined {
  const normalized = defFile.replaceAll("\\", "/")
  const suffix = `${agentName}.md`
  if (!normalized.endsWith(suffix)) return undefined
  const head = normalized.slice(0, normalized.length - suffix.length).replace(/\/+$/, "")
  const base = path.basename(head)
  if (base !== "agent" && base !== "agents") return undefined
  return path.dirname(head)
}

/** `<configDir>/bot/<slug>` — everything one bot privately owns. */
export function root(configDir: string, agentName: string): string {
  return path.join(configDir, BOT_DIR, slug(agentName))
}

/** `<configDir>/bot/<slug>/memory` — the foldered store inside that root. */
export function memoryDir(configDir: string, agentName: string): string {
  return MemoryLayout.memoryDir(root(configDir, agentName))
}

/**
 * Resolve `relative` inside `rootDir`, or throw.
 *
 * `path.relative` is the check, not a `startsWith` on the string: a prefix
 * comparison accepts `<root>-evil`, and a `..` segment can appear anywhere in
 * the path, not just at the front. An empty result means the target IS the
 * root, which is a directory and never a write target.
 */
export function resolveInRoot(rootDir: string, relative: string): string {
  const base = path.resolve(rootDir)
  const target = path.resolve(base, relative)
  const rel = path.relative(base, target)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new OutsideRootError(base, relative)
  return target
}

/**
 * The file one topic writes to. The topic is slugged FIRST (so `../../etc` has
 * already collapsed to `etc`) and then fenced anyway — the slug is the sane
 * path and the fence is the guarantee.
 */
export function topicFile(memdir: string, topic: string | undefined): string {
  return resolveInRoot(memdir, `${MemoryLayout.topicSlug(topic)}.md`)
}

/** The date a bullet carries, or "" when it has none (sorts oldest). */
function dateOf(line: string): string {
  return line.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]/)?.[1] ?? ""
}

/**
 * The system block a bot's memory becomes, or undefined when it has none.
 *
 * BOUNDED TWICE, and both bounds matter. The entry cap keeps a long-lived bot
 * from spending its whole context on its own history; the byte cap keeps ONE
 * enormous remembered line from defeating the entry cap. Newest first, so what
 * a cap drops is always the oldest thing the bot knows.
 *
 * The directory is named in the footer for the same reason the main memory
 * index names its own: the block is a summary, and the bot can read the rest
 * with the ordinary `read` tool when it needs to.
 */
export function block(
  memdir: string,
  entries: readonly Entry[],
  opts: { maxEntries: number; maxBytes: number },
): string | undefined {
  if (entries.length === 0) return undefined
  // Decorated sort: the index keeps same-date bullets in the order the store
  // listed them, so "newest first" never silently reshuffles one day's facts.
  const newest = [...entries]
    .map((entry, index) => ({ entry, index, date: dateOf(entry.line) }))
    .sort((a, b) => (a.date === b.date ? a.index - b.index : b.date.localeCompare(a.date)))
    .slice(0, opts.maxEntries)
    .map((item) => item.entry)

  const kept: string[] = []
  let bytes = 0
  for (const entry of newest) {
    const line = entry.line.trim()
    if (bytes + line.length > opts.maxBytes) break
    kept.push(line)
    bytes += line.length + 1
  }
  if (kept.length === 0) return undefined

  return [
    "## Your memory",
    "Facts you kept in earlier sessions, newest first.",
    ...kept,
    `The full store is at ${memdir} — read it when you need more than this.`,
  ].join("\n")
}

/**
 * The memory directory for one agent, or undefined when it has none.
 *
 * THREE refusals, each closing a different hole:
 *  - a NATIVE agent (build/plan/general/explore/…) never has one, which is the
 *    mechanical form of "a main session never reads a bot's memory";
 *  - a definition that declared `memory: false` opted out;
 *  - a definition with no FILE — declared in `origami.json` rather than on disk
 *    — has nothing to key a directory to, and inventing one would put two
 *    same-named agents in the same store.
 */
export const dirFor = Effect.fnUntraced(function* (input: {
  name: string
  info: { native?: boolean; options: Record<string, unknown> } | undefined
  definitionFile: (name: string) => Effect.Effect<string | undefined>
}) {
  if (!input.info) return undefined
  if (input.info.native === true) return undefined
  if (!AgentBot.read(input.info.options).memory) return undefined
  const file = yield* input.definitionFile(input.name)
  if (!file) return undefined
  const configDir = configDirOfDef(file, input.name)
  if (!configDir) return undefined
  return memoryDir(configDir, input.name)
})

/** Every remembered bullet in a store, with the topic it came from. */
export const entries = Effect.fnUntraced(function* (memdir: string) {
  const fs = yield* FSUtil.Service
  const found: Entry[] = []
  for (const topic of yield* MemoryLayout.listTopicFiles(fs, memdir)) {
    const text = yield* fs.readFileStringSafe(path.join(memdir, `${topic}.md`)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    for (const line of MemoryLayout.bulletsOf(text ?? "")) found.push({ topic, line })
  }
  return found
})

/** The bounded block for a store, ready to sit in a system prompt. */
export const read = Effect.fnUntraced(function* (
  memdir: string,
  opts?: { maxEntries?: number; maxBytes?: number },
) {
  return block(memdir, yield* entries(memdir), {
    maxEntries: opts?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxBytes: opts?.maxBytes ?? DEFAULT_MAX_BYTES,
  })
})

/**
 * Append one fact to a bot's own store.
 *
 * Topic file first, index second — the same ordering, and the same reason, as
 * the `remember` tool: an index line pointing at a file that failed to write is
 * a dangling hook, and a file with no index line merely goes unlisted.
 */
export const write = Effect.fnUntraced(function* (input: {
  memdir: string
  topic?: string
  fact: string
  date: string
}) {
  const fs = yield* FSUtil.Service
  const topic = MemoryLayout.topicSlug(input.topic)
  const target = topicFile(input.memdir, input.topic)
  const existing = yield* fs.readFileStringSafe(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
  yield* fs.writeWithDirs(target, MemoryLayout.appendTopicFact(existing ?? "", topic, input.fact, input.date))

  const index = resolveInRoot(input.memdir, MemoryLayout.INDEX_FILE)
  const indexText = yield* fs.readFileStringSafe(index).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const nextIndex = MemoryLayout.upsertIndexEntry(
    indexText?.trim() ? indexText : MemoryLayout.INDEX_HEADER,
    topic,
    MemoryLayout.oneLineHook(input.fact),
  )
  // A remember into an EXISTING topic leaves the index byte-identical, so the
  // common case wrote the same bytes back and bumped mtime for nothing. Same
  // skip, same reason, as the `remember` tool.
  if (nextIndex !== indexText) yield* fs.writeWithDirs(index, nextIndex)
  return { path: target, index, topic }
})

/**
 * The READ SEAM: one system block for a turn, or undefined.
 *
 * Undefined for every case that is not a bot with something remembered — a
 * native agent, a definition that opted out, a definition with no file, and a
 * bot whose store is empty — so an ordinary chat pays nothing and no prompt
 * changes shape until a bot has actually kept a fact.
 */
export const systemBlock = Effect.fnUntraced(function* (input: {
  name: string
  info: { native?: boolean; options: Record<string, unknown> } | undefined
  definitionFile: (name: string) => Effect.Effect<string | undefined>
}) {
  const dir = yield* dirFor(input)
  if (!dir) return undefined
  return yield* read(dir)
})

export * as AgentBotMemory from "./bot-memory"

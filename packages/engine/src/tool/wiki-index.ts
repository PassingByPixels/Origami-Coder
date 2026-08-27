import path from "path"
import { Effect, Option } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { MemoryLayout } from "./memory-layout"

/**
 * THE WORKSPACE KNOWLEDGE INDEX — metadata only, on purpose.
 *
 * A workspace keeps its depth in two places: hand-written wiki pages under
 * `wiki/` and the agent's own memory under `.origami/memory/`. Both were
 * effectively unreachable, because the only way in was `grep`, and grep needs
 * the phrasing the author happened to use. A page tagged `deploy` is invisible
 * to a search for "release ritual".
 *
 * This module builds the cheap half of a TWO-STAGE retrieval: it parses every
 * page's FRONT MATTER, title, headings and `[[links]]` and nothing else, so a
 * search round costs a few hundred tokens rather than a few hundred thousand.
 * PAGE BODIES ARE NEVER SEARCHED AND NEVER RETURNED. The agent follows a hit up
 * with the ordinary `read` tool on the one or two pages worth the tokens.
 *
 * Everything here is deterministic and lexical — token overlap, substring, and
 * a bounded edit distance for the "did you mean" recovery path. No embeddings,
 * no model calls, no network.
 */
export namespace WikiIndex {
  /** Knowledge roots, relative to the workspace directory, in scan order. */
  export const ROOTS = ["wiki", path.join(".origami", "memory")] as const

  /** Descriptions are a one-line hook, not a summary. */
  const DESCRIPTION_MAX = 120

  /** Brakes on a pathological tree. Neither is expected to bite in practice. */
  const MAX_DEPTH = 8
  const MAX_FILES = 2000

  export interface Page {
    /** Workspace-relative path without `.md`, POSIX separators. Append `.md` to read it. */
    readonly id: string
    /** Absolute path on disk. */
    readonly file: string
    /** Front-matter `tags:`, lower-cased. */
    readonly tags: readonly string[]
    /** Front-matter `title:`/`name:`, else the first `# heading`, else the basename. */
    readonly title: string
    /** Front-matter `description:`, else the first body paragraph, elided to one line. */
    readonly description: string
    /** `##`-and-deeper headings, in file order. */
    readonly headings: readonly string[]
    /** `[[link-target]]` occurrences in the body, de-duplicated, in file order. */
    readonly links: readonly string[]
  }

  export interface Index {
    readonly pages: readonly Page[]
    /** Roots that exist on disk. */
    readonly roots: readonly string[]
    /** Roots that were looked for and are not there. */
    readonly missing: readonly string[]
  }

  export interface Hit {
    readonly page: Page
    readonly score: number
    /** Short labels naming WHICH field matched — the model's audit trail. */
    readonly reasons: readonly string[]
  }

  /**
   * Parsed pages keyed by absolute path, invalidated on mtime+size.
   *
   * Module-level rather than instance-scoped: the key is an absolute path, so
   * two workspaces cannot collide, and a stale entry is impossible because the
   * key carries the file's own mtime and size. Re-stating a few hundred files
   * per call is far cheaper than re-parsing them.
   */
  const CACHE = new Map<string, { key: string; page: Page }>()

  const listMarkdown = (fs: FSUtil.Interface, dir: string, depth: number): Effect.Effect<string[]> =>
    Effect.gen(function* () {
      if (depth > MAX_DEPTH) return []
      const entries = yield* fs
        .readDirectoryEntries(dir)
        .pipe(Effect.catch(() => Effect.succeed([] as FSUtil.DirEntry[])))
      const out: string[] = []
      for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= MAX_FILES) break
        // Symlinks are skipped rather than followed, which is also what makes
        // this walk cycle-free without a visited set.
        if (entry.type === "directory") {
          if (entry.name.startsWith(".")) continue
          out.push(...(yield* listMarkdown(fs, path.join(dir, entry.name), depth + 1)))
          continue
        }
        if (entry.type !== "file") continue
        if (!entry.name.toLowerCase().endsWith(".md")) continue
        out.push(path.join(dir, entry.name))
      }
      return out.slice(0, MAX_FILES)
    })

  /** Build (or refresh) the index for a workspace directory. Never fails: an
   *  unreadable file or directory is skipped, and an absent root is reported in
   *  `missing` so the caller can say so out loud instead of returning nothing. */
  export const load = Effect.fn("WikiIndex.load")(function* (fs: FSUtil.Interface, directory: string) {
    const pages: Page[] = []
    const roots: string[] = []
    const missing: string[] = []
    for (const rel of ROOTS) {
      const root = path.join(directory, rel)
      if (!(yield* fs.isDir(root))) {
        missing.push(root)
        continue
      }
      roots.push(root)
      for (const file of yield* listMarkdown(fs, root, 0)) {
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!info) continue
        const key = `${Option.getOrElse(info.mtime, () => new Date(0)).getTime()}:${info.size}`
        const cached = CACHE.get(file)
        if (cached && cached.key === key) {
          pages.push(cached.page)
          continue
        }
        const text = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (text === undefined) continue
        const page = parse(pageID(directory, file), file, text)
        CACHE.set(file, { key, page })
        pages.push(page)
      }
    }
    return { pages, roots, missing } satisfies Index
  })

  /** Workspace-relative, POSIX, `.md` stripped — the string the model gets back
   *  and the string it appends `.md` to when it decides to read the page. */
  export function pageID(directory: string, file: string): string {
    return path
      .relative(directory, file)
      .split(/[\\/]/)
      .join("/")
      .replace(/\.md$/i, "")
  }

  export function parse(id: string, file: string, text: string): Page {
    const lines = text.split(/\r?\n/)
    let cursor = 0
    const front: string[] = []
    if (lines[0]?.trim() === "---") {
      cursor = 1
      while (cursor < lines.length && lines[cursor].trim() !== "---") front.push(lines[cursor++])
      if (cursor < lines.length) cursor++
    }

    const tags: string[] = []
    let frontTitle = ""
    let frontName = ""
    let frontDescription = ""
    for (let i = 0; i < front.length; i++) {
      const inline = front[i].match(/^\s*tags:\s*(.*)$/i)
      if (inline) {
        const value = inline[1].trim()
        if (value) {
          for (const raw of value.replace(/^\[/, "").replace(/\]$/, "").split(",")) addTag(tags, raw)
          continue
        }
        // Block form: `tags:` on its own line, then `- one` per line.
        for (let j = i + 1; j < front.length; j++) {
          const item = front[j].match(/^\s*-\s*(.+)$/)
          if (!item) break
          addTag(tags, item[1])
        }
        continue
      }
      const named = front[i].match(/^\s*(title|name|description):\s*(.+)$/i)
      if (!named) continue
      const value = unquote(named[2])
      if (!value) continue
      const key = named[1].toLowerCase()
      if (key === "description") frontDescription ||= value
      else if (key === "title") frontTitle ||= value
      else frontName ||= value
    }

    const headings: string[] = []
    const links: string[] = []
    let heading1 = ""
    let paragraph = ""
    let fenced = false
    for (let i = cursor; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.startsWith("```") || line.startsWith("~~~")) {
        fenced = !fenced
        continue
      }
      if (fenced) continue
      // `[[target]]`, `[[target|alias]]`, `[[target#section]]` all resolve to `target`.
      for (const match of line.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
        const target = match[1].trim()
        if (target && !links.includes(target)) links.push(target)
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/)
      if (heading) {
        const value = heading[2].trim()
        if (heading[1].length === 1) heading1 ||= value
        else if (!headings.includes(value)) headings.push(value)
        continue
      }
      if (paragraph || !line) continue
      if (line.startsWith(">") || line.startsWith("<!--") || line.startsWith("|") || line.startsWith("---")) continue
      paragraph = line.replace(/^[-*+]\s+/, "")
    }

    return {
      id,
      file,
      tags,
      title: frontTitle || frontName || heading1 || (id.split("/").pop() ?? id),
      description: MemoryLayout.oneLineHook(frontDescription || paragraph, DESCRIPTION_MAX),
      headings,
      links,
    }
  }

  function addTag(tags: string[], raw: string) {
    const tag = unquote(raw).toLowerCase()
    if (tag && !tags.includes(tag)) tags.push(tag)
  }

  function unquote(raw: string): string {
    return raw
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim()
  }

  export const normalize = (value: string) => value.toLowerCase().trim()

  /**
   * Function and question words, dropped from every token list.
   *
   * NOT decoration. The tools are advertised for "why did we choose X" style
   * questions, and without this a question ranks by its grammar: on a 269-page
   * corpus, "why did we choose the deploy ritual" put an unrelated weather page
   * first, because `the`/`we`/`did` appear in almost every title and
   * description. Only closed-class words are listed — no domain word, however
   * common it looks, because the corpus decides what is common, not this file.
   */
  const STOP_WORDS = new Set(
    ("about after again all am an and any are as at be because been before being between both but by can cannot " +
      "could did do does doing done down during each few for from further had has have having he her here hers him " +
      "his how if in into is it its itself just me more most my no nor not now of off on once only or other our " +
      "ours out over own same she should so some such than that the their theirs them then there these they this " +
      "those through to too under until up us very was we were what when where which while who whom why will with " +
      "would you your yours").split(" "),
  )

  export function tokenize(value: string): string[] {
    return Array.from(
      new Set(
        normalize(value)
          .split(/[^a-z0-9]+/)
          .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
      ),
    )
  }

  /**
   * How well ONE metadata field answers the query: the query tokens it carries,
   * scored as their count plus a bonus when the whole query appears verbatim.
   * Score zero means "did not match", which is what keeps a field out of the
   * match reasons; `matched` feeds the coverage bonus in {@link search}.
   */
  function fieldMatch(text: string, tokens: readonly string[], phrase: string): { score: number; matched: string[] } {
    const hay = normalize(text)
    if (!hay) return { score: 0, matched: [] }
    const hayTokens = tokenize(text)
    const matched = tokens.filter((token) => hayTokens.includes(token) || hay.includes(token))
    const bonus = phrase.length > 2 && hay.includes(phrase) ? 1 : 0
    return { score: matched.length + bonus, matched }
  }

  /**
   * Rank pages against a query and/or a tag filter.
   *
   * The weights encode the retrieval contract: a TAG is the strongest signal
   * (it is what the author deliberately filed the page under), then the title,
   * then the page id, then headings, and the description last — it is the
   * loosest of the five. On top of the per-field weights sits a COVERAGE bonus
   * for how many DISTINCT query words the page accounts for, so a page that
   * answers most of the question beats one that answers a single common word
   * very loudly. The tag filter is a SOFT AND: every requested tag that a page
   * carries adds score, and a page that carries none is dropped only when there
   * is no query to keep it in on other evidence.
   */
  export function search(
    pages: readonly Page[],
    input: { query?: string; tags?: readonly string[] },
  ): Hit[] {
    const phrase = normalize(input.query ?? "")
    const tokens = tokenize(input.query ?? "")
    const wanted = (input.tags ?? []).map(normalize).filter(Boolean)
    const hits: Hit[] = []

    for (const page of pages) {
      let score = 0
      const reasons: string[] = []

      for (const want of wanted) {
        const exact = page.tags.find((tag) => tag === want)
        if (exact) {
          score += 10
          reasons.push(`tag:${exact}`)
          continue
        }
        const near = page.tags.find((tag) => tag.startsWith(want) || want.startsWith(tag))
        if (near) {
          score += 6
          reasons.push(`tag~${near}`)
        }
      }
      const tagFilterScore = score
      if (wanted.length > 0 && tagFilterScore === 0 && tokens.length === 0) continue

      if (tokens.length > 0 || phrase) {
        // Which of the query's words this page accounts for ANYWHERE in its
        // metadata. A page that answers two of three words beats one that
        // answers a single word very loudly - without it, one page carrying a
        // common word as a literal tag (`model`) outranks the page whose title
        // and description carry the distinctive words as well.
        const covered = new Set<string>()

        for (const tag of page.tags) {
          const parts = tokenize(tag).filter((part) => tokens.includes(part))
          if (!tokens.includes(tag) && parts.length === 0) continue
          for (const part of tokens.includes(tag) ? [tag, ...parts] : parts) covered.add(part)
          if (reasons.some((reason) => reason.endsWith(tag))) continue
          score += 8
          reasons.push(`tag:${tag}`)
        }

        const title = fieldMatch(page.title, tokens, phrase)
        if (title.score > 0) {
          score += 5 * title.score
          reasons.push("title")
        }
        const id = fieldMatch(page.id, tokens, phrase)
        if (id.score > 0) {
          score += 4 * id.score
          reasons.push("id")
        }
        const heading = page.headings
          .map((value) => fieldMatch(value, tokens, phrase))
          .reduce((best, value) => (value.score > best.score ? value : best), { score: 0, matched: [] as string[] })
        if (heading.score > 0) {
          score += 2 * heading.score
          reasons.push("heading")
        }
        const description = fieldMatch(page.description, tokens, phrase)
        if (description.score > 0) {
          score += description.score
          reasons.push("description")
        }

        for (const field of [title, id, heading, description]) for (const token of field.matched) covered.add(token)
        score += 6 * covered.size
      }

      if (score === 0) continue
      hits.push({ page, score, reasons: reasons.slice(0, 3) })
    }

    return hits.toSorted((a, b) => b.score - a.score || a.page.id.localeCompare(b.page.id))
  }

  /** Tag -> number of pages carrying it, across the whole index. */
  export function vocabulary(pages: readonly Page[]): Map<string, number> {
    const counts = new Map<string, number>()
    for (const page of pages) for (const tag of page.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return counts
  }

  /** Tags that co-occur inside a HIT SET, most common first, excluding the ones
   *  already asked for. This is the "narrow it from here" move. */
  export function relatedTags(
    hits: readonly Hit[],
    exclude: readonly string[],
    limit = 6,
  ): { tag: string; count: number }[] {
    const skip = new Set(exclude.map(normalize))
    const counts = new Map<string, number>()
    for (const hit of hits) {
      for (const tag of hit.page.tags) {
        if (skip.has(tag)) continue
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return Array.from(counts, ([tag, count]) => ({ tag, count }))
      .toSorted((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, limit)
  }

  /**
   * The RECOVERY move, and the reason a miss is not a dead end: the tags in the
   * vocabulary closest to what was asked for, by substring or an edit distance
   * of at most 2, each with the number of pages under it.
   */
  export function nearestTags(
    pages: readonly Page[],
    probes: readonly string[],
    limit = 6,
  ): { tag: string; count: number; distance: number }[] {
    const terms = probes.map(normalize).filter(Boolean)
    if (terms.length === 0) {
      return Array.from(vocabulary(pages), ([tag, count]) => ({ tag, count, distance: 0 }))
        .toSorted((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .slice(0, limit)
    }
    const scored: { tag: string; count: number; distance: number }[] = []
    for (const [tag, count] of vocabulary(pages)) {
      let best = Infinity
      for (const term of terms) {
        const d = tag.includes(term) || term.includes(tag) ? 0 : distance(tag, term)
        if (d < best) best = d
      }
      if (best <= 2) scored.push({ tag, count, distance: best })
    }
    return scored
      .toSorted((a, b) => a.distance - b.distance || b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, limit)
  }

  /** Levenshtein distance. Only ever run over tags and query tokens, so the
   *  quadratic cost is on strings of a dozen characters. */
  export function distance(a: string, b: string): number {
    if (a === b) return 0
    if (!a.length || !b.length) return Math.max(a.length, b.length)
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
      const current = [i]
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        )
      }
      previous = current
    }
    return previous[b.length]
  }

  /** The page a `[[target]]` or a user-supplied name points at, by exact id,
   *  then case-insensitive id, then basename. `undefined` = no such page. */
  export function resolveLink(pages: readonly Page[], target: string): Page | undefined {
    const wanted = normalize(target).replace(/\.md$/i, "")
    return (
      pages.find((page) => page.id === target) ??
      pages.find((page) => normalize(page.id) === wanted) ??
      pages.find((page) => normalize(page.id.split("/").pop() ?? "") === wanted)
    )
  }

  /** How `resolve` found the page — reported to the model so an approximate
   *  name never silently answers about a different page. */
  export type Resolution = "exact" | "case-insensitive" | "basename" | "fuzzy"

  export function resolve(
    pages: readonly Page[],
    target: string,
  ): { page: Page; how: Resolution } | { page: undefined; nearest: Page[] } {
    const direct = resolveLink(pages, target)
    if (direct) {
      const how: Resolution =
        direct.id === target ? "exact" : normalize(direct.id) === normalize(target) ? "case-insensitive" : "basename"
      return { page: direct, how }
    }
    const ranked = search(pages, { query: target })
    if (ranked.length > 0) return { page: ranked[0].page, how: "fuzzy" }
    const wanted = normalize(target).replace(/\.md$/i, "")
    const nearest = pages
      .map((page) => ({ page, d: distance(normalize(page.id.split("/").pop() ?? ""), wanted) }))
      .toSorted((a, b) => a.d - b.d || a.page.id.localeCompare(b.page.id))
      .slice(0, 5)
      .map((entry) => entry.page)
    return { page: undefined, nearest }
  }

  /** Pages whose body links to `page` — the question grep cannot answer cheaply,
   *  because a link is written as a bare name and the page id is a path. */
  export function inbound(pages: readonly Page[], page: Page): Page[] {
    return pages.filter(
      (other) => other.id !== page.id && other.links.some((link) => resolveLink(pages, link)?.id === page.id),
    )
  }

  /** Neighbours by tag overlap, most shared tags first. */
  export function sharedTags(pages: readonly Page[], page: Page, limit = 8): { page: Page; shared: string[] }[] {
    if (page.tags.length === 0) return []
    return pages
      .filter((other) => other.id !== page.id)
      .map((other) => ({ page: other, shared: other.tags.filter((tag) => page.tags.includes(tag)) }))
      .filter((entry) => entry.shared.length > 0)
      .toSorted((a, b) => b.shared.length - a.shared.length || a.page.id.localeCompare(b.page.id))
      .slice(0, limit)
  }
}

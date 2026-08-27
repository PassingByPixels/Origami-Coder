import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import {
  backupDir,
  backupStamp,
  bulletKey,
  bulletsOf,
  candidateDir,
  INDEX_FILE,
  indexHooks,
  indexPath,
  listTopicFiles,
  memoryDir,
  readStore,
  type StoreSnapshot,
} from "./memory-layout"

/**
 * DREAM'S FOLDERED CURATION PASS.
 *
 * The flat store is one file, so dream could stage one candidate file and diff
 * it. A foldered store is a TREE (an index plus one file per topic), and the
 * curation the user actually wants is tree-shaped too: refile every inbox
 * bullet into a fitting topic, merge duplicate topics, rewrite a hook that no
 * longer describes its file, coin a topic for an unfiled theme.
 *
 * So the candidate is a DIRECTORY (`<origami>/memory.candidate/`), seeded by
 * MIRRORING the live store. The model then EDITS inside the mirror. Seeding by
 * mirror is the safety property: nothing is lost unless the model actively
 * removed it, and anything it did remove is recoverable by diffing the mirror
 * against the live store — which is exactly what `diffStore` reports.
 *
 * Everything here is either pure (mirror-free diffing and summary rendering) or
 * a narrow filesystem step, so the dangerous parts — what counts as a dropped
 * fact, what gets backed up before an overwrite — are testable without the
 * Database/Session/Question stack the tool itself needs.
 */

/** Word-overlap at or above this counts two bullets as the same fact reworded. */
const REWORD_THRESHOLD = 0.5

/** A bullet located in the store: which topic file it sits in, and its text. */
type Located = { readonly topic: string; readonly text: string; readonly key: string }

/** What happened to one topic between the live store and the candidate. */
export type TopicChange = {
  readonly topic: string
  /** `new`: absent from the live store. `removed`: absent from the candidate. */
  readonly status: "new" | "changed" | "removed" | "unchanged"
  /** Bullets that exist nowhere in the live store. */
  readonly added: number
  /** Bullets that arrived here from another topic (refiling). */
  readonly movedIn: number
  /** Bullets that left this topic for another one. */
  readonly movedOut: number
  /** Bullets kept but rewritten. */
  readonly reworded: number
  /** Duplicate copies folded into a surviving twin. NOT a loss — the fact is
   *  still in the candidate, which is why these are not counted as dropped. */
  readonly merged: number
  /** VERBATIM text of bullets this topic loses that survive nowhere else. */
  readonly dropped: readonly string[]
  /** Full text of the topic's hook when the candidate adds or rewrites it. */
  readonly hook?: string
  /** Non-bullet text (frontmatter, prose, headings) differs. */
  readonly proseChanged: boolean
  /** The file survives but the candidate's index no longer links it — the
   *  facts are on disk yet invisible to a model that only loads the index, so
   *  this is reported rather than passed over as "no bullet changes". */
  readonly unlisted: boolean
}

export type StoreDiff = {
  readonly topics: readonly TopicChange[]
  /** Every bullet the candidate loses store-wide, with the topic it came from. */
  readonly dropped: readonly { readonly topic: string; readonly bullet: string }[]
  readonly changed: boolean
}

/** Everything in a file that is not a top-level bullet, whitespace-normalised. */
function proseOf(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^- /.test(line))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
}

/** Comparable word set of a bullet, date prefix and punctuation dropped. */
function words(key: string): Set<string> {
  return new Set(key.split(/[^a-z0-9]+/).filter((word) => word.length > 2))
}

/** Jaccard overlap of two word sets — 1 is identical vocabulary, 0 disjoint. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared++
  return shared / (a.size + b.size - shared)
}

function locate(snapshot: StoreSnapshot): Located[] {
  const out: Located[] = []
  for (const [topic, text] of snapshot.topics) {
    for (const bullet of bulletsOf(text)) {
      const key = bulletKey(bullet)
      if (key) out.push({ topic, text: bullet, key })
    }
  }
  return out
}

/**
 * Pair up the live store's bullets with the candidate's.
 *
 * Exact key first (a bullet moved verbatim between topics is a MOVE, not a
 * drop plus an add), then a fuzzy pass so a reworded bullet is reported as a
 * reword rather than a scary "dropped". The fuzzy pass is deliberately
 * conservative: below the threshold a pair stays unmatched, which reports the
 * fact as DROPPED. Erring toward "dropped" is safe — a drop is listed verbatim
 * for the user to veto; a false "reworded" would hide a deletion.
 */
function pair(before: readonly Located[], after: readonly Located[]) {
  const takenAfter = new Set<number>()
  const matchedBefore = new Map<number, { after: number; exact: boolean }>()

  const byKey = new Map<string, number[]>()
  after.forEach((item, index) => {
    const list = byKey.get(item.key)
    if (list) list.push(index)
    else byKey.set(item.key, [index])
  })

  // Pass 1, exact key. Same-topic candidates win so an unchanged bullet is
  // never mis-read as "moved" just because a copy exists in another topic.
  before.forEach((item, index) => {
    const candidates = byKey.get(item.key)?.filter((i) => !takenAfter.has(i)) ?? []
    if (candidates.length === 0) return
    const chosen = candidates.find((i) => after[i].topic === item.topic) ?? candidates[0]
    takenAfter.add(chosen)
    matchedBefore.set(index, { after: chosen, exact: true })
  })

  // Pass 2, fuzzy. Greedy best-first over every remaining cross pair so the
  // strongest reword pairing wins regardless of file order.
  const restBefore = before.map((_, i) => i).filter((i) => !matchedBefore.has(i))
  const restAfter = after.map((_, i) => i).filter((i) => !takenAfter.has(i))
  const scored: { before: number; after: number; score: number }[] = []
  for (const b of restBefore) {
    const bw = words(before[b].key)
    for (const a of restAfter) {
      const score = overlap(bw, words(after[a].key))
      if (score >= REWORD_THRESHOLD) scored.push({ before: b, after: a, score })
    }
  }
  scored.sort((x, y) => y.score - x.score)
  for (const item of scored) {
    if (matchedBefore.has(item.before) || takenAfter.has(item.after)) continue
    takenAfter.add(item.after)
    matchedBefore.set(item.before, { after: item.after, exact: false })
  }

  return { matchedBefore, takenAfter }
}

/**
 * Per-topic change summary of a staged candidate against the live store.
 * Pure: both sides are already-read snapshots, so this is the one place the
 * meaning of "added / moved / reworded / dropped" is defined.
 */
export function diffStore(before: StoreSnapshot, after: StoreSnapshot): StoreDiff {
  const beforeBullets = locate(before)
  const afterBullets = locate(after)
  const { matchedBefore, takenAfter } = pair(beforeBullets, afterBullets)

  const beforeHooks = indexHooks(before.index)
  const afterHooks = indexHooks(after.index)

  const names = [...new Set([...before.topics.keys(), ...after.topics.keys()])].sort()
  const dropped: { topic: string; bullet: string }[] = []
  // Every key the candidate still holds anywhere. An unmatched live bullet
  // whose key is in here was a DUPLICATE folded into its surviving twin, which
  // is the merge dream exists to do — calling that a dropped fact would cry
  // wolf on the one signal the user must be able to trust.
  const afterKeys = new Set(afterBullets.map((item) => item.key))

  const topics = names.map((topic): TopicChange => {
    const inBefore = before.topics.has(topic)
    const inAfter = after.topics.has(topic)

    let added = 0
    let movedIn = 0
    let movedOut = 0
    let reworded = 0
    let merged = 0
    const lost: string[] = []

    beforeBullets.forEach((item, index) => {
      if (item.topic !== topic) return
      const match = matchedBefore.get(index)
      if (!match) {
        if (afterKeys.has(item.key)) {
          merged++
          return
        }
        lost.push(item.text)
        dropped.push({ topic, bullet: item.text })
        return
      }
      if (afterBullets[match.after].topic !== topic) movedOut++
    })

    afterBullets.forEach((item, index) => {
      if (item.topic !== topic) return
      if (!takenAfter.has(index)) {
        added++
        return
      }
      // Find the live bullet this one was matched to (the map is before->after).
      for (const [beforeIndex, match] of matchedBefore) {
        if (match.after !== index) continue
        if (beforeBullets[beforeIndex].topic !== topic) movedIn++
        if (!match.exact) reworded++
        break
      }
    })

    const hookBefore = beforeHooks.get(topic)
    const hookAfter = afterHooks.get(topic)
    // Only a hook the candidate ADDS or REWRITES is surfaced. An unchanged hook
    // is noise, and `upsertIndexEntry` deliberately never clobbers one.
    const hook = inAfter && hookAfter !== undefined && hookAfter !== hookBefore ? hookAfter : undefined
    const unlisted = inAfter && hookAfter === undefined

    const proseChanged =
      inBefore && inAfter && proseOf(before.topics.get(topic) ?? "") !== proseOf(after.topics.get(topic) ?? "")

    const status: TopicChange["status"] = !inBefore
      ? "new"
      : !inAfter
        ? "removed"
        : added ||
            movedIn ||
            movedOut ||
            reworded ||
            merged ||
            lost.length ||
            hook !== undefined ||
            proseChanged ||
            unlisted
          ? "changed"
          : "unchanged"

    return {
      topic,
      status,
      added,
      movedIn,
      movedOut,
      reworded,
      merged,
      dropped: lost,
      proseChanged,
      unlisted,
      ...(hook ? { hook } : {}),
    }
  })

  const changed = topics.some((topic) => topic.status !== "unchanged") || proseOf(before.index) !== proseOf(after.index)

  return { topics, dropped, changed }
}

/** Human-readable review summary. The user approves off THIS text. */
export function summaryText(diff: StoreDiff): string {
  const lines: string[] = []
  const counted = (change: TopicChange) =>
    [
      change.added ? `+${change.added} added` : "",
      change.movedIn ? `${change.movedIn} moved in` : "",
      change.movedOut ? `${change.movedOut} moved out` : "",
      change.reworded ? `${change.reworded} reworded` : "",
      change.merged ? `${change.merged} duplicate(s) merged` : "",
      change.dropped.length ? `${change.dropped.length} DROPPED` : "",
      change.proseChanged ? "prose edited" : "",
      change.unlisted ? "NOT LISTED IN THE INDEX" : "",
    ]
      .filter(Boolean)
      .join(", ") || "no bullet changes"

  for (const change of diff.topics) {
    if (change.status === "unchanged") continue
    const tag = change.status === "new" ? "NEW TOPIC" : change.status === "removed" ? "TOPIC REMOVED" : "changed"
    lines.push(`${change.topic} (${tag}): ${counted(change)}`)
    if (change.hook) lines.push(`    hook: ${change.hook}`)
  }
  if (lines.length === 0) lines.push("(no per-topic changes)")

  if (diff.dropped.length > 0) {
    lines.push("", `DROPPED — these facts survive nowhere in the candidate (${diff.dropped.length}):`)
    for (const item of diff.dropped) lines.push(`    [${item.topic}] ${item.bullet}`)
  } else {
    lines.push("", "No facts are dropped — every live bullet survives somewhere in the candidate.")
  }
  return lines.join("\n")
}

/** One-line headline for the approval question. */
export function summaryHeadline(diff: StoreDiff): string {
  const added = diff.topics.reduce((sum, topic) => sum + topic.added, 0)
  const moved = diff.topics.reduce((sum, topic) => sum + topic.movedIn, 0)
  const reworded = diff.topics.reduce((sum, topic) => sum + topic.reworded, 0)
  const newTopics = diff.topics.filter((topic) => topic.status === "new").length
  const goneTopics = diff.topics.filter((topic) => topic.status === "removed").length
  return [
    `${added} added`,
    `${moved} refiled`,
    `${reworded} reworded`,
    `${diff.dropped.length} dropped`,
    `${newTopics} new topic(s)`,
    `${goneTopics} removed topic(s)`,
  ].join(", ")
}

/**
 * Seed `<origami>/memory.candidate/` with a byte copy of the live store.
 *
 * Any previous candidate is removed first: a stale file from an abandoned pass
 * would otherwise read as a proposed change in the next review. Bytes, not
 * strings, so a topic file's exact encoding survives the round trip.
 */
export const mirrorStore = Effect.fn("Dream.mirrorStore")(function* (origamiDir: string) {
  const fs = yield* FSUtil.Service
  const memdir = memoryDir(origamiDir)
  const target = candidateDir(origamiDir)

  yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void))
  yield* fs.ensureDir(target)

  const names = yield* listTopicFiles(fs, memdir)
  for (const name of [...names.map((name) => `${name}.md`), INDEX_FILE]) {
    const source = path.join(memdir, name)
    const bytes = yield* fs.readFile(source).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (bytes === undefined) continue
    yield* fs.writeWithDirs(path.join(target, name), bytes)
  }
  return { candidate: target, files: names.length }
})

/** Read the staged candidate directory as a snapshot. */
export const readCandidate = (origamiDir: string) => readStore(candidateDir(origamiDir))

/** Delete the staged candidate. Never touches the live store. */
export const discardCandidate = Effect.fn("Dream.discardCandidate")(function* (origamiDir: string) {
  const fs = yield* FSUtil.Service
  yield* fs.remove(candidateDir(origamiDir), { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void))
})

export type ApplyResult = {
  readonly backup: string
  readonly written: number
  readonly removed: number
}

/**
 * Adopt the staged candidate as the live store.
 *
 * Order matters and is the whole safety story:
 *  1. BACK UP the live directory to `memory.bak-<stamp>/`, byte for byte. The
 *     name is probed until it is free, so a second dream in the same second
 *     can never overwrite the first pass's only copy of the old store.
 *  2. Replace the live files from the candidate — write every candidate file,
 *     then delete live files the candidate no longer has.
 *  3. Delete the candidate.
 *
 * Step 2 is file-by-file rather than a directory rename because a rename over
 * a directory whose files an editor holds open fails on Windows (the same
 * reason the flat path writes in place). With step 1 already on disk the
 * window between the first and last write is recoverable, which is what
 * "atomic as practical" buys here.
 */
export const applyCandidate = Effect.fn("Dream.applyCandidate")(function* (origamiDir: string, now = new Date()) {
  const fs = yield* FSUtil.Service
  const memdir = memoryDir(origamiDir)
  const source = candidateDir(origamiDir)

  // 1. back up, to a name nothing occupies
  const stamp = backupStamp(now)
  let backup = backupDir(origamiDir, stamp)
  for (let attempt = 2; yield* fs.existsSafe(backup); attempt++) backup = backupDir(origamiDir, `${stamp}-${attempt}`)
  yield* fs.ensureDir(backup)

  const liveNames = yield* listMarkdown(fs, memdir)
  for (const name of liveNames) {
    const bytes = yield* fs.readFile(path.join(memdir, name)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (bytes === undefined) continue
    yield* fs.writeWithDirs(path.join(backup, name), bytes)
  }

  // 2. write every candidate file, then remove what the candidate dropped
  const candidateNames = yield* listMarkdown(fs, source)
  let written = 0
  for (const name of candidateNames) {
    const bytes = yield* fs.readFile(path.join(source, name)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (bytes === undefined) continue
    yield* fs.writeWithDirs(path.join(memdir, name), bytes)
    written++
  }
  const keep = new Set(candidateNames)
  let removed = 0
  for (const name of liveNames) {
    if (keep.has(name)) continue
    yield* fs.remove(path.join(memdir, name)).pipe(Effect.catch(() => Effect.void))
    removed++
  }

  // 3. the candidate has served its purpose
  yield* fs.remove(source, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void))

  return { backup, written, removed } satisfies ApplyResult
})

/** Markdown filenames in a directory, INDEX INCLUDED — the copy/replace unit. */
function listMarkdown(fs: FSUtil.Interface, dir: string) {
  return Effect.gen(function* () {
    const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
    return entries
      .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
  })
}

/**
 * Refuse a candidate that would gut the store.
 *
 * The foldered sibling of the flat path's "normalises to zero bullets" guard.
 * A missing index or a candidate with no topic files at all is a staging
 * accident, not curation — adopting it would empty a store the user cannot get
 * back except from the backup. Returns the reason, or undefined when the
 * candidate is fit to review.
 */
export function rejectReason(live: StoreSnapshot, candidate: StoreSnapshot): string | undefined {
  if (candidate.topics.size === 0 && live.topics.size > 0)
    return "the candidate has no topic files at all, so adopting it would empty the store"
  if (!candidate.index.trim() && live.index.trim())
    return `the candidate has no ${INDEX_FILE}, so the adopted store would have no index`
  return undefined
}

/** Where the candidate's index lives — handed to the model as a write target. */
export const candidateIndexPath = (origamiDir: string) => indexPath(candidateDir(origamiDir))

export * as DreamStage from "./dream-stage"

import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@origami/core/database/database"
import * as Tool from "./tool"

const DESCRIPTION = [
  "Search your OWN past chat sessions (their message text) for a word or phrase, to recall context that",
  "scrolled out of the current window or was compacted away.",
  "Answers questions like 'what did we decide about X', 'have I hit this error before', 'where did I set up Y'.",
  "Returns matching sessions, most recent first, each with its title, when it was last active, and a short",
  "excerpt around the hit. Scoped to the CURRENT project by default (pass all_projects to widen).",
  "This searches conversation HISTORY, not the codebase - use grep/read for files.",
].join(" ")

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "The word or phrase to find in past session messages." }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max number of past sessions to return (default 8, capped at 25).",
  }),
  all_projects: Schema.optional(Schema.Boolean).annotate({
    description: "Search across every project instead of just the current one (default false).",
  }),
})

interface Row {
  session_id: string
  title: string
  time_created: number
  data: string
}

/** Pull a readable excerpt around the query from a serialized text/reasoning part.
 *  Returns undefined for parts with no string `.text` (e.g. tool parts) so the
 *  caller drops them. Whitespace is collapsed; the window is trimmed with ellipses. */
export function extractSnippet(dataJson: string, query: string): string | undefined {
  let text: string
  try {
    const parsed = JSON.parse(dataJson) as { text?: unknown }
    if (typeof parsed.text !== "string" || !parsed.text.trim()) return undefined
    text = parsed.text
  } catch {
    return undefined
  }
  const clean = (s: string) => s.replace(/\s+/g, " ").trim()
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return clean(text).slice(0, 160)
  const start = Math.max(0, idx - 60)
  const end = Math.min(text.length, idx + query.length + 100)
  return (start > 0 ? "…" : "") + clean(text.slice(start, end)) + (end < text.length ? "…" : "")
}

/** Compact human relative time for a past timestamp (ms). `now` injected for testability. */
export function relTime(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

export const SessionSearchTool = Tool.define(
  "session_search",
  Effect.gen(function* () {
    // Capture the DB service at define time (like grep captures fs/ripgrep) so
    // `execute` carries no Effect requirements - the tool framework needs its
    // execute to be fully resolved (R = never).
    const { db } = yield* Database.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { query: string; limit?: number; all_projects?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const query = params.query?.trim()
          if (!query) throw new Error("query is required")
          const limit = Math.max(1, Math.min(25, Math.floor(params.limit ?? 8)))
          const like = `%${query}%`
          const scopeAll = params.all_projects === true

          // Text parts of OTHER sessions that mention the query, newest first.
          // Default-scoped to the current session's project so recall stays
          // relevant (and doesn't leak another project's chats). Params are
          // bound (no injection); the "type":"text" filter matches the engine's
          // compact JSON serialization.
          const rows = yield* db
            .all<Row>(
              scopeAll
                ? sql`SELECT p.session_id AS session_id, s.title AS title, p.time_created AS time_created, p.data AS data
                      FROM part p JOIN session s ON s.id = p.session_id
                      WHERE p.data LIKE ${like} AND p.data LIKE '%"type":"text"%' AND p.session_id != ${ctx.sessionID}
                      ORDER BY p.time_created DESC LIMIT ${limit * 8}`
                : sql`SELECT p.session_id AS session_id, s.title AS title, p.time_created AS time_created, p.data AS data
                      FROM part p JOIN session s ON s.id = p.session_id
                      WHERE p.data LIKE ${like} AND p.data LIKE '%"type":"text"%' AND p.session_id != ${ctx.sessionID}
                        AND s.project_id = (SELECT project_id FROM session WHERE id = ${ctx.sessionID})
                      ORDER BY p.time_created DESC LIMIT ${limit * 8}`,
            )
            .pipe(Effect.orDie)

          const bySession = new Map<string, { title: string; time: number; snippets: string[] }>()
          for (const r of rows) {
            const snip = extractSnippet(r.data, query)
            if (!snip) continue
            let entry = bySession.get(r.session_id)
            if (!entry) {
              if (bySession.size >= limit) continue
              entry = { title: r.title || "(untitled)", time: r.time_created, snippets: [] }
              bySession.set(r.session_id, entry)
            }
            if (entry.snippets.length < 2 && !entry.snippets.includes(snip)) entry.snippets.push(snip)
          }

          if (bySession.size === 0) {
            return {
              title: query,
              metadata: { sessions: 0, matches: 0 },
              output: `No past ${scopeAll ? "" : "in-project "}sessions mention "${query}".`,
            }
          }

          const now = Date.now()
          const out: string[] = [
            `Found "${query}" in ${bySession.size} past session${bySession.size === 1 ? "" : "s"}${scopeAll ? "" : " (this project)"}, newest first:`,
          ]
          let matches = 0
          for (const [sid, e] of bySession) {
            out.push("")
            out.push(`${e.title} · ${relTime(e.time, now)} · ${sid}`)
            for (const s of e.snippets) {
              out.push(`  ${s}`)
              matches++
            }
          }
          return { title: query, metadata: { sessions: bySession.size, matches }, output: out.join("\n") }
        }).pipe(Effect.orDie),
    }
  }),
)

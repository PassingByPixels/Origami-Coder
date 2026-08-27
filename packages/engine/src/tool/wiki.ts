import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@origami/core/fs-util"
import SEARCH_DESCRIPTION from "./wiki-search.txt"
import RELATED_DESCRIPTION from "./wiki-related.txt"
import { WikiIndex } from "./wiki-index"
import * as Tool from "./tool"

/**
 * TWO-STAGE KNOWLEDGE RETRIEVAL over `wiki/` and `.origami/memory/`.
 *
 * Stage one is these two tools: they answer with page ids, tags, one-line
 * descriptions and match reasons — a few hundred tokens. Stage two is the
 * model's EXISTING `read` tool on the one or two pages that earned it. Nothing
 * here ever reads a page body into the answer, which is the whole reason a
 * retrieval round is affordable enough to repeat.
 *
 * Every reply ends with a NEXT MOVE, because a search that dead-ends sends the
 * model back to grep: hits carry the tags that co-occur with them, and a miss
 * carries the nearest tags in the vocabulary with their page counts. The
 * recovery path is not a courtesy — it is the feature.
 */

/** Hard ceiling on either tool's output. The token-economy promise in the
 *  descriptions is only worth as much as this number. */
const OUTPUT_CAP = 3000

export const SearchParameters = Schema.Struct({
  query: Schema.optional(Schema.String).annotate({
    description:
      "Words or a phrase to match against page tags, titles, headings, ids and one-line descriptions. Page bodies are NOT searched. Approximate wording is fine.",
  }),
  tags: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Tags to filter by, e.g. [\"deploy\", \"origami\"]. Exact and prefix matches both count. Use the related/nearest tags from a previous reply here.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max rows to return (default 12, capped at 20).",
  }),
})

export const RelatedParameters = Schema.Struct({
  page: Schema.String.annotate({
    description:
      "The page to walk out from: an exact page id (workspace-relative path without .md), a bare filename, or an approximate name.",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "1 (default) = direct neighbours only. 2 = one further hop on the outbound and inbound sets.",
  }),
})

export const WikiSearchTool = Tool.define(
  "wiki_search",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description: SEARCH_DESCRIPTION,
      parameters: SearchParameters,
      execute: (params: { query?: string; tags?: readonly string[]; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const query = (params.query ?? "").trim()
          const tags = (params.tags ?? []).map((tag) => tag.trim()).filter(Boolean)
          yield* ctx.ask({
            permission: "wiki_search",
            patterns: [query || tags.join(",") || "*"],
            always: ["*"],
            metadata: {
              query: params.query,
              tags: params.tags,
              limit: params.limit,
            },
          })

          const title = query || tags.join(", ") || "wiki"
          if (!query && tags.length === 0) {
            return {
              title,
              metadata: { pages: 0, matches: 0, truncated: false },
              output: "wiki_search needs a `query`, a `tags` list, or both. Nothing was searched.",
            }
          }

          const index = yield* WikiIndex.load(fs, ins.directory)
          if (index.roots.length === 0) {
            return {
              title,
              metadata: { pages: 0, matches: 0, truncated: false },
              output: `No wiki roots found — looked for ${index.missing.join(" and ")}. This workspace keeps no wiki or agent memory, so there is nothing to search.`,
            }
          }
          if (index.pages.length === 0) {
            return {
              title,
              metadata: { pages: 0, matches: 0, truncated: false },
              output: `No markdown pages under ${index.roots.join(" or ")}. The knowledge base exists but is empty.`,
            }
          }

          const limit = Math.max(1, Math.min(20, Math.floor(params.limit ?? 12)))
          const hits = WikiIndex.search(index.pages, { query, tags })
          const asked = query ? [...tags, ...WikiIndex.tokenize(query)] : tags

          if (hits.length === 0) {
            const nearest = WikiIndex.nearestTags(index.pages, asked)
            const fallback = nearest.length > 0 ? nearest : WikiIndex.nearestTags(index.pages, [])
            const footer: string[] = []
            if (fallback.length === 0) {
              footer.push(`None of the ${index.pages.length} pages carries a tag — try a broader \`query\` instead.`)
            } else {
              footer.push(`nearest tags: ${fallback.map((entry) => `${entry.tag}(${entry.count})`).join(", ")}`)
              const top = WikiIndex.search(index.pages, { tags: [fallback[0].tag] }).slice(0, 3)
              if (top.length > 0) {
                footer.push(`top pages under "${fallback[0].tag}": ${top.map((hit) => hit.page.id).join(", ")}`)
              }
              footer.push(`next: search again with tags: ["${fallback[0].tag}"] — another round costs almost nothing.`)
            }
            return {
              title,
              metadata: { pages: index.pages.length, matches: 0, truncated: false },
              output: assemble(
                [
                  `No wiki page matched ${describeQuery(query, tags)} across ${index.pages.length} pages (tags, titles, headings, ids and descriptions — page bodies are never searched).`,
                ],
                [],
                footer,
              ).text,
            }
          }

          const rows = hits
            .slice(0, limit)
            .map(
              (hit) =>
                `${hit.page.id}  [${hit.page.tags.join(", ") || "no tags"}]  ${hit.page.description || "(no description)"}  (matched: ${hit.reasons.join(", ")})`,
            )
          // The NEXT MOVE, and the reason a search is worth repeating. Hits
          // normally carry the tags that co-occur with them; when the whole hit
          // set shares nothing else, the closest OTHER tags in the vocabulary
          // are the only useful lever left, and "(none)" beats echoing the
          // query back as its own suggestion.
          const askedTags = new Set(asked.map(WikiIndex.normalize))
          const related = WikiIndex.relatedTags(hits, asked)
          const near =
            related.length > 0
              ? []
              : WikiIndex.nearestTags(index.pages, asked).filter((entry) => !askedTags.has(entry.tag))
          const label = (entries: { tag: string; count: number }[]) =>
            entries.map((entry) => `${entry.tag}(${entry.count})`).join(", ")
          const footer = [
            related.length > 0
              ? `related tags: ${label(related)}`
              : near.length > 0
                ? `nearest tags: ${label(near)}`
                : "related tags: (none — the matching pages share no other tags)",
            related.length > 0
              ? "next: read the best 1-2 pages with the read tool (<page-id>.md), or narrow with one of those tags."
              : "next: read the best 1-2 pages with the read tool (<page-id>.md).",
          ]
          const output = assemble(
            [
              `${hits.length} wiki page${hits.length === 1 ? "" : "s"} match ${describeQuery(query, tags)}${hits.length > rows.length ? `, top ${rows.length}` : ""} (metadata only — page bodies are never searched):`,
            ],
            rows,
            footer,
          )
          return {
            title,
            metadata: { pages: index.pages.length, matches: hits.length, truncated: output.truncated },
            output: output.text,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WikiRelatedTool = Tool.define(
  "wiki_related",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description: RELATED_DESCRIPTION,
      parameters: RelatedParameters,
      execute: (params: { page: string; depth?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const wanted = (params.page ?? "").trim()
          yield* ctx.ask({
            permission: "wiki_related",
            patterns: [wanted || "*"],
            always: ["*"],
            metadata: {
              page: params.page,
              depth: params.depth,
            },
          })

          if (!wanted) {
            return {
              title: "wiki",
              metadata: { links: 0, inbound: 0, truncated: false },
              output: "wiki_related needs a `page`. Nothing was looked up.",
            }
          }

          const index = yield* WikiIndex.load(fs, ins.directory)
          if (index.roots.length === 0) {
            return {
              title: wanted,
              metadata: { links: 0, inbound: 0, truncated: false },
              output: `No wiki roots found — looked for ${index.missing.join(" and ")}. This workspace keeps no wiki or agent memory, so there is nothing to walk.`,
            }
          }

          const resolved = WikiIndex.resolve(index.pages, wanted)
          if (!resolved.page) {
            const nearest = resolved.nearest.map((page) => page.id)
            return {
              title: wanted,
              metadata: { links: 0, inbound: 0, truncated: false },
              output: [
                `No page resolved from "${wanted}" across ${index.pages.length} pages.`,
                nearest.length > 0
                  ? `nearest page ids: ${nearest.join(", ")}`
                  : "The knowledge base has no pages at all.",
                "next: pass one of those ids, or use wiki_search to find the topic by tag.",
              ].join("\n"),
            }
          }

          const page = resolved.page
          const depth = Math.max(1, Math.min(2, Math.floor(params.depth ?? 1)))
          const inbound = WikiIndex.inbound(index.pages, page)
          const neighbours = WikiIndex.sharedTags(index.pages, page)
          const rows: string[] = []

          // Depth 2 expands only the first few neighbours on each side. The
          // char cap would throw the rest away anyway, and a second hop off
          // thirty inbound pages is a full re-scan of the index per page for
          // lines nobody will see.
          const HOPS = 5

          rows.push(`outbound links (${page.links.length}):`)
          if (page.links.length === 0) rows.push("  (none — this page links nowhere)")
          page.links.forEach((link, position) => {
            const target = WikiIndex.resolveLink(index.pages, link)
            if (!target) {
              rows.push(`  ${link} (unwritten)`)
              return
            }
            rows.push(`  ${describePage(target)}`)
            if (depth < 2 || position >= HOPS) return
            for (const hop of target.links.slice(0, HOPS)) {
              const next = WikiIndex.resolveLink(index.pages, hop)
              rows.push(`      -> ${next ? next.id : `${hop} (unwritten)`}`)
            }
          })

          rows.push(`inbound links (${inbound.length}) — pages that link TO this one:`)
          if (inbound.length === 0) rows.push("  (none — nothing cites this page)")
          inbound.forEach((source, position) => {
            rows.push(`  ${describePage(source)}`)
            if (depth < 2 || position >= HOPS) return
            for (const hop of WikiIndex.inbound(index.pages, source).slice(0, HOPS)) {
              rows.push(`      <- ${hop.id}`)
            }
          })

          rows.push(`shared tags (${neighbours.length}):`)
          if (neighbours.length === 0) rows.push("  (none — no other page carries these tags)")
          for (const entry of neighbours) {
            rows.push(`  ${describePage(entry.page)}  (${entry.shared.length} shared: ${entry.shared.join(", ")})`)
          }

          const output = assemble(
            [
              `${page.id}  [${page.tags.join(", ") || "no tags"}]${resolved.how === "exact" ? "" : ` (resolved from "${wanted}" by ${resolved.how} match)`}`,
              `  ${page.description || "(no description)"}`,
            ],
            rows,
            ["next: read the 1-2 that matter with the read tool (<page-id>.md). Metadata only above — no page bodies."],
          )
          return {
            title: page.id,
            metadata: { links: page.links.length, inbound: inbound.length, truncated: output.truncated },
            output: output.text,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function describePage(page: WikiIndex.Page): string {
  return `${page.id}  [${page.tags.join(", ") || "no tags"}]  ${page.description || "(no description)"}`
}

function describeQuery(query: string, tags: readonly string[]): string {
  if (query && tags.length > 0) return `"${query}" filtered by tags [${tags.join(", ")}]`
  if (query) return `"${query}"`
  return `tags [${tags.join(", ")}]`
}

/**
 * Join header + rows + footer under {@link OUTPUT_CAP}, dropping ROWS from the
 * end — never the footer, because the footer is the next move and a reply that
 * loses it is a dead end. The drop is always announced: a silently shortened
 * list reads as "that is all there is".
 */
function assemble(
  header: readonly string[],
  rows: readonly string[],
  footer: readonly string[],
): { text: string; truncated: boolean } {
  const build = (count: number, note?: string) =>
    [
      ...header,
      ...(count > 0 ? ["", ...rows.slice(0, count)] : []),
      ...(note ? ["", note] : []),
      ...(footer.length > 0 ? ["", ...footer] : []),
    ].join("\n")

  let shown = rows.length
  let text = build(shown)
  while (text.length > OUTPUT_CAP && shown > 1) {
    shown--
    const dropped = rows.length - shown
    text = build(shown, `(${dropped} more line${dropped === 1 ? "" : "s"} — output capped at ${OUTPUT_CAP} characters)`)
  }
  return { text, truncated: shown < rows.length }
}

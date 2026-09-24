/**
 * OFFLINE measurement of tool-result aging (session/tool-aging.ts).
 *
 * It replays real session history — every model call of every turn, rebuilt the
 * way `session/prompt.ts` rebuilds it — through `MessageV2.toModelMessagesEffect`
 * twice, with aging OFF and ON, and prints what the second one saved.
 *
 * IT NEVER CALLS A MODEL AND IT NEVER WRITES. The database is opened readonly
 * with `PRAGMA query_only = ON`, and the script refuses any path under the live
 * instance directory: measurement runs on a COPY.
 *
 *   Copy-Item "$env:USERPROFILE\.local\share\origami\origami.db*" <scratch>\db\
 *   bun script/tool-aging-replay.ts <scratch>\db\origami.db [--sessions 20]
 *
 * WHAT IT APPROXIMATES, stated plainly:
 *
 * - A model call is a `step-start` part. The outgoing array for that call is
 *   every part written before it, which is what the step loop pages out of
 *   SQLite. Reconstructed, not recorded — the engine keeps no copy of the array.
 * - The boundary rule needs `overflow.usable()`, which needs the model's context
 *   limit, and the database does not store one. So the second half of the rule
 *   uses `--context` (default 200000) as the window. The first half — a turn's
 *   first step — is exact, and it is the half that fires on almost every turn.
 * - Bytes are `JSON.stringify` of the array, UTF-8. Tokens are bytes / 3.2, the
 *   measured chars-per-token of this box (token_burn_facts_2026-09-02.md §2.2).
 */

import { Database as Sqlite } from "bun:sqlite"
import * as path from "node:path"
import { Effect } from "effect"
import { MessageV2 } from "../src/session/message-v2"
import { SessionToolAging } from "../src/session/tool-aging"
import type { Provider } from "../src/provider/provider"
import type { SessionV1 } from "@origami/core/v1/session"

/** The measured chars/token of this box, from the fact sheet. */
const CHARS_PER_TOKEN = 3.2

const DEFAULT_SESSIONS = 20
const DEFAULT_CONTEXT = 200_000
const MIN_TOOL_CALLS = 3

/**
 * A path the LIVE instance owns. Opening it readonly would still be wrong: the
 * point of the copy is that a running engine cannot be perturbed at all.
 */
function isLivePath(target: string): boolean {
  const normalized = target.replaceAll("\\", "/").toLowerCase()
  return normalized.includes("/.local/share/origami/")
}

/** Only the shape `toModelMessagesEffect` reads off a model. */
const model = {
  id: "replay",
  providerID: "replay",
  api: { id: "replay", url: "https://example.invalid", npm: "@ai-sdk/openai" },
  name: "Replay",
  limit: { context: 0, input: 0, output: 0 },
} as unknown as Provider.Model

type Row = { id: string; data: string }

type Message = { info: SessionV1.Info; parts: SessionV1.Part[] }

function loadSession(db: Sqlite, sessionID: string): Message[] {
  const messageRows = db
    .query<Row & { session_id: string }, [string]>(
      "select id, session_id, data from message where session_id = ? order by time_created asc, id asc",
    )
    .all(sessionID)
  const partRows = db
    .query<Row & { message_id: string; session_id: string }, [string]>(
      "select id, message_id, session_id, data from part where session_id = ? order by message_id asc, id asc",
    )
    .all(sessionID)

  const byMessage = new Map<string, SessionV1.Part[]>()
  for (const row of partRows) {
    const part = { ...JSON.parse(row.data), id: row.id, sessionID: row.session_id, messageID: row.message_id }
    const list = byMessage.get(row.message_id)
    if (list) list.push(part)
    else byMessage.set(row.message_id, [part])
  }
  return messageRows.map((row) => ({
    info: { ...(JSON.parse(row.data) as object), id: row.id, sessionID: row.session_id } as SessionV1.Info,
    parts: byMessage.get(row.id) ?? [],
  }))
}

type Call = {
  /** The array this call would have sent, oldest message first. */
  readonly messages: Message[]
  /** 1-based step inside its own turn. */
  readonly step: number
  /** Tokens the previous step finished on, for the 50%-of-window half. */
  readonly previousTokens: { input: number; cacheRead: number } | undefined
}

/**
 * Every model call of a session, each with the history it carried.
 *
 * A call is a `step-start`. Its array is the messages already closed, plus its
 * own message truncated to the parts written before that step-start — which is
 * exactly what the loop reads back out of SQLite at that instant.
 */
function calls(messages: Message[]): Call[] {
  const result: Call[] = []
  const closed: Message[] = []
  let step = 0
  let previousTokens: Call["previousTokens"]

  for (const message of messages) {
    if (message.info.role === "user") {
      step = 0
      previousTokens = undefined
    }
    if (message.info.role === "assistant") {
      for (let index = 0; index < message.parts.length; index++) {
        const part = message.parts[index]
        if (part.type === "step-start") {
          step++
          result.push({
            messages: [...closed, { info: message.info, parts: message.parts.slice(0, index) }],
            step,
            previousTokens,
          })
        }
        if (part.type === "step-finish") {
          previousTokens = { input: part.tokens.input, cacheRead: part.tokens.cache.read }
        }
      }
    }
    closed.push(message)
  }
  return result
}

function isBoundary(call: Call, context: number): boolean {
  if (call.step === 1) return true
  if (!call.previousTokens) return false
  return call.previousTokens.input + call.previousTokens.cacheRead > context / 2
}

/**
 * TEXT bytes of one outgoing array — a `data:` payload counts as its length,
 * not its characters.
 *
 * An image on the wire is base64, and the tokens it costs are set by the
 * provider's own tiling rule, not by `bytes / 3.2`. Counting the base64 would
 * make the token columns of a screenshot-heavy session meaningless, and would
 * drown the thing being measured: the 20 most recent sessions on this box are
 * video work, where 98.6% of tool-part bytes are attachments and the whole text
 * output of 38 tool calls is 16.5 KB. The same rule is applied to the OFF and
 * the ON array, so the comparison is unaffected either way.
 */
function bytes(value: unknown): number {
  // Two shapes reach the array: a media part keeps its base64 under `data`
  // with the `data:` prefix already stripped (message-v2 `toModelOutput`), and
  // a file part injected for a provider that cannot take media in a tool
  // result keeps the whole `data:` URI under `url`.
  const text = JSON.stringify(value, (key, entry) => {
    if (typeof entry !== "string" || entry.length <= 256) return entry
    if (key === "data" || entry.startsWith("data:")) return `[media ${entry.length} chars]`
    return entry
  })
  return Buffer.byteLength(text ?? "null", "utf8")
}

function percent(before: number, after: number): string {
  if (before === 0) return "0.0%"
  return `${(((after - before) / before) * 100).toFixed(1)}%`
}

const main = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const target = args.find((arg) => !arg.startsWith("--"))
  if (!target) {
    console.error("usage: bun script/tool-aging-replay.ts <copy-of-origami.db> [--sessions N] [--context N]")
    process.exit(2)
  }
  const resolved = path.resolve(target)
  if (isLivePath(resolved)) {
    console.error(`refusing to open the live instance database: ${resolved}`)
    console.error("copy it first (origami.db plus -wal and -shm) and point this script at the copy.")
    process.exit(2)
  }
  const limit = Number(args.find((arg) => arg.startsWith("--sessions="))?.split("=")[1] ?? DEFAULT_SESSIONS)
  const context = Number(args.find((arg) => arg.startsWith("--context="))?.split("=")[1] ?? DEFAULT_CONTEXT)

  const db = new Sqlite(resolved, { readonly: true })
  db.run("PRAGMA query_only = ON")

  // Sessions with tool calls, newest first. `compaction` parts disqualify a
  // session: its history was rewritten, so a replay would measure the summary
  // rather than the transcript.
  const candidates = db
    .query<{ session_id: string; tools: number; created: number }, []>(
      `select p.session_id as session_id,
              sum(case when json_extract(p.data,'$.type') = 'tool' then 1 else 0 end) as tools,
              max(s.time_created) as created
         from part p join session s on s.id = p.session_id
        where p.session_id not in (
                select session_id from part where json_extract(data,'$.type') = 'compaction'
              )
        group by p.session_id
       having tools >= ${MIN_TOOL_CALLS}
        order by created desc
        limit ${limit}`,
    )
    .all()

  const rows: string[] = []
  let totalSteps = 0
  let totalBefore = 0
  let totalAfter = 0

  for (const candidate of candidates) {
    const messages = loadSession(db, candidate.session_id)
    const sessionCalls = calls(messages)
    if (sessionCalls.length === 0) continue

    SessionToolAging.reset()
    let before = 0
    let after = 0
    for (const call of sessionCalls) {
      const boundary = isBoundary(call, context)
      const plan = SessionToolAging.plan({
        sessionID: candidate.session_id,
        messages: call.messages as SessionV1.WithParts[],
        boundary,
      })
      const off = yield* MessageV2.toModelMessagesEffect(call.messages as SessionV1.WithParts[], model)
      const on = yield* MessageV2.toModelMessagesEffect(call.messages as SessionV1.WithParts[], model, {
        toolRewrites: plan.rewrites,
      })
      before += bytes(off)
      after += bytes(on)
    }

    const steps = sessionCalls.length
    totalSteps += steps
    totalBefore += before
    totalAfter += after
    rows.push(
      [
        candidate.session_id.slice(0, 20),
        String(steps),
        Math.round(before / steps).toLocaleString("en-US"),
        Math.round(after / steps).toLocaleString("en-US"),
        Math.round(before / steps / CHARS_PER_TOKEN).toLocaleString("en-US"),
        Math.round(after / steps / CHARS_PER_TOKEN).toLocaleString("en-US"),
        percent(before, after),
      ].join(" | "),
    )
  }

  console.log(`# tool-result aging replay — ${resolved}`)
  console.log(`sessions=${rows.length} K=${SessionToolAging.K} context=${context} chars/token=${CHARS_PER_TOKEN}\n`)
  console.log("| session | steps | bytes/call before | bytes/call after | tokens before | tokens after | delta |")
  console.log("|---|---|---|---|---|---|---|")
  for (const row of rows) console.log(`| ${row} |`)
  if (totalSteps > 0) {
    console.log(
      `| **TOTAL** | ${totalSteps} | ${Math.round(totalBefore / totalSteps).toLocaleString("en-US")} | ` +
        `${Math.round(totalAfter / totalSteps).toLocaleString("en-US")} | ` +
        `${Math.round(totalBefore / totalSteps / CHARS_PER_TOKEN).toLocaleString("en-US")} | ` +
        `${Math.round(totalAfter / totalSteps / CHARS_PER_TOKEN).toLocaleString("en-US")} | ` +
        `${percent(totalBefore, totalAfter)} |`,
    )
  }
  db.close()
})

await Effect.runPromise(main)

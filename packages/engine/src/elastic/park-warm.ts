export * as ElasticParkWarm from "./park-warm"

import fs from "node:fs"
import path from "node:path"
import { asSchema, jsonSchema, type Tool } from "ai"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { Global } from "@origami/core/global"
import { SessionCacheState } from "@/session/cache-state"
import { SessionCacheWarm } from "@/session/cache-warm"
import { LLM } from "@/session/llm"

/**
 * t-z6ytkw: A CACHE WARM ACROSS A PARK. The extension parks an idle chat at the
 * user's Park-after time, also while a cache warm is armed (owner decision
 * 2026-09-26). The armed warm dies with the process, so the park hands it over:
 *
 *  - `persist` (at `_elastic_park`): each armed warm's stream input is written to
 *    `<state>/park-warm/<session>.json`, and the answer names when it is due.
 *  - the extension wakes the chat in the background shortly before that time
 *    (vscode elastic/warmWake.ts) and asks `_elastic_warm`:
 *  - `take` + `send`: the file is read and deleted, and the SAME stream input goes
 *    through the SAME `LLM.stream` the live warm uses (session/llm.ts `send`), with
 *    the same trailing message and `warm: true`. So the request bytes are the ones
 *    the live engine would have sent (test/elastic/park-warm-bytes.test.ts).
 *
 * One warm per real request, as the live engine does (cache-warm.ts arms one and
 * does not re-arm). A file is used once. No warm when warming is off, or when this
 * process already sent a real request for the session (its own warm is armed).
 *
 * The stream input is plain data but for three things, encoded here: the tools
 * (their JSON schema; no `execute`: a warm answers one token and runs no tool),
 * binary parts (`Uint8Array`) and `URL` values.
 */

export const DIR = "park-warm"

export type Recipe = {
  readonly input: Omit<LLM.StreamInput, "warm" | "retries">
  readonly directory?: string
}

export type Handed = { readonly sessionId: string; readonly dueAt: number }

const file = (sessionID: string, root = Global.Path.state) =>
  path.join(root, DIR, sessionID.replace(/[^A-Za-z0-9_-]/g, "_") + ".json")

const SCHEMA = "$jsonSchema"
const U8 = "$u8"
const URL_KEY = "$url"

async function encodeTools(tools: Record<string, Tool>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [name, item] of Object.entries(tools)) {
    const plain: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (typeof value === "function") continue
      if ((key === "inputSchema" || key === "outputSchema") && value !== undefined) {
        plain[key] = { [SCHEMA]: await asSchema(value as never).jsonSchema }
        continue
      }
      plain[key] = value
    }
    out[name] = plain
  }
  return out
}

/** The recipe as text. Exported for the test. */
export async function encode(recipe: Recipe): Promise<string> {
  const tools = await encodeTools(recipe.input.tools)
  return JSON.stringify({ ...recipe, input: { ...recipe.input, tools } }, function (this: Record<string, unknown>, key, value) {
    const raw = this[key]
    if (raw instanceof Uint8Array) return { [U8]: Buffer.from(raw).toString("base64") }
    if (raw instanceof URL) return { [URL_KEY]: raw.href }
    return value
  })
}

export function decode(text: string): Recipe {
  return JSON.parse(text, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.length === 1 && keys[0] === U8) return new Uint8Array(Buffer.from(value[U8], "base64"))
      if (keys.length === 1 && keys[0] === URL_KEY) return new URL(value[URL_KEY])
      if (keys.length === 1 && keys[0] === SCHEMA) return jsonSchema(value[SCHEMA])
    }
    return value
  }) as Recipe
}

/** At a park: write each armed warm, and drop the stale file of a session that has
 *  none now. The warms the extension should wake for, soonest first. Never throws. */
export async function persist(root = Global.Path.state): Promise<Handed[]> {
  const handed: Handed[] = []
  const pending = SessionCacheWarm.pendingWarms()
  const armed = new Set(pending.map((p) => p.sessionID))
  for (const id of SessionCacheWarm.requestedSessions()) if (!armed.has(id)) fs.rmSync(file(id, root), { force: true })
  if (!SessionCacheWarm.enabled()) return handed
  for (const warm of pending) {
    try {
      const target = file(warm.sessionID, root)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target + ".tmp", await encode(warm.recipe() as Recipe))
      fs.renameSync(target + ".tmp", target)
      handed.push({ sessionId: warm.sessionID, dueAt: warm.dueAt })
    } catch (error) {
      console.error(`[elastic] park-warm: not persisted for ${warm.sessionID}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return handed.sort((a, b) => a.dueAt - b.dueAt)
}

export type Taken = { readonly recipe: Recipe } | { readonly refused: string }

/** Read and delete the handed-over warm of `sessionID`. */
export function take(sessionID: string, root = Global.Path.state): Taken {
  const target = file(sessionID, root)
  let text: string
  try {
    text = fs.readFileSync(target, "utf8")
  } catch {
    return { refused: "no warm was handed over" }
  }
  fs.rmSync(target, { force: true })
  if (!SessionCacheWarm.enabled()) return { refused: "cache warming is off" }
  if (SessionCacheWarm.requested(sessionID)) return { refused: "a real request went out since the park" }
  return { recipe: decode(text) }
}

/** Send the handed-over warm: the live engine's `send`, from its recipe. */
export const send = (recipe: Recipe) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const input = recipe.input
    let cacheRead: number | undefined
    yield* Stream.runForEach(
      llm.stream({ ...input, messages: SessionCacheWarm.warmRequest(input.messages).messages, warm: true, retries: 0 }),
      (event) =>
        Effect.sync(() => {
          if (event.type !== "step-finish") return
          cacheRead = event.usage?.cacheReadInputTokens
          SessionCacheState.warmed({ sessionID: input.sessionID, cacheRead })
        }),
    )
    yield* Effect.logInfo("cache warm after park", { "session.id": input.sessionID, cacheRead })
    return { warmed: true as const, ...(cacheRead === undefined ? {} : { cacheRead }) }
  })

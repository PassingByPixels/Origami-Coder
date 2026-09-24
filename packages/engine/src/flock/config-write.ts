export * as FlockConfigWrite from "./config-write"

import fs from "node:fs"
import path from "node:path"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { Global } from "@origami/core/global"
import { FlockPolicy } from "./policy"

/**
 * Read and write `flock.frontDesk` — THE GLOBAL CONFIG FILE, and only that one.
 * The same argument that keeps `flock.json` global applies: a project-local
 * `origami.json` must never decide who this Origami answers, on whose model, from
 * which files — cloning a repo with a `flock` block in it would silently take
 * over the owner's answering policy for as long as that folder was open.
 *
 * Deliberately NOT through `Config.Service`, for the reason `mcp/config-write.ts`
 * states: it merges every config file into one value with no record of which
 * physical file an entry came from, so a write has nowhere correct to land.
 * The edit goes through jsonc-parser, so a hand-written file keeps its comments and its
 * formatting. `directory` is a parameter so a test never writes the real config directory.
 */

const FILE = "origami.json"

/** The three fields that live in the config file. `autoAnswer` and the
 *  specialties are NOT here — see `store.ts`'s `Desk`. */
export interface FrontDesk {
  readonly model?: string
  readonly dailyBudgetTokens?: number
  readonly scope?: FlockPolicy.Scope
}

export function file(directory: string = Global.Path.config): string {
  return path.join(directory, FILE)
}

function readText(target: string): string {
  try {
    return fs.readFileSync(target, "utf8")
  } catch {
    return "{}"
  }
}

export function read(directory?: string): FrontDesk {
  const target = file(directory)
  let parsed: unknown
  try {
    parsed = parseJsonc(readText(target))
  } catch {
    throw new Error(`${target} is not valid JSON — fix or remove it first`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const flock = (parsed as Record<string, unknown>)["flock"]
  if (!flock || typeof flock !== "object" || Array.isArray(flock)) return {}
  const desk = (flock as Record<string, unknown>)["frontDesk"]
  if (!desk || typeof desk !== "object" || Array.isArray(desk)) return {}
  const block = desk as FrontDesk
  // THE SCOPE IS SANITISED ON THE WAY OUT, every read. This file is hand-editable
  // and predates the ruling that a skill is not a permission, so a
  // `flock.frontDesk.scope.skills` list written by an older build is dropped here
  // rather than honoured, which would keep widening the desk's path cage.
  if (block.scope === undefined) return block
  return { ...block, scope: FlockPolicy.sanitiseScope(block.scope) }
}

/** `flock.relayUrl` from the same file — the relay a friendship falls back to when
 *  the friend's invite named none. NOT `origamicoder.remote.relayUrl`, the VS Code
 *  setting pointing the owner's PHONE at a relay; they may well name the same host
 *  and are still different settings. Nothing here ever reads that one. */
export function relayUrl(directory?: string): string | undefined {
  const target = file(directory)
  let parsed: unknown
  try {
    parsed = parseJsonc(readText(target))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const flock = (parsed as Record<string, unknown>)["flock"]
  if (!flock || typeof flock !== "object" || Array.isArray(flock)) return undefined
  const value = (flock as Record<string, unknown>)["relayUrl"]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Merge a patch into `flock.frontDesk` and return the file it landed in. A field
 *  the caller left `undefined` is untouched; a field set to `null` is REMOVED.
 *  Those are two different intentions — "I did not edit the budget" and "I want no
 *  budget cap" — and collapsing them makes a cap impossible to clear once set. */
export function write(
  patch: { model?: string | null; dailyBudgetTokens?: number | null; scope?: FlockPolicy.Scope | null },
  directory?: string,
): string {
  const target = file(directory)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let text = readText(target)
  const formattingOptions = { tabSize: 2, insertSpaces: true }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const edits = modify(text, ["flock", "frontDesk", key], value === null ? undefined : value, { formattingOptions })
    text = applyEdits(text, edits)
  }
  fs.writeFileSync(target, text)
  return target
}

import path from "path"
import fs from "fs"
import { Global } from "@origami/core/global"

/**
 * The reasoning-effort tiers a model has refused, remembered across restarts.
 * Every other source of a model's ladder is a claim made before the request (a
 * name-regex table in `provider/transform.ts`, or the levels the ChatGPT
 * backend advertises); the endpoint's own 400 is the only statement made after
 * the fact, so it is kept here.
 *
 * Per user, not per session, unlike `session/degrade.ts`: a vendor model
 * refusing a tier is a fact about that model, so a tier that 400s once must
 * never cost a second request and must never be offered in the picker again.
 *
 * Read once per process, written synchronously only on a real demotion. Every
 * filesystem call is wrapped: an unreadable store means "nothing is demoted".
 */

/**
 * Every effort tier this engine knows, WEAKEST FIRST. The order is what "one
 * tier down" means. One shared table, not per-provider: the words are shared
 * vocabulary, and a demotion only steps between tiers the model itself offers,
 * so a tier listed here that a model lacks is never reached.
 *
 * `none` and `minimal` sit below `low` even though no OpenAI ladder offers them
 * any more (see OPENAI_RETIRED_EFFORTS in provider/transform.ts) - a session
 * still holding one resolves upwards to `low` through this same order.
 */
export const TIER_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const

type Store = Record<string, string[]>

let store: Store | undefined

/** Where the demotions live. A getter, not a const, so a test that redirects
 *  XDG_DATA_HOME still gets its own file. */
export function file(): string {
  return path.join(Global.Path.data, "effort-demotions.json")
}

function storeKey(providerID: string, modelID: string): string {
  return providerID + "/" + modelID
}

function load(): Store {
  if (store) return store
  const loaded: Store = {}
  store = loaded
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue
        const tiers = value.filter((tier): tier is string => typeof tier === "string")
        if (tiers.length > 0) loaded[key] = tiers
      }
    }
  } catch {
    // No file yet, or one this cannot read: nothing is demoted, the state
    // every install starts in.
  }
  return loaded
}

/** The tiers this model has refused. Empty when it has refused none. */
export function demoted(providerID: string, modelID: string): readonly string[] {
  return load()[storeKey(providerID, modelID)] ?? []
}

/**
 * Remember that this model refused this tier. Idempotent: a tier already
 * recorded costs no disk write.
 */
export function record(providerID: string, modelID: string, tier: string): void {
  const current = load()
  const key = storeKey(providerID, modelID)
  const tiers = current[key] ?? []
  if (tiers.includes(tier)) return
  current[key] = [...tiers, tier]
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(current, null, 2))
  } catch {
    // The in-memory answer still holds for this process. A store that cannot
    // be written must not take the request down with it.
  }
}

/**
 * `tiers` with every demoted one removed. Never empty: a model whose whole
 * ladder has been refused gets the original list back untouched, rather than
 * losing its reasoning control and sending no effort at all.
 */
export function ladder(providerID: string, modelID: string, tiers: readonly string[]): string[] {
  const gone = demoted(providerID, modelID)
  if (gone.length === 0) return [...tiers]
  const kept = tiers.filter((tier) => !gone.includes(tier))
  return kept.length > 0 ? kept : [...tiers]
}

/** `variants` with every demoted tier's entry removed, by the same rule. */
export function filterVariants<T>(
  providerID: string,
  modelID: string,
  variants: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!variants) return variants
  const keys = Object.keys(variants)
  if (keys.length === 0) return variants
  const kept = ladder(providerID, modelID, keys)
  if (kept.length === keys.length) return variants
  return Object.fromEntries(kept.map((key) => [key, variants[key]!]))
}

/**
 * The strongest available tier still weaker than `tier`, or undefined when
 * there is none. `tier` itself is never returned, so a caller cannot loop on it.
 */
export function below(tier: string, available: readonly string[]): string | undefined {
  const rank = TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number])
  if (rank < 0) return undefined
  let best: string | undefined
  let bestRank = -1
  for (const candidate of available) {
    const candidateRank = TIER_ORDER.indexOf(candidate as (typeof TIER_ORDER)[number])
    if (candidateRank < 0 || candidateRank >= rank) continue
    if (candidateRank > bestRank) {
      best = candidate
      bestRank = candidateRank
    }
  }
  return best
}

/**
 * Which tier a withdrawn choice becomes: one step down where the ladder has a
 * step, otherwise its weakest tier. The fallback is what carries a stored
 * `none` or `minimal` up to `low`, rather than sending no effort at all.
 */
export function replacement(tier: string, available: readonly string[]): string | undefined {
  return below(tier, available) ?? available[0]
}

/** Test seam - the store is module state AND a file, so a test must empty both. */
export function reset(): void {
  store = undefined
  try {
    fs.rmSync(file(), { force: true })
  } catch {
    // Nothing to remove.
  }
}

/** Test seam - drop the in-memory copy WITHOUT touching the file, so a test can
 *  prove that a demotion survives a restart. */
export function forget(): void {
  store = undefined
}

export * as ProviderEffortDemotion from "./effort-demotion"

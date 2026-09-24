/**
 * Live model discovery: ask each provider what this credential is served, with
 * the baked catalogue as a seed rather than as the answer. Two rules hold for
 * every provider: one loader's failure must not cost the others their rows, and
 * opening the picker must not re-hit the network.
 *
 * Discovery only fills in what nobody had said yet - it never deletes or edits a
 * row, and the config's version wins over a discovered one (the same rule
 * provider.ts's config pass follows).
 */
import type { Model } from "./provider"
import { Hash } from "@origami/core/util/hash"

/** How long a loader's answer stands. Long enough that reopening the picker is
 *  free, short enough that a model added mid-session needs no restart. */
export const DISCOVERY_TTL_MS = 10 * 60 * 1000

export type DiscoverModels = () => Promise<Record<string, Model>>

/**
 * The memo, at module scope on purpose: the provider list is an `InstanceState`
 * entry that every `provider_refresh` drops, and the picker fires one before it
 * asks for models, so a cache built inside that rebuild would always be empty.
 *
 * Keyed by provider id AND a fingerprint of the credential, never by the id
 * alone: signing out and back in on a different account must not be served the
 * previous account's model list for the rest of the TTL. `discoveryKey` below
 * builds the key; the credential itself never becomes one.
 */
const cache = new Map<string, { at: number; value: Record<string, Model> }>()
const inflight = new Map<string, Promise<Record<string, Model>>>()

/** Drop every memoised answer. For tests; a credential change is handled by the key. */
export function resetDiscoveryCache(): void {
  cache.clear()
  inflight.clear()
}

/**
 * The cache key for one provider under one credential. The secret is hashed and
 * truncated, never stored: a raw access token as a Map key would sit in
 * long-lived module scope for any heap dump or debug print to carry, and all the
 * key has to do is change when the credential changes.
 *
 * An absent credential gets its own key rather than sharing the "" one, so a
 * signed-out provider's empty answer is not what a signed-in one reads back.
 */
export function discoveryKey(providerID: string, secret: string | undefined): string {
  return providerID + ":" + (secret ? Hash.fast(secret).slice(0, 16) : "anonymous")
}

/**
 * Wrap a loader so its answer is reused for `ttlMs`. Concurrent calls share one
 * in-flight promise.
 *
 * A rejection is not cached - a loader that failed while the token was mid
 * refresh must be free to succeed on the next attempt. An empty answer IS
 * cached: "this account is served nothing extra" is a real answer.
 */
export function memoizeDiscovery(
  key: string,
  fn: DiscoverModels,
  options: { ttlMs?: number; now?: () => number } = {},
): DiscoverModels {
  const ttlMs = options.ttlMs ?? DISCOVERY_TTL_MS
  const now = options.now ?? Date.now
  return async () => {
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.value
    const running = inflight.get(key)
    if (running) return running
    const promise = fn()
      .then((value) => {
        cache.set(key, { at: now(), value })
        return value
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, promise)
    return promise
  }
}

/**
 * Run every registered loader and merge what each one answers into its own
 * provider's model list.
 *
 * One provider at a time, each in its own try/catch: a loader reaches the
 * network with a credential that can be expired, revoked or rate-limited, and
 * catching here means a plugin author cannot take the whole provider list down
 * by forgetting to.
 *
 * `isAllowed` is the caller's enabled/disabled gate, asked again rather than
 * assumed: a provider the user switched off must not have its credential put
 * on the wire at all.
 */
export async function runDiscoveryLoaders(input: {
  loaders: Record<string, DiscoverModels>
  providers: Record<string, { models: Record<string, Model> }>
  isAllowed: (providerID: string) => boolean
  onError?: (providerID: string, error: unknown) => void
}): Promise<void> {
  for (const [providerID, load] of Object.entries(input.loaders)) {
    const provider = input.providers[providerID]
    if (!provider || !input.isAllowed(providerID)) continue
    try {
      const discovered = await load()
      for (const [modelID, model] of Object.entries(discovered)) {
        const existing = provider.models[modelID]
        if (!existing) {
          provider.models[modelID] = model
          continue
        }
        // origami_change (t-48ffvz): the ADVERTISED effort ladder wins over the
        // one the row already carries.
        //
        // `variants` is the one field where a seeded or config row is only a
        // guess (its ladder comes from the name-regex table in
        // `provider/transform.ts`), so the account's own list replaces it.
        // Everything else about an existing row is left alone.
        //
        // Only a non-empty ladder replaces anything: `undefined` from a loader
        // means "this provider does not publish levels" (anthropic and xai both
        // leave it so), which must not erase what the row already had.
        if (model.variants && Object.keys(model.variants).length > 0) existing.variants = model.variants
        // origami_change (t-d94t8t): the same "fills in what nobody had said"
        // rule, for the context window. 0 is this codebase's sentinel for
        // "unset" (see anthropic-catalog.ts), so a discovered positive value
        // backfills it; a config or models.dev claim - anything already
        // positive - stands untouched.
        if (existing.limit.context <= 0 && model.limit.context > 0) existing.limit.context = model.limit.context
      }
    } catch (e) {
      input.onError?.(providerID, e)
    }
  }
}

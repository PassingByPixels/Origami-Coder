/**
 * WHICH providers can report subscription consumption at all — the gate the
 * model bar asks before it fires a usage read.
 *
 * WHY THIS IS NOT A LINE IN providerUsage.ts. That file owns one lazy READ and
 * the wording for its answer; this owns a different question, asked at a
 * different time (once on mount, before any provider is picked) and answered
 * from a different source (the config FILE, with no engine involved). Keeping
 * them apart is also what lets the gate be tested without a disk: the decision
 * below is pure, and only `configuredUsageCapableIds` touches the filesystem.
 *
 * WHY THE OAUTH HALF IS ABSENT. `providerAuthData.connected` already tells the
 * webview which providers hold an OAuth credential, and the picker ORs the two
 * together. Restating the OAuth set here would put the same fact on the wire
 * twice, from two readers that can disagree.
 *
 * NOTHING HERE SEES A KEY. The presence of `apiKey` is the whole answer; the
 * value is read, tested for emptiness and dropped. The engine holds the
 * credential and makes the call (acp/provider-usage.ts).
 */

import { globalConfigPath, readConfigObject } from './globalConfig';

/**
 * Providers whose subscription usage the engine reads from an API KEY in the
 * global config rather than from an OAuth credential.
 *
 * ONE ENTRY, AND THE OTHER OPENCODE ID IS DELIBERATELY NOT IT. OpenCode GO is a
 * flat-rate plan bought with the key itself, and `/zen/go/v1/usage` reports how
 * much of it is spent. OpenCode Zen (`opencode`) is the same host but METERED
 * per token, with no usage route under `/zen/v1` — it stays cost-tracked, and
 * adding it here would put a Zen key on a request for a plan it has not got.
 */
export const KEY_USAGE_PROVIDERS = ['opencode-go'];

/**
 * Which of those actually hold a key, given the `provider` blocks of a config.
 *
 * Pure and defensive: a config that is missing, empty, or shaped in a way this
 * build does not expect answers "none". A capability read degrades to "no
 * pill"; it never throws, and it never guesses a provider is ready.
 */
export function usageCapableIds(providers: unknown): string[] {
  if (!providers || typeof providers !== 'object') return [];
  const blocks = providers as Record<string, { options?: { apiKey?: unknown } } | undefined>;
  return KEY_USAGE_PROVIDERS.filter((id) => {
    const key = blocks[id]?.options?.apiKey;
    // A block written without a key (an OAuth provider's, or a half-finished
    // connect) is present but not usage-capable — asking would earn a refusal.
    return typeof key === 'string' && key.trim() !== '';
  });
}

/** The same read against the GLOBAL origami.json the connect form writes. */
export function configuredUsageCapableIds(): string[] {
  try {
    return usageCapableIds(readConfigObject(globalConfigPath())?.provider);
  } catch {
    return [];
  }
}

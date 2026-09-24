// Which providers can report subscription consumption at all — the gate the model bar asks before
// firing a usage read.
// Separate from providerUsage.ts's lazy READ: this is asked once on mount, before any provider is
// picked, from the config FILE with no engine involved — kept pure and testable without a disk
// beyond `configuredUsageCapableIds`.
// The OAuth half is deliberately absent: `providerAuthData.connected` already tells the webview
// which providers hold OAuth, and the picker ORs the two — restating it here would put the same
// fact on the wire from two readers that can disagree. Nothing here sees a key; only its presence
// is read.

import { globalConfigPath, readConfigObject } from './globalConfig';

/**
 * Providers whose subscription usage the engine reads from an API KEY rather
 * than OAuth. Only `opencode-go` — a flat-rate plan bought with the key
 * itself. OpenCode Zen is the same host but metered per token with no usage
 * route, so it stays cost-tracked, not listed here.
 */
export const KEY_USAGE_PROVIDERS = ['opencode-go'];

/** Providers whose usage the engine reads from an OAuth credential — read off
 *  `acp/provider-usage.ts`'s own table, since holding a credential alone isn't enough (asking about
 *  one with no usage source just earns a refusal). */
export const OAUTH_USAGE_PROVIDERS = ['openai', 'xai', 'github-copilot'];

/** Which of those actually hold a key, given a config's `provider` blocks. Pure and defensive — a
 *  missing/malformed config answers "none" rather than throwing or guessing. */
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

// billing.ts — plan-metered vs per-token, for the chat header's `$` figure.
//
// A subscription's spend is a QUOTA, not money — showing a dollar figure for
// one invents a bill that will never arrive. SpendBadge.svelte already applies
// that reasoning to the Claude Code passthrough (its own `subscription` prop);
// this covers the ENGINE's own native connections — a chat run directly on
// github-copilot / openai (ChatGPT) / xai (Grok) / opencode-go via OAuth or a
// flat-rate key, as opposed to a metered API key or OpenRouter.
//
// THE RULE. OAuth authentication is presumed to fund a plan; an API key is
// presumed to be billed per token. ONE named exception: opencode-go is a
// flat-rate PLAN bought WITH an api key (usageCapable.ts's KEY_USAGE_PROVIDERS
// — the sole entry there, and deliberately the sole exception here; that file
// cannot be imported into the webview build — rootDir split, see
// providerUsage.ts — so the one id is mirrored rather than shared).
//
// An unresolved provider or an unknown auth kind defaults to SHOWING the
// figure: hiding a real cost is the worse mistake than showing a stale one.
export type AuthKind = 'oauth' | 'apiKey' | 'unknown';

/** Mirrors usageCapable.ts's KEY_USAGE_PROVIDERS (host-only, not importable here). */
const FLAT_RATE_KEY_PROVIDERS = new Set(['opencode-go']);

export function isPerTokenBilled(providerId: string, authKind: AuthKind): boolean {
  if (!providerId) return true;
  if (authKind === 'oauth') return false;
  if (FLAT_RATE_KEY_PROVIDERS.has(providerId)) return false;
  return true;
}

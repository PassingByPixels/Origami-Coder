// billing.test.ts — the plan-vs-per-token decision the chat header's `$`
// figure hides behind (SpendBadge.svelte). Pure, so the full decision table
// runs with no DOM.

import { describe, expect, it } from 'vitest';
import { isPerTokenBilled } from './billing';

describe('isPerTokenBilled', () => {
  it('hides the figure for an OAuth-connected provider (github-copilot)', () => {
    expect(isPerTokenBilled('github-copilot', 'oauth')).toBe(false);
  });

  it('hides the figure for openai OAuth (ChatGPT plan)', () => {
    expect(isPerTokenBilled('openai', 'oauth')).toBe(false);
  });

  it('hides the figure for anthropic OAuth (Claude plan) — the rule is OAuth-general, not a 3-id allowlist', () => {
    expect(isPerTokenBilled('anthropic', 'oauth')).toBe(false);
  });

  it('hides the figure for opencode-go even though it authenticates with an API key — the named flat-rate-plan exception', () => {
    expect(isPerTokenBilled('opencode-go', 'apiKey')).toBe(false);
  });

  it('shows the figure for OpenRouter (metered, keyed)', () => {
    expect(isPerTokenBilled('openrouter', 'apiKey')).toBe(true);
  });

  it('shows the figure for any other API-key provider', () => {
    expect(isPerTokenBilled('anthropic', 'apiKey')).toBe(true);
  });

  it('shows the figure when the auth kind is unknown — the safe default is to show, never to hide a real cost', () => {
    expect(isPerTokenBilled('some-new-provider', 'unknown')).toBe(true);
  });

  it('shows the figure when no provider has resolved yet', () => {
    expect(isPerTokenBilled('', 'unknown')).toBe(true);
    expect(isPerTokenBilled('', 'oauth')).toBe(true);
  });
});

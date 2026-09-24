// SpendBadge.test.ts — the composer's ONE funding readout. `subscription`
// covers the Claude Code passthrough; `providerId`/`authKind` (billing.ts)
// cover the engine's own native OAuth/flat-rate connections — a chat run
// directly on github-copilot, openai (ChatGPT) or opencode-go must not show a
// dollar figure either, even though the engine's usage_update carries a real
// (list-price) cost.amount for those models.

import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import SpendBadge from './SpendBadge.svelte';

describe('SpendBadge', () => {
  it('shows the cost for an ordinary per-token connection (OpenRouter)', () => {
    render(SpendBadge, { props: { totalCost: 0.5613, providerId: 'openrouter', authKind: 'apiKey' } });
    expect(screen.getByText('$0.5613')).toBeInTheDocument();
  });

  it('shows the cost for a keyed provider with no OAuth', () => {
    render(SpendBadge, { props: { totalCost: 0.12, providerId: 'anthropic', authKind: 'apiKey' } });
    expect(screen.getByText('$0.1200')).toBeInTheDocument();
  });

  it('hides the cost for an OAuth-connected github-copilot chat, even though the engine reports a real list-price total_cost_usd', () => {
    render(SpendBadge, { props: { totalCost: 0.5613, providerId: 'github-copilot', authKind: 'oauth' } });
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('hides the cost for OAuth openai (ChatGPT plan)', () => {
    render(SpendBadge, { props: { totalCost: 1.2, providerId: 'openai', authKind: 'oauth' } });
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('hides the cost for opencode-go (flat-rate plan bought with a key)', () => {
    render(SpendBadge, { props: { totalCost: 0.3, providerId: 'opencode-go', authKind: 'apiKey' } });
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('shows the cost when the auth kind is unknown — the safe default', () => {
    render(SpendBadge, { props: { totalCost: 0.4, providerId: 'some-new-provider', authKind: 'unknown' } });
    expect(screen.getByText('$0.4000')).toBeInTheDocument();
  });

  it('the Claude Code passthrough `subscription` flag still hides the cost regardless of providerId/authKind', () => {
    render(SpendBadge, { props: { totalCost: 0.9, subscription: true, providerId: 'anthropic', authKind: 'apiKey' } });
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('renders nothing at all when there is no cost yet', () => {
    const { container } = render(SpendBadge, { props: { totalCost: 0, providerId: 'openrouter', authKind: 'apiKey' } });
    expect(container.querySelector('.cost')).toBeNull();
  });
});

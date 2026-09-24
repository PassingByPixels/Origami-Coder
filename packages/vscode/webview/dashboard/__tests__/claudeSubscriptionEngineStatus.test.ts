// claudeSubscriptionEngineStatus.test.ts — the picker's one host call
// (src/claudeSubscription/engineStatus.ts), against a FAKE engine reply. This
// is the seam t-tjt9wd's acceptance item names: "all four states render
// (tests with a fake engine reply)".

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchClaudeSubscriptionReadiness,
  parseEngineClaudeSubscriptionStatus,
  resetClaudeSubscriptionStatusCache,
} from '../../../src/claudeSubscription/engineStatus';

afterEach(() => resetClaudeSubscriptionStatusCache());

describe('parseEngineClaudeSubscriptionStatus — narrowing an untrusted ext-method reply', () => {
  it('maps all four named states', () => {
    expect(parseEngineClaudeSubscriptionStatus({ state: 'ready' })).toEqual({ state: 'ready' });
    expect(parseEngineClaudeSubscriptionStatus({ state: 'cli-missing' })).toEqual({ state: 'cli-missing' });
    expect(parseEngineClaudeSubscriptionStatus({ state: 'not-logged-in' })).toEqual({ state: 'not-logged-in' });
    expect(parseEngineClaudeSubscriptionStatus({ state: 'version-too-old', found: '2.1.198', floor: '2.1.263' }))
      .toEqual({ state: 'version-too-old', found: '2.1.198', floor: '2.1.263' });
  });

  it('a version-too-old reply missing found/floor still returns that state, with blanks rather than a throw', () => {
    expect(parseEngineClaudeSubscriptionStatus({ state: 'version-too-old' })).toEqual({
      state: 'version-too-old', found: '', floor: '',
    });
  });

  it('an unmapped state (the engine own generic unready) keeps the reason text', () => {
    expect(parseEngineClaudeSubscriptionStatus({ state: 'unready', reason: 'ANTHROPIC_API_KEY is set' })).toEqual({
      state: 'unready', reason: 'ANTHROPIC_API_KEY is set',
    });
  });

  it('a malformed or missing reply reads as unready, NEVER as ready', () => {
    expect(parseEngineClaudeSubscriptionStatus(undefined).state).toBe('unready');
    expect(parseEngineClaudeSubscriptionStatus(null).state).toBe('unready');
    expect(parseEngineClaudeSubscriptionStatus('nope').state).toBe('unready');
    expect(parseEngineClaudeSubscriptionStatus({}).state).toBe('unready');
    expect(parseEngineClaudeSubscriptionStatus({ state: 'made-up' }).state).toBe('unready');
  });
});

describe('fetchClaudeSubscriptionReadiness — the host call, cached briefly', () => {
  it('calls the engine ext method once and returns its mapped answer', async () => {
    const extMethod = vi.fn().mockResolvedValue({ state: 'not-logged-in' });
    const readiness = await fetchClaudeSubscriptionReadiness({ extMethod }, 1000);
    expect(readiness).toEqual({ state: 'not-logged-in' });
    expect(extMethod).toHaveBeenCalledWith('claude_subscription_status', {});
    expect(extMethod).toHaveBeenCalledTimes(1);
  });

  it('a second call inside the cache window reuses the answer without calling the engine again', async () => {
    const extMethod = vi.fn().mockResolvedValue({ state: 'ready' });
    await fetchClaudeSubscriptionReadiness({ extMethod }, 1000);
    const second = await fetchClaudeSubscriptionReadiness({ extMethod }, 1001);
    expect(second).toEqual({ state: 'ready' });
    expect(extMethod).toHaveBeenCalledTimes(1);
  });

  it('a call after the cache window expires re-asks the engine, and picks up a changed answer', async () => {
    const extMethod = vi.fn()
      .mockResolvedValueOnce({ state: 'cli-missing' })
      .mockResolvedValueOnce({ state: 'ready' });
    const first = await fetchClaudeSubscriptionReadiness({ extMethod }, 1000);
    const second = await fetchClaudeSubscriptionReadiness({ extMethod }, 10_000);
    expect(first).toEqual({ state: 'cli-missing' });
    expect(second).toEqual({ state: 'ready' });
    expect(extMethod).toHaveBeenCalledTimes(2);
  });

  it('a rejected ext-method call answers unready with the error text, instead of throwing', async () => {
    const extMethod = vi.fn().mockRejectedValue(new Error('no engine session'));
    const readiness = await fetchClaudeSubscriptionReadiness({ extMethod }, 1000);
    expect(readiness).toEqual({ state: 'unready', reason: 'no engine session' });
  });
});

// collabHealth — can this agent actually TAKE A TURN? The report's S6: a user
// invites an agent pinned to a disconnected provider and only finds out at the
// first turn, as a red `!` on a chip.
//
// The two failures worth catching here are both LIES the UI could tell:
//   1. "dead" before the provider status has arrived. The list is empty on
//      mount, and treating empty as "nothing is live" would mark every
//      candidate unreachable for the first round trip.
//   2. "unpinned" and "dead" folded together. Seeds now ship UNPINNED, so
//      "needs a model" is the ordinary out-of-the-box state and must not read
//      as a broken provider.

import { describe, expect, it } from 'vitest';
import { agentHealth, healthLabel, providerOf } from './collabHealth';

const LIVE = [{ id: 'lmstudio', live: true }, { id: 'openrouter', live: false }];

describe('providerOf', () => {
  it('takes the provider id from the front of a provider/model pin', () => {
    expect(providerOf('lmstudio/qwen3.5-35b')).toBe('lmstudio');
  });

  it('keeps only the FIRST segment — openrouter models carry a vendor path too', () => {
    expect(providerOf('openrouter/poolside/laguna-s-2.1:free')).toBe('openrouter');
  });

  it('a pin with no provider segment names no provider, rather than guessing one', () => {
    expect(providerOf('qwen3.5-35b')).toBe('');
    expect(providerOf(null)).toBe('');
    expect(providerOf('')).toBe('');
  });
});

describe('agentHealth', () => {
  it('an UNPINNED agent needs a model — that is not a provider failure', () => {
    expect(agentHealth(null, LIVE)).toEqual({ kind: 'unpinned', provider: '' });
    expect(agentHealth('', LIVE)).toEqual({ kind: 'unpinned', provider: '' });
  });

  it('a pin on a reachable provider is live', () => {
    expect(agentHealth('lmstudio/qwen3.5-35b', LIVE)).toEqual({ kind: 'live', provider: 'lmstudio' });
  });

  it('a pin on an unreachable provider is DEAD, and names the provider', () => {
    expect(agentHealth('openrouter/poolside/laguna-s-2.1:free', LIVE))
      .toEqual({ kind: 'dead', provider: 'openrouter' });
  });

  it('an EMPTY status list is unknown, never dead — the probe has not answered yet', () => {
    expect(agentHealth('lmstudio/qwen3.5-35b', [])).toEqual({ kind: 'unknown', provider: 'lmstudio' });
  });

  it('a provider the status list does not mention is unknown, not dead', () => {
    expect(agentHealth('ollama/llama3', LIVE)).toEqual({ kind: 'unknown', provider: 'ollama' });
  });

  it('a pin with no provider segment is unknown — nothing to check it against', () => {
    expect(agentHealth('qwen3.5-35b', LIVE)).toEqual({ kind: 'unknown', provider: '' });
  });
});

describe('healthLabel', () => {
  it('says what to DO about an unpinned agent', () => {
    expect(healthLabel({ kind: 'unpinned', provider: '' })).toBe('needs a model');
  });

  it('names the provider that is down', () => {
    expect(healthLabel({ kind: 'dead', provider: 'openrouter' })).toBe('openrouter unreachable');
  });

  it('says nothing at all when there is nothing to warn about', () => {
    expect(healthLabel({ kind: 'live', provider: 'lmstudio' })).toBe('');
    expect(healthLabel({ kind: 'unknown', provider: 'lmstudio' })).toBe('');
  });
});

// t-qn0wj5, proposal 24: reading origamicoder.chat.backdrop. Mirrors the
// getConfiguration mock shape from browserViewportControl.test.ts.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fake: { settings: Record<string, unknown> } = { settings: {} };

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => fake.settings[key],
    }),
  },
}));

import { chatBackdropEnabled, CHAT_BACKDROP_SECTION, CHAT_BACKDROP_KEY } from '../../../src/dashboard/chatBackdropSetting';

beforeEach(() => { fake.settings = {}; });

describe('chatBackdropEnabled', () => {
  it('reads origamicoder.chat.backdrop under the section/key it names', () => {
    expect(CHAT_BACKDROP_SECTION).toBe('origamicoder.chat');
    expect(CHAT_BACKDROP_KEY).toBe('backdrop');
  });

  it('defaults ON when the setting is absent', () => {
    expect(chatBackdropEnabled()).toBe(true);
  });

  it('is OFF only on an exact false', () => {
    fake.settings.backdrop = false;
    expect(chatBackdropEnabled()).toBe(false);
  });

  it('stays ON for any other stored value (a stale non-boolean, say)', () => {
    fake.settings.backdrop = 'nope' as unknown as boolean;
    expect(chatBackdropEnabled()).toBe(true);
  });

  it('is a costless static decoration, so a getConfiguration throw still reads ON', () => {
    fake.settings = new Proxy(
      {},
      { get: () => { throw new Error('no settings store'); } },
    ) as unknown as Record<string, unknown>;
    expect(chatBackdropEnabled()).toBe(true);
  });
});

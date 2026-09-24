// t-qn0wj5, proposal 26: chatDensity.ts, mirroring collabsSection.ts's own
// shape (absent = default, stored only when it differs from the default).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CHAT_DENSITY_KEY,
  CHAT_DENSITY_MESSAGE_TYPES,
  chatDensityCompact,
  handleChatDensityMessage,
} from '../../../src/dashboard/chatDensity';

function memento(initial: Record<string, unknown> = {}) {
  const store = { ...initial };
  return {
    get: vi.fn((key: string) => store[key]),
    update: vi.fn((key: string, value: unknown) => {
      if (value === undefined) delete store[key];
      else store[key] = value;
      return Promise.resolve();
    }),
    _store: store,
  };
}

describe('chatDensityCompact', () => {
  it('defaults to Comfortable (false) when never set', () => {
    const m = memento();
    expect(chatDensityCompact({ workspaceState: () => m as never })).toBe(false);
  });

  it('reads Compact only on an exact stored true', () => {
    const m = memento({ [CHAT_DENSITY_KEY]: true });
    expect(chatDensityCompact({ workspaceState: () => m as never })).toBe(true);
  });

  it('reads Comfortable for a stale non-boolean value', () => {
    const m = memento({ [CHAT_DENSITY_KEY]: 'yes' });
    expect(chatDensityCompact({ workspaceState: () => m as never })).toBe(false);
  });
});

describe('handleChatDensityMessage', () => {
  let m: ReturnType<typeof memento>;
  beforeEach(() => { m = memento(); });

  it('stores true when the message turns Compact on', () => {
    handleChatDensityMessage({ workspaceState: () => m as never }, { type: 'setChatDensity', compact: true });
    expect(m.update).toHaveBeenCalledWith(CHAT_DENSITY_KEY, true);
  });

  it('CLEARS the key (undefined) rather than writing false when Compact turns off', () => {
    m = memento({ [CHAT_DENSITY_KEY]: true });
    handleChatDensityMessage({ workspaceState: () => m as never }, { type: 'setChatDensity', compact: false });
    expect(m.update).toHaveBeenCalledWith(CHAT_DENSITY_KEY, undefined);
    expect(chatDensityCompact({ workspaceState: () => m as never })).toBe(false);
  });

  it('ignores a message of any other type', () => {
    handleChatDensityMessage({ workspaceState: () => m as never }, { type: 'somethingElse', compact: true });
    expect(m.update).not.toHaveBeenCalled();
  });

  it('CHAT_DENSITY_MESSAGE_TYPES names exactly the one message type it handles', () => {
    expect([...CHAT_DENSITY_MESSAGE_TYPES]).toEqual(['setChatDensity']);
  });
});

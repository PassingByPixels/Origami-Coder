// t-ru1qsp: scheduleTab.ts, mirroring chatDensity.test.ts's shape (absent =
// default, stored only when it differs from the default).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  SCHEDULE_TAB_KEY,
  SCHEDULE_TAB_MESSAGE_TYPES,
  scheduleTab,
  handleScheduleTabMessage,
} from '../../../src/dashboard/scheduleTab';

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

describe('scheduleTab', () => {
  it('defaults to crons (the first tab) when never set', () => {
    const m = memento();
    expect(scheduleTab({ workspaceState: () => m as never })).toBe('crons');
  });

  it('reads loops only on an exact stored "loops"', () => {
    const m = memento({ [SCHEDULE_TAB_KEY]: 'loops' });
    expect(scheduleTab({ workspaceState: () => m as never })).toBe('loops');
  });

  it('reads crons for a stale/unknown stored value', () => {
    const m = memento({ [SCHEDULE_TAB_KEY]: 'somethingElse' });
    expect(scheduleTab({ workspaceState: () => m as never })).toBe('crons');
  });
});

describe('handleScheduleTabMessage', () => {
  let m: ReturnType<typeof memento>;
  beforeEach(() => { m = memento(); });

  it('stores "loops" when the message picks Loops', () => {
    handleScheduleTabMessage({ workspaceState: () => m as never }, { type: 'setScheduleTab', tab: 'loops' });
    expect(m.update).toHaveBeenCalledWith(SCHEDULE_TAB_KEY, 'loops');
  });

  it('CLEARS the key (undefined) rather than writing "crons" when Crons is picked', () => {
    m = memento({ [SCHEDULE_TAB_KEY]: 'loops' });
    handleScheduleTabMessage({ workspaceState: () => m as never }, { type: 'setScheduleTab', tab: 'crons' });
    expect(m.update).toHaveBeenCalledWith(SCHEDULE_TAB_KEY, undefined);
    expect(scheduleTab({ workspaceState: () => m as never })).toBe('crons');
  });

  it('ignores a message of any other type', () => {
    handleScheduleTabMessage({ workspaceState: () => m as never }, { type: 'somethingElse', tab: 'loops' });
    expect(m.update).not.toHaveBeenCalled();
  });

  it('SCHEDULE_TAB_MESSAGE_TYPES names exactly the one message type it handles', () => {
    expect([...SCHEDULE_TAB_MESSAGE_TYPES]).toEqual(['setScheduleTab']);
  });
});

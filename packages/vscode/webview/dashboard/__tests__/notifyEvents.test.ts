// notifyEvents.test.ts — the event -> toast rule table: settings gate each
// kind, the window's focus state gates all of them (when onlyWhenUnfocused is
// on), repeats within the throttle window are dropped, and the two dispatch
// helpers (notifyOnPost, notifyFlockMailbox) route the right payload shape to
// the right kind. sendOsToast itself is mocked — this file proves the GATE,
// not the OS spawn (see osToast.test.ts for that).

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    settings: {
      enabled: true,
      question: true,
      permission: true,
      turnDone: true,
      flock: true,
      remote: true,
      onlyWhenUnfocused: true,
    } as Record<string, boolean>,
    focused: false,
  },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, def: unknown) => (key in fake.settings ? fake.settings[key] : def),
    }),
  },
  window: {
    get state() {
      return { focused: fake.focused };
    },
  },
}));

vi.mock('../../../src/notify/osToast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/notify/osToast')>();
  return { ...actual, sendOsToast: vi.fn() };
});

import { sendOsToast } from '../../../src/notify/osToast';
import {
  notifyFlockMailbox,
  notifyOnPost,
  notifyPermissionWaiting,
  notifyQuestionWaiting,
  notifyRemotePaired,
  notifyTurnDone,
  resetNotifyState,
  shouldNotify,
  THROTTLE_MS,
} from '../../../src/notify/notifyEvents';

const toastMock = vi.mocked(sendOsToast);

beforeEach(() => {
  fake.settings = {
    enabled: true,
    question: true,
    permission: true,
    turnDone: true,
    flock: true,
    remote: true,
    onlyWhenUnfocused: true,
  };
  fake.focused = false;
  resetNotifyState();
  toastMock.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

describe('shouldNotify (pure gate)', () => {
  it('blocks when overall enabled is false', () => {
    expect(shouldNotify({ enabled: false, kindEnabled: true, onlyWhenUnfocused: false, focused: false, now: 0 })).toBe(false);
  });
  it('blocks when the kind setting is off', () => {
    expect(shouldNotify({ enabled: true, kindEnabled: false, onlyWhenUnfocused: false, focused: false, now: 0 })).toBe(false);
  });
  it('blocks when focused and onlyWhenUnfocused is on', () => {
    expect(shouldNotify({ enabled: true, kindEnabled: true, onlyWhenUnfocused: true, focused: true, now: 0 })).toBe(false);
  });
  it('allows when focused but onlyWhenUnfocused is off', () => {
    expect(shouldNotify({ enabled: true, kindEnabled: true, onlyWhenUnfocused: false, focused: true, now: 0 })).toBe(true);
  });
  it('blocks inside the throttle window and allows once it elapses', () => {
    const base = { enabled: true, kindEnabled: true, onlyWhenUnfocused: false, focused: false };
    expect(shouldNotify({ ...base, now: 1000, last: 995 })).toBe(false);
    expect(shouldNotify({ ...base, now: 1000 + THROTTLE_MS, last: 995 })).toBe(true);
  });
});

describe('notifyQuestionWaiting', () => {
  it('toasts when unfocused', () => {
    notifyQuestionWaiting('Fox', 'Which file?');
    expect(toastMock).toHaveBeenCalledWith('Fox needs you', 'Which file?');
  });
  it('does not toast while the window is focused (default onlyWhenUnfocused)', () => {
    fake.focused = true;
    notifyQuestionWaiting('Fox', 'Which file?');
    expect(toastMock).not.toHaveBeenCalled();
  });
  it('is silenced by its own setting even when enabled overall', () => {
    fake.settings.question = false;
    notifyQuestionWaiting('Fox', 'Which file?');
    expect(toastMock).not.toHaveBeenCalled();
  });
  it('is silenced by the master switch', () => {
    fake.settings.enabled = false;
    notifyQuestionWaiting('Fox', 'Which file?');
    expect(toastMock).not.toHaveBeenCalled();
  });
  it('throttles a second call within 10s, then allows one after', () => {
    notifyQuestionWaiting('Fox', 'first');
    notifyQuestionWaiting('Fox', 'second');
    expect(toastMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000_000 + THROTTLE_MS + 1);
    notifyQuestionWaiting('Fox', 'third');
    expect(toastMock).toHaveBeenCalledTimes(2);
  });
});

describe('notifyPermissionWaiting', () => {
  it('is gated by its own setting, independent of question', () => {
    fake.settings.permission = false;
    notifyPermissionWaiting('Fox', 'Run rm -rf?');
    expect(toastMock).not.toHaveBeenCalled();
    notifyQuestionWaiting('Fox', 'still on');
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});

describe('notifyTurnDone', () => {
  it('toasts a normal finish', () => {
    notifyTurnDone('Fox', 'end_turn');
    expect(toastMock).toHaveBeenCalledWith('Fox finished', 'end_turn');
  });
  it('does not toast for idle or blocked stop reasons', () => {
    notifyTurnDone('Fox', 'idle');
    notifyTurnDone('Fox', 'blocked');
    expect(toastMock).not.toHaveBeenCalled();
  });
  it('is gated by its own setting', () => {
    fake.settings.turnDone = false;
    notifyTurnDone('Fox', 'end_turn');
    expect(toastMock).not.toHaveBeenCalled();
  });
});

describe('notifyOnPost (DashboardPanel.post choke point)', () => {
  it('routes a turnDone post to notifyTurnDone', () => {
    notifyOnPost({ type: 'turnDone', stopReason: 'end_turn', sessionId: 's1' }, 'Fox');
    expect(toastMock).toHaveBeenCalledWith('Fox finished', 'end_turn');
  });
  it('routes a plain requestPermission post to the permission kind', () => {
    notifyOnPost({ type: 'requestPermission', title: 'Run a shell command', sessionId: 's1' }, 'Fox');
    expect(toastMock).toHaveBeenCalledWith('Fox is waiting', 'Run a shell command');
  });
  it('routes a requestPermission post carrying `questions` to the question kind', () => {
    notifyOnPost({ type: 'requestPermission', title: 'Pick one', questions: [{}], sessionId: 's1' }, 'Fox');
    expect(toastMock).toHaveBeenCalledWith('Fox needs you', 'Pick one');
  });
  it('ignores unrelated post types', () => {
    notifyOnPost({ type: 'toolResult', sessionId: 's1' }, 'Fox');
    expect(toastMock).not.toHaveBeenCalled();
  });
});

describe('notifyFlockMailbox', () => {
  it('does not toast an empty mailbox', () => {
    notifyFlockMailbox([]);
    expect(toastMock).not.toHaveBeenCalled();
  });
  it('toasts once for a new, non-empty thread set', () => {
    notifyFlockMailbox([{ id: 't1' }]);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
  it('does not re-toast an identical repeat post (dedupe by snapshot)', () => {
    notifyFlockMailbox([{ id: 't1' }]);
    notifyFlockMailbox([{ id: 't1' }]);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
  it('toasts again once the content actually changes (and the throttle window has passed)', () => {
    notifyFlockMailbox([{ id: 't1' }]);
    vi.setSystemTime(1_000_000 + THROTTLE_MS + 1);
    notifyFlockMailbox([{ id: 't1' }, { id: 't2' }]);
    expect(toastMock).toHaveBeenCalledTimes(2);
  });
  it('is gated by its own setting', () => {
    fake.settings.flock = false;
    notifyFlockMailbox([{ id: 't1' }]);
    expect(toastMock).not.toHaveBeenCalled();
  });
});

describe('notifyRemotePaired', () => {
  it('toasts when unfocused', () => {
    notifyRemotePaired();
    expect(toastMock).toHaveBeenCalledWith('Origami Code', 'Phone paired');
  });
  it('is gated by its own setting', () => {
    fake.settings.remote = false;
    notifyRemotePaired();
    expect(toastMock).not.toHaveBeenCalled();
  });
});

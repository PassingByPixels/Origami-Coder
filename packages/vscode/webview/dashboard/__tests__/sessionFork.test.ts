// Fork dispatch — what the shell does when the user forks a chat (the composer's
// Fork button, or a typed /btw kept for muscle memory).
//
// The requirements this pins, in the user's words:
//   "a NEW chat tab whose conversation is a full copy of the current one"
//   "the original tab keeps running untouched"
//   "answers its first prompt with the full prior context"
// so the assertions are about which chat each message and each engine call
// lands in. The failure mode worth a test is a fork that acts on the WRONG
// session: forking the fork, or writing anything back into the chat the user
// forked away from — both look like success on screen.
//
// Driven against a fake host (no `vscode`, no engine), the convention
// sessionDelete.test.ts follows.

import { describe, expect, it, vi } from 'vitest';
import { FORK_CHAT_MESSAGE_TYPES, forkChat, sessionLabel, startSystemLine, type ForkHost } from '../../../src/dashboard/sessionFork';

interface Recorded {
  posts: Array<Record<string, unknown>>;
  forks: Array<{ sessionId: string; label: string }>;
  sends: Array<{ sessionId: string; text: string }>;
}

function makeHost(over: Partial<ForkHost> = {}): ForkHost & Recorded {
  const rec: Recorded = { posts: [], forks: [], sends: [] };
  const host: ForkHost = {
    post: (msg) => void rec.posts.push(msg),
    engineIdOf: () => 'ses_parent',
    labelOf: () => 'chat 3',
    isPassthroughCell: () => false,
    fork: vi.fn(async (source) => {
      rec.forks.push(source);
      return 'session-9';
    }),
    send: (sessionId, text) => void rec.sends.push({ sessionId, text }),
    ...over,
  };
  return Object.assign(host, rec);
}

const texts = (host: Recorded, type: string) =>
  host.posts.filter((p) => p['type'] === type).map((p) => String(p['text'] ?? p['message'] ?? ''));

describe('forking the chat', () => {
  it("forks the SOURCE chat's engine session and opens a new tab for it", async () => {
    const host = makeHost();
    await forkChat('session-1', host);

    expect(host.forks).toEqual([{ sessionId: 'ses_parent', label: 'chat 3' }]);
  });

  it("the Fork button’s message type is the one the host routes", () => {
    expect(FORK_CHAT_MESSAGE_TYPES.has('forkChat')).toBe(true);
  });

  it("sends a typed /btw’s trailing text as the FORK’s first prompt, never back into the source chat", async () => {
    const host = makeHost();
    await forkChat('session-1', host, 'try a queue instead');

    // 'session-9' is what fork() resolved with: the new tab, not 'session-1'.
    expect(host.sends).toEqual([{ sessionId: 'session-9', text: 'try a queue instead' }]);
  });

  it('sends nothing when there is no first prompt', async () => {
    const host = makeHost();
    await forkChat('session-1', host);
    expect(host.sends).toEqual([]);
  });
});

// t-v5qv6u: the owner's stress test. The fork was right, but the ORIGINAL chat
// showed a '/btw' user row followed by its agent's reply to a background-task
// wake, so it read as the agent answering '/btw'. Any row or turn signal posted
// to the source is a write into a chat the user forked AWAY from.
describe('forking sends nothing to the original chat', () => {
  it('posts no message of any kind to the source chat on a successful fork', async () => {
    const host = makeHost();
    await forkChat('session-1', host);

    expect(host.forks).toHaveLength(1);
    expect(host.posts.filter((p) => p['sessionId'] === 'session-1')).toEqual([]);
    expect(host.sends.filter((s) => s.sessionId === 'session-1')).toEqual([]);
  });

  it('with a first prompt too: the prompt goes to the fork and the source gets nothing', async () => {
    const host = makeHost();
    await forkChat('session-1', host, 'branch this');

    expect(host.posts).toEqual([]);
    expect(host.sends.map((s) => s.sessionId)).toEqual(['session-9']);
  });
});

// A refusal is ONE `system` line in the chat the user acted in. Never `turnDone`
// or `error`: both end the webview's in-flight state (ChatPane's `error` case),
// so either would settle a turn still running in that chat.
const onlySystemLine = (host: Recorded) => {
  expect(host.posts.map((p) => p['type'])).toEqual(['system']);
  expect(host.sends).toEqual([]);
};

describe('the three refusals', () => {
  it('refuses a chat with no engine session yet, and says what to do instead', async () => {
    const host = makeHost({ engineIdOf: () => null });
    await forkChat('session-1', host, 'branch this');

    expect(host.forks).toEqual([]);
    expect(texts(host, 'system').join(' ')).toMatch(/send a message first/i);
    onlySystemLine(host);
  });

  it('treats an undefined engine id the same as a null one (a client mid-start)', async () => {
    const host = makeHost({ engineIdOf: () => undefined });
    await forkChat('session-1', host);
    expect(host.forks).toEqual([]);
  });

  it('refuses a Claude Code passthrough cell by name rather than failing silently', async () => {
    const host = makeHost({ isPassthroughCell: () => true });
    await forkChat('session-1', host);

    expect(host.forks).toEqual([]);
    expect(texts(host, 'system').join(' ')).toMatch(/Claude Code/);
    onlySystemLine(host);
  });

  it('reports a fork the engine refused, instead of leaving a tab that never opened', async () => {
    const host = makeHost({
      fork: async () => {
        throw new Error('session not found');
      },
    });
    await forkChat('session-1', host, 'branch this');

    expect(texts(host, 'system').join(' ')).toMatch(/Fork failed: session not found/);
    onlySystemLine(host);
  });
});

describe('the line a chat opens with', () => {
  it('a fork names its parent and states what did NOT come across', async () => {
    const line = startSystemLine('ses_fork', undefined, 'Folio ledger bug');
    expect(line).toContain('Forked from Folio ledger bug');
    // The engine does not copy the parent's permission preset (Session.fork
    // creates the row on `default`) but DOES copy the todo list. Neither is
    // visible in the replayed transcript, so the line is the only place a user
    // can learn it — a fork that silently kept auto-approve would be a safety
    // bug, and one that silently lost the plan reads as a lost plan.
    expect(line).toMatch(/ask-first/);
    expect(line).toMatch(/plan carried over/);
  });

  it('a recall and a fresh chat keep the wording they had', () => {
    expect(startSystemLine('ses_a', 'ses_a')).toBe('Recalled session ses_a. Continue the conversation below.');
    expect(startSystemLine('ses_b')).toBe('Connected. Session ses_b. Type a message and press Enter.');
  });

  it('a fork wins over a recall id, matching which engine call actually ran', () => {
    expect(startSystemLine('ses_fork', 'ses_old', 'chat 2')).toContain('Forked from chat 2');
  });
});

describe('sessionLabel — what a fork calls its parent', () => {
  it('prefers the chat title', () => {
    expect(sessionLabel('Folio ledger bug', 3)).toBe('Folio ledger bug');
  });

  it('falls back to the chat number when the title is missing or blank', () => {
    // A chat forked before its first message has no title yet — "chat 3" is
    // still an identity the user can find in the sidebar; "" is not.
    expect(sessionLabel(undefined, 3)).toBe('chat 3');
    expect(sessionLabel('   ', 3)).toBe('chat 3');
  });
});

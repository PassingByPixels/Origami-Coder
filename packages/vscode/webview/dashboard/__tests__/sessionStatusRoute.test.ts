// `origami/sessionStatus` reaches DashboardPanel with the ENGINE's own session
// id. The old wiring posted `args.sessionId || sessionId` — since the engine
// id is never falsy, that always posted the ENGINE id downstream, and every
// consumer (ChatsList.svelte, ChatPane) keys on the LOCAL id, so the lane was
// inert for any turn the engine starts on its own (an injected background-task
// result, a goal-mode check): the ring never learned to spin for it.

import { describe, expect, it } from 'vitest';
import { makeSessionStatusHandler } from '../../../src/dashboard/sessionStatusRoute';

describe('makeSessionStatusHandler — routes origami/sessionStatus under the LOCAL id', () => {
  it('posts the LOCAL id, not the engine id, for a report this connection owns', () => {
    const posts: unknown[] = [];
    const handler = makeSessionStatusHandler({
      engineSessionId: () => 'ses_abc123',
      localSessionId: 'session-7',
      post: (message) => posts.push(message),
    });

    handler({ sessionId: 'ses_abc123', status: 'busy' });

    expect(posts).toEqual([{ type: 'sessionStatus', status: 'busy', sessionId: 'session-7' }]);
  });

  it('drops a report for a session this connection does not own, instead of mis-routing it', () => {
    const posts: unknown[] = [];
    const handler = makeSessionStatusHandler({
      engineSessionId: () => 'ses_abc123',
      localSessionId: 'session-7',
      post: (message) => posts.push(message),
    });

    handler({ sessionId: 'ses_someone_else', status: 'busy' });

    expect(posts).toEqual([]);
  });

  it('reads the engine id fresh on every call, not once at wiring time — currentSessionId is a live getter', () => {
    // Regression for exactly this: an earlier draft of the fix captured
    // `session.client.currentSessionId` as a plain VALUE when the handler was
    // built, which reads the client's session id from before `start()` ever
    // ran (often `null`) and freezes it there. currentSessionId is a live
    // getter, so the handler must call it, not just read it once.
    let engineId: string | null = null;
    const posts: unknown[] = [];
    const handler = makeSessionStatusHandler({
      engineSessionId: () => engineId,
      localSessionId: 'session-7',
      post: (message) => posts.push(message),
    });

    handler({ sessionId: 'ses_started_later', status: 'busy' });
    expect(posts).toEqual([]); // engine not started yet — nothing owns this report

    engineId = 'ses_started_later';
    handler({ sessionId: 'ses_started_later', status: 'idle' });
    expect(posts).toEqual([{ type: 'sessionStatus', status: 'idle', sessionId: 'session-7' }]);
  });

  it('drops a report while the client has not started (engine id null)', () => {
    const posts: unknown[] = [];
    const handler = makeSessionStatusHandler({
      engineSessionId: () => null,
      localSessionId: 'session-7',
      post: (message) => posts.push(message),
    });

    handler({ sessionId: '', status: 'busy' });

    expect(posts).toEqual([]);
  });
});

// t-w2qv3o: the HOST keeps its own copy of the engine's busy/idle, so a hidden chat whose engine
// started a turn by itself (an injected background result) is never classed idle and trimmed mid-turn.
describe('makeSessionStatusHandler — the host copy for the elastic tracker', () => {
  it('records every status this connection owns, in order, and nothing for a foreign session', () => {
    const recorded: string[] = [];
    const handler = makeSessionStatusHandler({
      engineSessionId: () => 'ses_abc123',
      localSessionId: 'session-7',
      post: () => undefined,
      record: (status) => recorded.push(status),
    });

    handler({ sessionId: 'ses_abc123', status: 'busy' });
    handler({ sessionId: 'ses_someone_else', status: 'idle' });
    handler({ sessionId: 'ses_abc123', status: 'retry' });
    handler({ sessionId: 'ses_abc123', status: 'idle' });

    expect(recorded).toEqual(['busy', 'retry', 'idle']);
  });
});

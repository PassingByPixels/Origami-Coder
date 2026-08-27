// The host half of the running-turn messages (src/dashboard/turnMessages.ts).
//
// Two obligations. The first is a NON-REGRESSION one: `stopBackgroundShell` was
// a `case` in DashboardPanel.ts's switch and is now an entry in this set, so the
// arguments it forwards — client, session, jobId, and the failure reporter —
// have to be the ones backgroundShellMessage.ts already expected, including its
// exact wording, which is the part a re-implementation would quietly change.
//
// The second is the new one: `interject` reaches the engine as the ACP
// ext-method `interject` with `{ sessionId, text }`, and EVERY outcome comes
// back to the webview as a message, because the composer is sitting on an
// "interjecting…" chip that only a message can retire.

import { describe, it, expect } from 'vitest';
import { TURN_MESSAGE_TYPES, handleTurnMessage, interjectIntoTurn } from '../../../src/dashboard/turnMessages';

const SESSION = 'session-3';
/** The ENGINE's id for the same session. The wire must carry THIS one — sending
 *  the webview id produced the live failure
 *  "Invalid params: session not found: session-3". */
const ENGINE_SESSION = 'ses_feb9engine';

function clientThat(outcome: 'resolve' | 'reject' = 'resolve', error = 'engine gone', engineSid: string | null = ENGINE_SESSION) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    currentSessionId: engineSid,
    extMethod: (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return outcome === 'resolve'
        ? Promise.resolve({ delivered: true, busy: true, promoted: 1 })
        : Promise.reject(new Error(error));
    },
  };
}

/** `sessionId` is passed explicitly, never defaulted: one of the cases below is
 *  "the panel could not resolve a session", and a default would erase it. */
function hostWith(client: ReturnType<typeof clientThat> | null, sessionId?: string) {
  const out: Record<string, unknown>[] = [];
  return { host: { client, sessionId, post: (m: Record<string, unknown>) => void out.push(m) }, out };
}

/** Both handlers report through a promise the caller cannot await. */
const drain = () => new Promise((r) => setTimeout(r, 0));

describe('TURN_MESSAGE_TYPES — the routing set', () => {
  it('claims exactly the two message types, and nothing the switch still owns', () => {
    expect([...TURN_MESSAGE_TYPES].sort()).toEqual(['interject', 'stopBackgroundShell']);
  });
});

describe('stopBackgroundShell — unchanged, still the backgroundShellMessage.ts leaf', () => {
  it('forwards the session and jobId as shell_stop', async () => {
    const client = clientThat();
    const { host } = hostWith(client, SESSION);

    handleTurnMessage(host, { type: 'stopBackgroundShell', jobId: 'job-7' });
    await drain();

    expect(client.calls).toEqual([{ method: 'shell_stop', params: { sessionId: ENGINE_SESSION, jobId: 'job-7' } }]);
  });

  it('reports a rejection with the leaf’s own wording, on the posting chat', async () => {
    const { host, out } = hostWith(clientThat('reject', 'shell already dead'), SESSION);

    handleTurnMessage(host, { type: 'stopBackgroundShell', jobId: 'job-7' });
    await drain();

    expect(out).toEqual([
      { type: 'error', message: 'Background shell stop failed: shell already dead', sessionId: SESSION },
    ]);
  });

  it('stays silent, and calls nothing, without a client / session / jobId', async () => {
    const noClient = hostWith(null, SESSION);
    handleTurnMessage(noClient.host, { type: 'stopBackgroundShell', jobId: 'job-7' });

    const client = clientThat();
    const noJob = hostWith(client, SESSION);
    handleTurnMessage(noJob.host, { type: 'stopBackgroundShell' });

    const noSession = hostWith(client, undefined);
    handleTurnMessage(noSession.host, { type: 'stopBackgroundShell', jobId: 'job-7' });

    await drain();
    expect(client.calls).toEqual([]);
    expect([...noClient.out, ...noJob.out, ...noSession.out]).toEqual([]);
  });
});

describe('interject — the line goes INTO the running turn', () => {
  it('calls the engine’s interject ext-method with the session and the text', async () => {
    const client = clientThat();
    const { host } = hostWith(client, SESSION);

    handleTurnMessage(host, { type: 'interject', text: 'also check the migration' });
    await drain();

    expect(client.calls).toEqual([
      { method: 'interject', params: { sessionId: ENGINE_SESSION, text: 'also check the migration' } },
    ]);
  });

  it('confirms delivery back to the webview, naming the session it belongs to', async () => {
    const { host, out } = hostWith(clientThat(), SESSION);

    handleTurnMessage(host, { type: 'interject', text: 'go on' });
    await drain();

    expect(out).toEqual([{ type: 'interjected', sessionId: SESSION }]);
  });

  it('reports a refusal as an error on that chat — the chip clears either way', async () => {
    const { host, out } = hostWith(clientThat('reject', 'no turn in flight'), SESSION);

    handleTurnMessage(host, { type: 'interject', text: 'go on' });
    await drain();

    expect(out).toEqual([
      { type: 'error', message: 'Interject failed: no turn in flight', sessionId: SESSION },
    ]);
  });

  it('answers a dead end with a reason rather than silence — silence would strand the chip', async () => {
    const noClient = hostWith(null, SESSION);
    handleTurnMessage(noClient.host, { type: 'interject', text: 'go on' });

    const client = clientThat();
    const noText = hostWith(client, SESSION);
    handleTurnMessage(noText.host, { type: 'interject', text: '   ' });

    // A client that never completed its handshake has NO engine session — the
    // local id must not be sent in its place (that is the live bug this file
    // exists to prevent), and the chip still gets its answer.
    const unstarted = clientThat('resolve', 'engine gone', null);
    const noEngine = hostWith(unstarted, SESSION);
    handleTurnMessage(noEngine.host, { type: 'interject', text: 'go on' });

    await drain();
    expect(client.calls, 'nothing whitespace-only reaches the engine').toEqual([]);
    expect(unstarted.calls, 'no engine session id -> nothing on the wire').toEqual([]);
    expect(noClient.out[0]).toMatchObject({ type: 'error', sessionId: SESSION });
    expect(String(noClient.out[0]!['message'])).toContain('Interject failed');
    expect(noText.out[0]).toMatchObject({ type: 'error', sessionId: SESSION });
    expect(noEngine.out[0]).toMatchObject({ type: 'error', sessionId: SESSION });
  });

  it('interjects with NO turn streaming — the engine id still crosses, no turn is consulted', async () => {
    // The standing hypothesis for "interject often fails" was that the engine
    // id is only there while a turn streams. It is not: AcpClient sets it in
    // start() and clears it only when the child exits, and this handler never
    // asks about a turn at all — the engine itself starts one when an
    // interjection lands unbusy. Pinned here so a future "only while running"
    // guard cannot be added quietly.
    const idle = clientThat();
    const { host, out } = hostWith(idle, SESSION);

    handleTurnMessage(host, { type: 'interject', text: 'while nothing is running' });
    await drain();

    expect(idle.calls).toEqual([
      { method: 'interject', params: { sessionId: ENGINE_SESSION, text: 'while nothing is running' } },
    ]);
    expect(out).toEqual([{ type: 'interjected', sessionId: SESSION }]);
  });

  it('never puts a LOCAL id on the wire, even when the client is holding one', async () => {
    // Since 0.4.14 the id comes from the client instead of the message — but
    // AcpClient.start() assigns `this.sessionId = loadSessionId` verbatim, so
    // "the client said so" is not proof the id came from the engine. Both
    // session-scoped methods refuse it, and the chip still gets its answer.
    const smuggled = clientThat('resolve', 'engine gone', SESSION);
    const interject = hostWith(smuggled, SESSION);
    handleTurnMessage(interject.host, { type: 'interject', text: 'go on' });

    const shell = hostWith(smuggled, SESSION);
    handleTurnMessage(shell.host, { type: 'stopBackgroundShell', jobId: 'job-7' });

    await drain();
    expect(smuggled.calls, 'session-3 on the wire IS the live failure').toEqual([]);
    expect(interject.out[0]).toMatchObject({ type: 'error', sessionId: SESSION });
    expect(String(interject.out[0]!['message'])).toContain('Interject failed');
  });

  it('trims the text before it crosses, so a stray newline is not the message', async () => {
    const client = clientThat();
    const { host } = hostWith(client, SESSION);

    handleTurnMessage(host, { type: 'interject', text: '  tighten the loop\n' });
    await drain();

    expect(client.calls[0]!.params).toEqual({ sessionId: ENGINE_SESSION, text: 'tighten the loop' });
  });

  it('the ACP leaf names the method, and nothing else', async () => {
    const client = clientThat();
    await interjectIntoTurn(client, 'sess-9', 'now');
    expect(client.calls).toEqual([{ method: 'interject', params: { sessionId: 'sess-9', text: 'now' } }]);
  });
});

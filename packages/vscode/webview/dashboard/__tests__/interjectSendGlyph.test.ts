// t-ru13hb item 1 — the SECONDARY SEND GLYPH.
//
// While a turn runs the composer's one action control is Stop, and stopping is
// a 600ms hold (SendStopButton.svelte / holdToStop.ts). A CLICK on it is
// deliberately dead. That left a mouse-only user with no way at all to send an
// interjection: Enter is the only route in, and the visible button refuses.
//
// The fix is a second, smaller glyph of the same `.action-btn` family, left of
// Stop, that exists ONLY while a turn is running and the textarea has text. It
// must send EXACTLY what Enter sends — the same message, through the same
// doSend path — or the composer would have two send rules that can drift.
//
// That is what this file asserts: the payload posted by the click is compared
// byte for byte (bar the session id, which differs per mount) with the payload
// posted by Enter on the same text, in the same state.

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const ASK = 'do the thing';
const LINE = 'stop, use the other file';

const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const posted = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);

afterEach(() => { cleanup(); globalThis.__vscodeApiMock.postMessage.mockClear(); });

let seq = 0;

/** A chat with a real turn running, started the way the user starts one
 *  (mountTurn in interjectSplit.test.ts, same rules). */
async function mountTurn(): Promise<{ c: HTMLElement; sid: string }> {
  const sid = `ijg-${++seq}`;
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru' });
  post({ type: 'modelStatus', sessionId: sid, ok: true, modelName: 'deepseek' });
  await tick();
  await fireEvent.input(container.querySelector('.input') as HTMLTextAreaElement, { target: { value: ASK } });
  await fireEvent.click(container.querySelector('.action-btn') as HTMLButtonElement);
  await tick();
  globalThis.__vscodeApiMock.postMessage.mockClear();
  return { c: container as HTMLElement, sid };
}

const glyph = (c: HTMLElement) => c.querySelector('.interject-send') as HTMLButtonElement | null;
const box = (c: HTMLElement) => c.querySelector('.input') as HTMLTextAreaElement;

/** Whatever the composer hands the host for a mid-turn line. `sessionId` is
 *  dropped: it is the one field that legitimately differs between two mounts. */
function interjectPayload(): Record<string, unknown> | undefined {
  const msg = posted().find((m) => String(m.type).toLowerCase().includes('interject'));
  if (!msg) return undefined;
  const { sessionId: _sid, ...rest } = msg;
  return rest;
}

describe('the secondary send glyph, while a turn runs', () => {
  it('is absent at rest', async () => {
    const { container } = render(ChatPane, { props: {} });
    const sid = `idle-${++seq}`;
    post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru' });
    await tick();
    await fireEvent.input(container.querySelector('.input') as HTMLTextAreaElement, { target: { value: LINE } });
    await tick();
    expect(glyph(container as HTMLElement), 'an idle composer already sends on the main button').toBeNull();
  });

  it('is absent while a turn runs with an EMPTY textarea', async () => {
    const { c } = await mountTurn();
    expect(glyph(c), 'nothing to send, so nothing to offer').toBeNull();
  });

  it('appears once a turn is running and the textarea has text', async () => {
    const { c } = await mountTurn();
    await fireEvent.input(box(c), { target: { value: LINE } });
    await tick();
    const g = glyph(c);
    expect(g, 'a mouse-only user has no other way into a running turn').not.toBeNull();
    // Same family as the stop control, smaller — one visual vocabulary.
    expect(g!.classList.contains('action-btn')).toBe(true);
  });

  it('posts EXACTLY what Enter posts — same message, same fields', async () => {
    const a = await mountTurn();
    await fireEvent.input(box(a.c), { target: { value: LINE } });
    await fireEvent.keyDown(box(a.c), { key: 'Enter' });
    await tick();
    const byEnter = interjectPayload();
    expect(byEnter, 'Enter is the reference route into a running turn').toBeDefined();

    cleanup();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    const b = await mountTurn();
    await fireEvent.input(box(b.c), { target: { value: LINE } });
    await tick();
    await fireEvent.click(glyph(b.c)!);
    await tick();
    const byClick = interjectPayload();

    expect(byClick).toEqual(byEnter);
  });

  it('clears the draft and goes away again, as Enter does', async () => {
    const { c } = await mountTurn();
    await fireEvent.input(box(c), { target: { value: LINE } });
    await tick();
    await fireEvent.click(glyph(c)!);
    await tick();
    expect(box(c).value).toBe('');
    expect(glyph(c), 'an empty draft mid-turn offers nothing to send').toBeNull();
  });
});

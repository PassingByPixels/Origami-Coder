// composerPrefill — the one path by which one surface writes into another's
// text box (t-f89g49, Start on a side quest).
//
// Two halves, both tested here: the RULE as a pure function, and the rule as the
// mounted InputBar actually applies it. The second half is not a duplicate of the
// first — the listener could have been wired to the ordinary
// `msg.sessionId == null || msg.sessionId === sessionId` broadcast test every
// other message in that file uses, which would drop one brief into every open
// composer at once, and only a mounted assertion catches that.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import InputBar from './InputBar.svelte';
import { prefillFor } from './composerPrefill';

const SID = 'sess-prefill-1';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const BRIEF = 'Extend extractWireVerbs to the shell frames and assert each has a row.';

afterEach(cleanup);

function mount(sessionId: string | null = SID) {
  const view = render(InputBar, {
    props: {
      inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
      sessionId, onSend: () => {}, onCancel: () => {},
    },
  });
  const box = () => view.container.querySelector('textarea') as HTMLTextAreaElement;
  return { ...view, box };
}

describe('prefillFor — the rule', () => {
  it('hands the text over for an EMPTY composer on the named session', () => {
    expect(prefillFor({ type: 'composerPrefill', sessionId: SID, text: BRIEF }, SID, '')).toBe(BRIEF);
    // Whitespace a stray keystroke left is still empty.
    expect(prefillFor({ type: 'composerPrefill', sessionId: SID, text: BRIEF }, SID, '   \n ')).toBe(BRIEF);
  });

  it('NEVER overwrites typed text — a draft beats a prefill nobody asked for', () => {
    expect(prefillFor({ type: 'composerPrefill', sessionId: SID, text: BRIEF }, SID, 'half a thought')).toBeNull();
  });

  it('is refused for another cell, and for a frame that names no cell at all', () => {
    expect(prefillFor({ type: 'composerPrefill', sessionId: 'sess-other', text: BRIEF }, SID, '')).toBeNull();
    // NOT the broadcast rule the rest of the listener uses: a prefill with no
    // session would land in every open composer at once.
    expect(prefillFor({ type: 'composerPrefill', text: BRIEF }, SID, '')).toBeNull();
    expect(prefillFor({ type: 'composerPrefill', sessionId: SID, text: BRIEF }, null, '')).toBeNull();
  });

  it('ignores an empty brief and any other message type', () => {
    expect(prefillFor({ type: 'composerPrefill', sessionId: SID, text: '' }, SID, '')).toBeNull();
    expect(prefillFor({ type: 'echoUser', sessionId: SID, text: BRIEF }, SID, '')).toBeNull();
    expect(prefillFor(null, SID, '')).toBeNull();
  });
});

describe('the mounted composer takes a prefill (t-f89g49)', () => {
  it('lands the brief in an empty composer', async () => {
    const { box } = mount();
    post({ type: 'composerPrefill', sessionId: SID, text: BRIEF });
    await Promise.resolve();
    expect(box().value).toBe(BRIEF);
  });

  it('leaves a composer that already holds a draft exactly as it was', async () => {
    const { box } = mount();
    await fireEvent.input(box(), { target: { value: 'my own half-written question' } });
    post({ type: 'composerPrefill', sessionId: SID, text: BRIEF });
    await Promise.resolve();
    expect(box().value).toBe('my own half-written question');
  });

  it('ignores a prefill addressed to another chat', async () => {
    const { box } = mount();
    post({ type: 'composerPrefill', sessionId: 'sess-someone-else', text: BRIEF });
    await Promise.resolve();
    expect(box().value).toBe('');
  });

  it('does not send anything — the owner presses Send once he has picked a model', async () => {
    let sent = 0;
    const view = render(InputBar, {
      props: {
        inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
        sessionId: SID, onSend: () => { sent += 1; }, onCancel: () => {},
      },
    });
    post({ type: 'composerPrefill', sessionId: SID, text: BRIEF });
    await Promise.resolve();
    expect((view.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(BRIEF);
    expect(sent).toBe(0);
  });
});

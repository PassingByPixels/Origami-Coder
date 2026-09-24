// The stuck-tip case (owner, 0.4.156): a control that vanishes under the
// pointer fires no mouseleave, so the open tip must close by other means.
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { setTipSink, tip, resetTipState, TIP_FUSE } from './warmTip';
import { nodeGone, suspendTipWatch } from './warmTipWatch';

let shown: string | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  shown = null;
  setTipSink((_node, text) => { shown = text || null; });
});
afterEach(() => {
  resetTipState();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function openTipOn(btn: HTMLElement) {
  // jsdom draws no boxes; a real control has one. The detached case is the
  // isConnected half and needs no box.
  (btn as HTMLElement & { getClientRects: () => DOMRectList }).getClientRects = () => [{}] as unknown as DOMRectList;
  const action = tip(btn, 'Jump to the newest message and follow the turn again');
  btn.dispatchEvent(new Event('mouseenter'));
  vi.advanceTimersByTime(TIP_FUSE + 1);
  expect(shown).toContain('Jump');
  return action;
}

describe('warmTipWatch — a tip never outlives its control', () => {
  it('closes when the control is removed under the pointer and the pointer moves', () => {
    document.body.innerHTML = '<div id="host"><button id="b">jump</button></div>';
    const btn = document.getElementById('b') as HTMLElement;
    openTipOn(btn);
    // Removed without mouseleave (what a {#if} teardown under the pointer looks like
    // in a real browser), and without the action's destroy running first.
    btn.remove();
    document.body.dispatchEvent(new Event('pointermove', { bubbles: true }));
    expect(shown).toBeNull();
  });

  it('closes when the pointer moves somewhere that is not the control', () => {
    document.body.innerHTML = '<button id="b">jump</button><p id="p">text</p>';
    const btn = document.getElementById('b') as HTMLElement;
    openTipOn(btn);
    document.getElementById('p')!.dispatchEvent(new Event('pointermove', { bubbles: true }));
    expect(shown).toBeNull();
  });

  it('stays open while the pointer moves inside the control', () => {
    document.body.innerHTML = '<button id="b"><span id="s">jump</span></button>';
    const btn = document.getElementById('b') as HTMLElement;
    openTipOn(btn);
    document.getElementById('s')!.dispatchEvent(new Event('pointermove', { bubbles: true }));
    expect(shown).toContain('Jump');
  });

  it('closes on any scroll', () => {
    document.body.innerHTML = '<div id="sc"><button id="b">jump</button></div>';
    const btn = document.getElementById('b') as HTMLElement;
    openTipOn(btn);
    document.getElementById('sc')!.dispatchEvent(new Event('scroll'));
    expect(shown).toBeNull();
  });

  // t-ru13hb item 5: the context breakdown card can be PINNED open. The pointer
  // is then meant to travel over it and its rows to scroll — both of which this
  // watchdog reads as "the user has moved on". It is held off while a pinned
  // surface holds, and re-armed when the pin goes.
  it('a suspension holds it off, and the release re-arms it', () => {
    document.body.innerHTML = '<button id="b">jump</button><p id="p">text</p>';
    const btn = document.getElementById('b') as HTMLElement;
    openTipOn(btn);
    const release = suspendTipWatch();
    document.getElementById('p')!.dispatchEvent(new Event('pointermove', { bubbles: true }));
    document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(shown, 'the pinned surface is being used, not abandoned').toContain('Jump');

    release();
    document.getElementById('p')!.dispatchEvent(new Event('pointermove', { bubbles: true }));
    expect(shown, 'and the watchdog is back once the pin goes').toBeNull();
  });

  it('two suspensions need two releases', () => {
    document.body.innerHTML = '<button id="b">jump</button><p id="p">text</p>';
    const btn = document.getElementById('b') as HTMLElement;
    openTipOn(btn);
    const a = suspendTipWatch();
    const b = suspendTipWatch();
    a();
    a(); // idempotent — a double release must not re-arm under the other holder
    document.getElementById('p')!.dispatchEvent(new Event('pointermove', { bubbles: true }));
    expect(shown).toContain('Jump');
    b();
    document.getElementById('p')!.dispatchEvent(new Event('pointermove', { bubbles: true }));
    expect(shown).toBeNull();
  });

  it('nodeGone: detached or box-less controls count as gone', () => {
    const el = document.createElement('button');
    expect(nodeGone(el)).toBe(true); // detached
    document.body.appendChild(el);
    // jsdom draws no boxes, so a connected node is still "gone" here; the
    // isConnected half is what this asserts, the box half needs a browser.
    expect(el.isConnected).toBe(true);
  });
});

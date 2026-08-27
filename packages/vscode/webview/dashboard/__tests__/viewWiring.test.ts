// The doubled-send guard (src/dashboard/viewWiring.ts). A sidebar view can
// re-resolve WITHOUT disposing, so attachView runs again for the SAME webview.
// Before rewireView, that left the webview in extraViews twice with two live
// message subscriptions — every broadcast delivered twice, every inbound send
// handled twice: two prompts and two echoUser for one click, which is the
// second row the 0.4.19 one-shot pendingEcho could not absorb (its own suite
// deliberately pins that a bare duplicate echo draws a row).

import { describe, expect, it, vi } from 'vitest';
import { rewireView } from '../../../src/dashboard/viewWiring';

type Webview = { onDidReceiveMessage: (h: (m: unknown) => void) => { dispose: () => void } };

function fakeWebview() {
  const handlers: Array<(m: unknown) => void> = [];
  const webview = {
    onDidReceiveMessage: (h: (m: unknown) => void) => {
      handlers.push(h);
      return { dispose: () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); } };
    },
  };
  return { webview, deliver: (m: unknown) => [...handlers].forEach((h) => h(m)), live: () => handlers.length };
}

// The maps are typed against vscode.Webview host-side; structurally our fake
// satisfies everything rewireView touches. One cast at the boundary.
const wire = (w: ReturnType<typeof fakeWebview>, maps: { wiring: Map<unknown, () => void>; extra: unknown[]; solo: Map<unknown, string> }, onMessage: (m: unknown) => void) =>
  rewireView(maps.wiring as never, maps.extra as never, maps.solo as never, w.webview as never, onMessage);

const freshMaps = () => ({ wiring: new Map<unknown, () => void>(), extra: [] as unknown[], solo: new Map<unknown, string>() });

describe('rewireView — one webview, one wiring, however many attaches', () => {
  it('a RE-ATTACH of the same webview leaves ONE list entry and ONE live handler', () => {
    const w = fakeWebview();
    const maps = freshMaps();
    const seen = vi.fn();

    wire(w, maps, seen);
    wire(w, maps, seen); // the sidebar re-resolve

    expect(maps.extra.filter((v) => v === w.webview)).toHaveLength(1);
    w.deliver({ type: 'send', text: 'hi' });
    expect(seen, 'one inbound message handled ONCE').toHaveBeenCalledTimes(1);
    expect(w.live()).toBe(1);
  });

  it('re-attach clears the previous solo mapping (the caller re-sets it after)', () => {
    const w = fakeWebview();
    const maps = freshMaps();
    wire(w, maps, () => {});
    maps.solo.set(w.webview, 'session-1'); // the caller sets solo AFTER wiring, as attachView does
    wire(w, maps, () => {}); // re-attach runs the OLD teardown, which owns the clear
    expect(maps.solo.has(w.webview), 'stale solo mapping cleared by the rewire').toBe(false);
  });

  it('teardown is idempotent — onDidDispose after a re-attach cannot evict the new wiring', () => {
    const w = fakeWebview();
    const maps = freshMaps();
    const first = wire(w, maps, () => {});
    wire(w, maps, () => {}); // re-attach already ran `first` internally
    first(); // the OLD view's onDidDispose firing late
    expect(maps.extra.filter((v) => v === w.webview), 'the live wiring survives').toHaveLength(1);
    expect(w.live()).toBe(1);
  });

  it('two DIFFERENT webviews coexist untouched', () => {
    const a = fakeWebview();
    const b = fakeWebview();
    const maps = freshMaps();
    wire(a, maps, () => {});
    wire(b, maps, () => {});
    expect(maps.extra).toHaveLength(2);
    const down = maps.wiring.get(a.webview);
    down?.();
    expect(maps.extra.filter((v) => v === b.webview)).toHaveLength(1);
    expect(b.live()).toBe(1);
  });
});

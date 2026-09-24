// Origami Remote — the phone-as-a-webview shim.
//
// The risk this file exists for is DRIFT: the shim implements exactly the
// members DashboardPanel.attachView + viewWiring.rewireView + post/postTo
// actually touch, and if someone adds a seventh the phone silently stops
// hydrating. So the last test here is a mirror guard in the sense of
// origami_coder_agent_guide Part 5 — it READS the real source and asserts
// every `webview.<member>` those functions use exists on the shim.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteView } from '../../../src/remote/remoteView';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('remote view — the WebviewHost shape attachView wants', () => {
  it('offers webview, onDidDispose, reveal and dispose', () => {
    const host = new RemoteView({ send: () => {} }).host;
    expect(host.webview).toBeTruthy();
    expect(typeof host.onDidDispose).toBe('function');
    expect(typeof host.reveal).toBe('function');
    expect(typeof host.dispose).toBe('function');
  });

  it('accepts an html assignment without touching the wire', () => {
    const send = vi.fn();
    const view = new RemoteView({ send });
    view.webview.html = '<html>a rendered chat shell</html>';
    expect(view.renderedHtmlBytes).toBe(34);
    expect(send).not.toHaveBeenCalled();
  });

  it('asWebviewUri is the identity, because its only consumer is that html', () => {
    const view = new RemoteView({ send: () => {} });
    const uri = { scheme: 'file', path: '/out/webview/chat.js' } as never;
    expect(view.webview.asWebviewUri(uri)).toBe(uri);
  });

  it('exposes a cspSource string, which renderHtmlFor interpolates', () => {
    expect(typeof new RemoteView({ send: () => {} }).webview.cspSource).toBe('string');
  });
});

describe('remote view — host to phone', () => {
  it('every postMessage becomes one send, and resolves true', async () => {
    const sent: unknown[] = [];
    const view = new RemoteView({ send: (m) => sent.push(m) });
    await expect(view.webview.postMessage({ type: 'sessionCreated', sessionId: 's1' })).resolves.toBe(true);
    await view.webview.postMessage({ type: 'contextUpdate', sessionId: 's1' });
    expect(sent).toEqual([
      { type: 'sessionCreated', sessionId: 's1' },
      { type: 'contextUpdate', sessionId: 's1' },
    ]);
  });

  it('a disposed view sends nothing and resolves false', async () => {
    const send = vi.fn();
    const view = new RemoteView({ send });
    view.dispose();
    await expect(view.webview.postMessage({ type: 'x' })).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('remote view — phone to host', () => {
  it('delivers to every onDidReceiveMessage listener', () => {
    const view = new RemoteView({ send: () => {} });
    const seen: unknown[] = [];
    view.webview.onDidReceiveMessage((m) => seen.push(m));
    view.deliver({ type: 'send', text: 'hello from the phone' });
    expect(seen).toEqual([{ type: 'send', text: 'hello from the phone' }]);
  });

  it('a disposed subscription stops receiving — this is what rewireView relies on', () => {
    const view = new RemoteView({ send: () => {} });
    const seen: unknown[] = [];
    const sub = view.webview.onDidReceiveMessage((m) => seen.push(m));
    view.deliver({ i: 1 });
    sub.dispose();
    view.deliver({ i: 2 });
    expect(seen).toEqual([{ i: 1 }]);
    expect(view.listenerCount).toBe(0);
  });

  it('a re-attach that disposes then re-subscribes leaves exactly ONE listener', () => {
    // The doubled-send bug viewWiring.rewireView was written to stop.
    const view = new RemoteView({ send: () => {} });
    const seen: unknown[] = [];
    const first = view.webview.onDidReceiveMessage((m) => seen.push(m));
    first.dispose();
    view.webview.onDidReceiveMessage((m) => seen.push(m));
    view.deliver({ i: 1 });
    expect(seen).toHaveLength(1);
    expect(view.listenerCount).toBe(1);
  });

  it('pushes a subscription into a disposables array, as vscode.Event does', () => {
    const view = new RemoteView({ send: () => {} });
    const bag: Array<{ dispose(): void }> = [];
    view.webview.onDidReceiveMessage(() => {}, undefined, bag as never);
    expect(bag).toHaveLength(1);
    bag[0]!.dispose();
    expect(view.listenerCount).toBe(0);
  });

  it('a listener that unsubscribes mid-dispatch does not break the dispatch', () => {
    const view = new RemoteView({ send: () => {} });
    const seen: string[] = [];
    const a = view.webview.onDidReceiveMessage(() => {
      seen.push('a');
      a.dispose();
    });
    view.webview.onDidReceiveMessage(() => seen.push('b'));
    view.deliver({});
    expect(seen).toEqual(['a', 'b']);
  });

  it('drops messages after dispose', () => {
    const view = new RemoteView({ send: () => {} });
    const seen: unknown[] = [];
    view.webview.onDidReceiveMessage((m) => seen.push(m));
    view.dispose();
    view.deliver({ type: 'send' });
    expect(seen).toEqual([]);
  });
});

describe('remote view — lifecycle', () => {
  it('fires onDidDispose once, and calls the owner back', () => {
    const onDispose = vi.fn();
    const view = new RemoteView({ send: () => {}, onDispose });
    const fired: number[] = [];
    view.host.onDidDispose(() => fired.push(1));
    view.dispose();
    view.dispose();
    expect(fired).toEqual([1]);
    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it('reveal() is a no-op — a phone has no tab to bring forward', () => {
    expect(() => new RemoteView({ send: () => {} }).host.reveal()).not.toThrow();
  });

  it('host.dispose() tears the view down', () => {
    const onDispose = vi.fn();
    new RemoteView({ send: () => {}, onDispose }).host.dispose();
    expect(onDispose).toHaveBeenCalledTimes(1);
  });
});

describe('remote view — DRIFT GUARD against the real DashboardPanel', () => {
  /** Every `webview.<member>` the host actually reaches for. Scanning the
   *  WHOLE of DashboardPanel.ts + viewWiring.ts deliberately over-approximates
   *  what attachView alone needs: a member added anywhere in the host is a
   *  member the phone's view may one day be asked for, and failing early is
   *  the point. Today this set is exactly five. */
  function hostWebviewMembers(): string[] {
    const source =
      readFileSync(path.join(pkgRoot, 'src/dashboard/DashboardPanel.ts'), 'utf8') +
      readFileSync(path.join(pkgRoot, 'src/dashboard/viewWiring.ts'), 'utf8');
    const used = new Set<string>();
    for (const m of source.matchAll(/\bwebview\.([A-Za-z_]\w*)/g)) used.add(m[1]!);
    return [...used].sort();
  }

  it('finds the members by reading the real source, not a fixture', () => {
    // If this drops to nothing the regex has stopped matching and the guard
    // below would pass vacuously — the trap the agent guide calls a test that
    // cannot fail.
    expect(hostWebviewMembers()).toEqual(['asWebviewUri', 'cspSource', 'html', 'onDidReceiveMessage', 'postMessage']);
  });

  it('the shim implements every one of them', () => {
    const shim = new RemoteView({ send: () => {} }).webview as unknown as Record<string, unknown>;
    const missing = hostWebviewMembers().filter((member) => !(member in shim));
    expect(
      missing,
      `DashboardPanel uses webview.${missing.join(', webview.')} — RemoteView must implement it or the phone stops hydrating.`,
    ).toEqual([]);
  });

  it('and each is the right KIND of member', () => {
    const view = new RemoteView({ send: () => {} });
    const wv = view.webview as unknown as Record<string, unknown>;
    expect(typeof wv.postMessage).toBe('function');
    expect(typeof wv.onDidReceiveMessage).toBe('function');
    expect(typeof wv.asWebviewUri).toBe('function');
    expect(typeof wv.cspSource).toBe('string');
    expect(typeof wv.html).toBe('string');
  });
});

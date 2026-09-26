// sidebarFocus.test.ts — t-x3a89j: the sidebar chat webview tells the host when it gains or loses keyboard
// focus, so a grid tile counts as "the chat you work in" only while the sidebar has focus
// (src/elastic/sessionSignals.ts inFocus). The bugs caught: no post at mount (a sidebar that opens focused
// stays "unfocused" until the next blur/focus); a post per event instead of per change (a pass per
// keystroke-focus); listeners left behind after the pane unmounts or turns into a solo tab.
import { describe, expect, it } from 'vitest';
import { watchSidebarFocus } from './sidebarFocus';

function fakeWindow(focused: boolean) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    focused,
    addEventListener(type: string, l: () => void) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(l); },
    removeEventListener(type: string, l: () => void) { listeners.get(type)?.delete(l); },
    fire(type: 'focus' | 'blur') { this.focused = type === 'focus'; for (const l of [...(listeners.get(type) ?? [])]) l(); },
    count() { return [...listeners.values()].reduce((n, s) => n + s.size, 0); },
  };
}

describe('watchSidebarFocus', () => {
  it('posts the focus state at mount, then each change once', () => {
    const w = fakeWindow(true);
    const posts: boolean[] = [];
    watchSidebarFocus(w, { hasFocus: () => w.focused }, (f) => posts.push(f));
    expect(posts).toEqual([true]);
    w.fire('blur');
    w.fire('blur');
    w.fire('focus');
    expect(posts).toEqual([true, false, true]);
  });

  it('a pane that mounts without focus says so', () => {
    const w = fakeWindow(false);
    const posts: boolean[] = [];
    watchSidebarFocus(w, { hasFocus: () => w.focused }, (f) => posts.push(f));
    expect(posts).toEqual([false]);
  });

  it('the cleanup removes both listeners and tells the host the focus is gone', () => {
    const w = fakeWindow(true);
    const posts: boolean[] = [];
    const stop = watchSidebarFocus(w, { hasFocus: () => w.focused }, (f) => posts.push(f));
    expect(w.count()).toBe(2);
    stop();
    expect(w.count()).toBe(0);
    expect(posts).toEqual([true, false]);
    w.fire('focus');
    expect(posts).toEqual([true, false]);
  });
});

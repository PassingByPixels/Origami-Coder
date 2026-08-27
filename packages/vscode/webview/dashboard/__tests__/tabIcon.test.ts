// t-q6jxrs — the pure tab-affordance leaf (tabIcon.ts): the crane icon is
// branding set ONCE at panel creation (every runtime swap scheme was
// falsified live — see the module header), and the WAITING signal is a blue
// dot in the tab TITLE. Tested directly (no vscode import in the module
// under test), same split as attention.test.ts.

import { describe, it, expect } from 'vitest';
import { applyTabIcon, waitingTitleFor, WAITING_TITLE_PREFIX, type TabIconTarget } from '../../../src/dashboard/tabIcon';

describe('applyTabIcon — the one-time crane branding', () => {
  it('sets the normal light/dark crane pair', () => {
    const panel: TabIconTarget = { iconPath: undefined };
    applyTabIcon(panel, (name) => `uri:${name}`);
    expect(panel.iconPath).toEqual({ light: 'uri:origami-icon-light.svg', dark: 'uri:origami-icon-dark.svg' });
  });

  it('a disposed panel (setting iconPath throws) does not propagate — nothing left to paint', () => {
    const panel = {} as TabIconTarget;
    // A real vscode.WebviewPanel throws "Webview panel is disposed" when a
    // property is set after dispose(); model that with a throwing setter.
    Object.defineProperty(panel, 'iconPath', {
      get() { return undefined; },
      set() { throw new Error('Webview panel is disposed'); },
    });
    expect(() => applyTabIcon(panel, (name) => `uri:${name}`)).not.toThrow();
  });
});

describe('waitingTitleFor — the blue-dot waiting signal', () => {
  it('adds the dot while asks are pending and strips it at zero', () => {
    expect(waitingTitleFor('Tsuru #5', 1)).toBe(`${WAITING_TITLE_PREFIX}Tsuru #5`);
    expect(waitingTitleFor(`${WAITING_TITLE_PREFIX}Tsuru #5`, 2)).toBe(`${WAITING_TITLE_PREFIX}Tsuru #5`);
    expect(waitingTitleFor(`${WAITING_TITLE_PREFIX}Tsuru #5`, 0)).toBe('Tsuru #5');
    expect(waitingTitleFor('Tsuru #5', 0)).toBe('Tsuru #5');
  });
  it('the prefix is the blue circle emoji', () => {
    expect(WAITING_TITLE_PREFIX).toBe('\u{1F535} ');
  });
});

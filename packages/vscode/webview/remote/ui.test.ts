import { beforeEach, describe, expect, it } from 'vitest';
import { WATCH_ONLY_TEXT, isRefusedWhenKeyless, setNotice, setStatus, setWatchOnly } from './ui';

/** The exact ids webview/remote/index.html declares. A rename there without
 *  one here would leave the line silently inert on the phone. */
function mountShell(): void {
  document.body.innerHTML = `
    <div id="remoteStatus" data-state="connecting">connecting</div>
    <div id="remoteNotice"></div>
    <div id="remoteWatch"></div>`;
}

const watch = () => document.getElementById('remoteWatch') as HTMLElement;

beforeEach(mountShell);

// THE PIN SHEET IS GONE. What used to be tested here — a four-digit code typed
// into a browser page to release a shell command — no longer exists on either
// side of the wire: a page with no device key may read the chat and nothing
// else (src/remote/inbound.ts clamps it to `watch`). These tests hold the ONE
// thing that replaced it: the sentence that says so, and the four message
// types that trigger it.
describe('isRefusedWhenKeyless', () => {
  it.each(['send', 'sendWithImages', 'remote/set-mode-request'])(
    'names %s, which a keyless page cannot get acted on',
    (type) => {
      expect(isRefusedWhenKeyless({ type })).toBe(true);
    },
  );

  it('names an APPROVE but never a deny — refusing an ask is free at every tier', () => {
    expect(isRefusedWhenKeyless({ type: 'permission', toolCallId: 't1', optionId: 'allow' })).toBe(true);
    expect(isRefusedWhenKeyless({ type: 'permission', toolCallId: 't1', optionId: null })).toBe(false);
    expect(isRefusedWhenKeyless({ type: 'permission', toolCallId: 't1' })).toBe(false);
  });

  it('says nothing about the reads a keyless page IS allowed', () => {
    for (const type of ['remote/snapshot', 'cancel', 'requestSessions', 'soloSession']) {
      expect(isRefusedWhenKeyless({ type })).toBe(false);
    }
  });

  it('survives a message with no usable type', () => {
    expect(isRefusedWhenKeyless(null)).toBe(false);
    expect(isRefusedWhenKeyless({})).toBe(false);
    expect(isRefusedWhenKeyless({ type: 7 })).toBe(false);
  });
});

describe('setWatchOnly', () => {
  it('paints the sentence and opens the line', () => {
    expect(watch().getAttribute('data-open')).toBeNull();
    setWatchOnly(document);
    expect(watch().textContent).toBe(WATCH_ONLY_TEXT);
    expect(watch().getAttribute('data-open')).toBe('true');
  });

  it('says the same thing twice rather than stacking', () => {
    setWatchOnly(document);
    setWatchOnly(document);
    expect(watch().textContent).toBe(WATCH_ONLY_TEXT);
  });

  it('leaves the repair notice alone — the two strips are separate elements', () => {
    setNotice(document, 'This phone lost its pairing state — scan the QR code again.');
    setWatchOnly(document);
    expect(document.getElementById('remoteNotice')?.textContent).toBe(
      'This phone lost its pairing state — scan the QR code again.',
    );
    expect(watch().textContent).toBe(WATCH_ONLY_TEXT);
  });

  it('does not throw when the shell DOM is missing', () => {
    document.body.innerHTML = '';
    expect(() => setWatchOnly(document)).not.toThrow();
  });
});

describe('setStatus', () => {
  it('paints the state on the strip', () => {
    setStatus(document, 'open');
    const el = document.getElementById('remoteStatus') as HTMLElement;
    expect(el.getAttribute('data-state')).toBe('open');
    expect(el.textContent).toBe('open');
  });

  it('appends a detail when one is given', () => {
    setStatus(document, 'closed', 'relay unreachable');
    expect(document.getElementById('remoteStatus')?.textContent).toBe('closed — relay unreachable');
  });
});

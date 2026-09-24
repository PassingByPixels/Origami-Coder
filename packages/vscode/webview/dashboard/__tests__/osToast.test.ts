// osToast.test.ts — the OS-toast spawn: right command per platform, no shell
// string built from user text, failures swallowed rather than thrown. The
// injected ToastRunner means no test here ever spawns a real process or pops
// a real toast.

import { describe, expect, it, vi } from 'vitest';
import {
  encodeToastCommand,
  sendOsToast,
  windowsToastScript,
  TOAST_APP_ID,
} from '../../../src/notify/osToast';

// A title/body pair chosen to exercise quotes, an ampersand, and non-ASCII —
// each is a distinct way naive interpolation breaks a spawned command.
const TITLE = 'Agent "Fox" needs you';
const BODY = "Approve rm -rf & rename 'ünïcode.txt'?";

describe('windowsToastScript', () => {
  it('XML-escapes the title and body into the toast payload', () => {
    const script = windowsToastScript(TITLE, BODY);
    expect(script).toContain('&quot;Fox&quot;');
    expect(script).toContain('&amp;');
    expect(script).toContain('&apos;');
    // The raw quote/apostrophe must never appear un-escaped inside the XML.
    expect(script).not.toMatch(/<text>[^<]*"[^<]*<\/text>/);
  });

  it('carries the stable AppId through CreateToastNotifier', () => {
    expect(windowsToastScript('t', 'b')).toContain(`CreateToastNotifier('${TOAST_APP_ID}')`);
  });

  it('stays ASCII in its own script skeleton (only escaped payload values vary)', () => {
    const script = windowsToastScript('plain', 'plain body');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(script)).toBe(true);
  });
});

describe('encodeToastCommand', () => {
  it('round-trips through UTF-16LE base64, preserving non-ASCII', () => {
    const script = windowsToastScript(TITLE, BODY);
    const encoded = encodeToastCommand(script);
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toBe(script);
    expect(decoded).toContain('nïcode');
  });
});

describe('sendOsToast', () => {
  it('on win32, spawns powershell.exe with -EncodedCommand carrying the escaped payload', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    await sendOsToast(TITLE, BODY, 'win32', runner);
    expect(runner).toHaveBeenCalledTimes(1);
    const [file, args] = runner.mock.calls[0] as [string, string[]];
    expect(file).toBe('powershell.exe');
    expect(args[0]).toBe('-NoProfile');
    expect(args).toContain('-EncodedCommand');
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(decoded).toContain('&quot;Fox&quot;');
  });

  it('on darwin, spawns osascript -e with an escaped AppleScript display notification', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    await sendOsToast(TITLE, BODY, 'darwin', runner);
    const [file, args] = runner.mock.calls[0] as [string, string[]];
    expect(file).toBe('osascript');
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('display notification');
    expect(args[1]).toContain('\\"Fox\\"'); // the embedded quote is escaped, not raw
  });

  it('on linux, spawns notify-send with title/body as plain argv (no shell to escape for)', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    await sendOsToast(TITLE, BODY, 'linux', runner);
    expect(runner).toHaveBeenCalledWith('notify-send', [TITLE, BODY]);
  });

  it('never throws when the runner rejects, and logs once', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(sendOsToast(TITLE, BODY, 'linux', runner)).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});

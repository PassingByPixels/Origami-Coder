// Native OS toast — Windows first, macOS and Linux as fallbacks. Spawned with
// execFile (never a shell), but every platform still escapes the title/body
// because the string is interpreted again — as XML on Windows, as AppleScript
// on macOS. Windows carries them in a base64 -EncodedCommand (UTF-16LE) so
// non-ASCII survives. Failures are logged and swallowed, never thrown.

import { execFile } from 'node:child_process';

/** Runs one OS command with no shell. Injected so tests can assert the argv. */
export type ToastRunner = (file: string, args: string[]) => Promise<void>;

const TOAST_TIMEOUT_MS = 3000;
export const TOAST_APP_ID = 'Origami Code';

const defaultRunner: ToastRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TOAST_TIMEOUT_MS, windowsHide: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

/** Escape for embedding inside the toast XML's <text> nodes. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Defense in depth: double any quote left after xmlEscape, so it cannot close the PowerShell
 *  literal. */
function psQuoteSafe(s: string): string {
  return s.replace(/'/g, "''");
}

/** ASCII-only script source; title/body are XML+PS escaped and the whole script re-encoded
 *  UTF-16LE. */
export function windowsToastScript(title: string, body: string): string {
  const t = psQuoteSafe(xmlEscape(title));
  const b = psQuoteSafe(xmlEscape(body));
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${t}</text><text>${b}</text></binding></visual></toast>`;
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('${xml}')`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show($toast)`,
  ].join('\r\n');
}

export function encodeToastCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** AppleScript source escaping for `osascript -e` — the string is parsed a
 *  second time as AppleScript, so its quotes/backslashes must be escaped. */
function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Fire one native toast. Platform and runner are injectable for tests. */
export async function sendOsToast(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
  runner: ToastRunner = defaultRunner,
): Promise<void> {
  try {
    if (platform === 'win32') {
      const encoded = encodeToastCommand(windowsToastScript(title, body));
      await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
    } else if (platform === 'darwin') {
      const script = `display notification "${appleScriptEscape(body)}" with title "${appleScriptEscape(title)}"`;
      await runner('osascript', ['-e', script]);
    } else {
      await runner('notify-send', [title, body]);
    }
  } catch (err) {
    console.error('[origami] os toast failed', err);
  }
}

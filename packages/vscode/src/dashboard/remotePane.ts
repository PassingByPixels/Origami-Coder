// Remote pane — host side, routed out of DashboardPanel.ts like tools/skills/plugins/mcp.
// Nothing here goes to the engine: settings are VS Code's, the pairing secret is the OS keychain's,
// the socket belongs to RemoteController. Every write re-reads and re-posts so the pane never shows
// a state the host doesn't believe — a failed configuration.update must not leave a toggle stuck on
// optimistically.

import * as vscode from 'vscode';
import type { DeviceView } from '../remote/deviceAuth';
import type { ModeRecord } from '../remote/privilege'; import { readCapability, type RemoteCapability } from '../remote/remoteVerbs';
import { remotePair, remoteRevoke, remoteSnapshot, remoteTakeOver } from '../remote/control';
import { deviceNameFor, setDeviceName } from '../remote/deviceNames';
import { relayHttpUrl } from '../remote/pairing';
import { encodeQr, qrSvg } from '../remote/qr';

import { GROUP_PANE_MESSAGE_TYPES, handleGroupPaneMessage } from './groupPane';

export const REMOTE_PANE_MESSAGE_TYPES = new Set([
  ...GROUP_PANE_MESSAGE_TYPES,
  'remoteRequest',
  'remoteSetEnabled',
  'remoteSetRelayUrl',
  'remotePair',
  'remoteTakeOver',
  'remoteRevoke',
  'remoteSetDeviceName',
]);

export interface RemotePaneHost {
  post(message: Record<string, unknown>): void;
}

const SECTION = 'origamicoder.remote';
const DEFAULT_RELAY = 'wss://relay.origamilabs.nl';

export interface RemotePayload {
  type: 'remoteData';
  enabled: boolean;
  relayUrl: string;
  connection: string;
  rid: string | null;
  /** What the OWNER called this phone, or '' — the phone never sends one. */
  deviceName: string;
  /** The enrolled device key, or null. The pane shows its full fingerprint. */
  device: DeviceView | null;
  capability: RemoteCapability; modes: ModeRecord[];
  pairedAt: number | null;
  lastSeen: number | null;
  detail: string;
  error?: string;
}

export function remotePayload(): RemotePayload {
  const c = vscode.workspace.getConfiguration(SECTION);
  const snapshot = remoteSnapshot();
  return {
    type: 'remoteData',
    enabled: c.get<boolean>('enabled', false),
    relayUrl: c.get<string>('relayUrl', DEFAULT_RELAY),
    connection: snapshot.connection,
    rid: snapshot.rid,
    deviceName: deviceNameFor(snapshot.rid),
    device: snapshot.device,
    capability: readCapability(c.get<string>('capability', 'full')), modes: snapshot.modes,
    pairedAt: snapshot.pairedAt,
    lastSeen: snapshot.lastSeen,
    detail: snapshot.detail,
  };
}

/** Written GLOBAL, never workspace-scoped: a pairing lives in the OS keychain for the whole user,
 *  so per-folder state would let the phone reach the machine from one window and not another. */
async function update(key: string, value: unknown): Promise<string | undefined> {
  try {
    await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
    return undefined;
  } catch (e) {
    const message = `Origami: could not update "${SECTION}.${key}" — ${e instanceof Error ? e.message : String(e)}`;
    vscode.window.showErrorMessage(message);
    return message;
  }
}

function post(host: RemotePaneHost, error?: string): void {
  host.post({ ...remotePayload(), ...(error ? { error } : {}) });
}

export async function handleRemotePaneMessage(
  host: RemotePaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  // The device group is the same pane's second half (t-rz1b14). It is routed
  // from here, not from DashboardPanel, so the panel keeps ONE remote entry
  // point; the whole implementation is the groupPane.ts leaf.
  if (typeof m.type === 'string' && GROUP_PANE_MESSAGE_TYPES.has(m.type)) return handleGroupPaneMessage(host, m);
  switch (m.type) {
    case 'remoteRequest':
      post(host);
      return;
    case 'remoteSetEnabled': {
      const enabled = m['enabled'] === true;
      const error = await update('enabled', enabled);
      // Turning Remote off also revokes the pairing — leaving it live in the keychain behind a
      // switch reading "off" would let a phone paired long ago reconnect with no new consent.
      if (!enabled && !error) await remoteRevoke('Origami Remote was switched off');
      post(host, error);
      return;
    }
    case 'remoteSetRelayUrl': {
      const raw = typeof m['url'] === 'string' ? m['url'].trim() : '';
      // Empty means back to default — the only way to undo a typo without knowing the original
      // default string.
      const url = raw || DEFAULT_RELAY;
      if (!/^wss?:\/\//i.test(url)) {
        post(host, 'The relay URL must start with wss:// (or ws:// on a trusted network).');
        return;
      }
      post(host, await update('relayUrl', url)); await remoteTakeOver(); // reopen the socket on the NEW relay; the live transport keeps the URL it was built with
      return;
    }
    // No confirmation dialog: the app proves pairing with its device key on every connection, so
    // pressing the button is the whole gesture.
    case 'remotePair': {
      try {
        const offer = await remotePair();
        // Rendered host-side: the webview cannot import the encoder (tsconfig pins rootDir to
        // webview/), and relayOrigin is the same value the QR payload is built from so the two
        // can't drift.
        const relayUrl = vscode.workspace.getConfiguration(SECTION).get<string>('relayUrl', DEFAULT_RELAY);
        host.post({
          type: 'remoteQr', svg: qrSvg(encodeQr(offer.qr)), expiresAt: offer.expiresAt, rid: offer.rid,
          relayOrigin: relayHttpUrl(relayUrl),
        });
        post(host);
      } catch (e) {
        // The controller's own refusal message is passed through unchanged, since it names the real
        // fix.
        post(host, e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // Naming is desktop-side only; nothing is sent to the phone. Re-posts like every other write.
    case 'remoteSetDeviceName': {
      await setDeviceName(typeof m['rid'] === 'string' ? m['rid'] : '', m['name']);
      post(host);
      return;
    }
    // Takes the phone from whichever window has it; the button only appears when another window
    // owns the pairing, so pressing it is the confirmation.
    case 'remoteTakeOver': {
      await remoteTakeOver();
      post(host);
      return;
    }
    case 'remoteRevoke': {
      try {
        await remoteRevoke();
        post(host);
      } catch (e) {
        post(host, e instanceof Error ? e.message : String(e));
      }
      return;
    }
  }
}

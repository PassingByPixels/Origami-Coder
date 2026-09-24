// Origami Remote — the ONE seam between the activation-owned controller and a
// surface that wants to drive it. `activate.ts` keeps the RemoteController
// private (with the setting off it must not be constructed at all), so
// activation REGISTERS itself here and the pane asks this module; a window
// where `activateRemote` never ran answers `off` rather than throwing.
// It also holds WHEN the transport last said anything; WHEN the pairing was
// made belongs to the controller (`confirmedAt` is the phone's hello).

import type { DeviceView } from './deviceAuth'; import type { ModeRecord } from './privilege';
import { forgetDeviceName } from './deviceNames';
import { ownedElsewhere, takeLease } from './ownerLease';
import type { PairingOffer } from './pairing';
import { SUPERSEDED_REASON } from './transport';

/** The subset of RemoteController this module drives. Structural, so the pane's tests can register
 *  a fake. */
export interface RemoteControlTarget {
  pair(lanUrl?: string): Promise<PairingOffer>;
  /** Re-open the stored pairing. What Take over calls once the lease is ours. */
  restore(): Promise<void>;
  revoke(reason?: string): Promise<void>;
  readonly connected: boolean;
  readonly rid: string | null;
  /** Epoch ms of the PHONE's hello, or null. Distinct from `connected`, which
   *  is only the desktop's own socket to the relay. */
  readonly confirmedAt: number | null;
  /** The enrolled device key, or null. Never carries the public key itself. */
  readonly device: DeviceView | null; readonly modes: ModeRecord[];
}

/** `off` = the setting is off. `unpaired` = on, no code shown. `pending` = a
 *  code IS showing and no phone has answered. `other-window` = another VS Code
 *  window owns this pairing; it outranks all of them bar `off`. `connecting` =
 *  a phone paired, socket down. `paired` = a phone paired, socket up.
 *  Without `pending` the desktop's own relay socket read as "paired". */
export type RemoteConnection = 'off' | 'unpaired' | 'pending' | 'other-window' | 'connecting' | 'paired';

export interface RemoteSnapshot {
  connection: RemoteConnection;
  /** The rendezvous id. Shown truncated — it is the pairing's only name. */
  rid: string | null;
  pairedAt: number | null;
  lastSeen: number | null;
  /** The controller's last status line, verbatim. It names the real failure. */
  detail: string;
  /** The enrolled phone: name, platform, app, key backend and the FULL fingerprint. */
  device: DeviceView | null;
  modes: ModeRecord[];
}

interface Registration {
  target: () => RemoteControlTarget;
  enabled: () => boolean;
}

let registration: Registration | null = null;
let lastSeen: number | null = null;
let detail = '';
/** Set by a relay close 4001: another desktop took the slot, so this window is
 *  no longer the owner. Cleared by pair, revoke and Take over. */
let superseded = false;
const listeners = new Set<() => void>();

/** Called once by `activateRemote`. A second call replaces the first. */
export function registerRemoteControl(reg: Registration): void {
  registration = reg;
  notify();
}

/** Test hook: put the module back to a never-activated window. */
export function resetRemoteControl(): void {
  registration = null;
  lastSeen = null;
  detail = '';
  superseded = false;
  listeners.clear();
}

/** Every controller status line lands here. It is the only clock the pane has,
 *  so "last seen" is real transport activity rather than a guess. */
export function noteRemoteStatus(text: string): void {
  if (text.includes(SUPERSEDED_REASON)) superseded = true;
  detail = text;
  lastSeen = Date.now();
  notify();
}

export function onRemoteChange(fn: () => void): { dispose: () => void } {
  listeners.add(fn);
  return { dispose: () => void listeners.delete(fn) };
}

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a broken listener must not stop the others, or the pane stops updating */
    }
  }
}

export function remoteSnapshot(): RemoteSnapshot {
  if (!registration || !registration.enabled()) {
    return { connection: 'off', rid: null, pairedAt: null, lastSeen: null, detail, device: null, modes: [] };
  }
  const target = registration.target();
  const rid = target.rid;
  const pairedAt = target.confirmedAt;
  // ORDER MATTERS: the phone's hello is asked about BEFORE the socket.
  const connection: RemoteConnection = !rid
    ? 'unpaired'
    : superseded || ownedElsewhere(rid)
      ? 'other-window'
      : pairedAt === null
        ? 'pending'
        : target.connected
          ? 'paired'
          : 'connecting';
  return { connection, rid, pairedAt, lastSeen, detail, device: target.device, modes: target.modes };
}

/** Start a pairing. Throws in the controller's own words when Remote is off. */
export async function remotePair(lanUrl?: string): Promise<PairingOffer> {
  if (!registration) throw new Error('origami remote: this window has no remote controller');
  superseded = false;
  const offer = await registration.target().pair(lanUrl);
  // No pairedAt here: a code that has been shown is not a pairing.
  lastSeen = null;
  notify();
  return offer;
}

/** Forget the pairing. Safe on a window that never paired. */
export async function remoteRevoke(reason = 'revoked from the Remote pane'): Promise<void> {
  if (!registration) return;
  // Read the rid BEFORE the revoke: revoking rotates the key.
  const rid = registration.target().rid;
  superseded = false;
  await registration.target().revoke(reason);
  await forgetDeviceName(rid);
  lastSeen = null;
  notify();
}

/** Take the phone from whichever window has it. The loser stands down on its
 *  next heartbeat; this window then re-opens the stored pairing. */
export async function remoteTakeOver(): Promise<void> {
  const rid = registration?.target().rid;
  if (!registration || !rid) return;
  await takeLease(rid);
  superseded = false;
  await registration.target().restore();
  notify();
}

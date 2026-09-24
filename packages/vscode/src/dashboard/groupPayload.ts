// groupPayload.ts — the `groupData` message the Nests view draws (t-s9jr6u).
// Split out of groupPane.ts when the Nests fields (switch, relay, this desk)
// took that file over its cap. Pure read: roster, controller snapshot, settings.

import { hostname } from 'node:os';
import { deskOs } from '../remote/deskOs';
import { groupSnapshot } from '../remote/groupControl';
import type { GroupSnapshot } from '../remote/groupController';
import { nestsRelayUrl, readNestsEnabled } from '../remote/nestsSetting';
import { qrSvg, encodeQr } from '../remote/qr';
import { nestHub } from './nestHubWindow';
import type { TailStatus } from './nestTail';

export interface GroupPayload extends Record<string, unknown> {
  type: 'groupData';
  active: boolean;
  deviceId: string | null;
  nestsEnabled: boolean; // off = the Nests view shows the pitch and the switch only
  relayUrl: string; // the relay Nests shares with Remote, for the Config card
  self: { name: string; os: string }; // this desk before it is in any nest (Config)
  devices: GroupSnapshot['devices'];
  /** The invite string itself, so the owner can COPY it — the owner's decision:
   *  QR and a pasted key, because most desks have no camera. */
  inviteKey: string | null;
  /** The same string, drawn. One string, two carriers, nothing to keep in step. */
  inviteQr: string | null;
  inviteExpiresAt: number | null;
  /** t-sj32zl: a join in flight (the joining desk's name + match code), and why the last one ended. */
  joinCheck: GroupSnapshot['joinCheck'];
  joinNotice: string | null;
  /** t-selspn: the mother base's tail per desk; null on any other desk. */
  tail: TailStatus | null;
  error?: string;
}

export function groupPayload(error?: string): GroupPayload {
  const snapshot = groupSnapshot();
  return {
    type: 'groupData',
    active: snapshot.active,
    nestsEnabled: readNestsEnabled(),
    relayUrl: nestsRelayUrl(),
    self: { name: hostname(), os: deskOs(process.platform) },
    deviceId: snapshot.deviceId,
    devices: snapshot.devices,
    inviteKey: snapshot.inviteKey,
    // Rendered host-side: the webview cannot import the encoder (tsconfig pins
    // rootDir to webview/), and it is the SAME string the copy box shows.
    inviteQr: snapshot.inviteKey ? qrSvg(encodeQr(snapshot.inviteKey)) : null,
    inviteExpiresAt: snapshot.inviteExpiresAt,
    joinCheck: snapshot.joinCheck,
    joinNotice: snapshot.joinNotice,
    tail: nestHub.tail.status(),
    ...(error ? { error } : {}),
  };
}

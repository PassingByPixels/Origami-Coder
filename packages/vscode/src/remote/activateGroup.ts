// Device group — activation glue, split out of activate.ts so that file stays
// what it is: the remote lane's wiring and nothing else.
//
// The group rides its OWN switch, `origamicoder.nests.enabled` (t-s9jr6u, the
// owner's Nests view), default off: the same relay and keychain as the phone
// lane, but a desk joins desks, not a phone. The controller is not CONSTRUCTED
// until the switch is on and something asks, so a window with Nests off holds
// no sockets and no secrets. Turning it off disposes the controller.

import type * as vscode from 'vscode';
import { GroupController } from './groupController';
import { notifyGroupChange, registerGroupControl } from './groupControl';
import type { DeskOs } from './deskOs';
import { registerGroupMembers } from './groupMembers';
import type { RemoteConfig } from './remoteController';
import type { TransportDeps } from './transport';
import { attachNestGroup, nestHub } from '../dashboard/nestHubWindow';

export interface DeviceGroupHandle {
  restore(): Promise<void>;
  /** The Nests switch moved: on restores the group, off closes every link. */
  nestsChanged(on: boolean): void;
  dispose(): void;
}

export interface DeviceGroupDeps {
  config: () => RemoteConfig;
  /** `origamicoder.nests.enabled`. The only gate on the group. */
  nestsEnabled: () => boolean;
  os: DeskOs;
  deps: TransportDeps;
  claim: (rid: string, onFree?: () => void) => Promise<boolean>;
  /** This machine's name in the roster the other desks draw. */
  deviceName: string;
  onStatus: (text: string) => void;
}

export function activateDeviceGroup(
  context: vscode.ExtensionContext,
  wiring: DeviceGroupDeps,
): DeviceGroupHandle {
  let controller: GroupController | null = null;

  const ensure = (): GroupController => {
    controller ??= new GroupController({
      config: () => ({ enabled: wiring.nestsEnabled(), relayUrl: wiring.config().relayUrl }),
      secrets: context.secrets,
      deps: wiring.deps,
      deviceName: wiring.deviceName,
      claim: wiring.claim,
      onStatus: wiring.onStatus,
      os: wiring.os,
      onChange: () => { notifyGroupChange(); nestHub.onGroupChange(); },
      onPeerMessage: (peerId, msg) => void nestHub.onPeer(peerId, msg),
    });
    attachNestGroup(controller, wiring.deviceName);
    return controller;
  };

  // The roster is globalState, like the phone's device names: it is not a
  // credential (Kg is) and the pane must list the group with Remote off.
  registerGroupMembers(context.globalState); nestHub.away.attach(context.globalState); // t-t7lfho: "continued on <desk>" survives a reload
  registerGroupControl({ target: ensure, enabled: wiring.nestsEnabled });

  return {
    restore: () => (wiring.nestsEnabled() ? ensure().restore() : Promise.resolve()),
    nestsChanged: (on) => {
      if (on) void ensure().restore();
      else { controller?.dispose(); controller = null; nestHub.attachGroup(null); }
      notifyGroupChange();
    },
    dispose: () => { controller?.dispose(); nestHub.attachGroup(null); },
  };
}

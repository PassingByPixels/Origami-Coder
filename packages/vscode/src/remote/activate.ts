// Origami Remote — activation glue. The only file in src/remote/ that imports
// `vscode` at runtime; everything else takes injected dependencies. Checks
// `origamicoder.remote.enabled` BEFORE the controller is constructed: with the
// setting off this file registers two commands and nothing else.

import * as vscode from 'vscode';
import { hostname } from 'node:os';
import { deskOs } from './deskOs';
import { readNestsEnabled } from './nestsSetting';
import { DashboardPanel } from '../dashboard/DashboardPanel';
import { requestBoardSection } from '../dashboard/boardSection';
import { noteRemoteStatus, registerRemoteControl } from './control'; import { notifyRemotePaired } from '../notify/notifyEvents';
import { registerDeviceNames } from './deviceNames';
import { activateDeviceGroup, type DeviceGroupHandle } from './activateGroup';
import { HEARTBEAT_MS, claimLease, leaseHeartbeat, registerOwnerLease, releaseLease } from './ownerLease';
import { syncRemoteEnabledContext } from './remoteEnabledContext';
import { RemoteController, type RemoteConfig } from './remoteController'; import { readCapability } from './remoteVerbs';
import { registerRemoteSeq } from './seqStore';
import type { RemoteSocket, TransportDeps } from './transport';
import { setPhoneFocus } from '../elastic/elasticWindow';

export function readRemoteConfig(): RemoteConfig {
  const c = vscode.workspace.getConfiguration('origamicoder.remote');
  return {
    enabled: c.get<boolean>('enabled', false),
    relayUrl: c.get<string>('relayUrl', 'wss://relay.origamilabs.nl'),
    capability: readCapability(c.get<string>('capability', 'full')),
  };
}

/** The real transport dependencies. `WebSocket` is the platform global — the
 *  extension host runs on Node 22 — so there is no `ws` package to bundle. */
function hostDeps(): TransportDeps {
  return {
    connect: (url) => {
      const Ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
      if (!Ctor) throw new Error('origami remote: this VS Code build has no global WebSocket');
      return new Ctor(url) as unknown as RemoteSocket;
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

export function activateRemote(context: vscode.ExtensionContext): vscode.Disposable[] {
  let controller: RemoteController | null = null;
  let group: DeviceGroupHandle | null = null;

  // Palette visibility only; the setting still decides whether Remote acts.
  syncRemoteEnabledContext(readRemoteConfig().enabled);
  const contextWatch = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('origamicoder.remote.enabled')) syncRemoteEnabledContext(readRemoteConfig().enabled);
    if (e.affectsConfiguration('origamicoder.nests.enabled')) group?.nestsChanged(readNestsEnabled());
  });

  const ensure = (): RemoteController => {
    controller ??= new RemoteController({
      config: readRemoteConfig,
      secrets: context.secrets,
      deps: hostDeps(),
      // No dashboard yet = no hydration; the phone's next remote/snapshot picks it up.
      attach: (host) => DashboardPanel.current?.attachView(host, 'chat'),
      onStatus: (text) => { noteRemoteStatus(text); if (text === 'remote: phone paired') notifyRemotePaired(); },
      claim: claimLease, // t-xum9r8: with the retry callback
      deviceName: vscode.workspace.name ?? 'Origami Code',
      onPhoneFocus: setPhoneFocus, // t-w2qv3o: a chat open on the phone is active
    });
    return controller;
  };

  const requireEnabled = (): boolean => {
    if (readRemoteConfig().enabled) return true;
    void vscode.window.showWarningMessage(
      'Origami Remote is off. Turn on origamicoder.remote.enabled to pair a phone.',
    );
    return false;
  };

  // The Remote pane drives the same controller through control.ts. `ensure` is
  // handed over so that with the setting off nothing is constructed.
  registerRemoteControl({ target: ensure, enabled: () => readRemoteConfig().enabled });
  // Device names are globalState, not secrets, and are registered whether or not
  // Remote is on — the pane must show a pairing's name with the setting off.
  registerDeviceNames(context.globalState);
  // Frame sequence marks share the same store as the lease: the counter belongs
  // to the PAIRING, and restarting at 1 makes the phone drop every frame.
  registerRemoteSeq(context.globalState);
  // THE DEVICE GROUP (t-rz1b14): desk-to-desk on the same relay, behind the
  // Nests switch (t-s9jr6u). Named by HOST name, not workspace name (round 4).
  group = activateDeviceGroup(context, { config: readRemoteConfig, nestsEnabled: readNestsEnabled, os: deskOs(process.platform), deps: hostDeps(), claim: claimLease, onStatus: noteRemoteStatus, deviceName: hostname() });

  // ONE WINDOW OWNS THE PHONE. Every window restores the same pairing and the
  // relay allows one socket per role per rid, so they evicted each other. The
  // lease lives in globalState; the beat is a no-op in a window holding nothing.
  registerOwnerLease(context.globalState, `${process.pid}-${Math.random().toString(36).slice(2, 8)}`, {
    onLost: (rid) => {
      if (rid !== controller?.rid) return; // t-xum9r8: the lease holds desk-link rids too; only the phone's is this
      noteRemoteStatus('remote: this pairing is active in another window');
      controller?.dispose();
    },
  });
  const beat = setInterval(() => void leaseHeartbeat(), HEARTBEAT_MS);

  if (readRemoteConfig().enabled) void ensure().restore();
  void group.restore(); // a no-op with Nests off: nothing is constructed

  return [
    // The Remote pane is the pairing surface: ask for the section, then reveal it.
    vscode.commands.registerCommand('origami.remotePair', async () => {
      if (!requireEnabled()) return;
      requestBoardSection('remote');
      await vscode.commands.executeCommand('origami.openAgentManager');
    }),
    vscode.commands.registerCommand('origami.remoteRevoke', async () => {
      if (!controller) {
        void vscode.window.showInformationMessage('Origami: no remote device is paired.');
        return;
      }
      await controller.revoke('revoked by command');
      void vscode.window.showInformationMessage('Origami: remote devices revoked.');
    }),
    // Releasing on the way out makes the hand-over immediate (no STALE_MS wait).
    {
      dispose: () => {
        clearInterval(beat);
        void releaseLease();
        controller?.dispose();
        group?.dispose();
        contextWatch.dispose();
      },
    },
  ];
}

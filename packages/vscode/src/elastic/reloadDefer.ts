// reloadDefer.ts — t-wypna7 (epic t-w1r73y, owner decision 2026-09-25, option A): at a window reload, a chat of the
// open set comes back WITHOUT its engine. Its pane is on screen at once and shows "Loading chat history…" (its
// reopen history state, historyHost.ts). Its engine starts, with the same `session/load` as a reload today (same spawn,
// same request bytes), on the first of:
//   - focus: the tracker's wakeOnScreen (sessionSignals.ts) starts a `parked` gate that is in focus or on the phone;
//   - a message, a slash command, a /loop run or any session call: they go through the gate (engineGate.ts);
//   - peer mail: ParkHost.deferred writes the chat's stand-in and watches its mailbox (parkHost.ts, parkedMail.ts);
//   - any direct client call: `client.wake` asks the gate first (acpClient.ts `live()`), as for a parked chat.
// The client holds the engine session id from the start, so the open set keeps the chat, /loop re-arms on it and mail
// finds it. No vscode beyond the settings read: DashboardPanel hands in the chat.

import * as path from 'node:path';
import { agentNameSetting } from '../peerName';
import { readElasticSettings } from './elasticWindow';

/** The slice of AcpClient this needs. */
export interface DeferClient {
  defer(sessionId: string, cwd: string, wake: () => Promise<void>): void;
}

/** The slice of EngineGate this needs. */
export interface DeferGate {
  readonly current: string;
  defer(run: () => Promise<void>, refusal?: () => string, after?: () => void): Promise<void>;
  whenUp(): Promise<boolean>;
}

/** The slice of ParkHost this needs. */
export interface DeferPeers {
  deferred(sid: string, cwd: string, name: string): void;
}

export interface DeferChat {
  client: DeferClient;
  gate: DeferGate;
  cwd: string;
  number?: number;
}

/** The chat's start, as DashboardPanel.createSession would run it now. */
export interface DeferredStart {
  run: () => Promise<void>;
  refusal?: () => string;
  /** The pane's "starting" and history state settle once the first start has ended. */
  settled?: () => void;
}

/** A reload reopens chats without their engine while elastic engines are on (`origamicoder.elastic.enabled`).
 *  Off = every chat starts at once, as in 0.4.175. */
export function deferAtReload(read: () => { enabled: boolean } = readElasticSettings): boolean {
  return read().enabled;
}

/** The name the stand-in is listed under (list_agents shows `name#sessionId`; send_message resolves it the same way,
 *  engine origami/agent-broker.ts resolveParked). The engine's own name is `ORIGAMI_AGENT_NAME` (the `origami.agentName`
 *  setting) or `<basename(cwd)>-<last 4 digits of its pid>`; no engine runs yet, so the fallback has no pid part. */
export function standInName(cwd: string, setting: () => string = agentNameSetting): string {
  return setting() || path.basename(cwd) || 'agent';
}

/** Reopen `chat` on engine session `engineId` without starting its engine. */
export function deferChat(chat: DeferChat, engineId: string, start: DeferredStart, peers: DeferPeers, log: (line: string) => void): Promise<void> {
  const label = `chat ${chat.number ?? engineId}`;
  chat.client.defer(engineId, chat.cwd, async () => {
    if (chat.gate.current === 'starting') return; // the deferred start itself is running: its own calls pass
    if (!(await chat.gate.whenUp())) throw new Error('the engine did not start');
  });
  const begun = chat.gate.defer(async () => {
    log(`[elastic] ${label}: first use after the reload: starting its engine`);
    await start.run();
  }, start.refusal, start.settled);
  peers.deferred(engineId, chat.cwd, standInName(chat.cwd));
  log(`[elastic] ${label} reopened without its engine; it starts on focus, a message, peer mail or a /loop run`);
  return begun;
}

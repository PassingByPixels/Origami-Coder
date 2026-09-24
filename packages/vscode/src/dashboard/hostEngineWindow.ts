// hostEngineWindow.ts — t-sh7cog: the ONE host engine per VS Code window, built
// on the real AcpClient (connect only, no session), and the two things the
// window does with it at activation: give the Nests hub an engine that needs no
// panel, and dispose it on window close with the chat engines.
// The rules live in hostEngine.ts; this file is wiring.

import * as vscode from 'vscode';
import { AcpClient, type AcpEventHandlers } from '../acpClient';
import { HOST_ENGINE_CHANNEL, HostEngine, attachHostNestView } from './hostEngine';
import { nestHub } from './nestHubWindow';
import { TOOLS_PANE_MESSAGE_TYPES } from './toolsPane';
import { MCP_PANE_MESSAGE_TYPES } from './mcpPane';
import { FLOCK_PANE_MESSAGE_TYPES } from './flockPane';
import { STORAGE_PANE_MESSAGE_TYPES } from './storagePane';
import { ARTIFACTS_PANE_MESSAGE_TYPES } from './artifactsPane';
import { PLUGINS_PANE_MESSAGE_TYPES } from './pluginsPane';
import { SKILLS_PANE_MESSAGE_TYPES } from './skillsPane';
import { SESSION_DELETE_MESSAGE_TYPES } from './sessionDelete';
import { PROVIDER_AUTH_MESSAGE_TYPES } from './providerAuthPane';
import { GLIDEPATH_MESSAGE_TYPES } from './usageHistory';
import { COLLAB_MESSAGE_TYPES } from './collabManager';
import { CLAUDE_SUBSCRIPTION_CARD_MESSAGE_TYPES } from './claudeSubscriptionCard';
import { MODEL_LIST_REFRESH_MESSAGE_TYPES } from './modelListRefresh'; // t-ttmo5w: with no chat, Refresh clears the catalog cache through the host engine

/** The requests that may START the host engine when no chat is open: what a user
 *  surface asks for (the Manager panes, History, the Labyrinth, Insights). NOT the
 *  nest sidebar's index read (the sidebar sends it on every mount, Nests on or off;
 *  the hub starts the engine itself, only with Nests on) and no background timer. */
export const HOST_ENGINE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  ...TOOLS_PANE_MESSAGE_TYPES, ...MCP_PANE_MESSAGE_TYPES, ...FLOCK_PANE_MESSAGE_TYPES, ...STORAGE_PANE_MESSAGE_TYPES,
  ...ARTIFACTS_PANE_MESSAGE_TYPES, ...PLUGINS_PANE_MESSAGE_TYPES, ...SKILLS_PANE_MESSAGE_TYPES, ...SESSION_DELETE_MESSAGE_TYPES,
  ...PROVIDER_AUTH_MESSAGE_TYPES, ...GLIDEPATH_MESSAGE_TYPES, ...COLLAB_MESSAGE_TYPES, ...CLAUDE_SUBSCRIPTION_CARD_MESSAGE_TYPES,
  'requestHistory', 'requestRunSteps', 'requestRunStats', 'requestCollabSteps', 'requestSubagentTranscript',
  'listInstructions', 'openBasePrompt', 'restoreInstructionDefault', 'createInstructionFile', ...MODEL_LIST_REFRESH_MESSAGE_TYPES,
]);

const noop = (): void => undefined;

let channel: vscode.OutputChannel | undefined;
/** Every host-engine line goes to the channel HOST_ENGINE_FAILED names. Made on the
 *  first line, so a window whose host engine never runs gets no empty channel. */
export function hostEngineLog(line: string): void {
  (channel ??= vscode.window.createOutputChannel(HOST_ENGINE_CHANNEL)).appendLine(line);
}

/** A host client has no session, so no turn and no ask ever reaches these. */
function hostHandlers(onClose: () => void): AcpEventHandlers {
  return {
    onAgentMessageChunk: noop, onAgentImageChunk: noop, onToolCallStart: noop, onToolCallUpdate: noop,
    onPermissionRequest: noop, onAvailableCommands: noop, onPlanStatus: noop, onPlanReady: noop,
    onBestOfNComplete: noop, onTaskShape: noop, onTodoUpdate: noop,
    onClose: (reason) => { hostEngineLog(`[origami] host engine closed: ${reason}`); onClose(); },
    onError: (message) => hostEngineLog(`[origami] host engine: ${message}`),
  };
}

export const hostEngine = new HostEngine<AcpClient>({
  make: (onClose) => new AcpClient(hostHandlers(onClose)),
  cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
  log: hostEngineLog,
});

/** Activation: the hub reads through the host engine with no panel open, and the
 *  host engine goes with the window (context.subscriptions, like every disposable). */
export function activateHostEngine(
  context: { subscriptions: Array<{ dispose(): unknown }> },
  engine: { readonly nestEngine: HostEngine<AcpClient>['nestEngine']; dispose(): void } = hostEngine,
  hub: Parameters<typeof attachHostNestView>[0] = nestHub,
): void {
  attachHostNestView(hub, engine);
  context.subscriptions.push({ dispose: () => engine.dispose() });
}

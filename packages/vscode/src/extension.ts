// Origami VS Code Extension — activation entrypoint.
//
// The Origami crane icon in the activity bar opens the lean chat side
// panel — the single product surface (brand header + theme control +
// ControlStrip + the real ChatPane). There is no separate dashboard.

import * as vscode from 'vscode';
import { DashboardPanel } from './dashboard/DashboardPanel';
import { ChatViewProvider } from './sidebar/ChatViewProvider';
import { StatusBarController } from './statusBar/StatusBarController';
import { registerAgentDiffProvider } from './dashboard/agentManager/diffProvider';
import { resetPersistentPermissions } from './dashboard/agentManager/persistentPermissions';

let statusBar: StatusBarController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('Origami extension activating...');

  // --- Status bar (informational only) ---
  statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);
  DashboardPanel.setStatusBar(statusBar);

  // Agent Manager: readonly LEFT side of a Done card's "apply to main" diff.
  registerAgentDiffProvider(context);

  // --- Split surfaces: CONFIG (left activity bar) + CHAT (secondary side
  // bar, top-right) ---
  // The crane in the TOP-RIGHT secondary side bar opens the CHAT (the real
  // ChatPane + new-chat tabs) plus the embedded Settings (ControlStrip +
  // theme). The DashboardPanel host (resolveSharedView) bootstraps the ACP
  // session and broadcasts model/connection/theme status to every attached
  // view (incl. popped-out chat editor tabs) so they always agree. (The old
  // left activity-bar Setup view was removed — Settings now lives in the
  // right sidebar.)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewId,
      new ChatViewProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Thin error-guard around a command handler: surface failures as a
  // VS Code error toast instead of an unhandled rejection. (Onboarding is
  // an in-chat welcome card now — a fresh workspace is never blocked.)
  const guarded = <T extends unknown[]>(
    handler: (...args: T) => Promise<void> | void,
  ) => {
    return async (...args: T): Promise<void> => {
      try {
        await handler(...args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Origami command failed: ${msg}`);
      }
    };
  };

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('origami.toggleSidebar', () => {
      // Reveal the CHAT view (now in the secondary side bar). Focusing the
      // view id is order-independent and works wherever the user has
      // dragged it.
      vscode.commands.executeCommand('origami.chatView.focus');
    }),

    // Reveal the chat view directly (used by other entry points).
    vscode.commands.registerCommand('origami.openChat', () => {
      vscode.commands.executeCommand('origami.chatView.focus');
    }),

    vscode.commands.registerCommand(
      'origami.newSession',
      guarded(async () => {
        await DashboardPanel.addSession(context);
      }),
    ),

    // New Chat (+) in the chat view title bar — opens a fresh session in
    // the chat. Reveals the chat view first so the new session is visible,
    // then creates it via the shared host's session machinery.
    vscode.commands.registerCommand(
      'origami.newChat',
      guarded(async () => {
        await vscode.commands.executeCommand('origami.chatView.focus');
        await DashboardPanel.addSession(context);
      }),
    ),

    vscode.commands.registerCommand(
      'origami.switchModel',
      guarded(async () => {
        await DashboardPanel.switchModel(context);
      }),
    ),

    // Recall a past chat — lists prior engine sessions (ACP
    // listSessions) and reopens the chosen one (loadSession).
    vscode.commands.registerCommand(
      'origami.openHistory',
      guarded(async () => {
        await DashboardPanel.openHistory(context);
      }),
    ),

    // Feature 1 — clear the recalled "always allow" permission rules for this
    // workspace (the persisted allow_always decisions replayed across restarts).
    vscode.commands.registerCommand(
      'origami.resetSavedPermissions',
      guarded(async () => {
        resetPersistentPermissions(context.workspaceState);
        await vscode.window.showInformationMessage('Origami: saved permissions cleared for this workspace.');
      }),
    ),

    // Pop the chat out into a movable/splittable editor tab.
    vscode.commands.registerCommand(
      'origami.openChatInEditor',
      guarded(async () => {
        await DashboardPanel.openInEditor(context);
      }),
    ),

    vscode.commands.registerCommand('origami.toggleTheme', () => {
      // Cycle the fixed brand themes + the custom slot, in the same order as
      // the in-panel picker (webview/shared/theme.ts THEMES).
      const cycle = ['meadow', 'harbour', 'ember', 'midnight', 'custom'];
      const current = context.globalState.get<string>('origami.theme', 'meadow');
      const idx = cycle.indexOf(current);
      const next = cycle[(idx + 1) % cycle.length];
      context.globalState.update('origami.theme', next);
      vscode.window.showInformationMessage(`Origami: Theme switched to ${next}.`);
    }),

    vscode.commands.registerCommand('origami.openAgentProfile', async () => {
      // Open dashboard and focus the agent explorer
      await DashboardPanel.createOrShow(context);
    }),

    vscode.commands.registerCommand('origami.init', guarded(async () => {
      // "Get started" — reveal the chat and run /firstfold (scaffold the
      // workspace + connect a model). Replaces the old defunct ACP wizard;
      // the empty-state hint tells new users to run this too.
      await vscode.commands.executeCommand('origami.chatView.focus');
      await DashboardPanel.runSlashCommand(context, 'firstfold');
    })),

    // Agent Manager board — parallel agents in isolated git worktrees.
    vscode.commands.registerCommand(
      'origami.openAgentManager',
      guarded(async () => {
        await DashboardPanel.openAgentManagerInEditor(context);
      }),
    ),

  );

  console.log(
    'Origami extension activated. The crane chat sidebar is the only surface; focus it with Ctrl+Shift+L.',
  );
}

export function deactivate(): void {
  // DashboardPanel.dispose runs automatically via panel.onDidDispose.
}

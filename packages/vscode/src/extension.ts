// Origami VS Code Extension — activation entrypoint. The Origami crane icon in the
// activity bar opens the lean chat side panel (brand header + theme control +
// ControlStrip + ChatPane). There is no separate dashboard.

import * as vscode from 'vscode';
import { DashboardPanel } from './dashboard/DashboardPanel';
import { ChatViewProvider } from './sidebar/ChatViewProvider';
import { StatusBarController } from './statusBar/StatusBarController';
import { registerAgentDiffProvider } from './dashboard/agentManager/diffProvider';
import { resetPersistentPermissions } from './dashboard/agentManager/persistentPermissions';
import { claudeCliDiagnostics, disposeClaudeCodeSessions, probeClaudeCliInBackground } from './dashboard/claudeCodeManager';
import { CLAUDE_PATH_SETTING } from './claudeCode/discoveryProbes';
import { ensureGlobalSeeds, ensureSubagentToolDefaults } from './dashboard/seedGlobal';
import { activateRemote } from './remote/activate';
import { maybeShowChangelog, previewWhatsNew } from './dashboard/changelogActivate';
import { activateHostEngine } from './dashboard/hostEngineWindow';
import { ensureClaudeSubscriptionConsent, watchClaudeSubscriptionSetting } from './claudeSubscriptionConsent';
import { ensureClaudeSubscriptionBlockCleanup } from './dashboard/firstFold';

let statusBar: StatusBarController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('Origami extension activating...');

  statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);
  DashboardPanel.setStatusBar(statusBar);
  // t-sh7cog: host features read the engine with no chat open. Nothing spawns here;
  // this gives the Nests hub its engine and closes that engine with the window.
  activateHostEngine(context);
  // t-vd9s7z: find Claude Code now, in the background; the engine reads the result from a file. No spawn waits.
  probeClaudeCliInBackground();

  // Agent Manager: readonly LEFT side of a Done card's "apply to main" diff.
  registerAgentDiffProvider(context);

  // Global seed sweep — once per extension VERSION, before any engine child can spawn
  // (the engine scans its skill roots at startup, so a later write would stay
  // invisible until a window reload). Writes ONLY ~/.origami/skills, never a workspace.
  ensureGlobalSeeds({
    version: String((context.extension.packageJSON as { version?: unknown }).version ?? ''),
    marker: {
      get: () => context.globalState.get<string>('origami.seed.version'),
      set: (v) => void context.globalState.update('origami.seed.version', v),
    },
  });

  // t-f3a74m: the one-time pass that puts the owner-approved default tool matrix onto
  // the archetype DEFINITIONS of an install that already has them. Same boot slot and
  // the same reason — the engine reads an agent definition when it spawns, so a later
  // write would stay invisible until a reload. Touches only ~/.config/origami/agent,
  // never origami.json, and never a file the user has edited.
  ensureSubagentToolDefaults({
    marker: {
      get: () => context.globalState.get<string>('origami.seed.subagentTools'),
      set: (v) => void context.globalState.update('origami.seed.subagentTools', v),
    },
  });

  // What's new: once, on a PUBLIC release only (dashboard/publicReleases.ts), one
  // summary of everything since the last version the user saw. Never blocks
  // activation (t-obg1yz, t-v5r1fd).
  maybeShowChangelog(context);

  // t-u0rcmb: one-time clean-up of a stale `claude-subscription` provider block the
  // OLD pick path wrote (a persisted pin the engine's own connection now makes
  // pointless — t-ty02bb). ONCE per install, not every activation — a genuine vision
  // override on a claude-subscription model (writeModelVision's minimal `models`-only
  // block) is the SAME shape this clean-up removes, so running it on every boot would
  // delete a real, current override. Never blocks activation — a corrupt/unreadable/
  // commented config leaves the marker unset and is retried next boot.
  try {
    ensureClaudeSubscriptionBlockCleanup({
      get: () => context.globalState.get<boolean>('origami.cleanup.claudeSubscriptionBlock.v1'),
      set: (v) => void context.globalState.update('origami.cleanup.claudeSubscriptionBlock.v1', v),
    });
  } catch (e) {
    console.warn('[origami] claude-subscription block clean-up skipped:', e instanceof Error ? e.message : e);
  }

  // Claude (subscription, experimental): the setting's one-time disclosure
  // (t-tijdof). Repairs a synced/legacy "already on, never confirmed" state,
  // then watches for a live flip for the rest of this window's life.
  void ensureClaudeSubscriptionConsent(context);
  context.subscriptions.push(watchClaudeSubscriptionSetting(context));

  // Split surfaces: CONFIG (left activity bar) + CHAT (secondary side bar). The crane
  // in the top-right secondary side bar opens the CHAT plus the embedded Settings.
  // The DashboardPanel host (resolveSharedView) bootstraps the ACP session and
  // broadcasts model/connection/theme status to every attached view, including
  // popped-out chat editor tabs, so they always agree.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewId,
      new ChatViewProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Thin error-guard around a command handler: surface failures as a VS Code error
  // toast instead of an unhandled rejection.
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

  context.subscriptions.push(
    vscode.commands.registerCommand('origami.toggleSidebar', () => {
      // Reveal the CHAT view. Focusing the view id is order-independent and works
      // wherever the user has dragged it.
      vscode.commands.executeCommand('origami.chatView.focus');
    }),

    vscode.commands.registerCommand('origami.openChat', () => {
      vscode.commands.executeCommand('origami.chatView.focus');
    }),

    vscode.commands.registerCommand(
      'origami.newSession',
      guarded(async () => {
        await DashboardPanel.addSession(context);
      }),
    ),

    // New Chat (+) in the chat view title bar — reveals the chat view first, then
    // creates the session via the shared host.
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

    // Claude Code passthrough diagnostics: puts every PATH, verdict and failure reason
    // on the clipboard, so a "it did not find my CLI" report from a machine we cannot
    // reach arrives with its own evidence attached.
    vscode.commands.registerCommand('origami.claudeCodeDiagnostics', async () => {
      const text = await claudeCliDiagnostics();
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Origami: Claude Code discovery diagnostics copied to the clipboard.');
    }),

    // t-v5r1fd: the owner sees the pending What's new on a dev build before release.
    vscode.commands.registerCommand('origami.previewWhatsNew', () => previewWhatsNew(context)),

    // The override is the one input to detection a user can change without
    // restarting, so the memo must not outlive it.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CLAUDE_PATH_SETTING)) probeClaudeCliInBackground(true);
    }),

    vscode.commands.registerCommand('origami.openAgentProfile', async () => {
      await DashboardPanel.createOrShow(context);
    }),

    vscode.commands.registerCommand('origami.init', guarded(async () => {
      // "Get started" — reveal the chat and run /firstfold (scaffold the workspace +
      // connect a model). The empty-state hint points new users here too.
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

    // Origami Remote — pair a phone and mirror the session to it. With
    // origamicoder.remote.enabled off this registers two commands and
    // constructs nothing else: no socket, no timer, no secret read.
    ...activateRemote(context),
  );

  console.log(
    'Origami extension activated. The crane chat sidebar is the only surface; focus it with Ctrl+Shift+L.',
  );
}

export function deactivate(): void {
  // Claude Code passthrough children are NOT owned by a panel, so they are killed
  // here: a spawned CLI must never outlive the window.
  disposeClaudeCodeSessions();
}

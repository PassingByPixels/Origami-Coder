// Mirrors `origamicoder.remote.enabled` onto a VS Code context key, so
// package.json can hide origami.remotePair / origami.remoteRevoke from the
// command palette with a `when` clause without unregistering either command.
import * as vscode from 'vscode';

export const REMOTE_ENABLED_CONTEXT = 'origamicoder.remoteEnabled';

/** Push the current value: once at activation, and on every config change. */
export function syncRemoteEnabledContext(enabled: boolean): void {
  void vscode.commands.executeCommand('setContext', REMOTE_ENABLED_CONTEXT, enabled);
}

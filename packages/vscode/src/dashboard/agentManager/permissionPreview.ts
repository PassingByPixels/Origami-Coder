// Side-effect previews for a FORWARDED permission ask: plan_exit's "switch to build agent?"
// opens the plan the agent just wrote; the native `dream` tool's review opens a
// live-vs-candidate memory diff.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Open the markdown/diff preview a forwarded ask should surface, keyed off its title; a
 *  no-op unless the session actually staged the relevant file. */
export function openPermissionPreview(
  session: { lastPlanPath?: string; lastDreamCandidatePath?: string },
  title: string,
): void {
  // plan_exit approval: open the plan the agent just wrote so the user can read it before
  // accept/deny.
  if (session.lastPlanPath && /\bplan\b.*\bbuild agent\b/i.test(title)) {
    const uri = vscode.Uri.file(session.lastPlanPath);
    vscode.commands.executeCommand('markdown.showPreview', uri).then(
      () => {},
      () => vscode.window.showTextDocument(uri, { preview: true }).then(() => {}, () => {}),
    );
  }
  // /dream review: open a real diff of the live memory store vs the staged candidate,
  // double-gated so it only fires when a candidate was actually written.
  if (session.lastDreamCandidatePath && /reorgani[sz]ed memory/i.test(title)) {
    const candidate = session.lastDreamCandidatePath;
    const liveStore = path.join(path.dirname(candidate), 'memory.md');
    // Candidate is staged before the question, so it exists; the live store may not
    // (a first-ever dream). Diff when both exist, else preview the candidate alone.
    if (fs.existsSync(candidate) && fs.existsSync(liveStore)) {
      vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(liveStore),
        vscode.Uri.file(candidate),
        'Dream: memory changes',
      ).then(() => {}, () => {});
    } else if (fs.existsSync(candidate)) {
      const uri = vscode.Uri.file(candidate);
      vscode.commands.executeCommand('markdown.showPreview', uri).then(
        () => {},
        () => vscode.window.showTextDocument(uri, { preview: true }).then(() => {}, () => {}),
      );
    }
  }
}

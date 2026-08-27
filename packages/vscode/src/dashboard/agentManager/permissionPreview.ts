// Agent Manager - permissionPreview.ts (S7.1, 2026-07-22): the side-effect previews
// that ride a FORWARDED permission ask, EXTRACTED VERBATIM from DashboardPanel's
// onPermissionRequest so that file stays at its line cap while the S7.1 question
// routing lands beside it. plan_exit's "switch to build agent?" opens the plan the
// agent just wrote; the native `dream` tool's review opens a live-vs-candidate
// memory diff. Behaviour-preserving: same guards, same commands, same fallbacks.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Open the markdown/diff preview a forwarded permission ask should surface, keyed
 *  off its title. No-op unless the session actually staged the relevant file (the
 *  plan path / dream candidate were remembered on the prior tool-call update). */
export function openPermissionPreview(
  session: { lastPlanPath?: string; lastDreamCandidatePath?: string },
  title: string,
): void {
  // plan_exit approval — open the plan the agent just wrote in a markdown preview so
  // the user can read it before accept/deny. The question rides requestPermission
  // (acp/question.ts); its title is the plan_exit prompt.
  if (session.lastPlanPath && /\bplan\b.*\bbuild agent\b/i.test(title)) {
    const uri = vscode.Uri.file(session.lastPlanPath);
    vscode.commands.executeCommand('markdown.showPreview', uri).then(
      () => {},
      () => vscode.window.showTextDocument(uri, { preview: true }).then(() => {}, () => {}),
    );
  }
  // /dream review — the native `dream` tool asks Approve/Revise/Disapprove after the
  // candidate was staged. Open a real diff of the LIVE store (memory.md, same dir) vs
  // the candidate. Double-gated: only fires when a candidate was actually written.
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

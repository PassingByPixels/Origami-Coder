// Agent Manager - diffProvider.ts (S4): the read-only LEFT side of a Done card's
// native VS Code diff. `vscode.diff(left, right, title)` needs a document for the
// base content; the worktree's working file is the right (a real file: URI), and
// this provider serves `git -C <worktree> show <base>:<path>` as the left under a
// synthetic readonly scheme. A file absent at the base (an added file) shows as
// empty, so the diff reads as an all-add. Uri args ride in the query (JSON,
// encodeURIComponent) so one provider serves every worktree/base/path triple.

import * as vscode from 'vscode';
import { runGit } from './worktrees';

export const AGENT_BASE_SCHEME = 'origami-agent-base';

/** Encode a worktree/base/path triple into an origami-agent-base: URI. The path
 *  portion is only the tab label; the query carries the real args. */
export function makeBaseUri(worktree: string, base: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: AGENT_BASE_SCHEME,
    path: relPath.startsWith('/') ? relPath : `/${relPath}`,
    query: encodeURIComponent(JSON.stringify({ worktree, base, path: relPath })),
  });
}

export function registerAgentDiffProvider(context: vscode.ExtensionContext): void {
  const provider: vscode.TextDocumentContentProvider = {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      try {
        const { worktree, base, path: relPath } = JSON.parse(decodeURIComponent(uri.query)) as { worktree: string; base: string; path: string };
        const r = await runGit(['show', `${base}:${relPath}`], worktree);
        return r.ok ? r.output : ''; // absent at base (added file) -> empty left side
      } catch {
        return '';
      }
    },
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(AGENT_BASE_SCHEME, provider));
}

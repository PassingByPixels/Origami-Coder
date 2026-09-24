// changelogPanel.ts — the CHANGELOG.md popup (t-obg1yz). A themed webview, not a bare
// vscode.window.showInformationMessage: it links the CHAT bundle's theme sidecar CSS
// (out/webview/chat.css) so the --og-* tokens the user's chosen theme defines are the
// ones the popup renders with, matching Part 7 of WORKING_ON_ORIGAMI_CODER.md (no
// invented tokens, no unthemed native dialog).
//
// Markdown -> HTML uses `marked` (already a runtime dependency for chat message
// rendering), so this stays a small renderer rather than a hand-rolled parser.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { marked } from 'marked';
import { expandWhatsNewTokens } from './whatsNewInline';

let activePanel: vscode.WebviewPanel | undefined;

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/** Where the curated notes live (diagrams/ and shots/ beside them), and whether this
 *  is the owner's preview (placeholders for missing screenshots) or the real pop-up. */
export interface WhatsNewPanelOptions {
  notesDir: string;
  preview: boolean;
}

/**
 * Show (or reveal) the What's new popup, rendering `markdown` as the body. One panel
 * at a time — a second call while it is open reveals the existing one rather than
 * stacking duplicates.
 */
export function openChangelogPanel(
  context: vscode.ExtensionContext,
  markdown: string,
  opts: WhatsNewPanelOptions,
): void {
  if (activePanel) {
    activePanel.reveal();
    return;
  }
  const notesUri = vscode.Uri.file(opts.notesDir);
  const panel = vscode.window.createWebviewPanel(
    'origami.changelogPanel',
    "Origami Code — What's new",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview'), notesUri],
    },
  );
  activePanel = panel;
  panel.onDidDispose(() => {
    if (activePanel === panel) activePanel = undefined;
  });
  panel.webview.onDidReceiveMessage((m: { type?: unknown }) => {
    if (m && m.type === 'close') panel.dispose();
  });
  // The user's in-panel Origami theme, same key DashboardPanel reads; never a fixed palette.
  const theme = context.globalState?.get<string>('origami.theme') ?? 'meadow';
  const body = expandWhatsNewTokens(markdown, {
    preview: opts.preview,
    diagram: (name) => readIfExists(path.join(opts.notesDir, 'diagrams', `${name}.svg`)),
    shot: (name) => {
      const file = path.join(opts.notesDir, 'shots', `${name}.png`);
      return fs.existsSync(file) ? panel.webview.asWebviewUri(vscode.Uri.file(file)).toString() : undefined;
    },
  });
  panel.webview.html = renderHtml(context, panel.webview, body, theme);
}

function readIfExists(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

function renderHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  markdown: string,
  theme: string,
): string {
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'chat.css'),
  );
  const nonce = getNonce();
  const bodyHtml = marked.parse(markdown, { gfm: true }) as string;

  return /* html */ `<!DOCTYPE html>
<html lang="en" data-theme="${escapeHtml(theme)}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src 'unsafe-inline' ${webview.cspSource};
             img-src ${webview.cspSource};
             script-src 'nonce-${nonce}' ${webview.cspSource};
             font-src ${webview.cspSource};" />
  <title>What's new</title>
  <link rel="stylesheet" href="${cssUri}" />
  <style>
    /* chat.css pins the chat webview's html/body to the viewport with
       overflow hidden (the pane scrolls its own list). This page is a plain
       document, so it must scroll as one; owner saw it cut off on 0.4.154. */
    html, body {
      height: auto;
      min-height: 100%;
      overflow-y: auto;
    }
    body {
      background: var(--og-bg);
      color: var(--og-text);
      font-family: var(--vscode-font-family);
      padding: 0;
      margin: 0;
    }
    .changelog-wrap {
      /* t-v5r1fd: wide enough that a 640-unit diagram keeps its 12px text readable. */
      max-width: 720px;
      margin: 0 auto;
      padding: 24px 28px 32px;
    }
    .changelog-header {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      margin-bottom: 4px;
    }
    .changelog-close {
      background: var(--og-surface);
      color: var(--og-text);
      border: 1px solid var(--og-border);
      border-radius: 6px;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .changelog-close:hover { background: var(--og-accent); color: var(--og-bg); }
    .changelog-body { font-size: 13px; line-height: 1.5; }
    .changelog-body h2 {
      font-size: 18px;
      font-weight: 600;
      color: var(--og-text);
      margin: 0 0 12px;
    }
    .changelog-body h3 {
      font-size: 14px;
      font-weight: 600;
      color: var(--og-text);
      margin: 20px 0 8px;
      padding-top: 12px;
      border-top: 1px solid var(--og-border);
    }
    .changelog-body h3:first-of-type { padding-top: 0; border-top: none; }
    .changelog-body a { color: var(--og-accent-2); }
    .changelog-body ul { margin: 0 0 8px; padding-left: 22px; }
    .changelog-body li { margin: 4px 0; }
    .changelog-body code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }
    /* t-v5r1fd: diagrams (whats-new/diagrams/*.svg, inlined) and screenshots. The
       SVGs carry classes only; every colour comes from the theme tokens below. */
    .wn-fig, .wn-shot { margin: 14px 0 18px; }
    .wn-fig {
      padding: 12px;
      border: 1px solid var(--og-border);
      border-radius: 8px;
      background: var(--og-surface-alt);
    }
    .wn-fig svg { display: block; width: 100%; height: auto; }
    .wn-fig figcaption, .wn-shot figcaption {
      margin-top: 8px;
      font-size: 12px;
      color: var(--og-text-secondary);
    }
    .wn-shot img { display: block; max-width: 100%; border: 1px solid var(--og-border); border-radius: 6px; }
    .wn-shot-slot {
      padding: 28px 16px;
      border: 2px dashed var(--og-warning);
      border-radius: 6px;
      background: var(--og-warning-soft);
      color: var(--og-warning-text);
      font-size: 12px;
      text-align: center;
    }
    .wn-fig svg text { fill: var(--og-text); font-family: var(--vscode-font-family); font-size: 12px; }
    .wn-fig svg .t-muted { fill: var(--og-text-secondary); }
    .wn-fig svg .t-small { font-size: 10.5px; }
    .wn-fig svg .t-title { font-weight: 600; }
    .wn-fig svg .t-on { fill: var(--og-bg); font-weight: 600; }
    .wn-fig svg .box { fill: var(--og-surface); stroke: var(--og-border); stroke-width: 1.2; }
    .wn-fig svg .box-hi { fill: var(--og-surface); stroke: var(--og-chat); stroke-width: 1.8; }
    .wn-fig svg .box-dim { fill: var(--og-surface-alt); stroke: var(--og-border); stroke-width: 1.2; stroke-dasharray: 4 3; }
    .wn-fig svg .fill-chat { fill: var(--og-chat); }
    .wn-fig svg .pill-warn { fill: var(--og-surface-alt); stroke: var(--og-warning); stroke-width: 1.6; }
    .wn-fig svg .t-warn { fill: var(--og-warning-text); font-weight: 600; }
    .wn-fig svg .fill-ok { fill: var(--og-success); }
    .wn-fig svg .fill-muted { fill: var(--og-text-muted); }
    .wn-fig svg .line { fill: none; stroke: var(--og-text-muted); stroke-width: 1.4; }
    .wn-fig svg .line-hi { fill: none; stroke: var(--og-chat); stroke-width: 1.8; }
    .wn-fig svg .dash { stroke-dasharray: 4 4; }
    .wn-fig svg .head { fill: var(--og-text-muted); }
    .wn-fig svg .head-hi { fill: var(--og-chat); }
  </style>
</head>
<body>
  <div class="changelog-wrap">
    <div class="changelog-header">
      <button class="changelog-close" id="closeBtn">Close</button>
    </div>
    <article class="changelog-body">
      ${bodyHtml}
    </article>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('closeBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'close' });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

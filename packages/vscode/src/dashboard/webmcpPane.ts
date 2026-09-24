// Web MCP pane — host side, a sibling leaf to mcpPane.ts in the same shape (a MESSAGE_TYPES set
// plus one handler) so the two panes share a view, not a code path.
// Why this one skips the engine: mcpPane.ts routes through the session because the engine owns MCP
// config/clients/OAuth; a WebMCP site is just a curated address in a plain JSON file, and requiring
// a live session to write down a bookmark would be ceremony with nothing behind it.
// The three write operations live in webmcpWrites.ts (moved there when this file went over its
// cap); every write ends by re-reading and re-posting the list, so the pane never renders a state
// the file doesn't hold.

import * as vscode from 'vscode';
import { normalizeSiteUrl } from './webmcpFile';
import { add, edit, listPayload, remove, type WebMcpPaneHost } from './webmcpWrites';

export const WEBMCP_PANE_MESSAGE_TYPES = new Set([
  'webmcpRequest',
  'webmcpAdd',
  'webmcpEdit',
  'webmcpRemove',
  'webmcpOpen',
]);

export type { WebMcpPaneHost };

export function handleWebMcpPaneMessage(host: WebMcpPaneHost, m: { type?: string; [k: string]: unknown }): void {
  switch (m.type) {
    case 'webmcpRequest':
      host.post(listPayload());
      return;
    case 'webmcpAdd':
      add(host, m);
      return;
    case 'webmcpEdit':
      edit(host, m);
      return;
    case 'webmcpRemove':
      remove(host, m);
      return;
    case 'webmcpOpen': {
      // User-initiated only — joining a WebMCP server IS opening its page. Normalised again here
      // since this hands a URL to the OS.
      const url = normalizeSiteUrl(typeof m['url'] === 'string' ? m['url'] : '');
      if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
  }
}

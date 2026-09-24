// Web MCP registry WRITES — the three operations that change the file, split out of webmcpPane.ts
// when the Edit branch took it over its cap.
// Routing vs writing: webmcpPane.ts owns dispatch and the one action that touches no file;
// everything that reads-modifies-writes webmcp.json lives here, including `listPayload` (every
// write ends by re-reading and re-posting). Merge rule is webmcpFile.ts's.

import * as vscode from 'vscode';
import { dropSite, listSites, normalizeSiteUrl, updateWebMcpFile, upsertSite, webmcpFilePath } from './webmcpFile';

export interface WebMcpPaneHost {
  post(message: Record<string, unknown>): void;
}

/** The list as the pane renders it, plus where it came from — the path is shown
 *  so a user who wants to hand-edit the file knows which one to open. */
export function listPayload(): Record<string, unknown> {
  return { type: 'webmcpData', sites: listSites(), file: webmcpFilePath() };
}

export function add(host: WebMcpPaneHost, m: Record<string, unknown>): void {
  const raw = typeof m['url'] === 'string' ? m['url'] : '';
  const url = normalizeSiteUrl(raw);
  // The address is the one field that can make an unusable row — a bad name or purpose can be fixed
  // later, but a row whose Open button can't open anything looks registered but isn't.
  if (!url) {
    vscode.window.showErrorMessage(
      `"${raw.trim() || '(empty)'}" is not a web address. A WebMCP site is a page you open, so it needs an http:// or https:// URL.`,
    );
    return;
  }
  if (listSites().some((site) => site.url === url)) {
    vscode.window.showErrorMessage(`${url} is already registered.`);
    return;
  }
  const name = typeof m['name'] === 'string' ? m['name'].trim() : '';
  const purpose = typeof m['purpose'] === 'string' ? m['purpose'].trim() : '';
  // Through `upsertSite`, not a bespoke push: the duplicate case above is already refused, so this
  // only ever creates, but the shared helper keeps every other entry and unknown key intact.
  const failure = updateWebMcpFile((doc) =>
    upsertSite(doc, url, { name: name || new URL(url).host, purpose, addedAt: Date.now() }),
  );
  if (failure) vscode.window.showErrorMessage(failure);
  host.post(listPayload());
}

/**
 * Rewrite ONE site's name and purpose. `purpose` is the line the MODEL reads
 * (`webmcp_list` prints it per row), so this box is the user's words
 * reaching the agent deciding whether to open the site. `notes` is
 * deliberately not touched — that's the engine's own advisory memory from
 * `webmcp_note`. The address isn't editable: changing it would name a
 * different site (Add + Remove).
 */
export function edit(host: WebMcpPaneHost, m: Record<string, unknown>): void {
  const raw = typeof m['url'] === 'string' ? m['url'] : '';
  const url = normalizeSiteUrl(raw);
  // `upsertSite` CREATES an entry it can't find, which is wrong here: the engine writes this file
  // too, so between clicking Edit and Save the row may be gone — an edit must never resurrect it.
  if (!url || !listSites().some((site) => site.url === url)) {
    vscode.window.showErrorMessage(
      `No Web MCP site is registered at "${raw.trim() || '(empty)'}" — it may have been removed. Refresh the list.`,
    );
    host.post(listPayload());
    return;
  }
  const name = typeof m['name'] === 'string' ? m['name'].trim() : '';
  const purpose = typeof m['purpose'] === 'string' ? m['purpose'].trim() : '';
  // Only the two fields named: `addedAt`, `notes`, `lastLaunched` and every
  // unknown key ride through untouched, per the merge rule webmcpFile.ts holds.
  const failure = updateWebMcpFile((doc) => upsertSite(doc, url, { name: name || new URL(url).host, purpose }));
  if (failure) vscode.window.showErrorMessage(failure);
  host.post(listPayload());
}

export function remove(host: WebMcpPaneHost, m: Record<string, unknown>): void {
  const url = normalizeSiteUrl(typeof m['url'] === 'string' ? m['url'] : '');
  if (url) {
    const failure = updateWebMcpFile((doc) => dropSite(doc, url));
    if (failure) vscode.window.showErrorMessage(failure);
  }
  host.post(listPayload());
}

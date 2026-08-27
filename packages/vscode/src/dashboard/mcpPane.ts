// MCP pane — host side. Routed out of DashboardPanel.ts the same way
// tools/skills/plugins are, so the monolith carries only the one-line dispatch.
//
// Every job goes through the active session's generic `extMethod`, the same
// seam pluginsPane.ts uses, because the ENGINE owns the config files, the
// merge with plugin-provided servers, every live client and the OAuth flow:
// read the list (`mcp_list`), add (`mcp_add`), remove (`mcp_remove`), toggle
// (`mcp_set_enabled`), connect/disconnect, authenticate (`mcp_authenticate`)
// and forget a credential (`mcp_auth_remove`).
//
// Every write re-reads and re-posts the list afterward, success or failure, so
// the pane never renders a state the engine does not itself believe — the same
// shape pluginsPane.ts and toolsPane.ts already use. No optimistic patching
// here (unlike pluginsPane's enabled flag): `mcp_set_enabled` writes the config
// AND drives the live client, and `mcp_list` reads `MCP.status()`, which is the
// runtime map — so the re-read already carries the post-write truth.
//
// What an `mcpAdd` MEANS — the argv split, the optional cwd/environment/headers
// — lives in mcpAddServer.ts: it grew past what this file had room for, and it
// is the one part of the MCP surface worth checking with no host around it.

import * as vscode from 'vscode';
import type { McpListResult, McpWriteResult } from '../acpExtTypes';
import { serverFrom } from './mcpAddServer';

export const MCP_PANE_MESSAGE_TYPES = new Set([
  'mcpRequest',
  'mcpAdd',
  'mcpRemove',
  'mcpSetEnabled',
  'mcpConnect',
  'mcpDisconnect',
  'mcpAuthenticate',
  'mcpAuthRemove',
  'mcpOpenAuthUrl',
]);

export interface McpPaneClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface McpPaneHost {
  /** The active chat's engine connection, if any. MCP state is an engine read, so with no session there is no answer. */
  client?: McpPaneClient;
  post(message: Record<string, unknown>): void;
}

const NO_SESSION = 'Open a chat first — the MCP server list is read from a live engine connection.';

async function listPayload(host: McpPaneHost): Promise<Record<string, unknown>> {
  if (!host.client) return { type: 'mcpData', servers: [], error: NO_SESSION };
  try {
    const result = (await host.client.extMethod('mcp_list', {})) as unknown as McpListResult;
    return { type: 'mcpData', servers: result?.servers ?? [] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { type: 'mcpData', servers: [], error: `Could not read the MCP server list: ${message}` };
  }
}

/**
 * Run one write and report it. The engine's own message is shown VERBATIM on
 * failure — it names the config file, the schema issue or the server, and a
 * rewrite here would drop exactly the part the user needs.
 */
async function write(
  host: McpPaneHost,
  method: string,
  params: Record<string, unknown>,
  onOk: (result: Extract<McpWriteResult, { ok: true }>) => string | undefined,
): Promise<void> {
  if (!host.client) {
    vscode.window.showErrorMessage(NO_SESSION);
    return;
  }
  try {
    const result = (await host.client.extMethod(method, params)) as unknown as McpWriteResult;
    if (result?.ok) {
      const note = onOk(result);
      if (note) vscode.window.showInformationMessage(note);
    } else {
      vscode.window.showErrorMessage(result?.message ?? `${method} failed`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
  }
  host.post(await listPayload(host));
}

async function add(host: McpPaneHost, m: Record<string, unknown>): Promise<void> {
  const name = typeof m['name'] === 'string' ? m['name'].trim() : '';
  if (!name) {
    vscode.window.showErrorMessage('A server name is required.');
    return;
  }
  const server = serverFrom(m);
  if (typeof server === 'string') {
    vscode.window.showErrorMessage(server);
    return;
  }
  const scope = m['scope'] === 'global' ? 'global' : 'project';
  await write(host, 'mcp_add', { name, server, scope }, (result) =>
    `Added "${name}"${result.path ? ` to ${result.path}` : ''}.`);
}

function nameOf(m: Record<string, unknown>): string {
  return typeof m['name'] === 'string' ? m['name'].trim() : '';
}

export async function handleMcpPaneMessage(
  host: McpPaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type === 'mcpRequest') {
    host.post(await listPayload(host));
    return;
  }
  if (m.type === 'mcpAdd') {
    await add(host, m);
    return;
  }
  if (m.type === 'mcpOpenAuthUrl') {
    // User-initiated only. The ENGINE already opens the browser itself when a
    // sign-in starts (McpBrowser), so opening it here unasked would give two
    // windows; this is the "it did not open" fallback the pane offers.
    const url = typeof m['url'] === 'string' ? m['url'] : '';
    if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }

  const name = nameOf(m);
  // A blank name is dropped rather than sent: the engine would reject it, but
  // a rejection toast for a button the user never meaningfully pressed is noise.
  if (!name) return;

  switch (m.type) {
    case 'mcpRemove':
      await write(host, 'mcp_remove', { name }, () => `Removed "${name}".`);
      return;
    case 'mcpSetEnabled': {
      const enabled = m['enabled'] === true;
      await write(host, 'mcp_set_enabled', { name, enabled }, () => `${enabled ? 'Enabled' : 'Disabled'} "${name}".`);
      return;
    }
    case 'mcpConnect':
      await write(host, 'mcp_connect', { name }, () => undefined);
      return;
    case 'mcpDisconnect':
      await write(host, 'mcp_disconnect', { name }, () => undefined);
      return;
    case 'mcpAuthenticate':
      // Blocks until the sign-in finishes or fails. The engine pushes the
      // authorization URL out as an `origami/mcpAuthUrl` notification first,
      // which DashboardPanel forwards to the pane as `mcpAuthUrl`.
      await write(host, 'mcp_authenticate', { name }, () => `Signed in to "${name}".`);
      return;
    case 'mcpAuthRemove':
      await write(host, 'mcp_auth_remove', { name }, () => `Removed the stored credential for "${name}".`);
      return;
  }
}

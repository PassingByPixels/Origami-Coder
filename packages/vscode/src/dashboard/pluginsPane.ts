// Plugins pane — host side (t-kgtolm round 3: the management UI the loader/
// config/parser work deferred). Routed out of DashboardPanel.ts the same way
// tools/skills are, so the monolith carries only the one-line dispatch.
//
// Three jobs, all through the active session's generic `extMethod` — same
// seam `listSkills` uses inline in DashboardPanel.ts, because the ENGINE, not
// this process, owns the loader state, the config file resolution and the
// manifest parser "add from folder" validates against: read the plugin list
// (`list_agent_plugins`), flip one plugin's enabled state
// (`agent_plugin_set_enabled`), and validate + append a new folder
// (`agent_plugin_add`). Every write re-reads and re-posts the list afterward,
// success or failure, so the pane never goes stale — same shape
// `toolsPane.ts`'s `setDefer` uses.

import * as vscode from 'vscode';
import type {
  AgentPluginsResult,
  AgentPluginSetEnabledResult,
  AgentPluginWriteResult,
} from '../acpExtTypes';

export const PLUGINS_PANE_MESSAGE_TYPES = new Set(['pluginsRequest', 'pluginsSetEnabled', 'pluginsAddFolder']);

export interface PluginsPaneClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface PluginsPaneHost {
  /** The active chat's engine connection, if any. Plugin data is an engine read, so with no session there is no answer. */
  client?: PluginsPaneClient;
  post(message: Record<string, unknown>): void;
}

async function listPayload(host: PluginsPaneHost): Promise<Record<string, unknown>> {
  if (!host.client) {
    return {
      type: 'pluginsData',
      plugins: [],
      problems: [],
      error: 'Open a chat first — the plugin list is read from a live engine connection.',
    };
  }
  try {
    const result = (await host.client.extMethod('list_agent_plugins', {})) as unknown as AgentPluginsResult;
    return { type: 'pluginsData', plugins: result?.plugins ?? [], problems: result?.problems ?? [] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { type: 'pluginsData', plugins: [], problems: [], error: `Could not read the plugin list: ${message}` };
  }
}

async function setEnabled(host: PluginsPaneHost, spec: unknown, enabled: unknown): Promise<void> {
  if (typeof spec !== 'string' || !spec) return;
  const on = enabled === true;
  let wrote = false;
  if (host.client) {
    try {
      const result = (await host.client.extMethod('agent_plugin_set_enabled', { spec, enabled: on })) as unknown as AgentPluginSetEnabledResult;
      if (result.ok) {
        wrote = true;
        vscode.window.showInformationMessage(`${on ? 'Enabled' : 'Disabled'} "${spec}" — restart the session to apply it.`);
      } else {
        vscode.window.showErrorMessage(result.message);
      }
    } catch (e) {
      vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  }
  // agent_plugin_set_enabled writes the config file, but the ENGINE's own
  // AgentPlugins loader answers from a per-instance cache with no file
  // watcher (same shape as the Tools pane's tool_search config) — the
  // immediate re-read below still reflects the PRE-write state, so a
  // confirmed write is patched onto it here, or the switch would silently
  // look like it did nothing. A failed write patches nothing (the re-read
  // already carries the untouched, correct state).
  const payload = await listPayload(host);
  if (wrote && Array.isArray(payload['plugins'])) {
    payload['plugins'] = (payload['plugins'] as Array<Record<string, unknown>>).map((p) =>
      p['spec'] === spec ? { ...p, enabled: on } : p);
  }
  host.post(payload);
}

async function addFolder(host: PluginsPaneHost, dir: unknown): Promise<void> {
  const trimmed = typeof dir === 'string' ? dir.trim() : '';
  if (!trimmed) return;
  if (!host.client) {
    vscode.window.showErrorMessage('Open a chat first — adding a plugin validates it through the live engine connection.');
    return;
  }
  try {
    const result = (await host.client.extMethod('agent_plugin_add', { dir: trimmed })) as unknown as AgentPluginWriteResult;
    if (result.ok) {
      vscode.window.showInformationMessage(`Added "${result.name}" — restart the session to load it.`);
    } else {
      // The manifest parser's own message, verbatim — never rewritten here.
      vscode.window.showErrorMessage(result.message);
    }
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
  }
  host.post(await listPayload(host));
}

export async function handlePluginsPaneMessage(
  host: PluginsPaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  switch (m.type) {
    case 'pluginsRequest':
      host.post(await listPayload(host));
      return;
    case 'pluginsSetEnabled':
      await setEnabled(host, m.spec, m.enabled);
      return;
    case 'pluginsAddFolder':
      await addFolder(host, m.dir);
      return;
  }
}

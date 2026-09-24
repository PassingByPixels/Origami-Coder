// Tools pane — host side, routed out of DashboardPanel.ts so the panel carries the dispatch line
// and nothing else.
// Seven jobs: read the catalog, flip code mode, seed a scaffolded tool file, set one tool's state
// (Loaded/Deferred/Off) globally, route the per-agent writes to subagentToolWrites.ts, copy its
// path, open/delete a failed file. Every write resolves its target fresh rather than trusting the webview — never off whatever
// the message echoed back.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { CODE_MODE_SETTING } from '../engineEnv';
import { TOOL_DIR, toolFileName, toolTemplate } from './toolScaffold';
import { writeToolState, patchToolStatePayload } from './toolDeferConfig';
import { parseToolState, toolStateNotice } from './toolStateMessage';
import { catalogPayload, findEntry, postCatalog } from './toolsCatalog';
import type { ToolsPaneHost } from './toolsCatalog';
import { TOOL_PROBLEM_MESSAGE_TYPES, handleToolProblemMessage } from './toolProblemActions';
import { SUBAGENT_TOOL_MESSAGE_TYPES, handleSubagentToolMessage } from './subagentToolWrites';

export type { ToolsPaneClient, ToolsPaneHost } from './toolsCatalog';

export const TOOLS_PANE_MESSAGE_TYPES = new Set([
  'toolsRequest',
  'toolsSetCodeMode',
  'toolsScaffold',
  'toolsSetState',
  ...SUBAGENT_TOOL_MESSAGE_TYPES,
  'toolsCopyPath',
  ...TOOL_PROBLEM_MESSAGE_TYPES,
]);

async function scaffold(host: ToolsPaneHost, raw: unknown): Promise<void> {
  const name = toolFileName(raw);
  if (!name) {
    vscode.window.showErrorMessage('A tool name must start with a letter and use only letters, digits and underscores.');
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showErrorMessage('Open a folder first — a workspace tool is written into that folder.');
    return;
  }
  const uri = vscode.Uri.file(path.join(root, ...TOOL_DIR, `${name}.ts`));
  try {
    // Never clobber: an existing tool of that name is opened, not overwritten.
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(root, ...TOOL_DIR)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(toolTemplate(name), 'utf8'));
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  // Honest create: scaffold, open, and copy the path is the whole feature — the file the agent
  // edits next is the entire mechanism.
  await vscode.env.clipboard.writeText(uri.fsPath);
  vscode.window.showInformationMessage(`Created ${name}.ts and copied its path — hand it to an agent, or edit it yourself.`);
  postCatalog(host, await catalogPayload(host));
}

async function setState(host: ToolsPaneHost, id: unknown, raw: unknown): Promise<void> {
  if (typeof id !== 'string' || !id) return;
  const state = parseToolState(raw);
  if (!state) return; // a state the webview invented is never written
  const entry = await findEntry(host, id);
  if (entry?.hardRequired) {
    vscode.window.showErrorMessage(`${id} has no state to set — the engine always registers it.`);
    postCatalog(host, await catalogPayload(host));
    return;
  }
  try {
    writeToolState(id, state);
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    postCatalog(host, await catalogPayload(host));
    return;
  }
  vscode.window.showInformationMessage(toolStateNotice(id, state));
  postCatalog(host, patchToolStatePayload(await catalogPayload(host), id, state)); // still ENGINE-cached otherwise
}

async function copyPath(host: ToolsPaneHost, id: unknown): Promise<void> {
  if (typeof id !== 'string' || !id) return;
  const entry = await findEntry(host, id);
  if (!entry?.location) return;
  await vscode.env.clipboard.writeText(entry.location);
  vscode.window.showInformationMessage(`Copied ${entry.location}`);
}

export async function handleToolsPaneMessage(host: ToolsPaneHost, m: { type?: string; [k: string]: unknown }): Promise<void> {
  switch (m.type) {
    case 'toolsRequest':
      postCatalog(host, await catalogPayload(host));
      return;
    case 'toolsSetCodeMode': {
      // Global, not workspace: this is a "how I want the agent to work" choice. The engine reads
      // the flag once at spawn, so nothing changes until reload.
      await vscode.workspace.getConfiguration('origami').update(CODE_MODE_SETTING, m.on === true, vscode.ConfigurationTarget.Global);
      postCatalog(host, await catalogPayload(host));
      vscode.window.showInformationMessage(
        `Code mode ${m.on === true ? 'on' : 'off'} — reload the window to start the engine with the new setting.`,
      );
      return;
    }
    case 'toolsScaffold':
      await scaffold(host, m.name);
      return;
    case 'toolsSetState':
      await setState(host, m.id, m.state);
      return;
    case 'toolsSetSubagentState':
    case 'toolsSetSubagentColumn':
    case 'toolsSetSubagentRow':
    case 'toolsResetSubagentDefaults':
      // One cell, a whole column, one tool across every agent, or the reset that
      // takes any of them back off again — all in subagentToolWrites.ts, which
      // owns the per-agent block in origami.json.
      await handleSubagentToolMessage(host, m);
      return;
    case 'toolsCopyPath':
      await copyPath(host, m.id);
      return;
    case 'toolsOpenProblem':
    case 'toolsDeleteProblem':
      // The one pair that takes a PATH, because a file that produced no tool
      // has no id to take instead — re-validated there, never trusted here.
      await handleToolProblemMessage(host, m.type, m.file);
      return;
  }
}

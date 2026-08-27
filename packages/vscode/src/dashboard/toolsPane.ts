// Tools pane — host side. Routed out of DashboardPanel.ts the same way the
// collab and chat-section messages are, so the monolith carries the dispatch
// line and nothing else.
//
// Six jobs, one screen's worth of state: read the engine's tool catalog, flip
// code mode, seed a user-defined tool file (toolScaffold.ts), set one tool's
// state — Loaded / Deferred / Off (toolDeferConfig.ts) — copy its path, and
// open or delete a tool file that FAILED to load (toolProblemActions.ts).
//
// Both WRITES resolve their target fresh rather than trusting the webview:
// scaffold names a TOOL, never a path; the state control and copy-path both
// re-fetch the catalog and read `hardRequired`/`location` off THAT, never off
// whatever the message echoed back; the state VALUE is validated by
// toolStateMessage.ts, and an unrecognised one is dropped rather than written.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { CODE_MODE_SETTING } from '../engineEnv';
import { TOOL_DIR, toolFileName, toolTemplate } from './toolScaffold';
import { writeToolState, patchToolStatePayload } from './toolDeferConfig';
import { parseToolState, toolStateNotice } from './toolStateMessage';
import { catalogPayload, findEntry } from './toolsCatalog';
import type { ToolsPaneHost } from './toolsCatalog';
import { TOOL_PROBLEM_MESSAGE_TYPES, handleToolProblemMessage } from './toolProblemActions';

export type { ToolsPaneClient, ToolsPaneHost } from './toolsCatalog';

export const TOOLS_PANE_MESSAGE_TYPES = new Set([
  'toolsRequest',
  'toolsSetCodeMode',
  'toolsScaffold',
  'toolsSetState',
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
  // Honest create (t-kgtaac round 3): this IS the whole feature — scaffold,
  // open, and copy the path, so the natural next move is pasting it to an
  // agent. No form, no builder; the file the agent (or the user) edits next
  // is the entire mechanism.
  await vscode.env.clipboard.writeText(uri.fsPath);
  vscode.window.showInformationMessage(`Created ${name}.ts and copied its path — hand it to an agent, or edit it yourself.`);
  host.post(await catalogPayload(host));
}

async function setState(host: ToolsPaneHost, id: unknown, raw: unknown): Promise<void> {
  if (typeof id !== 'string' || !id) return;
  const state = parseToolState(raw);
  if (!state) return; // a state the webview invented is never written
  const entry = await findEntry(host, id);
  if (entry?.hardRequired) {
    vscode.window.showErrorMessage(`${id} has no state to set — the engine always registers it.`);
    host.post(await catalogPayload(host));
    return;
  }
  try {
    writeToolState(id, state);
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    host.post(await catalogPayload(host));
    return;
  }
  vscode.window.showInformationMessage(toolStateNotice(id, state));
  host.post(patchToolStatePayload(await catalogPayload(host), id, state)); // still ENGINE-cached otherwise
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
      host.post(await catalogPayload(host));
      return;
    case 'toolsSetCodeMode': {
      // Global, not workspace: this is a "how I want the agent to work" choice,
      // not a property of one repo. The engine reads the flag once at spawn, so
      // say plainly that nothing changes until the window reloads.
      await vscode.workspace.getConfiguration('origami').update(CODE_MODE_SETTING, m.on === true, vscode.ConfigurationTarget.Global);
      host.post(await catalogPayload(host));
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

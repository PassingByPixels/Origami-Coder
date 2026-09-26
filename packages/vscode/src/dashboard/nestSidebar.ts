// nestSidebar.ts — t-s9k0q6 (Nests L4c), host side of the sidebar's flat
// Nest view; wired to the engine and the desks in t-sc093o (nestHub.ts).
//
// THE WIRE:
//   webview -> host  requestNestIndex            (a read, the house prefix)
//   host -> webview  origami/nestIndex { rows, desks }
//   webview -> host  nestContinue { id }
//   host -> webview  nestContinueResult { id, result: 'taken'|'forked', newId } | { id, error }
//   webview -> host  nestOpenRead { id }         (a plain click on a Nest row)
//   host -> webview  nestOpenReadResult { id } | { id, error }
//
// The source is the hub: its rows are the other desks' chats (this desk's own
// are dropped), Continue pulls the body and calls nest_continue, and a read
// pulls the body and opens the chat. Everything is inert while
// `origamicoder.nests.enabled` is off (default FALSE): the push carries no
// desks, so the sidebar's Here | Nest control cannot show.
import * as vscode from 'vscode';
import type { NestEngine } from './nestHub';
import { hubNestSource, nestHub } from './nestHubWindow';

export const NEST_SIDEBAR_MESSAGE_TYPES = new Set(['requestNestIndex', 'nestContinue', 'nestOpenRead']);

export interface NestSidebarHost {
  post(message: Record<string, unknown>): void;
  /** The panel's engine client and its chat opener (recallSession). Absent in a unit test. */
  engine?: () => NestEngine | undefined;
  open?: (sessionId: string) => void | Promise<void>;
  /** t-xsrtml: the panel's own open-chat engine session ids (incl. parked). */
  openSessionIds?: () => string[];
}

/** Where the index and Continue come from. `selfId` = this desk's device id:
 *  its own rows are dropped here, so the sidebar never shows them in the Nest. */
export interface NestSource {
  index(): Promise<{ selfId: string | null; rows: unknown[]; desks: unknown[] } | null>;
  continueHere(id: string, row: Record<string, unknown> | undefined): Promise<{ result: 'taken' | 'forked'; newId: string }>;
}

let source: NestSource = hubNestSource;
let lastHost: NestSidebarHost | null = null;
let lastRows: Array<Record<string, unknown>> = [];
let watching: { dispose(): void } | null = null;

/** A test's seam. `null` puts the hub back. */
export function registerNestSource(next: NestSource | null): void {
  source = next ?? hubNestSource;
}

/** Is Nests on? DEFAULT FALSE; only an exact `true` turns it on, and a host
 *  with no settings store reads as off. */
export function nestsEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration('origamicoder.nests').get<boolean>('enabled') === true;
  } catch {
    return false;
  }
}

/** Rule 2 at the source: a row whose desk is this desk is not "on another desk". */
export function otherDeskRows(rows: unknown[], selfId: string | null): Array<Record<string, unknown>> {
  return rows.filter((r): r is Record<string, unknown> =>
    !!r && typeof r === 'object' && (!selfId || (r as Record<string, unknown>)['desk'] !== selfId));
}

export async function nestIndexPayload(enabled: boolean = nestsEnabled()): Promise<Record<string, unknown>> {
  const got = enabled ? await source.index().catch(() => null) : null;
  lastRows = got ? otherDeskRows(got.rows, got.selfId) : [];
  return { type: 'origami/nestIndex', rows: lastRows, desks: got ? got.desks : [], tail: nestHub.tail.status(), away: got ? nestHub.away.list() : [] };
}

/** Post a fresh index to the last sidebar that asked. */
export async function pushNestIndex(): Promise<void> {
  const host = lastHost;
  if (host) host.post(await nestIndexPayload());
}

/** The switch flips live: the next push carries (or drops) the desks. */
function watchSetting(): void {
  if (watching) return;
  try {
    watching = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('origamicoder.nests')) void pushNestIndex();
    });
  } catch {
    watching = null;
  }
}

export async function handleNestSidebarMessage(
  host: NestSidebarHost,
  m: { type?: string; [k: string]: unknown },
  enabled: () => boolean = nestsEnabled,
): Promise<void> {
  lastHost = host;
  if (host.engine) nestHub.attachView({ engine: host.engine, post: (x) => host.post(x), open: host.open ?? (() => undefined), openSessionIds: host.openSessionIds });
  if (m.type === 'requestNestIndex') {
    watchSetting();
    host.post(await nestIndexPayload(enabled()));
    return;
  }
  const id = typeof m['id'] === 'string' ? m['id'] : '';
  if (!id || (m.type !== 'nestContinue' && m.type !== 'nestOpenRead')) return;
  const reply = m.type === 'nestContinue' ? 'nestContinueResult' : 'nestOpenReadResult';
  if (!enabled()) {
    host.post({ type: reply, id, error: 'Nests is off.' });
    return;
  }
  if (m.type === 'nestOpenRead') {
    try {
      await nestHub.openRead(id);
      host.post({ type: reply, id });
    } catch (e) {
      host.post({ type: reply, id, error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  try {
    const r = await source.continueHere(id, lastRows.find((row) => row['id'] === id));
    host.post({ type: 'nestContinueResult', id, result: r.result, newId: r.newId });
  } catch (e) {
    host.post({ type: 'nestContinueResult', id, error: e instanceof Error ? e.message : String(e) });
  }
}

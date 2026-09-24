// Flock pane, host side — routed out of DashboardPanel.ts like tools/skills/plugins/mcp, and shaped
// like mcpPane.ts: the engine owns the files and every job goes through the active session's
// extMethod. Reads flock_state plus flockMailbox.ts's mailbox read, since the two change for
// different reasons. Every write re-reads and re-posts, success or failure, so the pane never
// renders a state the engine does not believe — no optimistic patching, except flockSetEnabled, a
// workspace setting.

import * as vscode from 'vscode';
import { encodeQr, qrSvg } from '../remote/qr';
import { flockEnabled, setFlockEnabled } from '../flockEnabled';
import { FLOCK_MAILBOX_MESSAGE_TYPES, handleFlockMailboxMessage, mailboxPayload } from './flockMailbox';
import { FLOCK_SCOPE_MESSAGE_TYPES, handleFlockScopeMessage } from './flockScope';
import { getHolderPid, flockRouteCandidates, pickFlockClient, readFlockState, type FlockRouteHost } from './flockRoute';
import { notifyFlockMailbox } from '../notify/notifyEvents';

export const FLOCK_PANE_MESSAGE_TYPES = new Set([
  ...FLOCK_SCOPE_MESSAGE_TYPES, // the pickers; flockScope.ts owns them
  ...FLOCK_MAILBOX_MESSAGE_TYPES, // the mail manager; flockMailbox.ts owns them
  'flockRequest',
  'flockInvite',
  'flockAccept',
  'flockRevoke',
  'flockSetIdentity',
  'flockSetPolicy',
  'flockFrontDesk',
  'flockSetSpecialties', 'flockSetEnabled',
]);

export interface FlockPaneClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface FlockPaneHost extends Pick<FlockRouteHost<FlockPaneClient>, 'hostEngine'> {
  /** The active chat's engine connection, if any. Flock state is an engine
   *  read, so with no session there is no answer — the same rule mcpPane has. */
  client?: FlockPaneClient;
  /** The open workspace folder, for the scope pickers. See flockScope.ts. */
  cwd?: string;
  post(message: Record<string, unknown>): void;
  /** The three the MAIL MANAGER needs (flockMailbox.ts). Optional because nothing else in this pane
   *  touches a chat, and a picker test must not have to build one. */
  openChat?(recall?: string): Promise<string | undefined>;
  // `pid` = the session's engine OS pid, matched against the lease's holder.
  sessions?(): { id: string; label: string; engineId?: string; pid?: number }[];
  chat?(localId: string): { client?: FlockPaneClient; engineId?: string; pid?: number } | undefined;
}

/** The invite as a QR, or '' when it is too long for one. The encoder tops out
 *  at version 10 (`remote/qr.ts`), which a long enough NAME can exceed — and an
 *  invite with no QR is still an invite you can copy, so this must not throw. */
function inviteQr(invite: string): string {
  try {
    return qrSvg(encodeQr(invite));
  } catch {
    return '';
  }
}

const NO_SESSION = 'Open a chat first — your flock is read from a live engine connection.';

type WriteResult = { ok?: boolean; message?: string; invite?: string; path?: string };

async function statePayload(host: FlockPaneHost): Promise<Record<string, unknown>> {
  if (!host.client) return { type: 'flockData', error: NO_SESSION };
  try {
    // Reroutes to a sibling chat's engine, `relay` not `other-engine`, when the holder is ours — flockRoute.ts owns why.
    const state = await readFlockState(host.client, host);
    return { type: 'flockData', state };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { type: 'flockData', error: `Could not read your flock: ${message}` };
  }
}

async function refresh(host: FlockPaneHost): Promise<void> {
  host.post(await statePayload(host));
  // The MAILBOX is re-read after every write too, and by the same argument: a
  // contact revoked here closes nothing, but a policy change moves what their
  // rows say, and two reads that disagree are worse than one that is slow.
  const mailbox = await mailboxPayload(host);
  host.post(mailbox);
  // Toast only a genuine change — notifyFlockMailbox snapshots threads itself,
  // since this posts on every write whether anything actually changed or not.
  notifyFlockMailbox(Array.isArray((mailbox as { threads?: unknown }).threads) ? (mailbox as { threads: unknown[] }).threads : []);
}

/** Run one write and report it. The engine's message is shown verbatim on failure — it names the
 *  handle, invite fault or config file, and a rewrite here would drop what the user needs. */
async function write(
  host: FlockPaneHost,
  method: string,
  params: Record<string, unknown>,
  onOk?: (result: WriteResult) => void,
): Promise<void> {
  // Off the CACHED holder pid (the last `flock_state`), never a fresh read —
  // else the active engine's own refresh() stays a no-op until its next beat.
  // Falls back to `host.client` when the holder is not one of ours, as today.
  const client = pickFlockClient(flockRouteCandidates(host), getHolderPid()) ?? host.client;
  if (!client) {
    vscode.window.showErrorMessage(NO_SESSION);
    return;
  }
  try {
    const result = (await client.extMethod(method, params)) as WriteResult;
    if (result?.ok) {
      onOk?.(result);
      if (result.message) vscode.window.showInformationMessage(result.message);
    } else {
      vscode.window.showErrorMessage(result?.message ?? `${method} failed`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
  }
  await refresh(host);
}

/** Only the fields the pane actually sent. `null` survives — it is how a
 *  per-friend override is CLEARED, and dropping it would make a budget
 *  impossible to remove once set. */
function picked(m: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (m[key] !== undefined) out[key] = m[key];
  return out;
}

function handleOf(m: Record<string, unknown>): string {
  return typeof m['handle'] === 'string' ? m['handle'].trim() : '';
}

export async function handleFlockPaneMessage(
  host: FlockPaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  switch (m.type) {
    case 'flockRequest':
      await refresh(host);
      host.post({ type: 'flockEnabled', enabled: flockEnabled() });
      return;
    case 'flockSetEnabled': {
      const error = await setFlockEnabled(m['enabled'] === true);
      host.post({ type: 'flockEnabled', enabled: error ? flockEnabled() : m['enabled'] === true, ...(error ? { error } : {}) });
      return;
    }
    case 'flockInvite':
      // The invite string is posted STRAIGHT to the pane rather than shown in a
      // toast: it is 200-odd characters the user has to copy, and a toast is
      // not a place anyone can select text from.
      await write(host, 'flock_invite', picked(m, ['relay']), (result) => {
        if (result.invite) host.post({ type: 'flockInviteMade', invite: result.invite, qr: inviteQr(result.invite) });
      });
      return;
    case 'flockAccept': {
      const invite = typeof m['invite'] === 'string' ? m['invite'].trim() : '';
      if (!invite) {
        vscode.window.showErrorMessage('Paste the invite your contact sent you first.');
        return;
      }
      await write(host, 'flock_accept', { invite, ...picked(m, ['autoAnswer', 'dailyBudgetTokens']) });
      return;
    }
    case 'flockRevoke': {
      const handle = handleOf(m);
      if (!handle) return;
      await write(host, 'flock_revoke', { handle });
      return;
    }
    case 'flockSetIdentity':
      // Both fields optional and neither nullable: `picked` drops what the tile
      // did not touch, and the engine leaves an absent one alone.
      await write(host, 'flock_set_identity', picked(m, ['name', 'icon']));
      return;
    case 'flockSetPolicy': {
      const handle = handleOf(m);
      if (!handle) return;
      await write(host, 'flock_set_policy', {
        handle,
        // `displayName` rides here because the friend row already writes to this
        // method; `null` clears the owner's own label back to the declared name.
        ...picked(m, ['autoAnswer', 'dailyBudgetTokens', 'model', 'scope', 'displayName']),
      });
      return;
    }
    case 'flockFrontDesk':
      await write(host, 'flock_front_desk', picked(m, ['model', 'dailyBudgetTokens', 'scope', 'autoAnswer']));
      return;
    case 'flockSetSpecialties': {
      const raw = m['specialties'];
      if (!Array.isArray(raw)) return;
      await write(host, 'flock_set_specialties', {
        specialties: raw.filter((item): item is string => typeof item === 'string'),
      });
      return;
    }
    default:
      // Two leaves under one dispatch: the pickers and the mail manager. The
      // sets above are disjoint, so the order here is arbitrary and neither
      // can swallow the other's message.
      if (typeof m.type === 'string' && FLOCK_MAILBOX_MESSAGE_TYPES.has(m.type)) {
        await handleFlockMailboxMessage(host, m);
        return;
      }
      await handleFlockScopeMessage(host, m);
  }
}

// The Front Desk MAILBOX, host side — its own leaf because flockPane.ts is near its cap and this
// touches the only two places in Flock that touch a chat session.
//
// Posted beside `flockData`, not inside it, since a reply can land while nobody is editing
// anything. Neither delivery door posts a `send`: both call the ACP method `flock_deliver` and the
// ENGINE writes the message — posting a worded sentence used to make every model believe the
// operator had said it themselves.
//
// The call always goes to the target chat's OWN engine, since a workspace runs one engine per chat
// and only the session holding it can inject a turn without waiting on the broker file.

import * as vscode from 'vscode';

export const FLOCK_MAILBOX_MESSAGE_TYPES = new Set([
  'flockMailboxRequest',
  'flockDecide',
  'flockSend',
  'flockMark',
  'flockFollowUp',
  'flockOpenChat',
  'flockDeliver',
]);

export interface MailboxClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface MailboxHost extends Pick<FlockRouteHost<MailboxClient>, 'hostEngine'> {
  client?: MailboxClient;
  post(message: Record<string, unknown>): void;
  /** Open a chat and return its LOCAL id. `recall` reopens a past engine
   *  session — the chat that asked, when the owner has since closed it. */
  openChat?(recall?: string): Promise<string | undefined>;
  /** The chats the owner has open, for the picker. `engineId` is what a
   *  thread's origin is matched against. */
  // `pid` = that session's engine OS pid, for flockRoute.ts's holder match.
  sessions?(): { id: string; label: string; engineId?: string; pid?: number }[];
  /** One chat's engine connection and the session id it talks on. */
  chat?(localId: string): { client?: MailboxClient; engineId?: string; pid?: number } | undefined;
}

export { flockMailboxPush, mailboxPayload } from './flockMailboxRead';
import { mailboxPayload, NO_SESSION } from './flockMailboxRead';
import { flockRouteCandidates, getHolderPid, pickFlockClient, type FlockRouteHost } from './flockRoute';

async function refresh(host: MailboxHost): Promise<void> {
  host.post(await mailboxPayload(host));
  host.post({ type: 'flockSessions', sessions: host.sessions?.() ?? [] });
}

/** One write, reported verbatim from the engine's own message. `on` defaults to the CACHED holder's
 *  client, not the active one — flock_decide/flock_send need the transport of the engine that
 *  actually won the lease, or they would silently fail to reach the wire. `deliverInto` overrides
 *  this with the target chat's own client, a different routing question. */
async function write(
  host: MailboxHost,
  method: string,
  params: Record<string, unknown>,
  on: MailboxClient | undefined = pickFlockClient(flockRouteCandidates(host), getHolderPid()) ?? host.client,
): Promise<boolean> {
  if (!on) {
    vscode.window.showErrorMessage(NO_SESSION);
    return false;
  }
  let ok = false;
  try {
    const result = (await on.extMethod(method, params)) as { ok?: boolean; message?: string };
    ok = result?.ok === true;
    if (ok) {
      if (result.message) vscode.window.showInformationMessage(result.message);
    } else {
      vscode.window.showErrorMessage(result?.message ?? `${method} failed`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
  }
  await refresh(host);
  return ok;
}

/** Ask ONE chat's engine to put the row into that chat. `flock_deliver` records
 *  `deliveredTo` itself, on the POST that landed, so there is no `flock_mark`
 *  behind it and no way to mark a row delivered into a chat that never got it. */
async function deliverInto(host: MailboxHost, localId: string, thread: string): Promise<void> {
  const chat = host.chat?.(localId);
  if (!chat?.client || !chat.engineId) {
    vscode.window.showErrorMessage('That chat has no live engine session yet. Try again in a moment.');
    await refresh(host);
    return;
  }
  await write(host, 'flock_deliver', { thread, sessionID: chat.engineId }, chat.client);
}

function str(m: Record<string, unknown>, key: string): string {
  return typeof m[key] === 'string' ? (m[key] as string).trim() : '';
}

export async function handleFlockMailboxMessage(
  host: MailboxHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  const thread = str(m, 'thread');
  switch (m.type) {
    case 'flockMailboxRequest':
      await refresh(host);
      return;
    case 'flockDecide': {
      const action = m['action'];
      if (!thread || (action !== 'answer' && action !== 'decline')) return;
      // Guidance and reason are sent only when the owner typed one: an empty
      // string is not the same as no guidance, and the engine treats a blank
      // guidance block as none rather than as an instruction saying nothing.
      const guidance = str(m, 'guidance');
      const reason = str(m, 'reason');
      await write(host, 'flock_decide', {
        thread,
        action,
        ...(guidance ? { guidance } : {}),
        ...(reason ? { reason } : {}),
      });
      return;
    }
    case 'flockSend': {
      if (!thread) return;
      const text = str(m, 'text');
      await write(host, 'flock_send', { thread, ...(text ? { text } : {}) });
      return;
    }
    case 'flockMark': {
      if (!thread) return;
      await write(host, 'flock_mark', { thread, mark: m['mark'] === 'delivered' ? 'delivered' : 'read' });
      return;
    }
    case 'flockFollowUp': {
      const to = str(m, 'to');
      const question = str(m, 'question');
      if (!to || !question) return;
      await write(host, 'flock_post', { to, question, ...(thread ? { followUpOf: thread } : {}) });
      return;
    }
    case 'flockOpenChat': {
      if (!thread || !host.openChat) return;
      const recall = str(m, 'recall');
      const local = await host.openChat(recall || undefined);
      // DELIVERED ONLY IF A CHAT ACTUALLY OPENED. A row recorded as delivered
      // into a session that never existed is a reply the owner would never look
      // at again, with nothing on screen to say where it went.
      if (local) await deliverInto(host, local, thread);
      else await refresh(host);
      return;
    }
    case 'flockDeliver': {
      const local = str(m, 'sessionID');
      if (!thread || !local) return;
      await deliverInto(host, local, thread);
      return;
    }
    default:
      return;
  }
}

// Origami Remote — WHAT THE PHONE MAY SEND, and how far the desk lets it go.
// The DATA TABLE is `remoteVerbsTable.ts`; this file is the predicates.
//
// Until this gate existed, `deliver()` handed the phone's message straight to
// the same `handleWebviewMessage` the sidebar uses, so a phone could post ANY
// dashboard message — `setApproveMode: bypass` included.
// DEFAULT DENY. A type with no row and no name in `NAMED_REFUSALS` is dropped
// (`verbNeeds` returns null), and the status line names the TYPE only — never
// the payload, which could put a prompt or a pasted credential on a pane.
// THE ENVELOPE is the LEAST envelope that admits each verb:
//   watch  reads, and giving authority BACK: cancel, deny, revert to Ask.
//   ask    driving the session: send, approve a permission, open/close chats,
//          pick a model or effort.
//   full   asking for YOLO, and endpoint/credential/settings writes.
// So `permission` and `remote/set-mode*` each appear under two needs: the same
// type is `watch` when it hands authority back and higher when it grants.
// `slashCommand` is refused BY NAME for its two escalating spellings.
// `request*` IS A PREFIX RULE and the one bet here: every `request…` the host
// answers is a read. If a `request…` that WRITES is added, give it its own row
// with a higher need and say so here.

import { ESCALATING_SLASH_COMMANDS, NAMED_REFUSALS, PHONE_VERBS, type RemoteCapability, type VerbNeeds } from './remoteVerbsTable';

export type { RemoteCapability, VerbNeeds };
export { NAMED_REFUSALS, PHONE_VERBS };

const RANK: Record<RemoteCapability, number> = { watch: 0, ask: 1, full: 2 };

function isDeny(msg: unknown): boolean {
  const optionId = (msg as { optionId?: unknown } | null)?.optionId;
  return optionId === null || optionId === undefined;
}

function isYolo(msg: unknown): boolean {
  return (msg as { mode?: unknown } | null)?.mode === 'yolo';
}

/** `/auto` and `/bypass` typed into the composer post `slashCommand` with these
 *  exact `command` strings — the ones `DashboardPanel.MODE_COMMANDS` routes to
 *  the unsigned `setSessionMode` bypass path. */
function isEscalatingSlash(msg: unknown): boolean {
  const command = (msg as { command?: unknown } | null)?.command;
  return typeof command === 'string' && ESCALATING_SLASH_COMMANDS.has(command);
}

/** The least envelope that admits THIS message, or null when the type is not in the table. */
export function verbNeeds(msg: unknown): VerbNeeds | null {
  const type = (msg as { type?: unknown } | null)?.type;
  if (typeof type !== 'string') return null;
  // Answering an ask with a refusal, and handing YOLO back, are both free.
  if (type === 'permission' && isDeny(msg)) return 'watch';
  if ((type === 'remote/set-mode' || type === 'remote/set-mode-request') && !isYolo(msg)) return 'watch';
  // Refused BY NAME, not by rank: nothing here proves the phone holds the
  // enrolled key, so no envelope should admit it.
  if (type === 'slashCommand' && isEscalatingSlash(msg)) return null;
  const listed = PHONE_VERBS.get(type);
  if (listed) return listed;
  return type.startsWith('request') ? 'watch' : null;
}

export type VerbVerdict = { allow: true } | { allow: false; status: string };

/** Named because the tests assert the sentence, and the TYPE is the whole diagnostic. */
export const NOT_ALLOWED = 'remote: dropped a message the phone may not send — ';
export const ENVELOPE_REFUSED = 'remote: this desk allows the phone only to ';

export function verbVerdict(msg: unknown, capability: RemoteCapability): VerbVerdict {
  const needs = verbNeeds(msg);
  // Only a STRING type is ever named: anything else would leak the payload.
  const raw = (msg as { type?: unknown } | null)?.type;
  const type = typeof raw === 'string' ? raw : '';
  if (needs === null) return { allow: false, status: NOT_ALLOWED + (type || '(no type)') };
  if (RANK[needs] > RANK[capability]) {
    return { allow: false, status: `${ENVELOPE_REFUSED}${capability} — refused ${type}` };
  }
  return { allow: true };
}

/** The setting's value, clamped. An unknown string is the DEFAULT, not a refusal. */
export function readCapability(value: unknown): RemoteCapability {
  return value === 'watch' || value === 'ask' ? value : 'full';
}

// EVERY HOST MESSAGE THE FLOCK PANE ACCEPTS, as one pure mapping.
//
// Extracted from FlockPane.svelte at its architecture cap, and the right seam
// on its own terms: this is UNTRUSTED input. `event.data` is whatever the host
// posted, so every field needs a typeof/Array.isArray gate before it reaches a
// tile, and a gate that lives in a component can only be tested by rendering
// one. Here it is arithmetic on a plain object.
//
// The pane keeps the two things that are not a mapping: assigning the patch to
// its `$state`, and stamping the folder pick's nonce (the counter is the
// pane's, and it is what makes the SAME folder picked twice into two events).

import type { MailRow } from './flockMail';
import type { MailSession } from './flockDeliverTargets';
import type {
  FlockScopeKind, FlockScopeOptions, FlockState,
} from './flockTypes';

export interface ModelOpt { value: string; name: string }
export interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }

export type FlockInbound =
  | { kind: 'data'; error: string; state: FlockState | null }
  | { kind: 'mailbox'; threads: MailRow[] }
  | { kind: 'sessions'; sessions: MailSession[] }
  | { kind: 'invite'; invite: string; qr: string }
  | { kind: 'scopeOptions'; options: FlockScopeOptions }
  | { kind: 'picked'; pick: { kind: FlockScopeKind; path: string; target: string } }
  | { kind: 'models'; options: ModelOpt[] }
  | { kind: 'providers'; providers: ProviderStat[] }
  | { kind: 'enabled'; enabled: boolean; error?: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Null for a message this pane does not own — every other pane's traffic
 *  arrives on the same window, so silence is the correct answer, not a throw. */
export function flockInbound(msg: Record<string, unknown>): FlockInbound | null {
  switch (msg['type']) {
    case 'flockData':
      return { kind: 'data', error: str(msg['error']), state: (msg['state'] as FlockState) ?? null };
    // The mailbox arrives whole rather than as a patch: a thread's state, its
    // reply and its unread flag all move together, and a partial update is how
    // a row ends up showing Send next to an answer that has already gone.
    case 'flockMailbox':
      return { kind: 'mailbox', threads: arr<MailRow>(msg['threads']) };
    case 'flockSessions':
      return { kind: 'sessions', sessions: arr<MailSession>(msg['sessions']) };
    case 'flockInviteMade':
      return { kind: 'invite', invite: str(msg['invite']), qr: str(msg['qr']) };
    case 'flockScopeOptions':
      return {
        kind: 'scopeOptions',
        options: { repos: arr(msg['repos']), wiki: arr(msg['wiki']) },
      };
    case 'flockScopePicked':
      return {
        kind: 'picked',
        // `target` is echoed by the host, not guessed here: two pickers are on
        // screen at once (the Permissions chip and a contact's Edit popover)
        // and a pick with no owner would be applied by both of them.
        pick: { kind: msg['kind'] as FlockScopeKind, path: str(msg['path']), target: str(msg['target']) },
      };
    case 'modelOptions':
      return { kind: 'models', options: arr<ModelOpt>(msg['options']) };
    case 'providerStatus':
      return { kind: 'providers', providers: arr<ProviderStat>(msg['providers']) };
    // origamicoder.flock.enabled, echoed back live after a write (or a late
    // mount's flockRequest) so the switch and the dimmed rail never lag.
    case 'flockEnabled':
      return {
        kind: 'enabled',
        enabled: msg['enabled'] === true,
        ...(typeof msg['error'] === 'string' ? { error: msg['error'] } : {}),
      };
    default:
      return null;
  }
}

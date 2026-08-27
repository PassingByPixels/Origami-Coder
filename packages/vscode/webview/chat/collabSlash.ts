// Collabs M2 (+ flock M4 wave X1) - the collab composer's `/` vocabulary, as a
// PURE leaf.
//
// It is a deliberately SHORT allowlist, not the chat's command set. The chat's
// commands run against an engine session; a collab has none of its own, so
// forwarding `/clear` or `/model` here would either do nothing or act on some
// unrelated chat. Nine commands map onto the wire methods plus the two
// controls the pane already owns (the cap, the context drawer).
//
// THE DEFAULT IS TO POST. Anything not on this list - including a bare `/`, a
// typo, and a code snippet that happens to start with a slash - is an ordinary
// message. A composer that swallowed unrecognised input would lose what the
// user typed, which is a far worse failure than posting a line reading
// "/achive" into the stream.

import type { SlashCommand } from '../dashboard/lib/slashCommands';

/** The palette's entries. `category` is what the dropdown groups on; these are
 *  all collab-scoped, so they carry one bucket rather than borrowing the chat's
 *  inferCategory (which knows nothing about these names). */
export const COLLAB_COMMANDS: SlashCommand[] = [
  { name: '/rename', description: 'Retitle this collab', category: 'Collab' },
  { name: '/archive', description: 'Close this collab (it stays in History)', category: 'Collab' },
  { name: '/invite', description: 'Add a collab agent to the roster', category: 'Roster' },
  { name: '/remove', description: 'Remove an agent from the roster', category: 'Roster' },
  { name: '/cap', description: 'Loop breaker: a number, off, or default', category: 'Collab' },
  { name: '/context', description: "Show an agent's last prompt", category: 'Roster' },
  { name: '/lead', description: 'Set the collab lead', category: 'Roster' },
  { name: '/objective', description: 'Set the collab objective', category: 'Collab' },
  { name: '/stop', description: 'Interrupt the agents until you post again', category: 'Collab' },
];

/** What the composer should DO with a submitted line. `post` is the fall-through
 *  and by far the commonest; `error` is a recognised command used wrongly, and
 *  says so instead of guessing an argument. */
export type CollabSlashAction =
  | { kind: 'post'; text: string }
  | { kind: 'rename'; title: string }
  | { kind: 'archive' }
  | { kind: 'invite'; slug: string }
  | { kind: 'remove'; slug: string }
  | { kind: 'cap'; cap: number | null }
  | { kind: 'context'; slug: string }
  | { kind: 'lead'; slug: string }
  | { kind: 'objective'; text: string }
  | { kind: 'stop' }
  | { kind: 'error'; message: string };

const needsArg = (name: string, what: string): CollabSlashAction => ({
  kind: 'error',
  message: `${name} needs ${what}.`,
});

/**
 * Parse one composer submission.
 *
 * `/cap` carries the same three-value rule the cap input does and must not
 * collapse it: `off` is 0 (the breaker is DISABLED), `default` is null (restore
 * the engine's), and a number is that number. `cap || default` is exactly the
 * bug this spells out - it would silently re-arm a breaker the user turned off.
 */
export function parseCollabSlash(text: string): CollabSlashAction {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'post', text: trimmed };
  const space = trimmed.search(/\s/);
  const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : trimmed.slice(space + 1).trim();
  switch (name) {
    case '/rename':
      return rest ? { kind: 'rename', title: rest } : needsArg('/rename', 'a title');
    case '/archive':
      return { kind: 'archive' };
    case '/invite':
      return rest ? { kind: 'invite', slug: rest.split(/\s+/)[0] } : needsArg('/invite', 'an agent name');
    case '/remove':
      return rest ? { kind: 'remove', slug: rest.split(/\s+/)[0] } : needsArg('/remove', 'an agent name');
    case '/context':
      return rest ? { kind: 'context', slug: rest.split(/\s+/)[0] } : needsArg('/context', 'an agent name');
    case '/lead':
      return rest ? { kind: 'lead', slug: rest.split(/\s+/)[0] } : needsArg('/lead', 'an agent name');
    case '/objective':
      return rest ? { kind: 'objective', text: rest } : needsArg('/objective', 'a sentence');
    case '/stop':
      return { kind: 'stop' };
    case '/cap': {
      const arg = rest.toLowerCase();
      if (arg === 'off') return { kind: 'cap', cap: 0 };
      if (arg === 'default' || arg === '') return { kind: 'cap', cap: null };
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0) return { kind: 'error', message: '/cap takes a whole number, off, or default.' };
      return { kind: 'cap', cap: n };
    }
    default:
      // Not one of ours: the user typed a message that begins with a slash.
      return { kind: 'post', text: trimmed };
  }
}

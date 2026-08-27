// Agent Manager - specRun.ts (Folds board, UAT round 1 item 3): the SPEC flow.
// A Triage ticket is a raw idea; this drives the conversation that turns it into
// a spec'd Todo one. Deliberately NOT a fold: the session's cwd is the REPO ROOT
// with no worktree and no WorktreeRecord, because the only file it may write is
// the ticket itself - a worktree copy would strand the spec on a branch nobody
// merges. The chat is opened BEFORE the prompt is sent: speccing is a
// CONVERSATION with the user, not a background run, so the window has to be in
// front of them when the agent asks its first question.
//
// The ticket FILE decides the outcome, never the agent's report of it: at the end
// of the turn the file is re-read and only real `- [ ]` acceptance lines move the
// ticket to Todo.

import * as path from 'node:path';
import { repoKey } from './registry';
import { acceptance, noteTicket, readTicket, scalar, serializeTicket, type Ticket } from './tickets';
import { effectiveModel, type RunContext } from './run';

/** `repoKey::id` of every ticket with a LIVE spec session. A module map - like
 *  the ticket poll's hashes next door - so the fleet owner holds no ticket state
 *  and stays under its line cap. tickets.ts reads it through the lookup manager.ts
 *  passes INTO its projection, never by importing this module (which imports it). */
const active = new Set<string>();

function key(root: string, id: string): string {
  return `${repoKey(root)}::${id}`;
}

/** Is this ticket mid-spec? Drives TicketRow.spec -> the card's "speccing…" chip. */
export function isSpecActive(root: string, id: string): boolean {
  return active.has(key(root, id));
}

/** Tests only: drop every live-spec mark. */
export function resetSpecRuns(): void {
  active.clear();
}

/** The spec brief: the ticket EXACTLY as it is on disk, its ABSOLUTE path, and the
 *  to-spec bar. The path is spelled out because the session's cwd is the repo
 *  root, not the tickets dir - the agent must edit that one file rather than
 *  write a spec document somewhere else. */
export function specBrief(t: Ticket, file: string): string {
  return [
    `Spec ticket ${t.id} — "${scalar(t.fm, 'title') || t.id}" — together with the user.`,
    `The ticket file, which is the thing you edit: ${file}`,
    'It reads exactly this right now:',
    '',
    serializeTicket(t).trim(),
    '',
    'Work it up to the spec bar and write the result INTO that file:',
    '- Objective: the outcome the work must produce, and why it matters.',
    '- What, not how: no implementation plan and no code.',
    '- Acceptance: TESTABLE criteria as `- [ ]` lines under a `## Acceptance` heading. Each one must be checkable by someone who did not write it.',
    '- Out of scope: what this ticket does NOT cover.',
    '',
    'Rules: edit ONLY that file - no other file in the repo. Keep its existing frontmatter keys. Talk to the user: ask what is ambiguous and agree the acceptance criteria with them before you write them.',
  ].join('\n');
}

/** Run one ticket's spec conversation. Interactive by design: this resolves only
 *  when the chat turn ends, which can be many minutes after the click. */
export async function runSpec(
  ctx: RunContext, root: string, id: string, agentName: string, model: string,
): Promise<void> {
  const { host } = ctx;
  const amError = (message: string) => host.post({ type: 'amError', message });
  const t = readTicket(root, id);
  if (!t) { amError('That ticket no longer exists.'); return; }
  if (t.malformed) { amError(`Ticket ${t.id} does not parse — fix its frontmatter before speccing it.`); return; }
  const k = key(root, t.id);
  // A second click landing before the first broadcast paints the chip would spawn
  // a second engine child onto the same file, and the first completion would then
  // clear the mark out from under the second.
  if (active.has(k)) { amError(`Ticket ${t.id} already has a spec session open.`); return; }
  active.add(k);
  ctx.broadcast();
  try {
    const sessionId = await host.createAgentSession(root, agentName || undefined);
    // Pin before the prompt, exactly like a fold run: a throw is FATAL (never
    // silently spec on the wrong model), and the repo default applies when the
    // picker named no model of its own.
    const effModel = effectiveModel(root, model);
    if (effModel) {
      try {
        await host.setSessionModel(sessionId, effModel);
      } catch (e) {
        throw new Error(`model pin failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    host.openChat(sessionId); // in front of the user BEFORE the first question
    await host.promptSession(sessionId, specBrief(t, path.resolve(t.file)));
    active.delete(k);
    // The FILE is the truth about whether this ticket is spec'd. No acceptance
    // criteria = still a raw idea: it stays in Triage and SAYS so, rather than
    // moving to Todo on an empty promise. No sessionAlive death-check here (a
    // fold run has one): the turn resolved, so whatever is on disk is the result
    // even if the user closed the chat as it finished.
    const after = readTicket(root, t.id);
    if (after && acceptance(after.body).total > 0) noteTicket(root, t.id, 'spec complete', 'todo');
    else noteTicket(root, t.id, 'spec session ended without acceptance');
  } catch (e) {
    active.delete(k); // never leave a chip pulsing over a session that is gone
    amError(`Spec session failed for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  ctx.broadcast();
}

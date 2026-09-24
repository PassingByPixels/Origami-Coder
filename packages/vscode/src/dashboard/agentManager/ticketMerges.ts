// The board stamps `merged` from GIT, not only its own Apply button: real work is often
// done in a hand-cut worktree merged by hand, which the old logic never saw. "Merged" means
// the branch tip is reachable AND off HEAD's first-parent chain (a --no-ff merge puts it
// there; a pointer that never advanced sits ON the chain, so a lane cut from master isn't
// falsely merged). Accepted limitation: a fast-forwarded lane is indistinguishable from a
// fresh pointer and is never stamped — close those by hand.

import { loadState, saveState } from './state';
import { runGitStdout } from './gitRun';
import { listTickets, markTicketMerged, stampFold } from './tickets';
import { scalar } from './ticketDoc';

/** A branch NAMES a ticket when the id appears as a whole token (`lane/t-ab12cd-thing` yes,
 *  `feature/t-ab12cdX` no), mirroring the board's own id-first launchName. */
function namesTicket(branch: string, id: string): boolean {
  // A separator, or the end of the string, on BOTH sides of the id.
  const sep = (c: string | undefined) => c === undefined || c === '/' || c === '-';
  for (let at = branch.indexOf(id); at >= 0; at = branch.indexOf(id, at + 1)) {
    if (sep(branch[at - 1]) && sep(branch[at + id.length])) return true;
  }
  return false;
}

/** The reachable branch a ticket's work is on: the frontmatter `branch` if set, else the
 *  first reachable branch naming the ticket; '' = no match. */
function mergedBranchFor(id: string, declared: string, reachable: string[], set: Set<string>): string {
  if (declared) return set.has(declared) ? declared : '';
  return reachable.find((b) => namesTicket(b, id)) ?? '';
}

/** HEAD's first-parent chain, capped so a deep history cannot stall the 5s poll.
 *  undefined = git failed; the caller then stamps NOTHING (worse to be wrong). */
async function firstParentChain(work: string): Promise<Set<string> | undefined> {
  const r = await runGitStdout(['rev-list', '--first-parent', '-n', '5000', 'HEAD'], work);
  return r.ok ? new Set(r.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) : undefined;
}

/** Stamp every ticket/fold record of the PRIMARY checkout whose branch has landed. Fold
 *  records go first — stampFold writes the ticket too, so the ticket pass skips an
 *  already-stamped file rather than writing twice. */
export async function reconcileMergedTickets(work: string): Promise<boolean> {
  const head = await runGitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], work);
  const primaryBranch = head.ok ? head.output.trim() : '';
  // Detached HEAD (or not a repo): there is no branch to say "merged INTO", and
  // stamping against a bare sha would be a claim we cannot name. Do nothing.
  if (!primaryBranch || primaryBranch === 'HEAD') return false;
  const listed = await runGitStdout(['branch', '--merged', 'HEAD', '--format=%(objectname) %(refname:short)'], work);
  if (!listed.ok) return false;
  const tips = new Map<string, string>(); // branch -> tip sha, from the ONE call
  for (const line of listed.output.split(/\r?\n/)) {
    const at = line.indexOf(' ');
    if (at > 0) tips.set(line.slice(at + 1).trim(), line.slice(0, at));
  }
  const state = loadState(work);
  // A fold still sitting on its baseSha has produced nothing, however reachable
  // its tip reads. Exact, and free - the tips came out of the same git call.
  for (const rec of state.worktrees) if (rec.branch && tips.get(rec.branch) === rec.baseSha) tips.delete(rec.branch);
  const reachable = [...tips.keys()];
  const set = new Set(reachable);
  const now = Date.now();
  let changed = false;

  const landed = state.worktrees.filter((r) => r.ticketId && !r.merged && r.branch && set.has(r.branch));
  if (landed.length > 0) {
    for (const rec of landed) rec.merged = { at: now };
    saveState(work, state); // save BEFORE stampFold: it re-reads state for the link
    for (const rec of landed) stampFold(work, rec.id, 'merged', `merged into ${primaryBranch} by hand`, now);
    changed = true;
  }

  const candidates: Array<{ id: string; branch: string }> = [];
  for (const t of listTickets(work)) {
    if (t.malformed) continue; // a file we cannot parse is never rewritten
    const status = scalar(t.fm, 'status');
    if (status === 'merged' || status === 'closed') continue; // the idempotence guard
    const branch = mergedBranchFor(t.id, scalar(t.fm, 'branch'), reachable, set);
    if (branch) candidates.push({ id: t.id, branch });
  }
  // The third git call is paid for only when a ticket is actually in question.
  const chain = candidates.length > 0 ? await firstParentChain(work) : undefined;
  for (const c of candidates) {
    const tip = tips.get(c.branch);
    // ON the chain = the primary's own history, not work that arrived.
    if (!chain || !tip || chain.has(tip)) continue;
    markTicketMerged(work, c.id, c.branch, `merged into ${primaryBranch} (seen by the board)`, now);
    changed = true;
  }
  return changed;
}

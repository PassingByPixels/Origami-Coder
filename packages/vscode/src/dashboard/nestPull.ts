// nestPull.ts — t-sc093o: bring one chat's journal to this desk from a desk
// that holds it. L4a's receiver-driven loop, over the group link:
//
//   nest_import(probe) -> have
//   repeat: nest/export-request {after: have} -> nest/chunk -> nest_import
//           until the import says done; on "gap", ask again from `have`.
//
// RESUMABLE by construction: `have` is read from this desk's store, so a pull
// that broke (a desk slept, a timeout) starts again where the store stands.

import type { GroupDeviceView } from '../remote/groupSnapshot';
import type { NestExportResult, NestImportResult, NestIndexRow } from './nestContract';

/** The part of the hub a pull needs. */
export interface NestPuller {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  request(peerId: string, sessionId: string, after: number): Promise<NestExportResult>;
}

/** Rounds without progress before a pull gives up. */
const STALLS = 3;

/** t-selspn: the tail's byte bound. No request starts with less than `reserve` left; the next pull resumes from `have`. */
export interface PullBudget { left: number; spent: number; reserve: number }

/** Which online desk to pull from (t-selspn): the one whose index row holds the
 *  HIGHEST seq of this writer's copy; on a tie the owner, then the mother base.
 *  So with the owner shut, the mother base's tailed copy serves. null = none online. */
export function pullSource(
  rows: readonly NestIndexRow[],
  desks: readonly GroupDeviceView[],
  sessionId: string,
  owner: string,
  self: string | null,
): string | null {
  const up = new Set(desks.filter((d) => d.online && d.id !== self).map((d) => d.id));
  const home = desks.find((d) => d.motherBase)?.id;
  const rank = (r: NestIndexRow) => r.seq * 4 + (r.desk === owner ? 2 : 0) + (r.desk === home ? 1 : 0);
  const holders = rows.filter((r) => r.id === sessionId && r.owner === owner && up.has(r.desk)).sort((x, y) => rank(y) - rank(x));
  return holders[0]?.desk ?? null;
}

export async function pullSession(hub: NestPuller, sessionId: string, owner: string, source: string, budget?: PullBudget): Promise<number> {
  const probe = await hub.call<NestImportResult>('nest_import', { chunk: probeChunk(sessionId, owner) });
  if (probe.refused) throw new Error(refusal(probe.refused));
  let have = probe.have;
  let stalls = 0;
  for (;;) {
    if (budget && budget.left < budget.reserve) return have;
    const chunk = await hub.request(source, sessionId, have);
    if (budget) spend(budget, chunk);
    if ('refused' in chunk) throw new Error('The other desk does not hold this chat.');
    const got = await hub.call<NestImportResult>('nest_import', { chunk });
    if (got.refused && got.refused !== 'gap') throw new Error(refusal(got.refused));
    if (!got.refused && got.done) return got.have;
    stalls = got.have > have ? 0 : stalls + 1;
    if (stalls >= STALLS) throw new Error('The pull made no progress.');
    have = got.have;
  }
}

function refusal(reason: NonNullable<NestImportResult['refused']>): string {
  switch (reason) {
    case 'owner': return 'This desk holds this chat under another writer.';
    case 'diverged': return 'The copy here differs from the other desk\'s at the same point.';
    default: return `The chat could not be imported (${reason}).`;
  }
}

/** The chunk's JSON bytes: what crossed the link, before the seal. */
function spend(budget: PullBudget, chunk: unknown): void {
  const n = new TextEncoder().encode(JSON.stringify(chunk)).length;
  Object.assign(budget, { left: budget.left - n, spent: budget.spent + n });
}

/** A chunk with no events: nest_import answers `have` only. */
export function probeChunk(sessionId: string, owner: string): Record<string, unknown> {
  return { sessionId, owner, from: 0, to: -1, last: 0, done: false, events: [] };
}

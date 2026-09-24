// nestArtifactRows.ts — t-sj39jx (artifacts lane 4): the pure rules over the
// other desks' artifact rows. Which copy of an artifact the pane shows, which
// desk a pull asks, and how local rows and nest rows become one list.

import type { GroupDeviceView } from '../remote/groupSnapshot';
import { namedDevice, otherDesk } from './nestOwnRows';

/** One nest_artifact_index row. MIRROR of packages/engine/src/artifact/nest-sync.ts
 *  IndexRow; nestArtifacts.test.ts reads both field lists and fails when they drift. */
export interface NestArtifactRow {
  id: string;
  title: string;
  version: number;
  digest: string;
  /** The desk that HOLDS this copy. */
  desk: string;
  deskName: string;
  /** The desk that made the latest version. */
  owner: string;
  updated: number;
  size: number;
}
export const NEST_ARTIFACT_ROW_FIELDS = ['id', 'title', 'version', 'digest', 'desk', 'deskName', 'owner', 'updated', 'size'] as const;

/** The desk chip's input (webview/chat/nestIndex.ts NestDesk). */
export type DeskView = Pick<GroupDeviceView, 'id' | 'name' | 'online' | 'lastSeen' | 'motherBase'> & { os: string };

export function nestArtifactRows(raw: unknown): NestArtifactRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is NestArtifactRow =>
    !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.desk === 'string' && typeof r.owner === 'string'
    && typeof r.version === 'number' && r.version >= 1);
}

/** Per artifact, the copy with the highest version on another desk; on a tie the owner's own copy. */
export function nestBest(others: readonly NestArtifactRow[], self: string | null): Map<string, NestArtifactRow> {
  const best = new Map<string, NestArtifactRow>();
  const own = (r: NestArtifactRow) => (r.desk === r.owner ? 1 : 0);
  for (const r of others) {
    if (r.desk === self) continue;
    const had = best.get(r.id);
    if (!had || r.version > had.version || (r.version === had.version && own(r) > own(had))) best.set(r.id, r);
  }
  return best;
}

/** The online desk to pull (id, version) from: a holder of exactly that version, the
 *  owner first, then the mother base. null = none online. */
export function artifactSource(
  others: readonly NestArtifactRow[],
  desks: readonly GroupDeviceView[],
  id: string,
  version: number,
  self: string | null,
): string | null {
  const up = new Set(desks.filter((d) => d.online && d.id !== self).map((d) => d.id));
  const home = desks.find((d) => d.motherBase)?.id;
  const rank = (r: NestArtifactRow) => (r.desk === r.owner ? 2 : 0) + (r.desk === home ? 1 : 0);
  const holders = others.filter((r) => r.id === id && r.version === version && up.has(r.desk)).sort((x, y) => rank(y) - rank(x));
  return holders[0]?.desk ?? null;
}

function deskView(desks: readonly GroupDeviceView[], id: string, name: string): DeskView {
  const d = desks.find((x) => x.id === id);
  return d
    ? { id: d.id, name: d.name, os: String(d.os ?? ''), online: d.online, lastSeen: d.lastSeen, motherBase: d.motherBase }
    : { id, name: name || otherDesk(id), os: '', online: false, lastSeen: 0, motherBase: false };
}

/**
 * The pane's list: every local row, then the artifacts only another desk holds.
 * A local row the nest holds a NEWER version of shows that version, `here:
 * false` (Open pulls it). A row owned by another desk carries `desk`, the chip.
 * Rows this desk made itself are returned exactly as the engine listed them,
 * except that an owner id is never printed bare (nestOwnRows.ts).
 */
export function mergeNestArtifacts(
  local: readonly Record<string, unknown>[],
  others: readonly NestArtifactRow[],
  desks: readonly GroupDeviceView[],
  self: string | null,
): Record<string, unknown>[] {
  const best = nestBest(others, self);
  const nameOf = (id: string, fallback = '') => desks.find((d) => d.id === id)?.name || fallback || otherDesk(id);
  const nest = (r: NestArtifactRow) => ({
    latest: r.version, here: false, unopened: true,
    ownerDevice: nameOf(r.owner, r.desk === r.owner ? r.deskName : ''), desk: deskView(desks, r.owner, r.desk === r.owner ? r.deskName : ''),
  });
  const out = local.map((row) => {
    const id = String(row['id'] ?? '');
    const b = best.get(id);
    if (b && b.version > Number(row['latest'] ?? 0)) return { ...row, ...nest(b) };
    const owner = typeof row['ownerDevice'] === 'string' ? row['ownerDevice'] : '';
    const other = desks.find((d) => d.id === owner && !d.self);
    return other ? { ...row, ownerDevice: other.name, desk: deskView(desks, other.id, other.name) } : namedDevice(row, 'ownerDevice', self, desks);
  });
  const held = new Set(local.map((r) => String(r['id'] ?? '')));
  const only = [...best.values()].filter((r) => !held.has(r.id)).sort((x, y) => y.updated - x.updated);
  return [...out, ...only.map((r) => ({ id: r.id, title: r.title, updated: r.updated, ...nest(r) }))];
}

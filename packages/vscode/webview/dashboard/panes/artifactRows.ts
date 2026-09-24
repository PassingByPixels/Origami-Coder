// artifactRows.ts — every RULE the Artifacts pane applies to a row, away from
// the markup so each one can be asserted without rendering a pane: which
// device is called "this desk" or "mother base", what the sync line says, what
// the conflict banner says, and what a search matches.
//
// t-vbj8xu: this machine reads "this desk". "mother base" is the Nests role,
// the desk the group roster marks (host: nestArtifacts.ts motherBase()), and
// only while Nests is on. Labels, never ids: the engine and the host name the
// device, this decides how that name is read aloud in the UI.

/** The owning desk, when another desk owns the row (t-sj39jx). Mirrors
 *  webview/chat/nestIndex.ts NestDesk, the shape DeskChip.svelte draws. */
export interface ArtifactDesk {
  id: string;
  name: string;
  os: string;
  online: boolean;
  lastSeen: number;
  motherBase: boolean;
}

export interface ArtifactConflict {
  device: string;
  theirVersion: number;
  yourVersion: number;
}

export interface ArtifactRow {
  id: string;
  title: string;
  latest: number;
  /** Epoch ms from the engine (acp/artifacts.ts ListRow); an ISO string is also read. */
  updated?: number | string;
  ownerDevice?: string;
  /** The body (the files) is on this machine, not only in the index. */
  here?: boolean;
  sessionID?: string;
  project?: string;
  /** Arrived from another device and not opened yet — the pill's badge. */
  unopened?: boolean;
  conflict?: ArtifactConflict;
  /** Set by the host only for a row another desk owns: the pane draws its chip. */
  desk?: ArtifactDesk;
}

export interface VersionRow {
  number: number;
  digest?: string;
  created?: number | string;
  device?: string;
}

export const THIS_DESK_LABEL = 'this desk';
export const MOTHER_BASE_LABEL = 'mother base';

/** The Nests mother base as the host posts it (`artifactsData.motherBase`).
 *  Absent with Nests off or no desk marked. */
export interface MotherBase {
  /** True when this desk is the mother base. */
  self: boolean;
  name: string;
}

export function motherBaseOf(raw: unknown): MotherBase | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  return typeof m['name'] === 'string' ? { self: m['self'] === true, name: m['name'] as string } : undefined;
}

/** Only rows the engine gave an id and a title survive: a row with neither is
 *  a row no button on it could act on. */
export function artifactRows(raw: unknown): ArtifactRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
    .filter((r) => typeof r['id'] === 'string' && r['id'])
    .map((r) => ({
      id: String(r['id']),
      title: typeof r['title'] === 'string' && r['title'] ? String(r['title']) : String(r['id']),
      latest: typeof r['latest'] === 'number' ? (r['latest'] as number) : 1,
      ...(timeOf(r['updated']) !== undefined ? { updated: timeOf(r['updated'])! } : {}),
      ...(typeof r['ownerDevice'] === 'string' ? { ownerDevice: r['ownerDevice'] as string } : {}),
      ...(typeof r['here'] === 'boolean' ? { here: r['here'] as boolean } : {}),
      ...(typeof r['sessionID'] === 'string' ? { sessionID: r['sessionID'] as string } : {}),
      ...(typeof r['project'] === 'string' ? { project: r['project'] as string } : {}),
      ...(r['unopened'] === true ? { unopened: true } : {}),
      ...(conflictOf(r['conflict']) ? { conflict: conflictOf(r['conflict'])! } : {}),
      ...(deskOf(r['desk']) ? { desk: deskOf(r['desk'])! } : {}),
    }));
}

function deskOf(raw: unknown): ArtifactDesk | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d['id'] !== 'string' || typeof d['name'] !== 'string') return undefined;
  return {
    id: d['id'] as string,
    name: d['name'] as string,
    os: typeof d['os'] === 'string' ? (d['os'] as string) : '',
    online: d['online'] === true,
    lastSeen: typeof d['lastSeen'] === 'number' ? (d['lastSeen'] as number) : 0,
    motherBase: d['motherBase'] === true,
  };
}

function conflictOf(raw: unknown): ArtifactConflict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c['theirVersion'] !== 'number' || typeof c['yourVersion'] !== 'number') return undefined;
  return {
    device: typeof c['device'] === 'string' ? (c['device'] as string) : '',
    theirVersion: c['theirVersion'] as number,
    yourVersion: c['yourVersion'] as number,
  };
}

/** t-v7i2au: the engine sends times as epoch ms; an ISO string is kept as it came. */
function timeOf(raw: unknown): number | string | undefined {
  return (typeof raw === 'number' && Number.isFinite(raw)) || typeof raw === 'string' ? raw : undefined;
}

export function versionRows(raw: unknown): VersionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && typeof v['number'] === 'number')
    .map((v) => ({
      number: v['number'] as number,
      ...(typeof v['digest'] === 'string' ? { digest: v['digest'] as string } : {}),
      ...(timeOf(v['created']) !== undefined ? { created: timeOf(v['created'])! } : {}),
      ...(typeof v['device'] === 'string' ? { device: v['device'] as string } : {}),
    }));
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * How a device name is written in the UI. This machine (`homeDevice`, or no
 * device at all) reads "this desk", or "mother base (this desk)" when the
 * roster marks it. The marked other desk reads "mother base (<name>)". Every
 * other device keeps the name it gave.
 */
export function deviceLabel(device: string | undefined, homeDevice?: string, motherBase?: MotherBase): string {
  const name = (device ?? '').trim();
  if (!name || (homeDevice?.trim() && same(name, homeDevice))) {
    return motherBase?.self ? `${MOTHER_BASE_LABEL} (${THIS_DESK_LABEL})` : THIS_DESK_LABEL;
  }
  if (motherBase && !motherBase.self && same(name, motherBase.name)) return `${MOTHER_BASE_LABEL} (${name})`;
  return name;
}

/** Search matches the TITLE only (design note: "Search by title"). */
export function filterArtifacts(rows: ArtifactRow[], query: string): ArtifactRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.title.toLowerCase().includes(q));
}

/** `on this desk v4`, plus the mark for a body this machine has not pulled. */
export function syncLine(row: ArtifactRow, homeDevice?: string, motherBase?: MotherBase): string {
  const line = `on ${deviceLabel(row.ownerDevice, homeDevice, motherBase)} v${row.latest}`;
  return row.here === false ? `${line} · body not on this machine yet` : line;
}

/** The banner sentence from design section 6, with the device named. */
export function conflictSentence(row: ArtifactRow, homeDevice?: string, motherBase?: MotherBase): string {
  if (!row.conflict) return '';
  const who = deviceLabel(row.conflict.device, homeDevice, motherBase);
  return `${who} published v${row.conflict.theirVersion} after you opened v${row.conflict.yourVersion}.`;
}

/** "3 days ago" from epoch ms or an ISO timestamp. Empty when the engine sent none or sent
 *  something unreadable — a row that says "Invalid Date" is worse than a row
 *  that says nothing about when it changed. */
export function lastChange(updated: number | string | undefined, now: number = Date.now()): string {
  if (updated === undefined || updated === '') return '';
  const at = typeof updated === 'number' ? updated : Date.parse(updated);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** The chat and repo the artifact came from, as one line. */
export function originLine(row: ArtifactRow): string {
  const parts: string[] = [];
  if (row.project) parts.push(row.project);
  if (row.sessionID) parts.push(`chat ${row.sessionID}`);
  return parts.join(' · ');
}

// nestsStatus.ts — the words the Nests view says about the desks (t-s9jr6u,
// mock rounds 4 and 5). Pure, so each sentence is a unit test: the status
// line is the whole truth in one line, and a wrong one is a real bug.
//
// MIRROR of the host's GroupDeviceView (src/remote/groupController.ts): a
// webview file cannot import from src/ (rootDir), so the shape is written here.

export type DeskOs = 'windows' | 'macos' | 'linux' | '';

export interface NestDesk {
  id: string;
  name: string;
  self: boolean;
  online: boolean;
  motherBase: boolean;
  os: DeskOs;
  /** ms epoch of the last hello or drop; 0 = never seen. */
  lastSeen: number;
}

/** The running-text form of membership: "2 desks in the nest". */
export const IN_NEST = 'in the nest';
export const HOME_WORD = 'mother base';

export function deskWord(n: number): string {
  return n === 1 ? '1 desk' : `${n} desks`;
}

/** A desk's label: the host name it announced, or the start of its id. */
export function deskLabel(d: Pick<NestDesk, 'id' | 'name'>): string {
  return d.name.trim() || d.id.slice(0, 6);
}

/** "now", "8 min ago", "3 h ago", "2 d ago" — the card's last-seen words. */
export function ago(at: number, now: number): string {
  if (!at) return 'a while ago';
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** The one status line under the Desks head. */
export function statusLine(desks: readonly NestDesk[]): string {
  const n = desks.length;
  if (n === 0) return 'This desk is not in a nest yet.';
  const self = desks.find((d) => d.self);
  const selfName = self ? deskLabel(self) : 'this desk';
  if (n === 1) return `Only this desk, ${selfName}, is ${IN_NEST}. Add a desk to share chats.`;
  const on = desks.filter((d) => d.online).length;
  const online = on === n ? `${n === 2 ? 'both' : 'all'} online` : `${on} of ${n} online`;
  const home = desks.find((d) => d.motherBase);
  let tail: string;
  if (home?.self) tail = `This is ${selfName}, the ${HOME_WORD}.`;
  else if (home) tail = `This is ${selfName}. ${deskLabel(home)} is the ${HOME_WORD}.`;
  else tail = `This is ${selfName}. No ${HOME_WORD} yet.`;
  return `${deskWord(n)} ${IN_NEST}, ${online}. ${tail}`;
}

/** The short line under a desk's name: state first, then "this desk". */
export function deskMeta(d: NestDesk, now: number): string {
  const bits = [d.online ? 'online' : `offline · last seen ${ago(d.lastSeen, now)}`];
  if (d.self) bits.push('this desk');
  return bits.join(' · ');
}

/** The toolbar summary beside the NESTS title. */
export function nestsSummary(enabled: boolean, desks: readonly NestDesk[]): string {
  if (!enabled) return 'Off · nothing dials the relay';
  return desks.length ? `${deskWord(desks.length)} ${IN_NEST} · connected` : 'On · no desks yet';
}

/**
 * The desk that just joined, or null. The Add a desk panel closes itself when
 * a new desk arrives: the host closes the invitation on the join and pushes a
 * snapshot, so "an invite was open, it is gone, and one id is new" is the join.
 */
export function joinedDesk(
  prev: { inviteKey: string | null; desks: readonly NestDesk[] },
  next: { inviteKey: string | null; desks: readonly NestDesk[] },
): NestDesk | null {
  if (!prev.inviteKey || next.inviteKey) return null;
  const known = new Set(prev.desks.map((d) => d.id));
  return next.desks.find((d) => !d.self && !known.has(d.id)) ?? null;
}

/** Read one desk off the wire; anything malformed is dropped by the caller. */
export function readDesks(raw: unknown): NestDesk[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string')
    .map((d) => ({
      id: String(d['id']),
      name: typeof d['name'] === 'string' ? d['name'] : '',
      self: d['self'] === true,
      online: d['online'] === true,
      motherBase: d['motherBase'] === true,
      os: d['os'] === 'windows' || d['os'] === 'macos' || d['os'] === 'linux' ? d['os'] : '',
      lastSeen: typeof d['lastSeen'] === 'number' ? d['lastSeen'] : 0,
    }));
}

export interface NestTailDesk { tailed: number; behind: number }
export interface NestTailState { running: boolean; desks: Record<string, NestTailDesk> }

/** t-selspn: the mother base's tail (host nestTail.ts TailStatus) off the wire; null elsewhere or malformed. */
export function readTail(raw: unknown): NestTailState | null {
  const t = raw as { running?: unknown; desks?: unknown } | null;
  if (!t || typeof t !== 'object' || !t.desks || typeof t.desks !== 'object') return null;
  const desks: Record<string, NestTailDesk> = {};
  for (const [id, d] of Object.entries(t.desks as Record<string, { tailed?: unknown; behind?: unknown }>)) if (typeof d?.tailed === 'number' && typeof d.behind === 'number') desks[id] = { tailed: d.tailed, behind: d.behind };
  return { running: t.running === true, desks };
}

/** "tailed: 3 chats, behind by 1" on a desk's tile; '' when the mother base holds none of its chats. */
export function tailLine(d: NestTailDesk | undefined): string {
  return !d || d.tailed === 0 ? '' : `tailed: ${d.tailed === 1 ? '1 chat' : `${d.tailed} chats`}, ${d.behind ? `behind by ${d.behind}` : 'up to date'}`;
}

/** The OS word Config prints after this desk's name. */
export function osWord(os: string): string {
  return os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : 'unknown OS';
}

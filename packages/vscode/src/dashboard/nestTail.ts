// nestTail.ts — t-selspn (Nests L6): the MOTHER BASE keeps a copy of every
// live chat in the nest, so Continue here has a body while its owner is shut.
//
//   after each index merge (the 30 s tick, a desk's nest/index):
//   queue = one row per chat from an online desk that this desk does not write:
//           running or open, or closed and changed since the last look
//           (or a copy held here that is behind), newest lastAt first
//   for each: pull from the online desk with the highest seq (pullSource),
//             from this desk's `have`, while the byte budget lasts
//   budget = TAIL_RUN_BYTES per run, TAIL_MINUTE_BYTES in any 60 s
//   a run that brought events asks for an index send (the others see the seq)
//
// The copy stays read only: nest_import keeps the owner's id (L4a). A chat
// that did not finish in one run resumes from `have` on the next.

import type { GroupDeviceView } from '../remote/groupSnapshot';
import type { NestIndexRow } from './nestContract';
import { pullSession, pullSource, type NestPuller, type PullBudget } from './nestPull';

/** Bytes one run may bring in. */
export const TAIL_RUN_BYTES = 512 * 1024;
/** Bytes the tail may bring in any 60 s: half the relay's 2 MiB/min live lane. */
export const TAIL_MINUTE_BYTES = 1024 * 1024;
const MINUTE_MS = 60_000;
/** Room kept before a request: one chunk's events (nestHub NEST_CHUNK_BYTES) and its JSON. */
export const TAIL_RESERVE = 48_000;

export interface TailHost extends NestPuller {
  deviceId(): string | null;
  devices(): GroupDeviceView[];
  /** The other desks' rows (nest_index `others`). */
  readonly others: readonly NestIndexRow[];
  /** This desk's rows (nest_index `rows`): what it holds, and at which seq. */
  readonly mine: readonly NestIndexRow[];
  /** The tail status moved: post the view. */
  changed(): void;
  /** This desk's copies grew: send the index soon. */
  touch(): void;
  status?(text: string): void;
}

export interface TailDesk { tailed: number; behind: number }
/** What the Nests view draws: per owner desk, the chats held here and how many are behind. */
export interface TailStatus { running: boolean; desks: Record<string, TailDesk> }

/** The panel posts that move this desk's index (t-selspn): a new chat, a
 *  retitle, a turn start or end, a close. Each one asks for an index send. */
const LOCAL_CHANGES = new Set(['sessionCreated', 'sessionTitle', 'sessionClosed', 'busy', 'turnDone']);
export const localChange = (m: { type?: unknown }): boolean => typeof m.type === 'string' && LOCAL_CHANGES.has(m.type);

/** The other desks' chats as the view lists them, one row per chat: the owner's
 *  copy when its desk sent one, else the newest copy. Not the ones this desk
 *  writes or took (`taken`: chat -> the old owner, whose rows are stale), and
 *  none from a desk the roster does not name (t-t7l3pa): the engine keeps rows
 *  under an id a desk had before it re-paired, and they are hidden here on read. */
export function viewRows(others: readonly NestIndexRow[], self: string | null, taken: ReadonlyMap<string, string>, desks: readonly GroupDeviceView[]): NestIndexRow[] {
  const best = new Map<string, NestIndexRow>();
  const known = new Set(desks.map((d) => d.id));
  const rank = (x: NestIndexRow) => (x.desk === x.owner ? 1 : 0);
  for (const r of others) {
    if (!known.has(r.desk) || r.desk === self || r.owner === self || taken.get(r.id) === r.owner) continue;
    const held = best.get(r.id);
    if (!held || rank(r) > rank(held) || (rank(r) === rank(held) && r.seq > held.seq)) best.set(r.id, r);
  }
  return [...best.values()];
}

/** t-t7l3pa: the desk whose presence stands for a row's writer. An owner the
 *  roster does not name falls back to the row's own desk while that desk
 *  reports the chat running or open, never to "offline". */
export function ownerDesk(row: NestIndexRow, desks: readonly GroupDeviceView[]): GroupDeviceView | undefined {
  return desks.find((d) => d.id === row.owner) ?? (row.state !== 'closed' ? desks.find((d) => d.id === row.desk) : undefined);
}

/** The chats to tail, newest first. `seen` = the seq each chat had at the last look. */
export function tailQueue(host: Pick<TailHost, 'others' | 'mine' | 'devices' | 'deviceId'>, seen: ReadonlyMap<string, number>): NestIndexRow[] {
  const self = host.deviceId();
  const up = new Set(host.devices().filter((d) => d.online && d.id !== self).map((d) => d.id));
  const held = new Map(host.mine.map((r) => [r.id, r]));
  const best = new Map<string, NestIndexRow>();
  for (const r of host.others) {
    if (!up.has(r.desk) || r.owner === self || held.get(r.id)?.owner === self) continue;
    const had = best.get(r.id);
    if (!had || r.seq > had.seq) best.set(r.id, r);
  }
  return [...best.values()]
    .filter((r) => {
      const have = held.get(r.id)?.seq ?? -1;
      if (r.state !== 'closed') return true;
      const was = seen.get(r.id);
      return r.seq > have && (have >= 0 || (was !== undefined && r.seq > was));
    })
    .sort((x, y) => y.lastAt - x.lastAt);
}

export class NestTail {
  private running = false;
  private again = false;
  private readonly seen = new Map<string, number>();
  /** Chat -> the `have` its last tail pull ended at (the index rows lag until the next sync). */
  private readonly got = new Map<string, number>();
  private readonly spent: Array<{ at: number; bytes: number }> = [];

  constructor(private readonly host: TailHost, private readonly now: () => number = Date.now) {}

  public home(): boolean {
    return this.host.devices().some((d) => d.self && d.motherBase);
  }

  /** One run, on the mother base only. A call during a run asks for one more after it. */
  public async run(): Promise<void> {
    if (!this.home()) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
    this.host.changed();
    let grew = false;
    try {
      const queue = tailQueue(this.host, this.seen);
      for (const r of this.host.others) this.seen.set(r.id, Math.max(r.seq, this.seen.get(r.id) ?? -1));
      const budget = this.budget();
      for (const row of queue) {
        if (budget.left < budget.reserve) break;
        const source = pullSource(this.host.others, this.host.devices(), row.id, row.owner, this.host.deviceId());
        if (!source) continue;
        const was = this.got.get(row.id) ?? this.host.mine.find((r) => r.id === row.id)?.seq ?? -1;
        try {
          const have = await pullSession(this.host, row.id, row.owner, source, budget);
          this.got.set(row.id, have);
          if (have > was) grew = true;
        } catch (e) {
          this.host.status?.(`nest tail: ${row.id} ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.spent.push({ at: this.now(), bytes: budget.spent });
    } finally {
      this.running = false;
      this.host.changed();
      if (grew) this.host.touch();
    }
    if (this.again) { this.again = false; await this.run(); }
  }

  /** The bytes this run may use: the per-run bound, cut to what the minute has left. */
  private budget(): PullBudget {
    const now = this.now();
    while (this.spent.length && now - this.spent[0]!.at >= MINUTE_MS) this.spent.shift();
    const minute = TAIL_MINUTE_BYTES - this.spent.reduce((n, s) => n + s.bytes, 0);
    return { left: Math.max(0, Math.min(TAIL_RUN_BYTES, minute)), spent: 0, reserve: TAIL_RESERVE };
  }

  /** Null off the mother base. Per OWNER desk: chats held here, and how many hold less than it has. */
  public status(): TailStatus | null {
    if (!this.home()) return null;
    const self = this.host.deviceId();
    const held = new Map(this.host.mine.map((r) => [r.id, r.seq]));
    const top = new Map<string, NestIndexRow>();
    for (const r of this.host.others) if (r.owner !== self && r.seq > (top.get(r.id)?.seq ?? -2)) top.set(r.id, r);
    const desks: Record<string, TailDesk> = {};
    for (const r of top.values()) {
      const have = Math.max(held.get(r.id) ?? -1, this.got.get(r.id) ?? -1);
      if (have < 0) continue;
      const d = (desks[r.owner] ??= { tailed: 0, behind: 0 });
      d.tailed += 1;
      if (have < r.seq) d.behind += 1;
    }
    return { running: this.running, desks };
  }
}

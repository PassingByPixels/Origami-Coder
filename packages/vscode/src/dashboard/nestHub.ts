// nestHub.ts — t-sc093o: the host side of Nests, between the engine's nest
// methods (nestContract.ts) and the desks on the group link (nestWire.ts).
//
//   index   nest_index -> nest/index {rows} to every online desk, on a desk
//           arriving and every 30 s; a received nest/index -> nest_apply_index.
//           The webview gets the OTHER desks' rows (origami/nestIndex).
//   pull    nest_import (probe) -> nest/export-request -> the peer runs
//           nest_export -> nest/chunk -> nest_import, until done. Resumable:
//           `have` is the receiver's store, so a broken pull starts from there.
//   take    pull, then nest_continue (L5). "taken" -> nest/release {seq} to the
//           old owner, now or when it comes back online; it runs nest_release
//           and, if it wrote past that seq, nest_reconcile (nestRelease.ts).
//   tail    L6 (t-selspn, nestTail.ts): after each index merge the mother base
//           pulls every live chat; a local change sends the index within 2 s.
//   artifacts  t-sj39jx (nestArtifacts.ts): the artifact index rides every sync; bodies pull on open.
//   away   t-t7lfho (nestAway.ts): a release records the chat as continued on the new desk and posts it at once; Take back here is continueHere on this desk, which clears it.
//
// Two attach points: the group (activateGroup.ts, when the controller exists)
// and the view (nestSidebar.ts, the panel's engine client and its broadcast).

import { NestUnwrap } from './nestUnwrap';
import { NestAway } from './nestAway';
import type { GroupDeviceView } from '../remote/groupSnapshot';
import { NEST_CHUNK, NEST_EXPORT_REQUEST, NEST_INDEX, NEST_RELEASE, nestFrames, readNestMessage, type NestPeerMessage } from '../remote/nestWire';
import { isMissingMethod, type NestContinueResult, type NestExportResult, type NestImportResult, type NestIndexResult, type NestIndexRow } from './nestContract';
import { releaseHere } from './nestRelease';
import { probeChunk, pullSession, pullSource } from './nestPull';
import { localChange, NestTail, ownerDesk, viewRows } from './nestTail';
import { NestArtifacts } from './nestArtifacts';
import { isNestArtifactMessage, type NestArtifactMessage } from '../remote/nestArtifactWire';
import { NestReplies } from './nestReplies';

export const NEST_SYNC_MS = 30_000;
/** t-selspn: a local change (a new chat, a retitle, a turn end) reaches the other desks within this. */
export const NEST_TOUCH_MS = 2_000;
export const NEST_PULL_WAIT_MS = 20_000;
/** Events per nest_export reply: most chunks then fit one 32 KB frame part. */
export const NEST_CHUNK_BYTES = 24_000;

export interface NestEngine {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface NestGroup {
  deviceId(): string | null;
  deskName: string;
  devices(): GroupDeviceView[];
  send(peerId: string, msg: Record<string, unknown>): void;
}
export interface NestView {
  engine(): NestEngine | undefined;
  post(msg: Record<string, unknown>): void;
  open(sessionId: string): void | Promise<void>;
  openSessionIds?(): string[]; // t-xsrtml: engine session ids of every chat open in this window (live or parked)
}
export interface NestHubDeps {
  enabled(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  status?(text: string): void;
  now?: () => number;
}

const NO_ENGINE = 'Open a chat first. The nest is read through a live engine connection.';
const NO_ID = 'This desk has no device id until it starts or joins a nest.';

export class NestHub {
  private group: NestGroup | null = null;
  private view: NestView | null = null;
  public others: NestIndexRow[] = [];
  public mine: NestIndexRow[] = [];
  public readonly tail: NestTail; // L6: the mother base's tail of every live chat (nestTail.ts)
  public readonly artifacts: NestArtifacts; // t-sj39jx: artifacts in the nest (nestArtifacts.ts)
  private soon: unknown = null;
  private online = new Set<string>();
  private timer: unknown = null;
  private readonly frames = new NestUnwrap();
  public readonly away = new NestAway(); // t-t7lfho: chats this desk gave to another desk (nestAway.ts)
  private readonly replies: NestReplies<NestExportResult>; // several waiters per peer + chat (nestReplies.ts)
  /** Old owner -> chats this desk took while it was offline (and the seq and time taken at): released on its return. */
  private readonly releases = new Map<string, Map<string, [number, number]>>();
  /** Chat -> the owner this desk took it from: its old rows are stale until that desk re-sends. */
  private readonly taken = new Map<string, string>();

  constructor(private readonly deps: NestHubDeps) { this.tail = new NestTail(this, deps.now); this.replies = new NestReplies(deps); this.artifacts = new NestArtifacts(this, { ...deps, post: (m) => this.view?.post(m) }); }

  public attachGroup(group: NestGroup | null): void {
    this.group = group;
    this.online = new Set(this.peers());
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    if (group) this.arm();
  }

  public attachView(view: NestView): void {
    this.view = view;
  }

  public deviceId(): string | null {
    return this.group?.deviceId() ?? null;
  }

  /** One engine call, gated the way the engine gates it. */
  public async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const engine = this.view?.engine();
    if (!engine) throw new Error(NO_ENGINE);
    const deviceId = this.deviceId();
    if (!deviceId) throw new Error(NO_ID);
    return (await engine.extMethod(method, { ...params, enabled: this.deps.enabled(), deviceId })) as T;
  }

  private arm(): void {
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.sync().then(() => void this.tail.run()).catch((e) => this.say('index', e)).finally(() => {
        if (this.group && this.timer === null) this.arm();
      });
    }, NEST_SYNC_MS);
  }

  private peers(): string[] {
    const self = this.deviceId();
    return (this.group?.devices() ?? []).filter((d) => d.online && d.id !== self).map((d) => d.id);
  }

  public devices(): GroupDeviceView[] {
    return this.deps.enabled() ? (this.group?.devices() ?? []) : [];
  }

  /** The other desks' chats, one row per chat: the owner's copy when its desk
   *  sent one, else the newest copy. A chat this desk owns is Here, not Nest. */
  public rows(): NestIndexRow[] {
    return viewRows(this.others, this.deviceId(), this.taken, this.devices());
  }

  public payload(): Record<string, unknown> {
    const on = this.deps.enabled() && !!this.group;
    return { type: 'origami/nestIndex', rows: on ? this.rows() : [], desks: on ? this.devices() : [], tail: on ? this.tail.status() : null, away: on ? this.away.list() : [] };
  }

  public changed(): void { this.view?.post(this.payload()); }
  public status(text: string): void { this.deps.status?.(text); }

  public onLocalPost(m: { type?: unknown }): void { if (localChange(m)) this.touch(); }
  /** t-selspn: this desk's index changed. Sent once within NEST_TOUCH_MS, whatever the burst; the 30 s tick stays. */
  public touch(): void {
    if (this.soon !== null || !this.group) return;
    this.soon = this.deps.setTimer(() => { this.soon = null; void this.sync().catch((e) => this.say('index', e)); }, NEST_TOUCH_MS);
  }

  /** nest_index; send this desk's rows to `to` (default: every online desk); push the view. */
  public async sync(to: string[] = this.peers()): Promise<void> {
    if (!this.deps.enabled() || !this.group) return;
    const r = await this.call<NestIndexResult>('nest_index', { deskName: this.group.deskName, open: this.view?.openSessionIds?.() ?? [] });
    this.others = Array.isArray(r.others) ? r.others : [];
    this.mine = Array.isArray(r.rows) ? r.rows : [];
    for (const peer of to) this.sendTo(peer, { type: NEST_INDEX, rows: this.mine });
    this.view?.post(this.payload());
    void this.artifacts.sync(to, this.group?.deskName ?? '').catch((e) => this.say('artifacts', e));
  }

  /** The roster moved: a desk that came online gets this desk's rows and any release it missed. */
  public onGroupChange(): void {
    const now = new Set(this.peers());
    const arrived = [...now].filter((p) => !this.online.has(p));
    this.online = now;
    for (const peer of arrived) {
      for (const [sessionId, [seq, at]] of this.releases.get(peer) ?? []) this.sendTo(peer, this.releaseMessage(sessionId, seq, at));
      this.releases.delete(peer);
    }
    if (arrived.length) void this.sync(arrived).catch((e) => this.say('index', e));
    else this.view?.post(this.payload());
  }

  public sendTo(peerId: string, msg: NestPeerMessage | NestArtifactMessage): void {
    for (const frame of nestFrames(msg)) this.group?.send(peerId, frame);
  }

  public async onPeer(peerId: string, raw: Record<string, unknown>): Promise<void> {
    if (!this.deps.enabled()) return;
    const whole = this.frames.unwrap(peerId, raw);
    if (whole && isNestArtifactMessage(whole)) return this.artifacts.onPeer(peerId, whole).catch((e) => this.say('artifacts', e));
    const m = whole && readNestMessage(whole);
    if (!m) return;
    try {
      if (m.type === NEST_INDEX) {
        await this.call('nest_apply_index', { desk: peerId, rows: m.rows, replace: true });
        await this.sync([]);
        void this.tail.run();
      } else if (m.type === NEST_EXPORT_REQUEST) {
        const chunk = await this.call<NestExportResult>('nest_export', { sessionId: m.sessionId, after: m.after, maxBytes: NEST_CHUNK_BYTES });
        this.sendTo(peerId, { type: NEST_CHUNK, chunk: chunk as unknown as Record<string, unknown> });
      } else if (m.type === NEST_CHUNK) {
        this.replies.answer(waitKey(peerId, String(m.chunk['sessionId'])), m.chunk as unknown as NestExportResult);
      } else if (m.newOwner === peerId) {
        // Only the desk that took the chat may say so: a third desk cannot release it for another.
        await releaseHere(this, m.sessionId, m.newOwner, m.seq, () => this.lost(m.sessionId, m.newOwner, m.at));
        await this.sync();
      }
    } catch (e) {
      this.say(m.type, e);
    }
  }

  /** t-t7lfho: the chat left this desk. Posted now, not on the new owner's next index; this
   *  desk's own take of it (if any) is over, so the new owner's rows count again. */
  private lost(id: string, desk: string, at: number | undefined): void {
    this.away.set(id, desk, at ?? this.now());
    this.taken.delete(id);
    this.changed();
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** Ask `peerId` for `sessionId` after `after`; the reply is its nest/chunk. */
  public request(peerId: string, sessionId: string, after: number): Promise<NestExportResult> {
    const reply = this.replies.wait(waitKey(peerId, sessionId), NEST_PULL_WAIT_MS);
    this.sendTo(peerId, { type: NEST_EXPORT_REQUEST, sessionId, after });
    return reply;
  }

  /** Continue here: pull the body, then nest_continue decides take-over or fork. */
  public async continueHere(id: string): Promise<{ result: 'taken' | 'forked'; newId: string }> {
    const row = this.rows().find((r) => r.id === id);
    if (!row) throw new Error('That chat is not in the nest index.');
    const owner = ownerDesk(row, this.devices()); // t-t7l3pa: an unknown owner reads as the desk that has it open
    const ownerOnline = !!owner?.online;
    const ownerRow = this.others.find((r) => r.id === id && r.desk === owner?.id);
    const ownerRunning = ownerOnline && ownerRow?.state === 'running';
    const source = pullSource(this.others, this.devices(), id, row.owner, this.deviceId());
    if (source) await pullSession(this, id, row.owner, source);
    let r: NestContinueResult;
    try {
      r = await this.call<NestContinueResult>('nest_continue', { sessionId: id, ownerOnline, ownerRunning });
    } catch (e) {
      if (isMissingMethod(e)) throw new Error('This engine cannot continue a chat from another desk yet (nest_continue is not in this build).');
      throw e;
    }
    if ('refused' in r) throw new Error('This desk holds no copy of that chat, and no desk that holds one is online.');
    if (r.result === 'taken') {
      this.taken.set(id, row.owner);
      this.away.clear(id); // t-t7lfho: Take back here ends "continued on <desk>" here
      const at = this.now();
      if (ownerOnline) this.sendTo(row.owner, this.releaseMessage(id, r.seq, at));
      else this.releases.set(row.owner, new Map([...(this.releases.get(row.owner) ?? []), [id, [r.seq, at]]]));
    }
    await this.sync();
    await this.view?.open(r.sessionId);
    return { result: r.result, newId: r.sessionId };
  }

  /** A plain click: bring the body here if a desk that holds it is online, then open it. */
  public async openRead(id: string): Promise<void> {
    const row = this.rows().find((r) => r.id === id);
    if (!row) throw new Error('That chat is not in the nest index.');
    const source = pullSource(this.others, this.devices(), id, row.owner, this.deviceId());
    if (source) await pullSession(this, id, row.owner, source);
    else {
      const probe = await this.call<NestImportResult>('nest_import', { chunk: probeChunk(id, row.owner) });
      if (probe.have < 0) throw new Error('No desk that holds this chat is online.');
    }
    await this.view?.open(id);
  }

  private releaseMessage(sessionId: string, seq: number, at: number): NestPeerMessage {
    return { type: NEST_RELEASE, sessionId, newOwner: this.deviceId() ?? '', seq, at };
  }

  private say(what: string, e: unknown): void {
    this.deps.status?.(`nest ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function waitKey(peerId: string, sessionId: string): string {
  return `${peerId} ${sessionId}`;
}

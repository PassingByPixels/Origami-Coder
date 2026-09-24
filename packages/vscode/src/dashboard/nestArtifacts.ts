// nestArtifacts.ts — t-sj39jx (artifacts lane 4): artifacts travel in the nest
// the way chats do. One per NestHub, over the hub's engine client and group link.
//
//   index  nest_artifact_index -> nest/artifact-index {rows} whenever the hub
//          sends its chat index (a desk arriving, a local change within 2 s,
//          the 30 s tick); a received one -> nest_artifact_apply.
//   open   the pane's Open on an artifact another desk holds newer: ask that
//          desk for the manifest, import it, then fetch each MISSING blob in
//          base64 pieces (nest_artifact_export / _import), then import again.
//          Resumable: each blob's `have` is what this desk's store holds.
//   bound  ARTIFACT_MINUTE_BYTES a minute; a pull waits when the minute is spent.
//
// Everything is inert while `origamicoder.nests.enabled` is off: no call, no
// send, and merge() hands the pane its rows unchanged.

import type { GroupDeviceView } from '../remote/groupSnapshot';
import {
  NEST_ARTIFACT_CHUNK, NEST_ARTIFACT_INDEX, NEST_ARTIFACT_REQUEST, readNestArtifactMessage, type NestArtifactMessage,
} from '../remote/nestArtifactWire';
import { artifactSource, mergeNestArtifacts, nestArtifactRows, nestBest, type NestArtifactRow } from './nestArtifactRows';
import { namedDevice, rosterMotherBase } from './nestOwnRows';
import { NestReplies, type ReplyTimers } from './nestReplies';

/** Raw bytes per piece: base64 plus the envelope stays under one 32 KB frame part. */
export const ARTIFACT_PIECE_BYTES = 24_000;
/** Bytes pulled in any 60 s: half the relay's 2 MiB/min live lane (the chat tail has the other half). */
export const ARTIFACT_MINUTE_BYTES = 1024 * 1024;
export const ARTIFACT_WAIT_MS = 20_000;
const MINUTE_MS = 60_000;
const STALLS = 3;

export interface ArtifactHubHost {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  sendTo(peerId: string, msg: NestArtifactMessage): void;
  deviceId(): string | null;
  devices(): GroupDeviceView[];
}
export interface ArtifactDeps extends ReplyTimers {
  enabled(): boolean;
  now?: () => number;
  /** To the webview: `origami/nestArtifacts` when the other desks' rows moved. */
  post?(msg: Record<string, unknown>): void;
}

type Missing = { sha256: string; size: number; have: number };
type Imported = { result?: string; missing?: Missing[]; refused?: string; have?: number };

export class NestArtifacts {
  public others: NestArtifactRow[] = [];
  public mine: NestArtifactRow[] = [];
  private deskName = '';
  private seen = '';
  /** id -> the latest version this desk's store listed at the pane's last read. */
  private local = new Map<string, number>();
  private readonly replies: NestReplies<Record<string, unknown>>;
  private readonly spent: Array<{ at: number; bytes: number }> = [];
  private readonly now: () => number;

  constructor(private readonly hub: ArtifactHubHost, private readonly deps: ArtifactDeps) {
    this.replies = new NestReplies(deps);
    this.now = deps.now ?? Date.now;
  }

  /** A host with no settings store (a unit test's vscode stub) reads as off, as in nestSidebar.ts. */
  private on(): boolean {
    try {
      return this.deps.enabled() && !!this.hub.deviceId();
    } catch {
      return false;
    }
  }

  /** This desk's id and the roster, with Nests off too; a host that cannot say reads as none. */
  private who(): { self: string | null; desks: GroupDeviceView[] } {
    try { return { self: this.hub.deviceId(), desks: this.hub.devices() }; } catch { return { self: null, desks: [] }; }
  }

  /** t-v7i2au: each version's `device` (an id) as the pane should print it. */
  public nameVersions(versions: Record<string, unknown>[]): Record<string, unknown>[] {
    const w = this.who();
    return versions.map((v) => namedDevice(v, 'device', w.self, w.desks));
  }

  /** t-vbj8xu: the roster's mother base for the pane's labels; none while Nests is off. */
  public motherBase(): { self: boolean; name: string } | undefined { return this.on() ? rosterMotherBase(this.who().desks) : undefined; }

  /** nest_artifact_index; send this desk's rows to `to`; tell the pane when the others' rows moved. */
  public async sync(to: string[], deskName = this.deskName): Promise<void> {
    if (!this.on()) return;
    this.deskName = deskName;
    const r = await this.hub.call<{ rows?: unknown; others?: unknown }>('nest_artifact_index', { deskName });
    this.mine = nestArtifactRows(r.rows);
    this.others = nestArtifactRows(r.others);
    for (const peer of to) this.hub.sendTo(peer, { type: NEST_ARTIFACT_INDEX, rows: this.mine });
    const now = JSON.stringify(this.others);
    if (now !== this.seen) { this.seen = now; this.deps.post?.({ type: 'origami/nestArtifacts' }); }
  }

  public async onPeer(peerId: string, raw: Record<string, unknown>): Promise<void> {
    const m = readNestArtifactMessage(raw);
    if (!m || !this.on()) return;
    if (m.type === NEST_ARTIFACT_INDEX) {
      await this.hub.call('nest_artifact_apply', { desk: peerId, rows: m.rows, replace: true });
      await this.sync([]);
    } else if (m.type === NEST_ARTIFACT_REQUEST) {
      const { artifactId, version, sha256 } = m;
      const params = sha256 ? { artifactId, version, sha256, offset: m.offset, maxBytes: ARTIFACT_PIECE_BYTES } : { artifactId, version };
      const chunk = await this.hub.call<Record<string, unknown>>('nest_artifact_export', params)
        .catch(() => ({ refused: 'not-found' }));
      this.hub.sendTo(peerId, { type: NEST_ARTIFACT_CHUNK, chunk: { ...chunk, artifactId, version, ...(sha256 ? { sha256 } : {}) } });
    } else {
      const c = m.chunk;
      this.replies.answer(key(peerId, String(c['artifactId']), Number(c['version']), c['sha256']), c);
    }
  }

  /** The pane's rows with the nest's merged in. With Nests off only the owner ids are named (nestOwnRows.ts). */
  public merge(local: Record<string, unknown>[]): Record<string, unknown>[] {
    this.local = new Map(local.map((r) => [String(r['id'] ?? ''), Number(r['latest'] ?? 0)]));
    const w = this.who();
    return mergeNestArtifacts(local, this.on() ? this.others : [], w.desks, w.self);
  }

  /** Before an Open: pull the version another desk holds when this desk's store lacks it. */
  public async ensure(artifactId: string, version?: number): Promise<void> {
    if (!this.on()) return;
    const best = nestBest(this.others, this.hub.deviceId()).get(artifactId);
    const want = version ?? best?.version ?? 0;
    if (!best || want <= (this.local.get(artifactId) ?? (await this.held(artifactId)))) return;
    await this.pull(artifactId, want, best.owner);
  }

  /** The latest version this desk's store holds, for an Open that did not come from the pane's list (a chat card). */
  private async held(artifactId: string): Promise<number> {
    const r = await this.hub.call<{ versions?: Array<{ number?: unknown }> }>('artifact_versions', { artifactId }).catch(() => ({ versions: [] }));
    const top = r.versions?.[0]?.number;
    return typeof top === 'number' ? top : 0;
  }

  public async pull(artifactId: string, version: number, owner: string): Promise<void> {
    const source = artifactSource(this.others, this.hub.devices(), artifactId, version, this.hub.deviceId());
    if (!source) throw new Error('No desk that holds this artifact is online.');
    const deskName = this.hub.devices().find((d) => d.id === owner)?.name ?? '';
    const manifest = await this.ask(source, { artifactId, version });
    if ('refused' in manifest) throw new Error('The other desk no longer holds that version.');
    let r = await this.hub.call<Imported>('nest_artifact_import', { chunk: manifest, deskName });
    if (r.result === 'missing') {
      for (const blob of r.missing ?? []) await this.pullBlob(source, artifactId, version, blob);
      r = await this.hub.call<Imported>('nest_artifact_import', { chunk: manifest, deskName });
    }
    if (r.refused) throw new Error(`The artifact could not be imported (${r.refused}).`);
    if (r.result === 'missing') throw new Error('The artifact is still missing files.');
    this.local.set(artifactId, Math.max(version, this.local.get(artifactId) ?? 0));
  }

  private async pullBlob(source: string, artifactId: string, version: number, blob: Missing): Promise<void> {
    let have = blob.have;
    let stalls = 0;
    while (have < blob.size) {
      await this.room();
      const piece = await this.ask(source, { artifactId, version, sha256: blob.sha256, offset: have });
      this.spend(piece);
      if ('refused' in piece) throw new Error('The other desk no longer holds that file.');
      const got = await this.hub.call<Imported>('nest_artifact_import', { chunk: piece });
      if (got.refused && got.refused !== 'gap') throw new Error(`A file failed its check (${got.refused}).`);
      const next = got.have ?? have;
      stalls = next > have ? 0 : stalls + 1;
      if (stalls >= STALLS) throw new Error('The pull made no progress.');
      have = next;
    }
  }

  private ask(peer: string, req: { artifactId: string; version: number; sha256?: string; offset?: number }): Promise<Record<string, unknown>> {
    const reply = this.replies.wait(key(peer, req.artifactId, req.version, req.sha256), ARTIFACT_WAIT_MS);
    this.hub.sendTo(peer, { type: NEST_ARTIFACT_REQUEST, ...req });
    return reply;
  }

  private spend(piece: Record<string, unknown>): void {
    this.spent.push({ at: this.now(), bytes: new TextEncoder().encode(JSON.stringify(piece)).length });
  }

  /** Wait until the last 60 s used less than the minute budget. */
  private async room(): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.spent.length && now - this.spent[0]!.at >= MINUTE_MS) this.spent.shift();
      if (this.spent.reduce((n, s) => n + s.bytes, 0) < ARTIFACT_MINUTE_BYTES) return;
      const wait = this.spent[0]!.at + MINUTE_MS - now;
      await new Promise<void>((resolve) => this.deps.setTimer(resolve, wait));
    }
  }
}

function key(peer: string, artifactId: string, version: number, sha256: unknown): string {
  return `${peer} ${artifactId} ${version} ${typeof sha256 === 'string' ? sha256 : 'manifest'}`;
}

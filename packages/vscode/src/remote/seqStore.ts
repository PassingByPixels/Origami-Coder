// THE SEQUENCE NUMBER OUTLIVES THE WINDOW.
//
// The wire spec puts a `seq` in every frame header — per sender, starts at 1,
// strictly increasing — and both ends reject a frame whose seq is not newer
// than the last accepted from that role. That rule is the only thing between a
// captured frame and a replay. What was wrong is WHERE the counter lived:
// `FrameCodec` is built in `RemoteController.open()`, so it restarted at 1
// every time a window opened the pairing, and the pairing is what persists.
//
// So the marks live in `globalState`. WRITES ARE RARE BY DESIGN: a window
// RESERVES a block of `BLOCK` seqs on open and writes again only when it
// reaches it. A window that dies mid-block leaves a gap, which is legal.

import { ROLE_DESKTOP, type Role } from './frame';
import { FrameCodec } from './frameCodec';
import type { RemoteKey } from './crypto';

/** The `vscode.Memento` surface this needs, structurally. */
export interface SeqMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface SeqMarks {
  /** Highest outbound seq any window on this machine has reserved. */
  out: number;
  /** Highest inbound seq any window on this machine has ACCEPTED. */
  in: number;
}

export const SEQ_KEY = 'origami.remote.seqMarks';

/** How many frames a window claims per write. Big enough that a normal session
 *  writes once, small enough that the header's uint32 is nowhere near exhausted. */
export const BLOCK = 4_096;

let store: SeqMemento | null = null;

export function registerRemoteSeq(next: SeqMemento | null): void {
  store = next;
}

/** Test hook: back to a window that never activated Remote. */
export function resetRemoteSeq(): void {
  store = null;
}

function all(): Record<string, SeqMarks> {
  const raw = store?.get<unknown>(SEQ_KEY, undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, SeqMarks> = {};
  for (const [rid, value] of Object.entries(raw as Record<string, unknown>)) {
    const rec = value as Partial<SeqMarks> | null;
    // A malformed record is treated as ABSENT, not repaired: a seq trusted
    // blindly is a pairing that can never send again.
    if (!rec || typeof rec.out !== 'number' || typeof rec.in !== 'number') continue;
    if (rec.out < 0 || rec.in < 0) continue;
    out[rid] = { out: rec.out, in: rec.in };
  }
  return out;
}

function write(rid: string, marks: SeqMarks): void {
  if (!store) return;
  const next = all();
  next[rid] = marks;
  void store.update(SEQ_KEY, next);
}

export function marksFor(rid: string): SeqMarks {
  return all()[rid] ?? { out: 0, in: 0 };
}

/**
 * Claim the next block for this pairing and answer the seq to CARRY ON FROM —
 * the last seq considered used, so the codec's first frame is `start + 1`.
 */
export function reserveOut(rid: string): number {
  const marks = marksFor(rid);
  write(rid, { out: marks.out + BLOCK, in: marks.in });
  return marks.out;
}

/** Called with every outbound seq. Writes only when the reservation runs out. */
export function noteOut(rid: string, seq: number): void {
  if (!store) return;
  const marks = marksFor(rid);
  if (seq < marks.out) return;
  write(rid, { out: seq + BLOCK, in: marks.in });
}

/** Called when a frame from the peer is ACCEPTED. Written EXACTLY, unlike `out`:
 *  this mark is the `?after=` a new window asks the relay for, and one that lags
 *  makes that window re-run the prompts still in the ring. */
export function noteIn(rid: string, seq: number): void {
  if (!store) return;
  const marks = marksFor(rid);
  if (seq <= marks.in) return;
  write(rid, { out: marks.out, in: seq });
}

/** Revoke rotates Ks and the rid, so the old marks are dead weight. */
export function forgetSeq(rid: string | null): void {
  if (!store || !rid) return;
  const next = all();
  if (!(rid in next)) return;
  delete next[rid];
  void store.update(SEQ_KEY, next);
}

/** A codec for one rid in whichever of the relay's two roles this machine
 *  holds, carrying on from wherever it left off. The ONE place that knows a
 *  codec has to be resumed. A device-group link takes the role its device id
 *  order gives it, so the role is a parameter; the phone lane is always the
 *  desktop and calls `desktopCodec` below. */
export function linkCodec(key: RemoteKey, rid: string, role: Role): FrameCodec {
  const marks = marksFor(rid);
  return new FrameCodec(key, rid, role, reserveOut(rid), marks.in, (seq) => noteOut(rid, seq));
}

/** The desktop's codec for a pairing. */
export function desktopCodec(key: RemoteKey, rid: string): FrameCodec {
  return linkCodec(key, rid, ROLE_DESKTOP);
}

// WHICH VS CODE WINDOW OWNS THE PHONE.
//
// The relay allows exactly ONE socket per role per rid and hands the old one
// close 4001 when a new one claims the slot, so every window that restored the
// same pairing took the slot from the others in a loop.
//
// So a window ASKS before it opens. The lease is a record per rid in
// `context.globalState` — the store every window shares — carrying the holder's
// window id and its last heartbeat. A lease unbeaten for STALE_MS is free.
//
// IT IS ADVISORY, NOT A LOCK: globalState has no compare-and-set, so every
// claim re-reads after writing and stands down if it finds another id, and the
// relay's 4001 remains the backstop.

/** The `vscode.Memento` surface this needs, structurally. */
export interface LeaseStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface LeaseRecord {
  windowId: string;
  /** Epoch ms of the holder's last heartbeat. */
  heartbeatAt: number;
}

export const LEASE_KEY = 'origami.remote.ownerLease';

/** How often the holder says it is alive. */
export const HEARTBEAT_MS = 5_000;

/** Three missed beats: fast hand-over, but a busy host is never declared dead. */
export const STALE_MS = 15_000;

export interface LeaseHooks {
  now?: () => number;
  /** Called once when a heartbeat finds another window in our slot. */
  onLost?: (rid: string) => void;
}

let store: LeaseStore | null = null;
let windowId = '';
let now: () => number = () => Date.now();
let onLost: ((rid: string) => void) | null = null;
/** The rids this window holds. Local truth; the store is the shared one. A SET
 *  (t-xum9r8): the phone pairing and each desk link are separate rids, and a
 *  single slot beat only the last one claimed, so the others went stale. */
const held = new Set<string>();
/** Claims refused because a live record named another window, with the call
 *  that asks again. Retried on the heartbeat (t-xum9r8): at an extension-host
 *  restart the old window's release is lost and its record lives STALE_MS on. */
const waiting = new Map<string, () => void>();

export function registerOwnerLease(next: LeaseStore | null, id: string, hooks: LeaseHooks = {}): void {
  store = next;
  windowId = id;
  now = hooks.now ?? (() => Date.now());
  onLost = hooks.onLost ?? null;
  held.clear();
  waiting.clear();
}

/** Test hook: put the module back to a window that never activated Remote. */
export function resetOwnerLease(): void {
  store = null;
  windowId = '';
  now = () => Date.now();
  onLost = null;
  held.clear();
  waiting.clear();
}

/** Every lease in the store. A malformed record is treated as ABSENT rather
 *  than trusted — a record trusted blindly is a pairing no window could open. */
function all(): Record<string, LeaseRecord> {
  const raw = store?.get<unknown>(LEASE_KEY, undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, LeaseRecord> = {};
  for (const [rid, value] of Object.entries(raw as Record<string, unknown>)) {
    const record = value as Partial<LeaseRecord> | null;
    if (!record || typeof record.windowId !== 'string' || typeof record.heartbeatAt !== 'number') continue;
    out[rid] = { windowId: record.windowId, heartbeatAt: record.heartbeatAt };
  }
  return out;
}

/** A record still counts as somebody's while it is being beaten. */
function live(record: LeaseRecord | undefined): boolean {
  return record !== undefined && now() - record.heartbeatAt < STALE_MS;
}

/** True ONLY when a live lease names a different window. No store, no lease, a
 *  stale lease and our own all answer false. */
export function ownedElsewhere(rid: string | null): boolean {
  if (!store || !rid) return false;
  const record = all()[rid];
  return live(record) && record!.windowId !== windowId;
}

export function holdsLease(rid: string | null): boolean {
  return rid !== null && held.has(rid);
}

async function write(rid: string): Promise<boolean> {
  const leases = all();
  leases[rid] = { windowId, heartbeatAt: now() };
  // Only live leases are carried forward, so dead records do not accumulate.
  for (const [key, record] of Object.entries(leases)) {
    if (key !== rid && !live(record)) delete leases[key];
  }
  await store!.update(LEASE_KEY, leases);
  // RE-READ, and FAIL OPEN. Two windows can pass the check in the same tick, so
  // the one whose write landed second owns the slot. But a read that comes back
  // with NO record is a store that did not persist, and refusing there would
  // leave Remote dead in every window — absent means "nobody said otherwise".
  const confirmed = all()[rid];
  const ours = confirmed === undefined || confirmed.windowId === windowId;
  if (ours) {
    held.add(rid);
    waiting.delete(rid);
  } else held.delete(rid);
  return ours;
}

/** Take this pairing if it is free, stale, or already ours. False = another
 *  window owns it; `onFree` is then called on the first heartbeat that finds the
 *  record free again, and the caller claims once more. */
export async function claimLease(rid: string, onFree?: () => void): Promise<boolean> {
  if (!store || !rid) return true;
  const record = all()[rid];
  if (live(record) && record!.windowId !== windowId) {
    if (onFree) waiting.set(rid, onFree);
    return false;
  }
  return write(rid);
}

/** The Take over button: claim a lease that IS live in another window. */
export async function takeLease(rid: string): Promise<boolean> {
  if (!store || !rid) return true;
  return write(rid);
}

/** Give every held pairing up so the next window claims it within one heartbeat. */
export async function releaseLease(): Promise<void> {
  const rids = [...held];
  held.clear();
  waiting.clear();
  if (!store || rids.length === 0) return;
  const leases = all();
  const ours = rids.filter((rid) => leases[rid]?.windowId === windowId);
  if (ours.length === 0) return;
  for (const rid of ours) delete leases[rid];
  await store.update(LEASE_KEY, leases);
}

/** One beat. Refreshes each record we hold, or drops that claim and says so
 *  ONCE; then asks again for every refused claim whose record is now free. */
export async function leaseHeartbeat(): Promise<void> {
  if (!store) return;
  for (const rid of [...held]) {
    const record = all()[rid];
    if (record && record.windowId !== windowId) {
      held.delete(rid);
      onLost?.(rid);
      continue;
    }
    await write(rid);
  }
  for (const [rid, retry] of [...waiting]) {
    if (ownedElsewhere(rid)) continue;
    waiting.delete(rid);
    retry();
  }
}

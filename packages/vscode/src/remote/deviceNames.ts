// A human-readable name for a paired phone, stored desktop-side against its rid.
//
// THE PHONE NEVER SENDS ONE: the pairing is anonymous and the rid is the only
// handle the wire carries, so a name can only be something the desktop was told.
// It lives in globalState, NOT secrets — a name is not a credential, and the
// pairing SECRET stays in `context.secrets` (pairing.ts). Registered by
// activate.ts, so a window that never activated Remote answers "no name".

/** The `vscode.Memento` surface this needs, structurally. */
export interface DeviceNameStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

const KEY = 'origami.remote.deviceNames';

/** A name is a LABEL: one line, trimmed, short enough not to break the row. */
export const DEVICE_NAME_MAX = 40;

let store: DeviceNameStore | null = null;

export function registerDeviceNames(next: DeviceNameStore | null): void {
  store = next;
}

/** Test hook: put the module back to a window that never activated Remote. */
export function resetDeviceNames(): void {
  store = null;
}

/** Every stored name. A value that is not an object of strings is treated as
 *  absent — globalState is a file another build could have left in any shape. */
function all(): Record<string, string> {
  const raw = store?.get<unknown>(KEY, undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [rid, name] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name === 'string' && name.trim()) out[rid] = name;
  }
  return out;
}

export function cleanDeviceName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, DEVICE_NAME_MAX) : '';
}

/** The name for this pairing, or '' — the pane turns '' into the rid prefix. */
export function deviceNameFor(rid: string | null): string {
  if (!rid) return '';
  return all()[rid] ?? '';
}

/** Name a pairing. An empty name FORGETS it rather than storing a blank. */
export async function setDeviceName(rid: string, name: unknown): Promise<void> {
  if (!store || !rid) return;
  const clean = cleanDeviceName(name);
  const names = all();
  if (clean) names[rid] = clean;
  else delete names[rid];
  await store.update(KEY, names);
}

/** Drop a name when its pairing is revoked: a rid is derived fresh from a new
 *  Ks, so a kept name can never match anything again. */
export async function forgetDeviceName(rid: string | null): Promise<void> {
  if (!store || !rid) return;
  const names = all();
  if (!(rid in names)) return;
  delete names[rid];
  await store.update(KEY, names);
}

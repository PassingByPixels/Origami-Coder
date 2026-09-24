// nestStoragePane.ts — the Nests view's Storage card, host half (t-s9jr6u;
// wired to the engine's real shapes in t-sc093o).
//
// It reads the ENGINE (the store is the engine's SQLite file), so it rides the
// storagePane.ts route, which already hands over the active chat's client.
// The methods are L4a's: `nest_storage` (bytes per class on this desk) and
// `nest_retention` (the Keep window per class: read, `set`, `apply`). Their
// replies go to the webview AS THE ENGINE SENDS THEM (nestContract.ts); the
// host adds only what it knows itself: when it measured, and what a window
// frees. An engine without them answers -32601: the reply then says `pending`.
//
// What a window frees is the tool-output prune plus the artifact prune
// (t-vb87lt); `unapplied` names the classes no prune reads yet. A dry run asks
// `nest_retention` with `apply.windows` (the choice, not stored), because its
// `set` is a write. Every engine call here has a time limit (answerWithin).

import { nestHub } from './nestHubWindow';
import { isMissingMethod, type NestRetentionResult } from './nestContract';
import { readNestsEnabled } from '../remote/nestsSetting';
import { ANSWER_MS, APPLY_MS, DRY_RUN_MS, answerWithin, measureStorage } from './nestStorageMeasure';

export { isMissingMethod } from './nestContract';

/** The four classes the card sets; the journal follows chats. */
export type NestWindowClass = 'chats' | 'subagents' | 'toolOutput' | 'artifacts';
/** Days a body is kept, or null = everything. The engine raises a window to 7. */
export type NestWindow = number | null;

export const NEST_STORAGE_MESSAGE_TYPES = new Set(['requestNestStorage', 'nestRetentionSet']);

export interface NestStorageClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface NestStorageHost {
  client?: NestStorageClient;
  post(message: Record<string, unknown>): void;
  /** This desk's device id (the group's). Default: the window's hub. */
  deviceId?: string | null;
  now?: () => number;
}

const NO_SESSION = 'Open a chat first. The store is measured through a live engine connection.';
const NOT_IN_ENGINE = 'This engine cannot measure by class yet (nest_storage is not in this build).';
const NO_ID = 'This desk has no device id until it starts or joins a nest.';

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const WINDOW_CLASSES: readonly NestWindowClass[] = ['chats', 'subagents', 'toolOutput', 'artifacts'];

/** A webview is not a trusted validator: keep only the four classes, and only
 *  null or a whole number of days above zero (the engine refuses 0). */
export function cleanWindows(raw: unknown): Partial<Record<NestWindowClass, NestWindow>> {
  const out: Partial<Record<NestWindowClass, NestWindow>> = {};
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const k of WINDOW_CLASSES) {
    const v = rec[k];
    if (v === null) out[k] = null;
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 1) out[k] = Math.floor(v);
  }
  return out;
}

export async function handleNestStorageMessage(
  host: NestStorageHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  const reply = m.type === 'requestNestStorage' ? 'nestStorageData' : 'nestRetentionData';
  if (!NEST_STORAGE_MESSAGE_TYPES.has(m.type ?? '')) return;
  const deviceId = host.deviceId !== undefined ? host.deviceId : nestHub.deviceId();
  if (!host.client || !deviceId) {
    host.post({ type: reply, pending: host.client ? NO_ID : NO_SESSION });
    return;
  }
  const gate = { enabled: readNestsEnabled(), deviceId };
  const call = <T>(method: string, params: Record<string, unknown> = {}) => host.client!.extMethod(method, { ...gate, ...params }) as Promise<T>;
  try {
    if (m.type === 'requestNestStorage') {
      // t-vbivj4: bounded, with the sums so far posted while the engine measures (nestStorageMeasure.ts).
      const stats = await measureStorage(call, (partial) => host.post({ type: reply, stats: partial, partial: true }));
      const retention = await answerWithin(call('nest_retention'), ANSWER_MS);
      host.post({ type: reply, stats, retention, measuredAt: (host.now ?? Date.now)() });
      return;
    }
    // A dry run unless the message says exactly false, the storagePrune rule.
    const dryRun = m['dryRun'] !== false;
    const windows = cleanWindows(m['windows']);
    const frees = (r: NestRetentionResult) => (r.applied?.toolOutput?.bytes ?? 0) + (r.applied?.artifacts?.bytes ?? 0);
    if (dryRun) {
      const preview = await answerWithin(call<NestRetentionResult>('nest_retention', { apply: { dryRun: true, windows } }), DRY_RUN_MS);
      host.post({ type: reply, dryRun, frees: frees(preview) });
      return;
    }
    const retention = await answerWithin(call<NestRetentionResult>('nest_retention', { set: windows, apply: { dryRun: false } }), APPLY_MS);
    host.post({ type: reply, retention, dryRun, frees: frees(retention) });
    await handleNestStorageMessage(host, { type: 'requestNestStorage' });
  } catch (error) {
    host.post(isMissingMethod(error) ? { type: reply, pending: NOT_IN_ENGINE } : { type: reply, error: reason(error) });
  }
}

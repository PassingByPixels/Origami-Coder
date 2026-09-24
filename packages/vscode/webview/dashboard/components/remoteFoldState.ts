// Whether the key-fingerprint fold is open, remembered PER PAIRING.
//
// The fold exists so the owner can compare 43 characters against the phone once
// and then put them away; a fold that reopened on every render would make that
// gesture pointless, and one remembered globally would hide the fingerprint of
// the NEXT phone before it had ever been compared. So the answer is keyed by
// rendezvous id, and an id with no entry defaults to OPEN.
//
// Its own module rather than state inside RemoteDeviceKey.svelte: the read and
// the write are pure map arithmetic over the webview's persisted state bag, and
// they can be asserted without rendering anything.

/** The one key this pane owns inside the shared `vscode.setState` object. */
export const REMOTE_FOLD_KEY = 'remote.keyFold';

type Bag = Record<string, unknown>;

function folds(state: unknown): Record<string, boolean> {
  const bag = (state as Bag | null | undefined)?.[REMOTE_FOLD_KEY];
  return bag && typeof bag === 'object' ? (bag as Record<string, boolean>) : {};
}

/** OPEN unless this exact pairing was folded away. A missing bag, a bag of the
 *  wrong shape and an unknown rid all mean "never compared yet". */
export function isKeyFoldOpen(state: unknown, rid: string | null): boolean {
  if (!rid) return true;
  return folds(state)[rid] !== false;
}

/** The whole state bag to write back — every other pane's key preserved. */
export function withKeyFold(state: unknown, rid: string | null, open: boolean): Bag {
  const previous = (state as Bag | null | undefined) ?? {};
  if (!rid) return { ...previous };
  return { ...previous, [REMOTE_FOLD_KEY]: { ...folds(state), [rid]: open } };
}

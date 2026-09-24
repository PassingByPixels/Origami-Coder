// nestOwnRows.ts — t-v7i2au: how a device id the engine stored (a row's
// `ownerDevice`, a version's `device`) is printed. Never the bare id. Split from
// nestArtifactRows.ts, which is at its cap.
//
// The engine stores an id there only when an artifact came through the nest
// (nest-sync importManifest writes the owner's id). A pull back of this desk's
// own artifact therefore stores THIS desk's id, which must read as this machine.

import type { GroupDeviceView } from '../remote/groupSnapshot';
import { isDeviceId } from '../remote/groupCrypto';

type Desk = Pick<GroupDeviceView, 'id' | 'name' | 'self'>;

/** t-vbj8xu: the desk the roster marks as the mother base, as the Artifacts pane
 *  labels it (webview artifactRows.ts MotherBase). Undefined when none is marked. */
export function rosterMotherBase(desks: readonly (Desk & Pick<GroupDeviceView, 'motherBase'>)[]): { self: boolean; name: string } | undefined {
  const d = desks.find((x) => x.motherBase);
  return d ? { self: d.self, name: d.name } : undefined;
}

/** A desk this window cannot name (it left the group, or Nests is off): a short id, marked as another desk. */
export function otherDesk(id: string): string {
  return `another desk (${id.slice(0, 6)}…)`;
}

/** `undefined` = this desk: the pane then reads it as this machine. A value that
 *  is not an id (the engine's "this machine") is kept as it came. */
export function deviceName(raw: string, self: string | null, desks: readonly Desk[]): string | undefined {
  const d = desks.find((x) => x.id === raw);
  if (raw === self || d?.self) return undefined;
  if (d) return d.name;
  return isDeviceId(raw) ? otherDesk(raw) : raw;
}

/** `row[key]` printed by deviceName; dropped for this desk. The same object when nothing changes. */
export function namedDevice(row: Record<string, unknown>, key: string, self: string | null, desks: readonly Desk[]): Record<string, unknown> {
  const raw = row[key];
  if (typeof raw !== 'string') return row;
  const name = deviceName(raw, self, desks);
  if (name === raw) return row;
  if (name !== undefined) return { ...row, [key]: name };
  const { [key]: _drop, ...rest } = row;
  return rest;
}

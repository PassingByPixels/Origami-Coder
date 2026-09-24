// modelStatusReason.ts — splitting a "provider/model" ref, and choosing the one-line reason the
// banner/footer/picker read. The sentinel 'No connections yet' is mirrored by modelBanner.ts's
// NO_CONNECTIONS; a drift test binds the two.

export interface ModelRef { cur: string; bare: string; pid: string }

/** "openai/gpt-5" -> { pid: "openai", bare: "gpt-5" }; a bare id has pid "". */
export function parseModelRef(cur: string): ModelRef {
  const slash = cur.indexOf('/');
  return { cur, bare: slash > 0 ? cur.slice(slash + 1) : cur, pid: slash > 0 ? cur.slice(0, slash) : '' };
}

export interface ReasonInput {
  ok: boolean;
  pid: string;
  isRemote: boolean;
  prov: { live?: boolean; reason?: string | null } | undefined;
  providerCount: number;
  localReason: string | null;
}

/** Nothing configured AND nothing resolved -> the setup prompt; a remote provider
 *  reports its own liveness; local falls back to the probe's reason. */
export function modelStatusReason(i: ReasonInput): string | null {
  if (!i.ok && (!i.pid || i.pid === 'unknown') && i.providerCount === 0) return 'No connections yet';
  if (i.isRemote) return i.ok ? null : (i.prov ? (i.prov.reason ?? 'Provider unreachable') : 'Checking provider…');
  return i.localReason;
}

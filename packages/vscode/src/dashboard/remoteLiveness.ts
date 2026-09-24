// remoteLiveness.ts — whether one session on a remote provider is reachable, and worth re-probing.
// An unknown provider (one broadcastProviderStatus never probes) reports reachable and is never
// queued, rather than being flagged unreachable forever.

/** How stale a cached liveness row may be before a re-probe is worth kicking; beyond the 20s
 *  broadcast TTL so a kick really re-probes. */
export const LIVENESS_STALE_MS = 30000;

export interface LivenessInput {
  /** The session is on a provider other than the local one. */
  isRemote: boolean;
  /** That provider id appears in the extension's global provider config. */
  known: boolean;
  /** The cached probe verdict, if one has ever landed. */
  row: { live: boolean; at: number } | undefined;
  /** The local LM Studio probe's verdict, for a session that is not remote. */
  localOk: boolean;
  now: number;
}

/** `probe` = kick one re-probe for this provider; never true for a provider no probe can reach. */
export function remoteLiveness(i: LivenessInput): { ok: boolean; probe: boolean } {
  if (!i.isRemote) return { ok: i.localOk, probe: false };
  if (!i.known) return { ok: true, probe: false };
  return { ok: !!i.row?.live, probe: !i.row || i.now - i.row.at > LIVENESS_STALE_MS };
}

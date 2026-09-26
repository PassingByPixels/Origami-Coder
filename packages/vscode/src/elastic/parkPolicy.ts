// parkPolicy.ts — t-w2txb2 (option D3): may this idle engine be stopped NOW? Pure: no vscode, no clock,
// no engine. The tracker (activityTracker.ts) asks it with a FRESH `_elastic_idle_report`.
//
// Owner decisions (2026-09-24):
//   - Only an engine the report calls `parkable` (no turn, sub-agent, job, ask, task result, flock or
//     Nests lease, collab run).
//   - t-z6ytkw (owner decision 2026-09-26): at the user's Park-after time whatever the provider cache life.
//     `cacheColdAt` is no longer waited for, and an armed cache warm (`warm-pending`) no longer holds the
//     park: a park does not evict the provider cache, a restore sends byte-identical requests (R3/R4), and
//     the engine hands its warm schedule to the extension at the park (warmWake.ts wakes it to warm).
//   - A provider that publishes no window (local servers, DeepSeek, ...) is never parked by that rule;
//     it parks after its own fixed delay, `parkUntimedAfterMs` (default 20 min, t-ze0hwh). That is safe because
//     a restore sends byte-identical requests (R4), so a server that still holds the prefix reuses it;
//     the delay only bounds how often such a chat pays the restore (1-3 s) on its next message.
//   - A chat on screen, on the phone, or holding work never reaches here (its class is not idle).

export interface ParkSettings {
  /** Hidden and quiet this long before an engine may be parked. 0 = never park. */
  parkAfterMs: number;
  /** The same for an engine that used a provider with no published cache window. */
  parkUntimedAfterMs: number;
}

export type ParkVerdict = { park: true } | { park: false; why: string; retryAt: number | null };

/** The idle-report reason of an armed cache warm (engine elastic/idle.ts). The park call waives it too. */
export const WARM_PENDING = 'warm-pending';

/** `quietSince` = when the engine went hidden and quiet (the tracker's clock). */
export function parkVerdict(report: Record<string, unknown> | undefined, now: number, quietSince: number, s: ParkSettings): ParkVerdict {
  if (s.parkAfterMs <= 0) return { park: false, why: 'parking is off', retryAt: null };
  if (now - quietSince < s.parkAfterMs) return { park: false, why: 'not quiet long enough', retryAt: quietSince + s.parkAfterMs };
  // No answer is not evidence of idleness: ask again one park period later.
  if (!report) return { park: false, why: 'no idle report', retryAt: now + s.parkAfterMs };
  if (report['parkable'] !== true) {
    const all = Array.isArray(report['reasons']) ? report['reasons'].map(String) : [];
    const held = all.filter((r) => r !== WARM_PENDING);
    // t-z6ytkw: an armed warm alone is not work; any other reason (or none named) is.
    if (held.length > 0 || all.length === 0) return { park: false, why: held.join(', ') || 'not parkable', retryAt: now + s.parkAfterMs };
  }
  if (report['cacheUntimed'] === true && now - quietSince < s.parkUntimedAfterMs) {
    return { park: false, why: 'the provider publishes no cache window', retryAt: quietSince + s.parkUntimedAfterMs };
  }
  return { park: true };
}

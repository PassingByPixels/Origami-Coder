// Tell a running engine that provider config changed on disk.
// The engine caches config per instance with no file watcher, so refresh drops the provider/SDK
// caches after every credential write — wired through the same writer both the connect/re-key form
// and the OAuth completion already use.

/** Just the ext-method seam. Structural, so a test needs no AcpClient. */
export interface RefreshClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Which engine to tell, and about which directory. */
export interface RefreshTarget {
  /** The live engine connection. Absent before the first chat opens. */
  client?: RefreshClient;
  /** The session's cwd; the engine keys per-project state on it and falls back to its own cwd when
   *  omitted. */
  cwd?: string;
}

export const PROVIDER_REFRESH_METHOD = 'provider_refresh';

/**
 * Ask every live engine to re-read provider config. Best-effort and never
 * throws: each chat holds its own engine caches, so every open chat is told
 * separately, using its own cwd, and one dead connection must not stop the
 * others. Resolves true when every engine answered.
 *
 * `hard` (t-ttmo5w, the Connections Refresh button) also makes each engine
 * forget its memoised live-discovery answers and its on-disk catalog cache.
 */
export async function refreshEngineProviders(targets: readonly RefreshTarget[], options: { hard?: boolean } = {}): Promise<boolean> {
  const answered = await Promise.all(
    targets.map(async (target) => {
      if (!target.client) return true;
      try {
        await target.client.extMethod(PROVIDER_REFRESH_METHOD, { ...(target.cwd ? { cwd: target.cwd } : {}), ...(options.hard ? { hard: true } : {}) });
        return true;
      } catch {
        return false;
      }
    }),
  );
  return answered.every(Boolean);
}

/**
 * Wrap a provider-config writer so the engine is refreshed right after every
 * write. The write stays synchronous; the refresh fires without being
 * awaited, so a prompt sent in the same instant may race it and use one
 * stale turn.
 */
export function refreshingWriter<C, R>(
  write: (choice: C) => R,
  targets: () => readonly RefreshTarget[],
): (choice: C) => R {
  return (choice: C) => {
    const result = write(choice);
    // Targets are read here, not at construction time, or the list would be empty forever.
    void refreshEngineProviders(targets());
    return result;
  };
}

/**
 * Same wrapper for a writer that reports whether it changed the file: engines
 * are told only when it did. Unlike refreshingWriter, this writer legitimately
 * answers false often (limit already right, provider unset), and an
 * unconditional refresh on every model switch would drop every engine's
 * caches for nothing.
 */
export function refreshingChangeWriter<A extends unknown[]>(
  write: (...args: A) => boolean,
  targets: () => readonly RefreshTarget[],
): (...args: A) => boolean {
  return (...args: A) => {
    const wrote = write(...args);
    if (wrote) void refreshEngineProviders(targets());
    return wrote;
  };
}

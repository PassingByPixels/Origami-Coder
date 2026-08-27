// Tell a RUNNING engine that provider configuration changed on disk.
//
// WHY THIS EXISTS. The extension writes `provider.<id>.options.apiKey` into the
// global origami.json itself (firstFold.ts's writeModelConfig). The engine never
// sees it: it caches the global file for the life of the process and holds the
// merged config and the built provider list in per-instance caches with no TTL
// and no file watcher. So every connect, every re-key and every OAuth completion
// used to end in the same place — a toast asking the user to reload the window,
// because that was genuinely the only way to make the key they had just pasted
// count for anything.
//
// `provider_refresh` is the engine ext method that closes it. It re-reads config
// and drops the provider/SDK/language-model caches for the session's instance,
// so the NEXT resolution builds a client with the new credential. Nothing else
// is disposed, so a turn already streaming is unaffected.
//
// SHAPE. This is a wrapper around the config writer rather than a call bolted
// onto each flow, for one reason: every path that writes provider auth already
// goes through the same injected `write` dependency — the connect/re-key form
// (setupProvider.ts) and the OAuth completion (providerAuthPane.ts) both take
// it, and both of those files sit one line under their architecture cap. One
// wrapper at the injection site covers all three flows and adds nothing to
// either leaf.

/** Just the ext-method seam. Structural, so a test needs no AcpClient. */
export interface RefreshClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Which engine to tell, and about which directory. */
export interface RefreshTarget {
  /** The live engine connection. Absent before the first chat opens. */
  client?: RefreshClient;
  /** The session's cwd — the engine keys its per-project state on it. Omitted
   *  rather than invented, exactly as the engine's other cwd-bearing ext
   *  methods are called; the engine then falls back to its own process cwd. */
  cwd?: string;
}

export const PROVIDER_REFRESH_METHOD = 'provider_refresh';

/**
 * Ask EVERY live engine to re-read provider config. NEVER throws and never
 * reports: this is a best-effort improvement on a write that already succeeded.
 *
 * Every one, not just the active chat, because each chat holds its own
 * `AcpClient` and therefore its own engine caches — telling one would leave a
 * second open chat sending the old key, which is the same defect with a
 * smaller blast radius. Agent-Manager chats run in their own worktree cwd, so
 * the cwd travels per target rather than being taken once from the panel.
 *
 * Three ways it legitimately does nothing, all of them fine:
 *   - no chat is open yet, so there is no engine to tell (the config is on
 *     disk and the next engine start reads it fresh anyway);
 *   - the running engine predates the ext method and answers method_not_found;
 *   - the connection died between the write and this call.
 * In every one of them the user is exactly where they were before — one window
 * reload away — so a failure here must not turn a successful connect into an
 * error message. One dead chat must not stop the others being told either,
 * which is why each call is caught on its own.
 */
export async function refreshEngineProviders(targets: readonly RefreshTarget[]): Promise<void> {
  await Promise.all(
    targets.map(async (target) => {
      if (!target.client) return;
      try {
        await target.client.extMethod(PROVIDER_REFRESH_METHOD, { ...(target.cwd ? { cwd: target.cwd } : {}) });
      } catch {
        // deliberately silent — see above
      }
    }),
  );
}

/**
 * Wrap a provider-config writer so the engine is told right after every write.
 *
 * The write stays SYNCHRONOUS and its result is returned untouched, because
 * both call sites use it that way and neither has room to grow. The refresh is
 * therefore fired without being awaited. That is a deliberate trade: a user who
 * sends a prompt in the same instant may still race the refresh and pay one
 * stale turn, which is strictly better than today's "every turn is stale until
 * you reload the window".
 *
 * A write that THROWS fires no refresh — nothing changed on disk, so there is
 * nothing to tell the engine about.
 */
export function refreshingWriter<C, R>(
  write: (choice: C) => R,
  targets: () => readonly RefreshTarget[],
): (choice: C) => R {
  return (choice: C) => {
    const result = write(choice);
    // Read the targets HERE, not at wire-up: the panel wires this in its
    // constructor, when no chat exists and the list would be empty forever.
    void refreshEngineProviders(targets());
    return result;
  };
}

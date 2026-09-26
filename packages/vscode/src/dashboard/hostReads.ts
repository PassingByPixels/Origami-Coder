// hostReads.ts — t-w2qv3o (epic t-w1r73y): which engine a HOST read goes to, so host timers stop
// waking hidden chat engines. DashboardPanel.ts is at its line cap; the rule lives here.
//
//   hostReadArg    Nests (via HostEngine.ensure), usage sampling, Insights/Nests storage, and the
//                  collab LIST (a store read the sidebar sends on every mount). The on-screen chat's
//                  engine (awake anyway), else the window's host engine, started for the read when a
//                  chat exists. A hidden chat's engine is never used. A bare window (no chat, no
//                  host engine) gets no client: it spawns nothing, as before.
//   hostOnlyClient Every other collab call. The collab runner keeps its live state in the process
//                  that ran the post (engine collab/runner.ts: statuses, live activity, hop budget),
//                  so those calls must reach ONE engine or the watch reads "idle" while a room runs.
//                  That engine is the host engine: a hidden or closed chat no longer holds a room.
//                  The 5 s collab watch reads `ownClient() ?? current()`: the host engine when it
//                  runs (with none running, no room runs in this window), else an on-screen chat,
//                  and it never starts an engine (DashboardPanel collabWatchClient).
//
// Flock is NOT routed here: its reads must reach the lease holder (flockRoute.ts).
// Each call is resolved when it is made, not when the client object is built, so a chat that
// hides between two timer ticks is not asked on the second.

import { HOST_ENGINE_FAILED } from './hostEngine';

export interface ReadClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** The slice of HostEngine (hostEngine.ts) this needs. */
export interface HostReadEngine<C extends ReadClient> {
  current(): C | undefined;
  ensure(): Promise<C | undefined>;
  ensureOwn(): Promise<C | undefined>;
}

function via<C extends ReadClient>(resolve: () => Promise<C | undefined>, touched?: () => void): ReadClient {
  return {
    extMethod: async (method, params) => {
      const client = await resolve();
      if (!client) throw new Error(HOST_ENGINE_FAILED);
      try {
        return await client.extMethod(method, params);
      } finally {
        touched?.(); // the activity tracker re-reads classes: this engine was just used
      }
    },
  };
}

/** For a host read or timer: `{ client }` in the shape `engineArg()` had, or `{}` in a bare window. */
export function hostReadArg<C extends ReadClient>(engine: HostReadEngine<C>, anyChat: () => boolean, touched?: () => void): { client?: ReadClient } {
  if (!engine.current() && !anyChat()) return {};
  return { client: via(() => engine.ensure(), touched) };
}

/** For every collab call: the host engine only, started if needed. */
export function hostOnlyClient<C extends ReadClient>(engine: HostReadEngine<C>, touched?: () => void): ReadClient {
  return via(() => engine.ensureOwn(), touched);
}

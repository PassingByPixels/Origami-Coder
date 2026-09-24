// Origami Remote — the `acquireVsCodeApi()` drop-in.
//
// The phone shell runs the real chat bundle unchanged; only the host is
// swapped: `postMessage` seals into a wire frame and `onmessage` arrives
// from one. Nothing in `ChatPane.svelte` knows or needs to.
//
// Two facts drive this file's shape:
//  1. `vscodeApi.ts` caches `acquireVsCodeApi()` once at module level, so
//     the shim must be a singleton installed on `window` before the bundle
//     evaluates, exposing all three methods synchronously.
//  2. `ChatView.svelte` picks its surface from a session id not known
//     until the desktop's snapshot arrives, so `MountGate` below buffers
//     every inbound message until `mountPick.ts` names the session, then
//     flushes them in order.

import { SessionPick } from './mountPick';
import { VIEW_STATE_PREFIX } from './pairing';

export interface VsCodeApiLike {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** Install the shim as `window.acquireVsCodeApi`. Call before loading chat.js. */
export function installShim(
  send: (msg: unknown) => void,
  rid: string,
  win: Window = window,
): VsCodeApiLike {
  const stateKey = VIEW_STATE_PREFIX + rid;
  const api: VsCodeApiLike = {
    postMessage(msg: unknown): void {
      send(msg);
    },
    getState(): unknown {
      // VS Code returns undefined for a view that never called setState;
      // a parse failure must degrade to undefined too, not a thrown boot.
      try {
        const raw = win.localStorage.getItem(stateKey);
        return raw === null ? undefined : JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
    setState(state: unknown): void {
      try {
        win.localStorage.setItem(stateKey, JSON.stringify(state));
      } catch {
        /* private mode / quota — losing a theme preference must not kill the shell. */
      }
    },
  };
  (win as unknown as { acquireVsCodeApi: () => VsCodeApiLike }).acquireVsCodeApi = () => api;
  return api;
}

/** Dispatch a desktop message so the untouched bundle's own listener sees it
 *  exactly as it would inside VS Code. */
export function dispatchToWebview(msg: unknown, win: Window = window): void {
  win.dispatchEvent(new MessageEvent('message', { data: msg }));
}

/**
 * Holds inbound messages until the chat bundle mounts against the right
 * session, then flushes them in order. Which session is `mountPick.ts`'s
 * job: the gate mounts the moment the host names its active chat, or after
 * `graceMs` of quiet, falling back to the oldest announced session.
 */
export class MountGate {
  private buffer: unknown[] = [];
  private mounted = false;
  private mounting = false;
  /** Bumped by every buffered message: the fallback timer's stamp. */
  private ticks = 0;
  private readonly pick = new SessionPick();

  constructor(
    private readonly loadBundle: (sessionId: string) => Promise<void>,
    private readonly dispatch: (msg: unknown) => void = (m) => dispatchToWebview(m),
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private readonly graceMs = 300,
  ) {}

  get isMounted(): boolean { return this.mounted; }

  get buffered(): number { return this.buffer.length; }

  /** The chats this phone has been told about, oldest first. */
  get sessions(): readonly string[] { return this.pick.all; }

  async accept(msg: unknown): Promise<void> {
    if (this.mounted) {
      this.dispatch(msg);
      return;
    }
    this.buffer.push(msg);
    this.pick.note(msg);
    if (this.mounting) return;
    const chosen = this.pick.chosen;
    if (chosen) return this.mount(chosen);
    if (this.pick.fallback === undefined) return;
    // Debounced: restarting the grace on every message means the fallback
    // fires once a burst of announcements goes quiet, not on the first one.
    const stamp = ++this.ticks;
    this.schedule(() => {
      if (this.ticks !== stamp || this.mounted || this.mounting) return;
      const sid = this.pick.chosen ?? this.pick.fallback;
      if (sid) void this.mount(sid);
    }, this.graceMs);
  }

  private async mount(sessionId: string): Promise<void> {
    this.mounting = true;
    await this.loadBundle(sessionId);
    this.mounted = true;
    this.mounting = false;
    const queued = this.buffer;
    this.buffer = [];
    for (const m of queued) this.dispatch(m);
  }
}

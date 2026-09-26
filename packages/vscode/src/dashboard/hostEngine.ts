// hostEngine.ts — t-sh7cog: the window's engine connection for HOST features
// (the Manager panes, History, the Labyrinth, the Nests hub), so they answer
// with no chat open. Design: docs/decisions/host-engine-connection.md.
//
// A chat's client comes first; the host client is the fallback. It is started
// by `ensure()` / `ensureOwn()` only, never by `current()`. t-w2qv3o: the chat source
// is the ON-SCREEN chat, so a host read never wakes a hidden chat (hostReads.ts). A bare
// window spawns nothing. `connect()` alone (no session/new) writes no stored session.
// Pure: the window singleton with the real AcpClient is hostEngineWindow.ts.

import type { NestEngine, NestView } from './nestHub';

export interface HostClient {
  connect(cwd: string, headless?: boolean): Promise<void>;
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  dispose(): void;
}

export interface HostEngineDeps<C extends HostClient> {
  /** A new, unconnected client. `onClose` fires when its engine process exits. */
  make(onClose: () => void): C;
  cwd(): string;
  log(line: string): void;
}

/** The output channel every host-engine line goes to (hostEngineWindow.ts creates it).
 *  t-tc2es2: the failure text used to name an "Origami" channel that did not exist. */
export const HOST_ENGINE_CHANNEL = 'Origami Host Engine';

export const HOST_ENGINE_FAILED = `The engine did not start. Check the "${HOST_ENGINE_CHANNEL}" output channel.`;

export class HostEngine<C extends HostClient> {
  private chats: { owner: object; source: () => C | undefined } | null = null;
  private own: C | null = null;
  private starting: Promise<C | undefined> | null = null;
  private disposed = false;

  constructor(private readonly deps: HostEngineDeps<C>) {}

  /** The chat a host read may use: the panel's on-screen chat (elastic/sessionSignals.ts onScreenClient). */
  public setChats(owner: object, source: () => C | undefined): void {
    this.chats = { owner, source };
  }

  /** The panel is gone; a newer panel's source stays. */
  public releaseChats(owner: object): void { if (this.chats?.owner === owner) this.chats = null; }

  /** A chat's client, else the host client if it runs. Never spawns. */
  public current(): C | undefined {
    return this.chats?.source() ?? this.own ?? undefined;
  }

  /** The host client alone, never a chat's. Flock routes to it when it holds the lease (flockRoute.ts). */
  public ownClient(): C | undefined { return this.own ?? undefined; }

  /** t-wdyi2t: the idle host engine is stopped (elastic/hostPark.ts); the next ensure() / ensureOwn() starts a new one. */
  public stopOwn(client: C): void { if (this.own === client) { this.own = null; client.dispose(); } }

  /** current(), else start the host client once; undefined when it cannot start. */
  public ensure(): Promise<C | undefined> {
    const now = this.current();
    return now ? Promise.resolve(now) : this.ensureOwn();
  }

  /** The host client alone, started once if it is not running (t-w2qv3o: collabs and host timers, hostReads.ts). */
  public ensureOwn(): Promise<C | undefined> {
    if (this.own || this.disposed) return Promise.resolve(this.own ?? undefined);
    this.starting ??= this.spawn().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async spawn(): Promise<C | undefined> {
    const client: C = this.deps.make(() => { if (this.own === client) this.own = null; });
    try {
      await client.connect(this.deps.cwd(), true); // headless: peer discovery leaves it out
    } catch (e) {
      this.deps.log(`[origami] host engine did not start: ${e instanceof Error ? e.message : String(e)}`);
      client.dispose();
      return undefined;
    }
    if (this.disposed) { client.dispose(); return undefined; }
    this.own = client;
    this.deps.log('[origami] host engine connected (no chat open)');
    return client;
  }

  /** The Nests hub's engine. The hub calls it only with Nests on and a device id. */
  public readonly nestEngine: NestEngine = {
    extMethod: async (method, params) => {
      const client = await this.ensure();
      if (!client) throw new Error(HOST_ENGINE_FAILED);
      return client.extMethod(method, params);
    },
  };

  /** Window close: the host client's engine goes the way a chat's does (AcpClient.dispose). */
  public dispose(): void {
    this.disposed = true;
    this.own?.dispose();
    this.own = null;
  }
}

/** The hub's view with no panel: the engine only. The sidebar attaches its own
 *  view (post, open) over this one when it asks for the nest index. */
export function attachHostNestView(hub: { attachView(view: NestView): void }, engine: { readonly nestEngine: NestEngine }): void {
  hub.attachView({ engine: () => engine.nestEngine, post: () => undefined, open: () => undefined });
}

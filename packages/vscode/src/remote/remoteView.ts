// Origami Remote — the phone as one more attached view.
//
// The wire spec says the phone speaks "the existing webview protocol verbatim",
// so this gives DashboardPanel something that looks exactly like the webview it
// already knows — a message the sidebar gets, the phone gets, with no second
// code path.
//
// `attachView(host, 'chat')` uses exactly six webview members: `html`,
// `onDidReceiveMessage`, `postMessage`, `asWebviewUri`, `cspSource` and
// `options`. Two are inert: the phone runs the REAL out/webview/chat.js served
// by the relay's /app, so the rendered HTML is never displayed and
// `asWebviewUri` is the identity function.

import type * as vscode from 'vscode';
import type { WebviewHost } from '../dashboard/DashboardPanel';
import { REMOTE_VIEW_BRAND, deniedToPhone, shapeForPhone } from './phoneView';

type Listener<T> = (e: T) => unknown;

/** The smallest thing that satisfies `vscode.Event<T>`. VS Code's EventEmitter
 *  exists only inside an extension host. */
class MiniEmitter<T> {
  private readonly listeners = new Set<{ fn: Listener<T>; thisArgs?: unknown }>();

  public readonly event = (
    listener: Listener<T>,
    thisArgs?: unknown,
    disposables?: vscode.Disposable[],
  ): vscode.Disposable => {
    const entry = { fn: listener, thisArgs };
    this.listeners.add(entry);
    const sub = { dispose: () => void this.listeners.delete(entry) };
    disposables?.push(sub);
    return sub;
  };

  public fire(value: T): void {
    // Snapshot first: a listener unsubscribing during dispatch must not mutate the set.
    for (const entry of [...this.listeners]) entry.fn.call(entry.thisArgs, value);
  }

  public get size(): number {
    return this.listeners.size;
  }

  public clear(): void {
    this.listeners.clear();
  }
}

export interface RemoteViewOptions {
  /** Host -> phone. Every broadcast and replay lands here. */
  send: (msg: unknown) => void;
  /** Called once when the view is disposed (revoke, disable, window close). */
  onDispose?: () => void;
}

/** A `WebviewHost` whose "webview" is a phone on the other end of the relay. */
export class RemoteView {
  private readonly inbound = new MiniEmitter<unknown>();
  private readonly disposed = new MiniEmitter<void>();
  private lastHtmlBytes = 0;
  private isDisposed = false;

  public readonly webview: vscode.Webview;

  constructor(private readonly opts: RemoteViewOptions) {
    const self = this;
    this.webview = {
      options: { enableScripts: true },
      // The panel's replay reads this to tell the phone from a popped-out tab.
      [REMOTE_VIEW_BRAND]: true,
      // Written by attachView and never read; kept as a byte count for diagnostics.
      set html(value: string) {
        self.lastHtmlBytes = value.length;
      },
      get html(): string {
        return '';
      },
      cspSource: 'origami-remote:',
      onDidReceiveMessage: self.inbound.event as vscode.Event<unknown>,
      postMessage(message: unknown): Thenable<boolean> {
        if (self.isDisposed) return Promise.resolve(false);
        // THE ONE THING THIS VIEW DOES NOT MIRROR (phoneView.ts). `true` because
        // the caller's contract is "the view took it", and it did.
        if (deniedToPhone(message)) return Promise.resolve(true);
        // ...and one field the phone is not sent: a read card's image bytes.
        self.opts.send(shapeForPhone(message));
        return Promise.resolve(true);
      },
      // Identity: the only caller is the discarded HTML above.
      asWebviewUri(localResource: vscode.Uri): vscode.Uri {
        return localResource;
      },
    } as unknown as vscode.Webview;
  }

  /** The object handed to `DashboardPanel.attachView`. */
  public get host(): WebviewHost {
    return {
      webview: this.webview,
      onDidDispose: (listener, thisArgs, disposables) => this.disposed.event(listener as Listener<void>, thisArgs, disposables),
      reveal: () => {
        // A phone is always "revealed" — there is no tab to bring forward.
      },
      dispose: () => this.dispose(),
    };
  }

  /** Phone -> host. Drives the same `handleWebviewMessage` the sidebar does. */
  public deliver(msg: unknown): void {
    if (this.isDisposed) return;
    this.inbound.fire(msg);
  }

  /** Diagnostics only — proves attachView really rendered for this view. */
  public get renderedHtmlBytes(): number {
    return this.lastHtmlBytes;
  }

  public get listenerCount(): number {
    return this.inbound.size;
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.disposed.fire();
    this.disposed.clear();
    this.inbound.clear();
    this.opts.onDispose?.();
  }
}

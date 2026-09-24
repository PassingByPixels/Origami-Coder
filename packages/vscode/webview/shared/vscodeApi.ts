// Typed wrapper around VS Code's webview API.
// acquireVsCodeApi() is injected by the webview host — only
// callable once, so we cache it at module level.

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

import { blocks, listenForAway } from './nestWriteGate';

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    const raw = acquireVsCodeApi();
    // t-t7lfho: every post passes the nest write gate (nestWriteGate.ts): a write
    // into a chat this desk gave to another desk is dropped here, in one place.
    if (typeof window !== 'undefined') listenForAway();
    api = {
      postMessage: (msg) => { if (!blocks(msg)) raw.postMessage(msg); },
      getState: () => raw.getState(),
      setState: (state) => raw.setState(state),
    };
  }
  return api;
}

// Svelte module declarations for TypeScript
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component;
  export default component;
}

// VS Code webview API injected by the host
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

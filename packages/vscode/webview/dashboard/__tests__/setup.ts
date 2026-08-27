// Pillar J — vitest setup. Loads @testing-library/jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, etc.) and stubs the
// `acquireVsCodeApi` global the webview expects when running in a
// real VS Code panel. Components under test that call
// `vscode.postMessage(...)` get a captured-message buffer they can
// assert against.

import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

interface VsCodeApiMock {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
}

declare global {
  // eslint-disable-next-line no-var
  var acquireVsCodeApi: () => VsCodeApiMock;
  // eslint-disable-next-line no-var
  var __vscodeApiMock: VsCodeApiMock;
}

globalThis.__vscodeApiMock = {
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
};

globalThis.acquireVsCodeApi = () => globalThis.__vscodeApiMock;

// jsdom implements no Web Animations API, and Svelte 5 drives `transition:`
// through `element.animate()`. An INTRO is skipped on initial mount, so this
// went unnoticed — but an OUTRO throws `element.animate is not a function`,
// and because the outro never reports finished, Svelte never removes the node.
// That turns "the element went away" into an un-assertable state and makes
// `expect(el).not.toBeNull()` pass for the wrong reason. This stub completes
// each animation on a microtask so a transitioning element really does leave
// the DOM. Duration is irrelevant — the tests assert presence, not motion.
class StubAnimation {
  #onfinish: (() => void) | null = null;
  #cancelled = false;
  currentTime = 0;
  playState = 'finished';
  effect: unknown = null;
  get onfinish() { return this.#onfinish; }
  set onfinish(fn: (() => void) | null) {
    this.#onfinish = fn;
    // `abort()` cancels and THEN assigns a no-op; a cancelled animation must
    // stay silent, matching the real API's post-cancel contract.
    queueMicrotask(() => { if (!this.#cancelled) this.#onfinish?.(); });
  }
  cancel() { this.#cancelled = true; }
  pause() {}
  play() {}
}
if (typeof Element !== 'undefined' && !Element.prototype.animate) {
  Element.prototype.animate = function animate() {
    return new StubAnimation() as unknown as Animation;
  };
}

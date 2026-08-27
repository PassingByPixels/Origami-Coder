// Reading the Tools pane's state message, and saying what it did.
//
// Split out of toolsPane.ts when the load/unload toggle became the three-way
// Loaded / Deferred / Off control and that file hit its architecture cap. Pure
// — no `vscode`, no fs — so both halves are unit-testable, which matters more
// here than the line count: one of them decides whether a tool gets switched
// off, and the input is a webview message.

import type { ToolState } from './toolDeferConfig';

/**
 * The state a message is asking for, or undefined.
 *
 * THERE IS NO DEFAULT, deliberately. The old two-state handler could read
 * anything as `defer === true` / else, because both outcomes were harmless and
 * reversible. `off` is neither harmless in the same way (the tool stops being
 * offered) nor guessable, so an unrecognised value is refused rather than
 * rounded to the nearest state.
 */
export function parseToolState(raw: unknown): ToolState | undefined {
  return raw === 'loaded' || raw === 'deferred' || raw === 'off' ? raw : undefined;
}

/**
 * What the toast says after a successful write. It names the CONSEQUENCE, not
 * the setting: "off" alone reads as cosmetic, and the one thing the user must
 * take away is that the model can no longer call the tool.
 */
export function toolStateNotice(id: string, state: ToolState): string {
  const said =
    state === 'off'
      ? 'is switched OFF — it will not be offered to the model at all'
      : state === 'deferred'
        ? 'is deferred behind tool_search'
        : 'sends its full schema with every request';
  return `${id} ${said} — reload the window to apply it.`;
}

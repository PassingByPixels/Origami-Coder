// Reading the Tools pane's state message, and saying what it did. Split out of toolsPane.ts when
// the toggle became a three-way control; pure (no vscode/fs) so both halves are unit-testable.

import type { ToolState } from './toolDeferConfig';

/**
 * The state a message is asking for, or undefined — no default. The old
 * two-state handler could round anything to a boolean since both outcomes
 * were reversible; `off` stops the model calling the tool at all, so an
 * unrecognised value is refused rather than guessed.
 */
export function parseToolState(raw: unknown): ToolState | undefined {
  return raw === 'loaded' || raw === 'deferred' || raw === 'off' ? raw : undefined;
}

/** What the toast says after a successful write — names the CONSEQUENCE ("off" alone reads as
 *  cosmetic), since the model can no longer call the tool. */
export function toolStateNotice(id: string, state: ToolState): string {
  const said =
    state === 'off'
      ? 'is switched OFF — it will not be offered to the model at all'
      : state === 'deferred'
        ? 'is deferred behind tool_search'
        : 'sends its full schema with every request';
  return `${id} ${said} — reload the window to apply it.`;
}

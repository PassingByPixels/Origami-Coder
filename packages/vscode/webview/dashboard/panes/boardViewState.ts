// The board's picked-view persistence — extracted from BoardShell.svelte
// (which was at 190/190 lines before the rail-expand hover state, S9 hover
// port). Same getState/setState mechanism theme.ts uses for the theme pick,
// so the board reopens on the last view instead of always defaulting to Folds.
import type { ViewId } from './boardViews';

interface VsCodeApi {
  getState(): unknown;
  setState(state: unknown): void;
}

export const BOARD_VIEW_STATE_KEY = 'origami.board.view';

export function loadView(vscode: VsCodeApi): unknown {
  try {
    const state = (vscode.getState() as Record<string, unknown>) || {};
    return state[BOARD_VIEW_STATE_KEY];
  } catch {
    return undefined;
  }
}

export function saveView(vscode: VsCodeApi, id: ViewId): void {
  try {
    const state = (vscode.getState() as Record<string, unknown>) || {};
    vscode.setState({ ...state, [BOARD_VIEW_STATE_KEY]: id });
  } catch {
    /* getState/setState unavailable in this host — best-effort only */
  }
}

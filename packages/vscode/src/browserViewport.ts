// browserViewport.ts — the PAGE VIEWPORT the agent's captures are taken at.
//
// THE FINDING THIS FILE EXISTS FOR (read off the SHIPPED bundle, VS Code 1.138.0,
// the build installed on this machine — `resources/app/out/vs/workbench/
// workbench.desktop.main.js` and `resources/app/out/main.js`):
//
//   1. `screenshot_page`'s inputSchema is `{ pageId, ref, selector, element,
//      scrollIntoViewIfNeeded }`. No width, no height, no fullPage. It captures the
//      viewport it is given, and that viewport is the editor tab's own layout size.
//   2. `open_browser_page`'s inputSchema is `{ url, forceNew }`. No size either, so
//      a page cannot be OPENED at a size.
//   3. The open COMMANDS take a url and nothing else (browserFocus.ts).
//   4. The workbench DOES emulate a device — `workbench.action.browser.
//      pickDevicePreset`, `toggleDeviceEmulation`, `setUserAgent`, `resetEmulation`
//      — but every one of those commands takes only the active editor pane; none
//      accepts a width or a height, and none is registered as a configuration
//      default. The full `workbench.browser.*` setting list carries no viewport.
//   5. The ONE programmatic seam is CDP. `out/main.js` registers a command
//      interceptor that turns `Emulation.setDeviceMetricsOverride` into the browser
//      view's own `setDevice({ width, height, mobile, deviceScaleFactor })`. That is
//      exactly the command Playwright's `page.setViewportSize` sends — so the
//      viewport IS settable, through `run_playwright_code` and through nothing else.
//
// `run_playwright_code` carries `confirmationMessages`, and this extension invokes
// with `toolInvocationToken: undefined`, so VS Code raises a modal of its own unless
// `chat.tools.global.autoApprove` is on — the same gate browserForce.ts already
// reads, for the same reason and with the same faithfulness. Hence the shape below:
// the viewport is applied when it CAN be, and every capture carries a sentence
// saying which of the two actually happened. A screenshot silently taken at the tab
// size while the model believes it is 1920x1080 is the failure this file prevents.

import * as vscode from 'vscode';
import { check } from './browserResult';
import { PLAYWRIGHT_TOOL } from './browserTools';
import { globalAutoApprove } from './browserVsCode';

/** The user's default, in the dashboard Settings section. Contributed
 *  configuration, so it persists with the rest of the user's settings. */
export const WIDTH_SETTING = 'origami.browser.viewportWidth';
export const HEIGHT_SETTING = 'origami.browser.viewportHeight';

/** 1920x1080 at device-pixel-ratio 1 — the ticket's "1080 full screen", settled as
 *  a page viewport rather than an OS full screen, which the embedded browser has no
 *  way to enter. */
export const DEFAULT_WIDTH = 1920;
export const DEFAULT_HEIGHT = 1080;

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** The bounds VS Code's own emulation toolbar enforces on its width/height inputs
 *  (`_createNumberInput(a, n, …, 1, 9999)`, floored at 50 by the drag handles).
 *  Taken from there rather than invented, so a value this file accepts is a value
 *  the workbench would accept from its own UI. */
export const MIN_SIDE = 50;
export const MAX_SIDE = 9999;

function side(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(n)));
}

/** A settings pair turned into a viewport. Out-of-range and non-numeric values are
 *  clamped rather than refused: this is read on the path to a capture, and a broken
 *  setting must not be the reason a screenshot fails. */
export function clampViewport(width: unknown, height: unknown): Viewport {
  return { width: side(width, DEFAULT_WIDTH), height: side(height, DEFAULT_HEIGHT) };
}

/** The configured default. Read live on every capture, so a change in Settings
 *  applies to the next screenshot without a reload. */
export function readViewport(): Viewport {
  const config = vscode.workspace.getConfiguration();
  return clampViewport(config.get(WIDTH_SETTING), config.get(HEIGHT_SETTING));
}

/** The body of `async (page) => { … }`. It SETS the viewport and then MEASURES it
 *  from inside the page, so the note this file writes quotes what the page really
 *  reports rather than what was asked for. `page.evaluate` is how the tool's own
 *  description says to reach `window`. */
export function viewportSnippet(view: Viewport): string {
  return (
    `await page.setViewportSize({ width: ${view.width}, height: ${view.height} });\n` +
    `return await page.evaluate(() => window.innerWidth + 'x' + window.innerHeight);`
  );
}

/** Bounded well inside the engine's 30s bridge timeout, and inside the screenshot
 *  that follows it. A resize is one CDP round trip; it is not a page load. */
const SNIPPET_MS = 5000;

export function viewportInput(pageId: string, view: Viewport): Record<string, unknown> {
  return { pageId, code: viewportSnippet(view), timeoutMs: SNIPPET_MS };
}

export type ViewportPlan = { run: true } | { run: false; why: string };

/** Whether the viewport can be set at all, and what a capture must say when it
 *  cannot. Pure — the setting arrives as a function, exactly as planForce takes it,
 *  so both sides of the gate are testable without a workbench. */
export function planViewport(
  tools: readonly string[],
  view: Viewport,
  autoApprove: () => boolean,
): ViewportPlan {
  if (!tools.includes(PLAYWRIGHT_TOOL)) {
    return {
      run: false,
      why:
        `The capture is at the embedded tab's own size, not ${view.width}x${view.height}: this VS Code build ` +
        `published no "${PLAYWRIGHT_TOOL}", and no published browser tool, open command or workbench command ` +
        'accepts a viewport size.',
    };
  }
  if (!autoApprove()) {
    return {
      run: false,
      why:
        `The capture is at the embedded tab's own size, not ${view.width}x${view.height}: setting the viewport ` +
        `needs "${PLAYWRIGHT_TOOL}", which VS Code confirms with a modal dialog unless ` +
        '"chat.tools.global.autoApprove" is on, and that setting is off — the dialog would stop this session ' +
        "until someone answered it. The composer's Browser control switches it between Ask and Bypass.",
    };
  }
  return { run: true };
}

/** What the page answered. `run_playwright_code` replies `Result: "1920x1080"`
 *  ahead of its summary, so the measurement is read back out of that. */
const MEASURED = /(\d{2,5})x(\d{2,5})/;

/** The size the capture REALLY is, as a pair rather than a sentence (t-qn0lpl).
 *
 *  The chat strip's caption says `frame 3 of 3 · 1280 × 720 px`, because a
 *  screenshot with no dimensions cannot be compared with anything. It reads the
 *  SAME reply `measuredNote` below reads — the page's own answer, when it gave
 *  one — so the caption and the sentence the model is told can never disagree.
 *  With nothing reported, the configured viewport is the honest answer: that is
 *  what the page was just set to. */
export function measuredSize(view: Viewport, text: string): Viewport {
  const seen = MEASURED.exec(text);
  return seen ? { width: Number(seen[1]), height: Number(seen[2]) } : view;
}

export function measuredNote(view: Viewport, text: string): string {
  const seen = MEASURED.exec(text);
  if (!seen) {
    return (
      `The page viewport was set to ${view.width}x${view.height} for this capture, but the page did not report ` +
      'its own size back, so the picture may still be at the tab size.'
    );
  }
  const measured = `${seen[1]}x${seen[2]}`;
  if (measured === `${view.width}x${view.height}`) {
    return `Captured at a ${measured} page viewport, independent of the size of the tab in the workbench.`;
  }
  return (
    `The page viewport was set to ${view.width}x${view.height}, but the page reports ${measured} — the capture ` +
    'is at that size, not the one configured.'
  );
}

export type ViewportRun = (name: string, input: Record<string, unknown>) => Promise<unknown>;

/**
 * Put the page at the configured viewport before it is captured, and return the
 * sentence the capture owes the model either way. Never throws and never fails the
 * capture: a screenshot at the wrong size is worth more than no screenshot, as long
 * as the model is told which it got.
 */
export async function applyViewport(
  run: ViewportRun,
  tools: readonly string[],
  pageId: string,
  view: Viewport,
): Promise<string> {
  const plan = planViewport(tools, view, globalAutoApprove);
  if (!plan.run) return plan.why;
  try {
    const seen = check(await run(PLAYWRIGHT_TOOL, viewportInput(pageId, view)), 'raw');
    if (seen.failed !== undefined) {
      return (
        `The page viewport could not be set to ${view.width}x${view.height}, so the capture is at the embedded ` +
        `tab's own size: ${seen.failed}`
      );
    }
    return measuredNote(view, seen.checked.text);
  } catch (error) {
    return (
      `The page viewport could not be set to ${view.width}x${view.height}, so the capture is at the embedded ` +
      `tab's own size: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

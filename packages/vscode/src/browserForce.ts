// browserForce.ts — the LAST attempt a click gets, and the only one that skips
// Playwright's actionability check. browserRetry.ts asks whether a narrower
// SELECTOR would have worked; this file accepts that the selector was right and the
// element was never judged clickable — an overlay, a zero-size hit box, a control
// disabled in the DOM but not to the eye.
//
// A forced click is not expressible through `click_element` (no `force`, no
// `timeout` in its schema), so it goes through `run_playwright_code`, which carries
// `confirmationMessages`. This extension invokes with `toolInvocationToken:
// undefined` — the no-chat-context branch, which raises a modal ITSELF unless
// `chat.tools.global.autoApprove` is on, so that setting is read here as a faithful
// predictor of VS Code's own decision. The residual it cannot see: the first time
// the stored opt-in is missing VS Code raises its own "YOLO mode" warning once, and
// declining writes the setting back to false.

import type { Checkup } from './browserResult';
import { check } from './browserResult';
import { PLAYWRIGHT_TOOL, type DrivenAction } from './browserTools';
import { isUnactionable } from './browserRetry';
import { globalAutoApprove } from './browserVsCode';

/** The wrapper is `async (page) => { <code> }` and the whole snippet is bounded
 *  by `timeoutMs` (default 5000). 8000 leaves room for the two waits below
 *  without the outer bound cutting the click short of its own timeout. */
const SNIPPET_MS = 8000;
const SCROLL_MS = 2000;
const CLICK_MS = 4000;

/** The forced click, as the BODY of `async (page) => { … }`. `.first()` because
 *  `force` does not make a locator unambiguous — a selector matching three elements
 *  throws strict mode inside the snippet exactly as it did in the tool. The scroll's
 *  failure is swallowed on purpose: `scrollIntoViewIfNeeded` runs an actionability
 *  wait of its own, so on the very page state this exists for it can time out, and
 *  letting that end the attempt would mean the force never runs. The selector goes
 *  through JSON.stringify, so a quote or newline in it stays a literal. */
export function forceSnippet(selector: string): string {
  return (
    `const el = page.locator(${JSON.stringify(selector)}).first();\n` +
    `try { await el.scrollIntoViewIfNeeded({ timeout: ${SCROLL_MS} }); } catch {}\n` +
    `await el.click({ force: true, timeout: ${CLICK_MS} });\n` +
    `return 'forced click dispatched';`
  );
}

export function forceInput(pageId: string, selector: string): Record<string, unknown> {
  return { pageId, code: forceSnippet(selector), timeoutMs: SNIPPET_MS };
}

/** `run` is the attempt; `why` is what a failure must say about an attempt that
 *  was NOT made. Both absent means the failure is none of this file's business
 *  and is passed through untouched. */
export type ForcePlan = { run: true; note: string } | { run: false; why?: string };

export interface ForceContext {
  tools: readonly string[];
  pageId: string;
  action: DrivenAction;
  selector?: string;
}

/** Whether a forced click is worth trying, and what it will owe the model if it
 *  works. Pure: the setting arrives as a function so both sides of the gate are
 *  testable without a workbench, and so the config is READ only on the one failure
 *  that could act on it. Only `click`, and only on an actionability timeout — a
 *  strict-mode violation is already answered by the narrowed retry, and forcing one
 *  would click an element nobody chose. */
export function planForce(ctx: ForceContext, failure: string, autoApprove: () => boolean): ForcePlan {
  if (ctx.action !== 'click' || !ctx.selector) return { run: false };
  if (!isUnactionable(failure)) return { run: false };
  if (!ctx.tools.includes(PLAYWRIGHT_TOOL)) {
    return {
      run: false,
      why: `A forced click could not be tried: this build published no "${PLAYWRIGHT_TOOL}", which is the only tool whose input can express one.`,
    };
  }
  if (!autoApprove()) {
    return {
      run: false,
      why:
        `A forced click was not tried. It needs "${PLAYWRIGHT_TOOL}", which VS Code confirms with a modal dialog ` +
        'unless "chat.tools.global.autoApprove" is on, and that setting is off — the dialog would stop this session ' +
        'until someone answered it.',
    };
  }
  return {
    run: true,
    note:
      `"${ctx.selector}" never became clickable, so it was clicked through "${PLAYWRIGHT_TOOL}" with Playwright's ` +
      'force option: the visible/enabled/stable checks were SKIPPED and the first match was used. A forced click ' +
      'can land on a covered or disabled control and report success, so confirm the page actually changed.',
  };
}

/** How a forced click that ALSO failed reads: the real failure leads, the force
 *  is appended as the attempt it was. Same rule as browserRetry's double
 *  failure — reporting only the second answers a question nobody asked. */
function forceFailed(first: string, second: string): Checkup {
  return {
    failed:
      `${first}\nA forced click (actionability checks skipped) also failed: ${second}\n` +
      'The element is on the page and cannot be clicked even unchecked, so it is covered by something, has no ' +
      'hit box, or the page is not the one on screen.',
  };
}

/** The last rung. Takes the outcome so far and either hands it straight back — with
 *  a sentence about the attempt that was not made — or replaces it with the forced
 *  attempt. `note` is set only on the far side of a force that WORKED. */
export async function forceAfterFailure(
  run: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  ctx: ForceContext,
  seen: Checkup,
): Promise<{ seen: Checkup; note?: string }> {
  if (seen.failed === undefined) return { seen };
  const plan = planForce(ctx, seen.failed, globalAutoApprove);
  if (!plan.run) return { seen: plan.why ? { failed: `${seen.failed}\n${plan.why}` } : seen };

  const forced = check(await run(PLAYWRIGHT_TOOL, forceInput(ctx.pageId, ctx.selector as string)), ctx.action);
  if (forced.failed !== undefined) return { seen: forceFailed(seen.failed, forced.failed) };
  return { seen: forced, note: plan.note };
}

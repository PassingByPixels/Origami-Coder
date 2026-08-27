// browserForce.ts — the LAST attempt a click gets, and the only one that lies
// to Playwright about actionability.
//
// Separate from browserRetry.ts (158/170, no room) and a different question
// again: that file asks whether a narrower SELECTOR would have worked, this one
// accepts that the selector was right and the element was simply never judged
// clickable. It runs after browserPage.ts has already brought the page to the
// front, so it is the answer to "the page is on screen and it STILL will not
// click" — an overlay, a zero-size hit box, a control that is disabled in the
// DOM but not to the eye.
//
// Round 2 refused to reach for this, and the refusal was correct THEN. It is
// recorded here so the change of mind is legible rather than looking like drift:
//
//   `click_element`'s inputSchema on 1.132.0 is { pageId, ref, selector,
//   element, dblClick, button } and its impl is `locator(sel).click({button})`.
//   There is no `force` and no `timeout` to pass, so a forced click is not
//   expressible through that tool at all. The one tool that CAN express it,
//   `run_playwright_code`, returns `confirmationMessages` from its
//   prepareToolInvocation, and this extension invokes tools with
//   `toolInvocationToken: undefined` — the no-chat-context branch, which raises
//   a modal dialog of its own. Reaching for it would have hung every headless
//   flow behind a dialog nobody was there to answer.
//
// What changed is the setting, and only the setting. In the 1.132.0 bundle the
// no-context branch reads
//
//   let {autoConfirmed: E, preparedInvocation: L} = await this.resolveAutoConfirmFromHook(m, g, e, I, void 0);
//   if (I?.confirmationMessages?.title && !E && !(await this._dialogService.confirm({…})).confirmed) throw;
//
// so a truthy `autoConfirmed` skips the dialog entirely, and `shouldAutoConfirm`
// produces one from the global setting:
//
//   let m = this._configurationService.inspect("chat.tools.global.autoApprove");
//   let g = m.value ?? m.defaultValue;
//   if (typeof t == "boolean" && (…));                       // t = runsInWorkspace
//   if ((g === !0 || …) && await this._checkGlobalAutoApprove()) return {type:2, …};
//
// `run_playwright_code`'s tool definition declares no `runsInWorkspace`, so `t`
// is undefined, the re-read is skipped, and `g` is exactly the effective value
// `getConfiguration().get()` returns — which is why reading the setting here is
// a faithful predictor of what VS Code will decide, not an approximation.
//
// The residual, stated plainly because it is the one thing this gate cannot
// see: `_checkGlobalAutoApprove` also requires a stored opt-in
// ("chat.tools.global.autoApprove.optIn"), and the FIRST time it is missing VS
// Code raises its own "YOLO mode" warning once. Answering it stores the flag;
// declining it writes the setting back to false, which this gate then reads as
// false. So a user who has never confirmed that warning can meet one dialog,
// once, and never again — and the alternative is worse, because with the
// setting OFF the modal is unconditional and there is no fallback at all.

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

/**
 * The forced click, as the BODY of `async (page) => { … }`.
 *
 * `.first()` because `force` does not make a locator unambiguous: a selector
 * that matches three elements throws strict mode inside the snippet exactly as
 * it did in the tool, and this path is reached on an actionability failure, so
 * picking the first match is the intent already.
 *
 * The scroll is attempted and its failure swallowed on purpose.
 * `scrollIntoViewIfNeeded` runs an actionability wait of its own, so on the
 * very page state this exists for it can time out — and letting that end the
 * attempt would mean the force never runs.
 *
 * The selector goes through JSON.stringify, so a quote, a backslash or a
 * newline in a model-written selector is a literal, not a syntax error in
 * somebody else's javascript.
 */
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

/**
 * Whether a forced click is worth trying, and what it will owe the model if it
 * works. Pure: the setting arrives as a function so both sides of the gate are
 * testable without a workbench, and — the reason it is a function and not a
 * boolean — so that the config is READ only on the one failure that could act
 * on it. Every other failed verb in the extension leaves the setting alone.
 *
 * Only `click`, and only on an actionability timeout. A strict-mode violation
 * has already been answered by the narrowed retry, and forcing one would click
 * an element nobody chose; a navigation or a detached frame is not made better
 * by skipping a check.
 */
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

/**
 * The last rung. Takes the outcome so far and either hands it straight back —
 * with a sentence about the attempt that was not made, when there was a reason
 * worth naming — or replaces it with the forced attempt.
 *
 * `note` is set only on the far side of a force that WORKED, so no answer ever
 * describes a force that did not happen.
 */
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

// browserRetry.ts — the ONE bounded retry a failed page verb is allowed.
//
// Extracted rather than folded into browserBridge.ts (356/360, no room) because
// it is a separate job: that file decides WHICH tool a verb means, this one
// decides whether the way a tool FAILED is worth one more attempt, and with
// what. Pure and vscode-free, so both branches are testable off the real error
// strings instead of a live browser.
//
// Two live failures, from a UAT run against VS Code 1.132.0, are what this
// answers. Both come back through `check` as `seen.failed`:
//
//   1. "strict mode violation: locator('text=Entrypoint') resolved to 3
//      elements:" — the model named a selector that is not unique. Playwright
//      refuses ambiguity outright rather than guessing, so nothing happened.
//   2. "locator resolved to <button …>" then "waiting for element to be
//      visible, enabled and stable" then "Timeout 10000ms" — the element EXISTS
//      but never became actionable. The usual cause is a selector that matched a
//      HIDDEN twin (a collapsed menu, an off-screen mobile nav) while a visible
//      one is on the page.
//
// Both are answered the same way: narrow the selector with a Playwright selector
// -engine suffix and try ONCE more. `>> nth=0` and `>> visible=true` are part of
// the selector STRING, which is why they work here at all — see below.
//
// What this file deliberately does NOT do is force the click. `click_element`'s
// inputSchema on 1.132.0 is { pageId, ref, selector, element, dblClick, button }
// and its impl is `locator(sel).click({ button })` — there is no `force` and no
// `timeout` to pass. The only tool that could force one is `run_playwright_code`,
// whose prepareToolInvocation carries its own `confirmationMessages`, so reaching
// for it would raise the very modal the browser feature is trying to avoid. A
// click that fails both attempts therefore says so plainly rather than claiming
// a force that never happened.

import { check, type Checkup } from './browserResult';
import type { DrivenAction } from './browserTools';

/** Playwright refuses an ambiguous locator instead of picking for you, and it
 *  prints the count and then a numbered list of what it matched. */
const AMBIGUOUS = /strict mode violation[\s\S]*?resolved to (\d+) elements/i;

/** The first entry of that numbered list — the element `>> nth=0` will take.
 *  The ` aka <playwright suggestion>` tail is dropped: the raw tag is what
 *  identifies the element, the suggestion is advice about a different selector. */
const FIRST_CANDIDATE = /^\s*1\)\s*(.+?)(?:\s+aka\s.*)?$/m;

/** The actionability wait, which is what a click spends its timeout ON. Matched
 *  rather than the bare "Timeout", because a navigation timeout and a click that
 *  never became stable are different failures with different answers. */
const UNACTIONABLE = /waiting for element to be visible, enabled and stable/i;

/** Shared with browserForce.ts rather than mirrored there: the LAST rung of the
 *  ladder triggers on exactly the failure this second rung does, and two copies
 *  of this regex could drift into a force that fires on a different failure
 *  than the one it was reasoned about. */
export function isUnactionable(failure: string): boolean {
  return UNACTIONABLE.test(failure);
}

/** How long VS Code actually waited, so the answer quotes the real number
 *  instead of a remembered default. */
const WAITED = /Timeout (\d+)ms/i;

/** Only the verbs that narrow ONE selector. `drag` names two ends and this file
 *  rewrites only the selector it is handed, so a retry could narrow the wrong
 *  one; `navigate` fails about a url, and read/screenshot/dialog/raw name no
 *  element at all. */
const RETRYABLE: ReadonlySet<DrivenAction> = new Set<DrivenAction>(['click', 'type', 'hover']);

/** A selector the model ALREADY narrowed this way. Appending a second
 *  `>> nth=0` to `… >> nth=2` is not a repair — it re-picks inside a pick the
 *  model made on purpose — and a second `>> visible=true` is pure churn. Matched
 *  as a trailing clause, because that is the only position where the suffix
 *  would have applied to the same match set this retry is trying to narrow. */
const ALREADY_NTH = />>\s*nth=\d+\s*$/i;
const ALREADY_VISIBLE = />>\s*visible=(?:true|false)\s*$/i;

export interface RetryPlan {
  /** The narrowed selector to try once more. */
  selector: string;
  /** What to say when the retry WORKED — never a claim made before it has. */
  note: string;
}

/**
 * Whether this failure earns one more attempt, and with what selector.
 *
 * `undefined` for everything else, which is most things: a page that navigated
 * away, a detached frame, a refused url. Retrying those changes nothing and
 * costs the model another round trip against the same wall.
 */
export function planRetry(action: DrivenAction, selector: string, failure: string): RetryPlan | undefined {
  if (!RETRYABLE.has(action)) return undefined;

  const ambiguous = AMBIGUOUS.exec(failure);
  if (ambiguous) {
    if (ALREADY_NTH.test(selector)) return undefined;
    const narrowed = `${selector.trimEnd()} >> nth=0`;
    const first = FIRST_CANDIDATE.exec(failure)?.[1]?.trim();
    // WHICH element was acted on is the whole point of reporting this: the model
    // asked for something ambiguous, so it cannot know what it just clicked
    // unless the answer says. Quoted verbatim from Playwright's own list.
    const which = first ? ` It acted on the first match: ${first}.` : '';
    return {
      selector: narrowed,
      note:
        `"${selector}" matched ${ambiguous[1]} elements, so it was retried as "${narrowed}".${which} ` +
        'Give a selector that matches exactly one element (a CSS id or class, or an explicit ">> nth=N") ' +
        'if that was the wrong one.',
    };
  }

  if (UNACTIONABLE.test(failure)) {
    if (ALREADY_VISIBLE.test(selector)) return undefined;
    const narrowed = `${selector.trimEnd()} >> visible=true`;
    const waited = WAITED.exec(failure)?.[1];
    const waiting = waited ? ` within ${waited}ms` : '';
    return {
      selector: narrowed,
      note:
        `"${selector}" matched an element that never became clickable${waiting} — usually a hidden twin of the ` +
        `one on screen — so it was retried as "${narrowed}", which matches visible elements only.`,
    };
  }

  return undefined;
}

/**
 * How a failed retry is reported: the FIRST failure, which is the real one,
 * with the second appended as the attempt it was. Reporting only the second
 * would answer a question nobody asked — "no visible match for
 * `button.run >> visible=true`" describes a selector this file invented.
 */
function bothFailed(first: string, plan: RetryPlan, second: string): Checkup {
  return {
    failed:
      `${first}\nA narrowed retry against "${plan.selector}" also failed: ${second}\n` +
      "VS Code's page tools take no force or timeout option, so this cannot be pushed through from here. " +
      'Check that the page is the one on screen, and that the element is not covered, disabled or off-screen.',
  };
}

/**
 * Run one page verb, and give it a SECOND attempt when the way it failed says a
 * narrower selector would do better. At most one retry, ever: a loop here would
 * spend the model's time re-proving the same wall, and every extra attempt is
 * another 10 seconds of the user's.
 *
 * `note` is set only on the far side of a retry that WORKED, so a result never
 * describes a repair that did not happen.
 */
export async function driveWithRetry(
  run: (input: Record<string, unknown>) => Promise<unknown>,
  buildInput: (pageId: string, selector: string) => Record<string, unknown>,
  pageId: string,
  action: DrivenAction,
  selector: string | undefined,
): Promise<{ seen: Checkup; note?: string }> {
  const seen = check(await run(buildInput(pageId, selector ?? '')), action);
  if (seen.failed === undefined || !selector) return { seen };

  const plan = planRetry(action, selector, seen.failed);
  if (!plan) return { seen };

  const again = check(await run(buildInput(pageId, plan.selector)), action);
  if (again.failed !== undefined) return { seen: bothFailed(seen.failed, plan, again.failed) };
  return { seen: again, note: plan.note };
}

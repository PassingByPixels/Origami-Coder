// browserPage.ts — which page a verb acts on, and whether it is ON SCREEN.
// browserBridge.ts decides which TOOL a verb means; this one decides which PAGE it
// runs against and whether that page can be acted on at all.
//
// Why a reveal exists. Two rounds of live UAT ended the same way: the locator
// RESOLVED and the element never became "visible, enabled and stable", so the click
// timed out. `list_browser_pages` ends each line with active / visible / not
// visible, and those states ARE the editor's render state, from the same service a
// reveal would move: "not visible" is a background tab with no layout and no
// bounding box, which Playwright's actionability check can never pass. NOT
// vscode.window.tabGroups — a browser tab's `Tab.input` arrives `undefined`, and
// `TabGroups` publishes `close()` and nothing else.

import { check, choosePageId, chosenPageNote, parsePageList, unsharedPages } from './browserResult';
import type { ListedPage, PageState } from './browserResult';
import { LIST_TOOL } from './browserTools';
import { invoke, revealPage } from './browserVsCode';
// WHETHER a reveal is allowed at all is the user's policy, not this file's —
// browserReveal.ts owns it, and owns why "never" cannot cover the first open.
import { REVEAL_SETTING, markRevealed, mayReveal, readRevealPolicy, type RevealPolicy } from './browserReveal';

export interface Found {
  pageId?: string;
  /** Which page was driven — part of the ANSWER. */
  note?: string;
  /** Where that page was on screen — spent only when something FAILED, which
   *  is the one time the difference between a hidden tab and a bad selector is
   *  worth a sentence. */
  screen?: string;
  unshared: number;
  failed?: string;
}

/** `rendered` needs nothing done; `reveal` is the failing case; `unlisted` is
 *  the guard — a reveal on an id VS Code did not list would OPEN A BLANK PAGE
 *  (`getOrCreateLazy`), so an unknown id is reported, never shown. */
export type RevealPlan =
  | { act: 'rendered'; state: PageState }
  | { act: 'reveal' }
  | { act: 'unlisted' }
  /** The page IS hidden and a reveal would have helped, but the user's reveal
   *  policy says leave it where it is. A separate act, not a silent skip: the
   *  sentence it produces is the one a failed click needs. */
  | { act: 'withheld'; policy: RevealPolicy };

/** Whether the page has to be brought to the front before a verb runs. "visible" is
 *  deliberately left alone: it means the page IS in `editorService.visibleEditors`,
 *  so it is laid out and painted, and Playwright needs layout, not focus. Revealing
 *  it anyway would take the user's cursor off whatever they are typing in. */
export function planReveal(pages: readonly ListedPage[], pageId: string): RevealPlan {
  const state = pages.find((page) => page.id === pageId)?.state;
  if (!state) return { act: 'unlisted' };
  return state === 'not visible' ? { act: 'reveal' } : { act: 'rendered', state };
}

/** Where the page was, in the words a failure needs. Never claims a reveal that
 *  did not happen: `failure` is the reveal's own error, and it is said. */
export function screenNote(plan: RevealPlan, pageId: string, failure?: unknown): string {
  if (plan.act === 'unlisted') {
    return `Page ${pageId} was not in VS Code's list of shared pages, so it was not brought to the front first.`;
  }
  if (plan.act === 'withheld') {
    return (
      `The browser page was listed as "not visible" and was LEFT where it is: "${REVEAL_SETTING}" is ` +
      `"${plan.policy}", so the agent does not bring its tab to the front${plan.policy === 'first' ? ' again' : ''}. ` +
      'A background editor tab is not laid out, so an element check can fail for that reason alone; the Insights ' +
      'Browser card has the setting.'
    );
  }
  if (plan.act === 'rendered') {
    return `The browser page was already on screen (VS Code listed it as "${plan.state}"), so a hidden tab is not the cause.`;
  }
  if (failure !== undefined) {
    return (
      'The browser page was listed as "not visible" and could NOT be brought to the front: ' +
      `${failure instanceof Error ? failure.message : String(failure)}. A background editor tab is not laid out, ` +
      'so Playwright can never find the element visible.'
    );
  }
  return 'The browser page was listed as "not visible", so it was brought to the front before this ran.';
}

/** Do it. Best effort: a reveal that throws must not swallow the verb, so the
 *  failure becomes a sentence and the verb runs anyway. */
async function reveal(pages: readonly ListedPage[], pageId: string): Promise<string> {
  const plan = planReveal(pages, pageId);
  if (plan.act !== 'reveal') return screenNote(plan, pageId);
  // The policy gate, between the decision and the call, so nothing above it had
  // to learn about settings and nothing below it can reveal past the rule.
  if (!mayReveal(pageId)) return screenNote({ act: 'withheld', policy: readRevealPolicy() }, pageId);
  try {
    await revealPage(pageId);
  } catch (error) {
    return screenNote(plan, pageId, error);
  }
  // Marked only on a reveal that actually ran: under "first" a reveal that threw
  // has not shown the page, so the next verb is still allowed to try.
  markRevealed(pageId);
  return screenNote(plan, pageId);
}

/** Which page the verbs act on. Resolved fresh on every call rather than cached: a
 *  cached id outlives the tab the user closed, and VS Code answers a dead id with
 *  "No browser page found with ID …", which reads as a broken tool. The extra
 *  in-process call also carries the render state the reveal needs. */
export async function lookupPage(tools: readonly string[]): Promise<Found> {
  if (!tools.includes(LIST_TOOL)) return { unshared: 0 };
  // Through the gate too: read without it, a FAILED list came back spliced
  // empty and the bridge answered "No page is open" over VS Code's reason.
  const seen = check(await invoke(LIST_TOOL, {}));
  if (seen.failed !== undefined) return { unshared: 0, failed: seen.failed };
  const listed = seen.checked.text;
  const pages = parsePageList(listed);
  const pageId = choosePageId(pages);
  if (!pageId) return { unshared: unsharedPages(listed) };
  const note = chosenPageNote(pages, pageId);
  return {
    pageId,
    ...(note ? { note } : {}),
    screen: await reveal(pages, pageId),
    unshared: unsharedPages(listed),
  };
}

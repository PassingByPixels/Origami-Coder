// browserPage.ts — which page a verb acts on, and whether it is ON SCREEN.
//
// Extracted from browserBridge.ts (357/360, no room) rather than folded in,
// and along a line that file already had: it decides which TOOL a verb means,
// this one decides which PAGE that tool runs against and whether that page can
// be acted on at all. `lookupPage` moved here whole; the reveal is new.
//
// Why a reveal exists at all. Two rounds of live UAT ended the same way: the
// locator RESOLVED ("locator resolved to <input checked>") and then the element
// never became "visible, enabled and stable", so the click timed out at
// 10000ms. Round 2 retried it as `>> visible=true` — the hidden-TWIN theory —
// and that matched nothing, which ruled the twin out and left the container:
// the browser page itself was not rendered while the agent clicked.
//
// VS Code says so in its own answer. `list_browser_pages` prints one line per
// shared page ending in a state, and the bundle computes it (`Lcn`) as
//
//   let t = editorService.activeEditor, i = new Set(editorService.visibleEditors);
//   … a === t ? " (active)" : i.has(a) ? " (visible)" : " (not visible)"
//
// so the three states ARE the editor's render state, from the same service a
// reveal would move. "not visible" is a background tab in an editor group: no
// layout, no bounding box, and nothing Playwright's actionability check can
// ever pass. That is the whole failure, and the state was already on the wire.
//
// The reveal itself is `vscode.open` on the page's editor resource — see
// browserVsCode.revealPage for why that reveals rather than duplicates.
//
// NOT vscode.window.tabGroups, which the round-3 brief offered as the lead. Two
// things kill it on 1.132.0, both read off the shipped bundle and the shipped
// types: (1) `MainThreadEditorTabs._editorInputToDto` has no branch for the
// browser editor input, so it falls through to `{kind:0}` (UnknownInput) and
// `Tab.input` arrives at an extension as `undefined` — a browser tab carries no
// resource, no scheme and no page id to match on; (2) `TabGroups` publishes
// `close()` and nothing else — there is no reveal, no focus and no activate on
// that API at all. Enumerating tabs could therefore neither FIND the page nor
// SHOW it, while the page list answers both.

import { check, choosePageId, chosenPageNote, parsePageList, unsharedPages } from './browserResult';
import type { ListedPage, PageState } from './browserResult';
import { LIST_TOOL } from './browserTools';
import { invoke, revealPage } from './browserVsCode';

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
export type RevealPlan = { act: 'rendered'; state: PageState } | { act: 'reveal' } | { act: 'unlisted' };

/**
 * Whether the page has to be brought to the front before a verb runs.
 *
 * "visible" is deliberately left alone. It means the page IS in
 * `editorService.visibleEditors` — the active editor of some other group — so
 * it is laid out and painted, and Playwright needs layout, not focus. Revealing
 * it anyway would take the user's cursor off whatever they are typing in, every
 * time, to fix nothing.
 */
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
  try {
    await revealPage(pageId);
  } catch (error) {
    return screenNote(plan, pageId, error);
  }
  return screenNote(plan, pageId);
}

/**
 * Which page the verbs act on. Resolved fresh on every call rather than cached
 * from the last open: a cached id outlives the tab the user closed, and VS Code
 * answers a dead id with "No browser page found with ID …", which reads as a
 * broken tool rather than a closed page. One extra in-process call is the
 * cheaper half of that trade — and it is also what carries the render state,
 * so the reveal costs no round trip of its own.
 */
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

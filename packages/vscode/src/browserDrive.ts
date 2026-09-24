// browserDrive.ts — the DRIVEN verbs: what input each one sends, and the run.
//
// browserBridge.ts owns the ext-method seam and the two verbs that SHOW a page;
// this file owns the eight that act on a page already shared — one shape, one page
// lookup, one retry ladder, one gate. Both halves of a verb live here because the
// input IS the verb. Every field below was read off the SHIPPED bundle (VS Code
// 1.133.0, re-read on 1.135.0 with every inputSchema unchanged), and each builder
// names the `inputSchema` it came from. Nothing is inferred from a tool's name — a
// wrong field is not an error: VS Code drops it and reports success.

import {
  ACTION_TOOLS,
  DIALOG_ACCEPT_ERROR,
  EMPTY_TEXT_ERROR,
  LIST_TOOL,
  driveFailedError,
  failed,
  isCancellation,
  missingToolError,
  noPageError,
  pickTool,
  rawBlockedError,
  rawDismissedError,
  succeeded,
  threwError,
  type BrowserResponse,
  type DrivenAction,
} from './browserTools';
import type { Checkup } from './browserResult';
import { discoverTools, globalAutoApprove, invoke, probe, toBrowserUrl } from './browserVsCode';
import { driveWithRetry } from './browserRetry';
import { lookupPage, type Found } from './browserPage';
import { forceAfterFailure } from './browserForce';
import { applyViewport, measuredSize, readViewport } from './browserViewport';
import type { BrowserRequest } from './browserBridge';

/** `click_element`, `hover_element` and `drag_element` REQUIRE their element
 *  description, and `type_in_page` requires it whenever a selector is given. VS
 *  Code spends it only on the sentence it shows the user, so the selector itself is
 *  the honest description. */
function describeElement(selector: string): string {
  return `the element matching ${selector}`;
}

/** `read_page`: `{ pageId }`. */
export function readInput(pageId: string): Record<string, unknown> {
  return { pageId };
}

/** `screenshot_page`: `{ pageId, ref, selector, element, scrollIntoViewIfNeeded }`.
 *  No `fullPage` — the viewport, or ONE element. `scrollIntoViewIfNeeded` is sent
 *  with an element capture because the bundle crops to a viewport-relative bounding
 *  box, so an element below the fold would give a picture of something else,
 *  reported as a success. Never sent for a viewport capture. */
export function screenshotInput(pageId: string, selector: string): Record<string, unknown> {
  if (!selector) return { pageId };
  return { pageId, selector, element: describeElement(selector), scrollIntoViewIfNeeded: true };
}

/** `navigate_page`: the url form of its `type` discriminator. */
export function navigateInput(pageId: string, url: string): Record<string, unknown> {
  return { pageId, type: 'url', url };
}

/** `navigate_page` in its other three forms — the SAME tool and the same `type`
 *  discriminator, `{ pageId, type: "url"|"back"|"forward"|"reload", url }`. No
 *  `url` is sent: the bundle's `switch (t.type)` reaches `page.goBack()` /
 *  `goForward()` / `reload()` and never reads it, and a field VS Code silently
 *  drops is exactly the quiet failure this file's header exists to prevent. */
export function historyInput(pageId: string, type: 'back' | 'forward' | 'reload'): Record<string, unknown> {
  return { pageId, type };
}

/** `click_element`: `{ pageId, ref, selector, element, dblClick, button }`. */
export function clickInput(pageId: string, selector: string): Record<string, unknown> {
  return { pageId, selector, element: describeElement(selector) };
}

/** `hover_element`: `{ pageId, ref, selector, element }` — the same shape as a
 *  click minus the button options, and driven by the same helper, so it fails
 *  the same two ways and earns the same narrowed retry. */
export function hoverInput(pageId: string, selector: string): Record<string, unknown> {
  return { pageId, selector, element: describeElement(selector) };
}

/** `drag_element`: `{ pageId, fromRef, fromSelector, fromElement, toRef,
 *  toSelector, toElement }`, required `[pageId, fromElement, toElement]`. NOT a
 *  selector pair — a `selector`/`toSelector` guess would be dropped whole. */
export function dragInput(pageId: string, from: string, to: string): Record<string, unknown> {
  return {
    pageId,
    fromSelector: from,
    fromElement: describeElement(from),
    toSelector: to,
    toElement: describeElement(to),
  };
}

/** `handle_dialog`: `{ pageId, acceptModal, promptText, selectFiles }`.
 *  `acceptModal` is always sent: the tool refuses a call carrying neither it nor
 *  `selectFiles`, and refuses the two together. File choosers are deliberately not
 *  offered — a path list is a different kind of consent from answering an alert. */
export function dialogInput(pageId: string, accept: boolean, promptText?: string): Record<string, unknown> {
  return { pageId, acceptModal: accept, ...(promptText !== undefined ? { promptText } : {}) };
}

/** `type_in_page`: `{ pageId, text, submit, key, ref, selector, element }`. `key`
 *  and `text` are alternatives — the tool refuses a call with neither — and `key`
 *  wins when both are set. With a selector it presses the key ON that locator;
 *  without one it goes to `page.keyboard`, the only way to reach whatever the page
 *  itself focused. `submit` is not offered: that is two calls, and a flag that
 *  silently submits a form hides what happened. */
export function typeInput(pageId: string, selector: string, text?: string, key?: string): Record<string, unknown> {
  return {
    pageId,
    ...(selector ? { selector, element: describeElement(selector) } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(key ? { key } : {}),
  };
}

/** `run_playwright_code`: `{ pageId, code, deferredResultId, timeoutMs }`. The
 *  snippet is the BODY of `async (page) => { … }`, so a value comes back only
 *  through `return`. 10s rather than the tool's own 5s default, and still inside
 *  the engine's 30s bridge timeout. `deferredResultId` is not offered, so a snippet
 *  that outlives its timeout is reported as one that did. */
const RAW_MS = 10_000;

export function rawInput(pageId: string, code: string): Record<string, unknown> {
  return { pageId, code, timeoutMs: RAW_MS };
}

/** One driven verb, decided and run. Everything here acts on a page that is
 *  ALREADY shared — driveTool looks it up and reveals it. */
export async function drive(request: BrowserRequest): Promise<BrowserResponse> {
  switch (request.action) {
    case 'screenshot':
      return await driveTool(request, 'screenshot', screenshotInput);

    case 'read':
      return await driveTool(request, 'read', readInput);

    case 'click': {
      if (!request.selector) return failed('"click" needs a selector.');
      return await driveTool(request, 'click', clickInput);
    }

    case 'hover': {
      if (!request.selector) return failed('"hover" needs a selector.');
      return await driveTool(request, 'hover', hoverInput);
    }

    case 'drag': {
      const { selector, toSelector } = request;
      if (!selector) return failed('"drag" needs a selector: the element to drag FROM.');
      if (!toSelector) return failed('"drag" needs a toSelector: the element to drop ONTO.');
      return await driveTool(request, 'drag', (pageId, used) => dragInput(pageId, used, toSelector));
    }

    case 'dialog': {
      const { accept, text } = request;
      if (accept === undefined) return failed(DIALOG_ACCEPT_ERROR);
      return await driveTool(request, 'dialog', (pageId) => dialogInput(pageId, accept, text));
    }

    case 'raw': {
      const { code } = request;
      if (!code) return failed('"raw" needs code: the body of an `async (page) => { … }` snippet.');
      // Read BEFORE the tool is invoked, and never written. Same gate class as the forced
      // click: with auto-approve off VS Code raises a modal of its own, and an unanswered
      // modal holds the turn until the engine's timeout kills it.
      if (!globalAutoApprove()) return failed(rawBlockedError(), discoverTools());
      return await driveTool(request, 'raw', (pageId) => rawInput(pageId, code));
    }

    default: {
      const { selector, text, key } = request;
      // A key with no selector is a real request: `page.keyboard.press` goes to whatever
      // the PAGE focused, which is the only way to reach a widget this bridge cannot name.
      if (!selector && !key) return failed('"type" needs a selector.');
      if (text === undefined && !key) return failed('"type" needs text.');
      if (text === '' && !key) return failed(EMPTY_TEXT_ERROR, discoverTools());
      return await driveTool(request, 'type', (pageId, used) => typeInput(pageId, used, text, key));
    }
  }
}

/** Run one driven action through its real tool, against the open page. */
async function driveTool(
  request: BrowserRequest,
  action: DrivenAction,
  buildInput: (pageId: string, selector: string) => Record<string, unknown>,
): Promise<BrowserResponse> {
  const tools = discoverTools();
  const name = pickTool(tools, action);
  if (!name) {
    // The one place the full probe is worth its round trip: "why can't you" is better
    // answered knowing whether a page can still be SHOWN, which is a command, not a tool.
    const { openCommand } = await probe();
    return failed(missingToolError(action, tools, openCommand), tools);
  }

  let seen: Checkup;
  let note: string | undefined;
  let viewportNote: string | undefined;
  // The same reading as the note above, as a pair the chat strip's caption can
  // print — a screenshot's bytes do not say what size the PAGE was.
  let viewportSize: { width: number; height: number } | undefined;
  let found: Found;
  try {
    found = await lookupPage(tools);
    if (found.failed !== undefined) return failed(driveFailedError(action, LIST_TOOL, found.failed), tools);
    if (!found.pageId) return failed(noPageError(action, found.unshared, tools), tools);
    // A viewport capture is taken at whatever size the TAB happens to be, so the
    // page is put at the configured viewport first — and the answer carries a
    // sentence saying whether that worked. browserViewport.ts has the finding.
    if (action === 'screenshot' && !request.selector) {
      const configured = readViewport();
      viewportNote = await applyViewport(invoke, tools, found.pageId, configured);
      viewportSize = measuredSize(configured, viewportNote);
    }
    const driven = await driveWithRetry((i) => invoke(name, i), buildInput, found.pageId, action, request.selector);
    // The last rung, and the only one that skips Playwright's own checks.
    const ctx = { tools, pageId: found.pageId, action, ...(request.selector ? { selector: request.selector } : {}) };
    const forced = await forceAfterFailure(invoke, ctx, driven.seen);
    seen = forced.seen;
    note = [found.note, driven.note, forced.note].filter(Boolean).join('\n') || undefined;
  } catch (error) {
    // The one throw that is an ANSWER rather than a broken surface: VS Code
    // raises its own dialog for `run_playwright_code` the first time global
    // auto-approve is used, and a dismissal arrives here as a cancellation.
    if (action === 'raw' && isCancellation(error)) return failed(rawDismissedError(), tools);
    return failed(threwError(action, error), tools);
  }

  // The tool RESOLVED, which says only that VS Code was reachable. Whether the action
  // worked is a separate question VS Code answers — a click on a selector that is not
  // on the page comes back resolved, with the timeout as a text part.
  if (seen.failed !== undefined) return failed(driveFailedError(action, name, seen.failed, found.screen), tools);
  const parts = seen.checked;

  const url = request.url ? toBrowserUrl(request.url) : undefined;
  const text = [note, parts.text].filter(Boolean).join('\n');
  if (action === 'screenshot') {
    if (!parts.imageBase64) {
      return failed(
        `"${name}" returned no image data` +
          (parts.text ? `, only text: ${parts.text}` : '. The page may not be open in the integrated browser.'),
        tools,
      );
    }
    // Still no which-page `note` here — but the VIEWPORT note does go out, because
    // the size a picture was taken at is not readable from the picture. The engine's
    // screenshot branch appends this sentence to its own caption.
    const imageMime = parts.imageMime ?? 'image/png';
    return succeeded(parts, {
      imageBase64: parts.imageBase64,
      imageMime,
      ...(viewportNote ? { pageText: viewportNote } : {}),
      ...(viewportSize ?? {}),
      ...(url ? { url } : {}),
    });
  }
  return succeeded(parts, { ...(text ? { pageText: text } : {}), ...(url ? { url } : {}) });
}

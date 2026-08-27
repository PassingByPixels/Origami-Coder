// browserDrive.ts — the DRIVEN verbs: what input each one sends, and the run.
//
// Extracted from browserBridge.ts (335/360, no room for four more verbs) and
// browserTools.ts (309/310, no room at all) when hover, drag, dialog and raw
// were mapped. The line is the one browserBridge's own header already drew: that
// file owns the ext-method seam and the two verbs that SHOW a page (open,
// navigate, which reach for a command when no tool will do), this file owns the
// eight that act on a page already shared — one shape, one page lookup, one
// retry ladder, one gate.
//
// Both halves of a verb live here for the same reason browserForce.ts keeps
// `forceInput` beside `forceAfterFailure`: the input IS the verb. `drag_element`
// takes fromSelector/toSelector rather than a selector pair, and a builder
// filed away from the case that calls it is exactly how the first bridge came to
// send fields VS Code silently ignored.
//
// Every field below was read off the SHIPPED bundle — VS Code 1.133.0,
// out/vs/workbench/workbench.desktop.main.js — and each builder names the
// `inputSchema` it was read from. Nothing is inferred from a tool's name. A
// wrong field here is not an error: VS Code drops it and reports success, which
// is the quietest failure this feature can have.
//
// `BrowserRequest` comes back the other way as a TYPE ONLY, erased at build
// time — the same arrangement browserTools.ts and browserResult.ts already have,
// so neither file gains a runtime dependency on the other.

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
import type { BrowserRequest } from './browserBridge';

/**
 * `click_element`, `hover_element` and `drag_element` REQUIRE their element
 * description (it is in each schema's `required`), and `type_in_page` requires
 * it whenever a selector is given. VS Code spends it only on the sentence it
 * shows the user, so the selector itself is the honest description — inventing a
 * friendlier one would put words in the model's mouth about an element neither
 * half has looked at.
 */
function describeElement(selector: string): string {
  return `the element matching ${selector}`;
}

/** `read_page`: `{ pageId }`. */
export function readInput(pageId: string): Record<string, unknown> {
  return { pageId };
}

/**
 * `screenshot_page`: `{ pageId, ref, selector, element, scrollIntoViewIfNeeded }`.
 * No `fullPage` — it captures the viewport, or ONE element, and nothing else.
 *
 * `scrollIntoViewIfNeeded` is sent with an element capture because the bundle
 * crops to `locator(sel).boundingBox()`, which is viewport-relative: an element
 * below the fold has a box outside the shot, so the model gets a picture of
 * something else and is told it worked. This tool publishes no scroll verb, so
 * there is no other way to bring it into frame. Never sent for a viewport
 * capture, which has no element to scroll to.
 */
export function screenshotInput(pageId: string, selector: string): Record<string, unknown> {
  if (!selector) return { pageId };
  return { pageId, selector, element: describeElement(selector), scrollIntoViewIfNeeded: true };
}

/** `navigate_page`: the url form of its `type` discriminator. */
export function navigateInput(pageId: string, url: string): Record<string, unknown> {
  return { pageId, type: 'url', url };
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

/**
 * `drag_element`: `{ pageId, fromRef, fromSelector, fromElement, toRef,
 * toSelector, toElement }`, required `[pageId, fromElement, toElement]`. NOT a
 * selector pair on one name — the source and the target are separate fields, and
 * a `selector`/`toSelector` guess would have been dropped whole.
 */
export function dragInput(pageId: string, from: string, to: string): Record<string, unknown> {
  return {
    pageId,
    fromSelector: from,
    fromElement: describeElement(from),
    toSelector: to,
    toElement: describeElement(to),
  };
}

/**
 * `handle_dialog`: `{ pageId, acceptModal, promptText, selectFiles }`.
 *
 * `acceptModal` is always sent: the tool refuses a call that carries neither it
 * nor `selectFiles` ("Either 'selectFiles' or 'acceptModal' must be provided"),
 * and it refuses the two TOGETHER. File choosers are the `selectFiles` half and
 * are deliberately not offered here — a path list is a different kind of consent
 * from answering an alert, and nothing in Track A asked for it.
 */
export function dialogInput(pageId: string, accept: boolean, promptText?: string): Record<string, unknown> {
  return { pageId, acceptModal: accept, ...(promptText !== undefined ? { promptText } : {}) };
}

/**
 * `type_in_page`: `{ pageId, text, submit, key, ref, selector, element }`.
 *
 * `key` and `text` are alternatives — the tool refuses a call with neither — and
 * `key` wins when both are set. With a selector it presses the key ON that
 * locator; without one it goes to `page.keyboard`, which is the only way to
 * reach whatever the page itself focused. `submit` is not offered: "type then
 * press Enter" is expressible as two calls, and one flag that silently submits a
 * form is worth less than the model knowing it did.
 */
export function typeInput(pageId: string, selector: string, text?: string, key?: string): Record<string, unknown> {
  return {
    pageId,
    ...(selector ? { selector, element: describeElement(selector) } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(key ? { key } : {}),
  };
}

/**
 * `run_playwright_code`: `{ pageId, code, deferredResultId, timeoutMs }`. The
 * snippet is the BODY of `async (page) => { … }`, so a value comes back only
 * through `return`.
 *
 * 10s rather than the tool's own 5s default: a snippet that waits for a selector
 * spends most of its budget waiting, and the whole request still has to answer
 * inside the engine's 30s bridge timeout. `deferredResultId` is not offered —
 * resuming a deferred run is a second round trip this bridge has no verb for, so
 * a snippet that outlives its timeout is reported as one that did.
 */
const RAW_MS = 10_000;

export function rawInput(pageId: string, code: string): Record<string, unknown> {
  return { pageId, code, timeoutMs: RAW_MS };
}

/**
 * One driven verb, decided and run. Everything here acts on a page that is
 * ALREADY shared: the page is looked up (and revealed) by driveTool, so no case
 * below has to think about which tab it is on.
 */
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
      // Read BEFORE the tool is invoked, and never written. Same gate class as
      // the forced click, for the same reason: with auto-approve off VS Code
      // raises a modal of its own, and an unanswered modal holds the turn until
      // the engine's timeout kills it. Refusing says which setting to change.
      if (!globalAutoApprove()) return failed(rawBlockedError(), discoverTools());
      return await driveTool(request, 'raw', (pageId) => rawInput(pageId, code));
    }

    default: {
      const { selector, text, key } = request;
      // A key with no selector is a real request: `page.keyboard.press` goes to
      // whatever the PAGE focused, which is the only way to answer a widget this
      // bridge cannot name.
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
    // The one place the full probe is worth its round trip: the answer to
    // "why can't you" is better when it also knows whether a page can still
    // be SHOWN, which is a command, not a tool.
    const { openCommand } = await probe();
    return failed(missingToolError(action, tools, openCommand), tools);
  }

  let seen: Checkup;
  let note: string | undefined;
  let found: Found;
  try {
    found = await lookupPage(tools);
    if (found.failed !== undefined) return failed(driveFailedError(action, LIST_TOOL, found.failed), tools);
    if (!found.pageId) return failed(noPageError(action, found.unshared, tools), tools);
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

  // The tool RESOLVED, which says only that VS Code was reachable. Whether the
  // action worked is a separate question, and one VS Code answers — a click on
  // a selector that is not on the page comes back resolved, with the timeout as
  // a text part. Asked here, before anything is called a success.
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
    // No `note` here: the engine's screenshot branch replaces pageText with its
    // own caption, so a which-page note would never reach the model.
    const imageMime = parts.imageMime ?? 'image/png';
    return succeeded(parts, { imageBase64: parts.imageBase64, imageMime, ...(url ? { url } : {}) });
  }
  return succeeded(parts, { ...(text ? { pageText: text } : {}), ...(url ? { url } : {}) });
}

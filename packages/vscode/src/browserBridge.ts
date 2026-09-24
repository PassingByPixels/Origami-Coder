// browserBridge.ts — the CLIENT half of the engine's `browser` tool.
//
// The engine drives no browser: it sends the ACP ext method `origami/browser` and
// reads back a fixed { ok, error?, url?, pageText?, imageBase64?, imageMime?,
// tools? } shape. Everything touching VS Code lives HERE — surface probing in
// browserVsCode.ts, tool ids and prose in browserTools.ts, the reading of answers
// in browserResult.ts. What is left is which tool a verb means, which page it acts
// on, and whether the answer is a success. Every tool takes a `pageId`, so
// browserPage's lookupPage runs first — it also brings the page ON SCREEN, because
// a tab that is not visible is not laid out and a click can never resolve on it.

import {
  LIST_TOOL,
  NO_TOOL_CALL,
  OPEN_TOOL,
  declinedOpenError,
  driveFailedError,
  failed,
  isCancellation,
  missingToolError,
  noOpenerError,
  noPageError,
  refusedOpenError,
  reusedPageNote,
  succeeded,
  unsharedOpenNote,
  pickTool,
  threwError,
  type BrowserResponse,
  type DrivenAction,
} from './browserTools';
import { check, choosePageId, declinedOpen, parseOpenedPageId, parsePageList } from './browserResult';
import {
  OPEN_COMMANDS,
  discoverTools,
  findOpenCommand,
  invoke,
  probe,
  runOpenCommand,
  str,
  toBrowserUrl,
} from './browserVsCode';
import { drive, historyInput, navigateInput } from './browserDrive';
import { lookupPage, type Found } from './browserPage';
import { emitSnapshot, type SnapshotSink } from './browserSnapshot';
import { applyOpenBeside } from './browserFocus';
import { markRevealed } from './browserReveal';

export { toBrowserUrl };
export type { BrowserSnapshot, SnapshotSink } from './browserSnapshot';

/** The three verbs that move a page without NAMING one — see `driveHistory`. */
export type HistoryAction = 'back' | 'forward' | 'reload';

export type BrowserAction = 'probe' | 'open' | 'navigate' | HistoryAction | DrivenAction;

export interface BrowserRequest {
  action: BrowserAction;
  url?: string;
  selector?: string;
  /** `drag` only: the element to drop ONTO. `drag_element` names its two ends
   *  separately, so one selector could never have expressed it. */
  toSelector?: string;
  text?: string;
  /** `type` only: a key or combination pressed instead of typed. */
  key?: string;
  /** `dialog` only: accept it, or dismiss it. */
  accept?: boolean;
  /** `raw` only: the Playwright snippet. */
  code?: string;
}

export type { BrowserResponse };

/** The ext method the engine calls. The TS ACP SDK forwards it verbatim; the
 *  Rust one prefixes `_`, so both spellings are accepted (see extNotification). */
export const BROWSER_METHOD = 'origami/browser';

export function isBrowserMethod(method: string): boolean {
  return method === BROWSER_METHOD || method === `_${BROWSER_METHOD}`;
}

/** There is deliberately no `comments` action for the integrated browser's
 *  "Comment on Elements" mode, and the reason is structural. The comment is typed
 *  into the workbench chat widget's own input and the element rides on its
 *  attachment model; neither is reachable from outside a chat request, none of the
 *  eleven published browser tools reads a comment, and the composer lives in a
 *  closed shadow root no snapshot or snippet can pierce. */
const ACTIONS: readonly BrowserAction[] = [
  'probe',
  'open',
  'navigate',
  'back',
  'forward',
  'reload',
  'screenshot',
  'read',
  'click',
  'type',
  'hover',
  'drag',
  'dialog',
  'raw',
];

/** Decode the wire params. An unknown action is refused by name rather than
 *  guessed at — the engine and this file are built against one contract, so a
 *  request outside it means the two have drifted. */
export function parseRequest(params: Record<string, unknown> | undefined | null): BrowserRequest | undefined {
  const action = str(params?.['action']);
  if (!action || !ACTIONS.includes(action as BrowserAction)) return undefined;
  return {
    action: action as BrowserAction,
    url: str(params?.['url']),
    selector: str(params?.['selector']),
    toSelector: str(params?.['toSelector']),
    // An empty string is a real instruction for `text` (and only refused once
    // the client knows VS Code cannot serve it), where an empty key or an empty
    // snippet is nothing at all — hence `str`, which drops both.
    text: typeof params?.['text'] === 'string' ? (params['text'] as string) : undefined,
    key: str(params?.['key']),
    accept: typeof params?.['accept'] === 'boolean' ? (params['accept'] as boolean) : undefined,
    code: str(params?.['code']),
  };
}

/** Answer one `origami/browser` request. Never throws: the caller is a tool result
 *  on the model's side, so a dead surface has to arrive as readable prose, not a
 *  JSON-RPC error the model cannot see. */
export async function handleBrowserRequest(request: BrowserRequest): Promise<BrowserResponse> {
  switch (request.action) {
    case 'probe': {
      const { tools, openCommand } = await probe();
      return succeeded(NO_TOOL_CALL, {
        tools,
        pageText: openCommand
          ? `open command: ${openCommand}`
          : `no integrated-browser open command found (tried ${OPEN_COMMANDS.join(', ')})`,
      });
    }

    case 'open':
    case 'navigate': {
      if (!request.url) return failed(`"${request.action}" needs a url.`);
      const url = toBrowserUrl(request.url);
      // navigate prefers the agent tool: it moves the OPEN page, where opening adds a
      // second tab. With no page open there is nothing to move, so it falls through to
      // opening and says so rather than reporting a move it did not make.
      if (request.action === 'navigate') {
        const moved = await driveNavigate(url);
        if (moved) return moved;
      }
      return await openPage(request.action, url);
    }

    case 'back':
    case 'forward':
    case 'reload':
      return await driveHistory(request.action);

    // Everything else acts on a page that is already shared and shares one shape —
    // tool lookup, page lookup, reveal, retry ladder. That is browserDrive.ts.
    default:
      return await drive(request);
  }
}

/** Move ONE known page to a url, and report whether VS Code actually moved it.
 *  Shared by the navigate verb and by an open VS Code declined. `note` is what the
 *  CALLER adds, and leads the page summary rather than replacing it. */
async function movePage(
  url: string,
  tools: string[],
  name: string,
  pageId: string,
  note?: string,
): Promise<BrowserResponse> {
  try {
    const seen = check(await invoke(name, navigateInput(pageId, url)), 'navigate');
    if (seen.failed !== undefined) return failed(driveFailedError('navigate', name, seen.failed), tools);
    const text = [note, seen.checked.text].filter(Boolean).join('\n');
    return succeeded(seen.checked, { url, tools, ...(text ? { pageText: text } : {}) });
  } catch (error) {
    return failed(threwError('navigate', error), tools);
  }
}

/** Move the open page. `undefined` means "there was nothing to move" — the
 *  caller then opens instead, which is what the request meant anyway. */
async function driveNavigate(url: string): Promise<BrowserResponse | undefined> {
  const tools = discoverTools();
  const name = pickTool(tools, 'navigate');
  if (!name) return undefined;
  let found: Found;
  try {
    found = await lookupPage(tools);
  } catch (error) {
    return failed(threwError('navigate', error), tools);
  }
  // A FAILED list is not "nothing to move": opening on it answers a reason with a tab.
  if (found.failed !== undefined) return failed(driveFailedError('navigate', LIST_TOOL, found.failed), tools);
  if (!found.pageId) return undefined;
  return await movePage(url, tools, name, found.pageId, found.note);
}

/** Move the open page through its own history, or load it again — `driveNavigate`
 *  minus the fallback. These three name no url, so no page is the END of the
 *  answer. The miss of the TOOL is reported against `navigate`, which is the id
 *  that would be absent. */
async function driveHistory(action: HistoryAction): Promise<BrowserResponse> {
  const tools = discoverTools();
  const name = pickTool(tools, 'navigate');
  if (!name) {
    const { openCommand } = await probe();
    return failed(missingToolError('navigate', tools, openCommand), tools);
  }
  let found: Found;
  try {
    found = await lookupPage(tools);
  } catch (error) {
    return failed(threwError(action, error), tools);
  }
  if (found.failed !== undefined) return failed(driveFailedError(action, LIST_TOOL, found.failed), tools);
  if (!found.pageId) return failed(noPageError(action, found.unshared, tools), tools);
  try {
    // Checked as a `navigate`: the failure signals belong to the tool that ran.
    const seen = check(await invoke(name, historyInput(found.pageId, action)), 'navigate');
    if (seen.failed !== undefined) return failed(driveFailedError(action, name, seen.failed, found.screen), tools);
    const text = [found.note, seen.checked.text].filter(Boolean).join('\n');
    return succeeded(seen.checked, { tools, ...(text ? { pageText: text } : {}) });
  } catch (error) {
    return failed(threwError(action, error), tools);
  }
}

/** Show a url. `open_browser_page` is preferred over the open COMMAND because only
 *  the tool SHARES the page with the agent — a page opened by the command is
 *  `notShared` and every page verb afterwards fails. The tool also answers with the
 *  page id, so the open is self-verifying. The command stays as the fallback. */
async function openPage(action: string, url: string): Promise<BrowserResponse> {
  const tools = discoverTools();
  // Beside the chat, not over it — browserFocus.ts owns the rule and the one
  // workbench setting that expresses it. Before the open, because the placement is
  // read when the editor group is chosen.
  await applyOpenBeside();
  if (tools.includes(OPEN_TOOL)) {
    try {
      const seen = check(await invoke(OPEN_TOOL, { url }));
      // Through the SAME gate as the driven verbs, which is the point: a failure
      // reported IN the result used to fall past into a hand-written success.
      if (seen.failed !== undefined) return failed(driveFailedError(action, OPEN_TOOL, seen.failed), tools);
      const parts = seen.checked;
      const pageId = parseOpenedPageId(parts.text);
      // A page id means it opened SHARED; the rest of that reply is the page summary,
      // which `read` returns on demand. No page id means the reduced open (sharing off)
      // — VS Code's own sentence is passed through verbatim rather than guessed at.
      if (pageId) {
        // VS Code's own open put this tab on screen — that IS the one reveal the
        // default policy allows, so it is recorded here rather than pretended
        // away. Under "first" every later verb on this id then leaves it alone.
        markRevealed(pageId);
        return succeeded(parts, { url, tools, pageText: `Opened as page ${pageId}, shared with the agent.` });
      }
      if (declinedOpen(parts.text)) return await reuseDeclined(url, tools, parts.text);
      return succeeded(parts, { url, tools, ...(parts.text ? { pageText: parts.text } : {}) });
    } catch (error) {
      // On 1.132.0 `open_browser_page` carries confirmationMessages, and the
      // no-chat-context branch of invokeTool raises that modal itself and throws a
      // cancellation when it is DECLINED — falling through to the open COMMAND put the
      // very url the user had just refused on screen. A refusal is an answer, so it is
      // reported. Every other throw is a capability failure in which nobody was asked,
      // so the command still stands as the fallback.
      if (isCancellation(error)) return failed(refusedOpenError(action, error), tools);
    }
  }
  const command = await findOpenCommand();
  if (!command) return failed(noOpenerError(OPEN_COMMANDS), tools);
  try {
    await runOpenCommand(command, url);
  } catch (error) {
    return failed(threwError(action, error), tools);
  }
  return succeeded(NO_TOOL_CALL, { url, tools, pageText: unsharedOpenNote(command) });
}

/** VS Code opened NOTHING: a page it judges similar is already shared, and it asks
 *  for that one to be reused or for `forceNew`. Reuse is the answer taken — the
 *  short-circuit exists to stop a second tab, and navigating the named page is what
 *  makes the reported url the url the user ends up on. This listing carries ids, so
 *  the page is addressable; when it cannot be driven, the decline is reported as
 *  the failure it is, in VS Code's own words. */
async function reuseDeclined(url: string, tools: string[], reply: string): Promise<BrowserResponse> {
  const name = pickTool(tools, 'navigate');
  const pages = parsePageList(reply);
  const pageId = choosePageId(pages);
  if (!name || !pageId) return failed(declinedOpenError(reply), tools);
  return await movePage(url, tools, name, pageId, reusedPageNote(pageId, pages.length));
}

/** The whole ext-method seam, as one call for acpClient's delegating member.
 *  `onSnapshot`, when the host supplies one, is fed a frame for the chat pane's
 *  browser strip — after the answer, never in front of it (browserSnapshot.ts). */
export async function handleBrowserExtMethod(
  params: Record<string, unknown> | undefined,
  onSnapshot?: SnapshotSink,
): Promise<Record<string, unknown>> {
  const request = parseRequest(params);
  const unknown = `Unknown browser action: ${JSON.stringify(params?.['action'] ?? null)}.`;
  const answer = request ? await handleBrowserRequest(request) : failed(unknown);
  if (request && onSnapshot) {
    emitSnapshot(request.action, answer, onSnapshot, () => handleBrowserRequest({ action: 'screenshot' }));
  }
  return answer as unknown as Record<string, unknown>;
}

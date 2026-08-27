// browserBridge.ts — the CLIENT half of the engine's `browser` tool.
//
// The engine drives no browser (packages/engine/src/browser/bridge.ts): it
// sends the ACP ext method `origami/browser` and reads back the fixed
// { ok, error?, url?, pageText?, imageBase64?, imageMime?, tools? } shape.
// Everything that touches VS Code lives HERE, not in acpClient.ts, which sits
// against its architecture cap — that file keeps only a delegating member.
//
// Two VS Code surfaces are used — the open COMMAND and the browser agent TOOLS
// — and neither is guaranteed on the build the user is running, so both are
// probed rather than assumed. That probing lives in browserVsCode.ts; the tool
// ids and this feature's prose in browserTools.ts; the reading of what VS Code
// answers, failure included, in browserResult.ts. What is left HERE is the
// deciding: which tool a verb means, which page it acts on, and whether what
// came back counts as a success.
//
// Every one of those tools takes a `pageId`, which is why browserPage's
// lookupPage runs before any page verb: without it VS Code answers "No page ID
// provided" and nothing happens. That file left this one when it grew the job
// of getting the page ON SCREEN as well as finding it — an editor tab that is
// not visible is not laid out, and two UAT rounds of clicks died on exactly
// that. The forced click that answers what a reveal cannot is browserForce.ts.
// A verb whose tool merely RESOLVED is not a success. NOTHING in this file
// decides that any more: every answer is minted by browserTools' `failed` /
// `succeeded`, and `succeeded` cannot be called without the `Checked` that
// browserResult's `check` alone hands out, after reading the failure signals.

import {
  LIST_TOOL,
  NO_TOOL_CALL,
  OPEN_TOOL,
  declinedOpenError,
  driveFailedError,
  failed,
  isCancellation,
  noOpenerError,
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
import { drive, navigateInput } from './browserDrive';
import { lookupPage, type Found } from './browserPage';

export { toBrowserUrl };

export type BrowserAction = 'probe' | 'open' | 'navigate' | DrivenAction;

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

const ACTIONS: readonly BrowserAction[] = [
  'probe',
  'open',
  'navigate',
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

/**
 * Answer one `origami/browser` request. Never throws: the caller is a tool
 * result on the model's side, so a dead surface has to arrive as readable
 * prose, not as a JSON-RPC error the model cannot see.
 */
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
      // navigate prefers the agent tool: it moves the OPEN page, where opening
      // adds a second tab. With no page open there is nothing to move, so it
      // falls through to opening and says so rather than reporting a move it
      // did not make.
      if (request.action === 'navigate') {
        const moved = await driveNavigate(url);
        if (moved) return moved;
      }
      return await openPage(request.action, url);
    }

    // Everything else acts on a page that is already shared, and they all share
    // one shape — tool lookup, page lookup, reveal, retry ladder. That is
    // browserDrive.ts, which is where the eight of them live.
    default:
      return await drive(request);
  }
}

/** Move ONE known page to a url, and report whether VS Code actually moved it.
 *  Shared by the navigate verb and by an open VS Code declined: both end in the
 *  same tool call, so both owe the same answer about whether it worked. `note`
 *  is what the CALLER has to add, and leads the page summary rather than
 *  replacing it. */
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

/**
 * Show a url. `open_browser_page` is preferred over the open COMMAND because
 * only the tool SHARES the page with the agent — a page opened by the command
 * is `notShared`, and every page verb afterwards fails with "open but not
 * shared", which is the shape of a browser that opens pages it cannot then
 * read. The tool also answers with the page id, so the open is self-verifying.
 * The command stays as the fallback, so a build without the tool is no worse
 * off than before.
 */
async function openPage(action: string, url: string): Promise<BrowserResponse> {
  const tools = discoverTools();
  if (tools.includes(OPEN_TOOL)) {
    try {
      const seen = check(await invoke(OPEN_TOOL, { url }));
      // Through the SAME gate as the driven verbs, which is the point: a failure
      // reported IN the result used to fall past into a hand-written success.
      if (seen.failed !== undefined) return failed(driveFailedError(action, OPEN_TOOL, seen.failed), tools);
      const parts = seen.checked;
      const pageId = parseOpenedPageId(parts.text);
      // A page id means it opened SHARED, and the rest of that reply is the
      // page summary, which `read` returns on demand — no need to spend it
      // here. No page id means the reduced open (sharing off): VS Code's own
      // sentence says why nothing can read the page, so it is passed through
      // verbatim rather than replaced with a guess.
      if (pageId) return succeeded(parts, { url, tools, pageText: `Opened as page ${pageId}, shared with the agent.` });
      if (declinedOpen(parts.text)) return await reuseDeclined(url, tools, parts.text);
      return succeeded(parts, { url, tools, ...(parts.text ? { pageText: parts.text } : {}) });
    } catch (error) {
      // On 1.132.0 `open_browser_page` carries confirmationMessages, and the
      // no-chat-context branch of invokeTool raises that modal itself and
      // throws a cancellation when it is DECLINED. Falling through to the open
      // COMMAND therefore put the very url the user had just refused on
      // screen, and answered ok. A refusal is an answer, so it is reported.
      // Every other throw (no chat request, a disposed view, a navigation that
      // timed out) is a capability failure in which nobody was asked and
      // nobody said no, so the command still stands as the fallback.
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

/**
 * VS Code opened NOTHING: a page it judges similar is already shared, and it
 * asks for that one to be reused or for `forceNew`. Reuse is the answer taken,
 * not `forceNew`: the short-circuit exists to stop a second tab, the tool's own
 * description asks callers to prefer an existing page, and navigating the named
 * page is what makes the url reported below the url the user ends up ON — which
 * `forceNew` would only match by opening the tab VS Code just refused. This
 * listing carries ids (only the REDUCED open passes excludeIds), so the page is
 * addressable. When it cannot be driven, the decline is reported as the failure
 * it is, in VS Code's own words, rather than as an open that happened.
 */
async function reuseDeclined(url: string, tools: string[], reply: string): Promise<BrowserResponse> {
  const name = pickTool(tools, 'navigate');
  const pages = parsePageList(reply);
  const pageId = choosePageId(pages);
  if (!name || !pageId) return failed(declinedOpenError(reply), tools);
  return await movePage(url, tools, name, pageId, reusedPageNote(pageId, pages.length));
}

/** The whole ext-method seam, as one call for acpClient's delegating member. */
export async function handleBrowserExtMethod(
  params: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const request = parseRequest(params);
  const unknown = `Unknown browser action: ${JSON.stringify(params?.['action'] ?? null)}.`;
  const answer = request ? await handleBrowserRequest(request) : failed(unknown);
  return answer as unknown as Record<string, unknown>;
}

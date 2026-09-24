// browserTools.ts — the VS Code integrated-browser CONTRACT, on its own.
//
// This file is pure and answers "what does VS Code publish, and what can this
// bridge SAY". It and browserResult.ts exchange TYPES only, both erased at build
// time, so neither gains a runtime dependency on the other. Every id below was read
// off the SHIPPED bundle (VS Code 1.132.0, re-read on 1.133.0 and 1.135.0 — the
// same eleven, unchanged), not inferred from a name: the first version inferred,
// matching `/browser/i` against tool names, and only two ids carry that word, so
// the five tools that DRIVE a page were never found.

import type { Checked } from './browserResult';

/** What this bridge ANSWERS, and the only two things that can build one.
 *
 *  Two false greens shipped, both the same shape: a second return path writing
 *  `{ ok: true, … }` by hand on a tool result whose failure signals nobody had read.
 *  So the type carries a brand that is a symbol with no runtime value: the only
 *  expressions of it are `failed` and `succeeded`, and `succeeded` asks for a
 *  `Checked`, which only browserResult's `check` produces after reading the failure
 *  signals. Success is unreachable except on the far side of the check. */
declare const ANSWERED: unique symbol;

export interface BrowserResponse {
  readonly [ANSWERED]: true;
  ok: boolean;
  error?: string;
  url?: string;
  pageText?: string;
  imageBase64?: string;
  imageMime?: string;
  /** The page viewport the picture was taken at (t-qn0lpl). A screenshot's own
   *  bytes do not say what size the PAGE was, and the chat strip's caption has
   *  to; browserViewport.ts's `measuredSize` is where the pair comes from. Only
   *  the screenshot path sets it. */
  width?: number;
  height?: number;
  tools?: string[];
}

/** A success minus the verdict — that part is not the caller's to write. */
export type Answer = Omit<BrowserResponse, typeof ANSWERED | 'ok' | 'error'>;

/** A refusal needs no proof: nothing has ever shipped by calling a failure a
 *  failure. Only the green direction is gated. */
export function failed(error: string, tools?: string[]): BrowserResponse {
  return { ok: false, error, ...(tools ? { tools } : {}) } as BrowserResponse;
}

/** `checked` is spent at COMPILE time — it is the proof the signals were read.
 *  It is re-read at run time as well, so that even a `Checked` someone cast by
 *  hand comes back out as the failure it carries. */
export function succeeded(checked: Checked, answer: Answer): BrowserResponse {
  if (checked.error) return failed(checked.error, answer.tools);
  return { ok: true, ...answer } as BrowserResponse;
}

/** The two answers that invoke no tool at all — the `probe` verb, and the open
 *  COMMAND. Named out loud, because every other success owes a real one. */
export const NO_TOOL_CALL = { text: '' } as Checked;

/** Opens a page AND shares it with the agent; answers with the page id. */
export const OPEN_TOOL = 'open_browser_page';
/** The shared-page inventory. Its presence is also a diagnostic — see `missingToolError`. */
export const LIST_TOOL = 'list_browser_pages';

/** The one tool each driven action maps to, by `vscode.lm.tools[].name` (the
 *  ext-host projection sets `name` from the workbench tool's `id`). Every one of
 *  these takes a `pageId`, which is what browserPage's lookup is for. */
export const ACTION_TOOLS = {
  navigate: 'navigate_page',
  screenshot: 'screenshot_page',
  read: 'read_page',
  click: 'click_element',
  type: 'type_in_page',
  hover: 'hover_element',
  drag: 'drag_element',
  dialog: 'handle_dialog',
  raw: 'run_playwright_code',
} as const;

export type DrivenAction = keyof typeof ACTION_TOOLS;

/** Raw Playwright. Also the last rung of the click ladder (browserForce.ts) — the
 *  alias keeps that one call site reading as what it is. */
export const PLAYWRIGHT_TOOL = ACTION_TOOLS.raw;

const FAMILY: ReadonlySet<string> = new Set<string>([OPEN_TOOL, LIST_TOOL, ...Object.values(ACTION_TOOLS)]);

/** The fallback, for a build that renamed something. The shipped family names its
 *  members after what they act ON — `..._page`, `..._pages`, `..._element` — so
 *  that SEGMENT is matched, not the word "browser": a suffixed `read_page_v2` still
 *  counts while `fetch_webpage` and `read_file` do not. `playwright` is named
 *  outright. Used only after an exact id match misses. */
const FAMILY_SHAPE = /browser|playwright|_(?:page|pages|element)(?:_|$)/i;

export function isBrowserTool(name: string): boolean {
  return FAMILY.has(name) || FAMILY_SHAPE.test(name);
}

/** Only consulted when the exact id is absent. Deliberately narrow: a wrong
 *  guess here drives the wrong tool, which is worse than reporting the miss. */
const RENAME_HINTS: Record<DrivenAction, RegExp> = {
  navigate: /navigate|goto/i,
  screenshot: /screenshot|capture/i,
  read: /read|snapshot|summar/i,
  click: /click/i,
  type: /type|fill/i,
  hover: /hover/i,
  drag: /drag/i,
  dialog: /dialog|alert|prompt/i,
  raw: /playwright|evaluate/i,
};

/** The tool that serves one action: its real id first, a renamed sibling second. */
export function pickTool(published: readonly string[], action: DrivenAction): string | undefined {
  const exact = ACTION_TOOLS[action];
  if (published.includes(exact)) return exact;
  return published.find((name) => isBrowserTool(name) && RENAME_HINTS[action].test(name));
}

/** Named ONLY where it is genuinely the cause — see `missingToolError`. */
const ENABLE_SETTING = 'workbench.browser.enableChatTools';

/** Why an action has no tool. Three different causes, three different answers. The
 *  setting appears in exactly one of them, and it is checkable rather than guessed
 *  at: VS Code registers the browser tools in an if/else and the
 *  sharing-unavailable branch publishes `open_browser_page` ALONE, so
 *  open-without-list IS that branch. Any other shape means the full branch ran and
 *  the setting is already on, which is why the third case never mentions it. */
export function missingToolError(action: string, published: readonly string[], openCommand?: string): string {
  const wanted = ACTION_TOOLS[action as DrivenAction] ?? action;
  if (published.length === 0) {
    // The open COMMAND is a separate surface from the tools, so a build can
    // still SHOW a page while being unable to read one. Saying so turns a dead
    // end into a usable answer: open the page, then look at it yourself.
    const canShow = openCommand
      ? ` A page can still be opened (${openCommand}) — it just cannot be read or driven from here.`
      : '';
    return (
      `This VS Code build published no integrated-browser tools to extensions at all, so "${action}" cannot be driven. ` +
      `vscode.lm.tools carries neither "${OPEN_TOOL}" nor "${wanted}".${canShow}`
    );
  }
  if (published.includes(OPEN_TOOL) && !published.includes(LIST_TOOL)) {
    return (
      `VS Code published only "${OPEN_TOOL}" (it published: ${published.join(', ')}), which is the reduced set it ` +
      `registers when integrated-browser page sharing is unavailable — so there is no "${wanted}" to run. ` +
      `Enabling "${ENABLE_SETTING}" is what publishes the full set, "${LIST_TOOL}" included.`
    );
  }
  return (
    `This VS Code build published ${published.join(', ')}, but nothing that can "${action}": ` +
    `it has no "${wanted}". The action is unavailable on this build.`
  );
}

/** VS Code ran the tool and reported the action FAILED. Its own message is the whole
 *  answer. `screen` is where the page WAS when it ran (browserPage.ts), spent only
 *  here because it is the one moment the difference between a hidden tab and a wrong
 *  selector changes what to try next. */
export function driveFailedError(action: string, tool: string, message: string, screen?: string): string {
  const where = screen ? `\n${screen}` : '';
  return `The VS Code browser ran "${tool}" for "${action}" and it failed: ${message}${where}`;
}

/** A VS Code surface that THREW instead of answering at all. */
export function threwError(action: string, error: unknown): string {
  return `The VS Code browser failed to "${action}": ${error instanceof Error ? error.message : String(error)}`;
}

/** The decline could not be served — this build published nothing that can
 *  drive the page it named. VS Code's own reply is forwarded whole, because it
 *  IS the reason, and it names the pages that got in the way. */
export function declinedOpenError(reply: string): string {
  return `The VS Code browser did not open the url. It answered:\n${reply}`;
}

/** An open served by REUSING the page VS Code pointed at. That is what its own
 *  reply asks for, and `forceNew` would open the very second tab the
 *  short-circuit exists to prevent. */
export function reusedPageNote(pageId: string, count: number): string {
  const others = count > 1 ? ` (${count} similar pages were listed)` : '';
  return `A similar page was already shared, so page ${pageId} was navigated to this url instead${others}.`;
}

/** Neither surface that can SHOW a page exists on this build. Kept beside the
 *  other refusals so all of this bridge's prose is in one file. */
export function noOpenerError(commands: readonly string[]): string {
  return (
    'This VS Code build registers no integrated-browser open command ' +
    `(tried ${commands.join(', ')}) and published no "${OPEN_TOOL}", so a page cannot be shown.`
  );
}

/** What the open COMMAND leaves behind. Unlike `open_browser_page` it does not
 *  share the page, so it is the one success worth warning about — the next
 *  verb is the one that pays for it. */
export function unsharedOpenNote(command: string): string {
  return (
    `${command} opened the url. It was opened WITHOUT being shared with the agent, ` +
    'so reading or clicking it may report that no page is shared.'
  );
}

/** Why a published tool has no page to work on. Never the setting: reaching
 *  here means the tool was found, so the full registration branch already ran. */
export function noPageError(action: string, unshared: number, published: readonly string[]): string {
  if (!published.includes(LIST_TOOL)) {
    return (
      `This build published no "${LIST_TOOL}", so the page id "${action}" needs cannot be looked up. ` +
      `Use this tool's "open" action, which reports the page it opened.`
    );
  }
  if (unshared > 0) {
    return (
      `${unshared} browser page${unshared === 1 ? ' is' : 's are'} open in VS Code but not shared with the agent, ` +
      `so "${action}" has no page to work on. Use this tool's "open" action, which opens a page already shared.`
    );
  }
  return `No page is open in the VS Code integrated browser, so "${action}" has nothing to work on. Open one first.`;
}

/** `type_in_page` guards `!text && !key`, so an empty string ALONE is refused by VS
 *  Code — clearing a field is not expressible through the published contract.
 *  Refused here, with the real reason. An empty text WITH a key is a keypress. */
export const EMPTY_TEXT_ERROR =
  'The VS Code browser cannot type an empty string: its "type_in_page" tool refuses text that is empty, ' +
  'so a field cannot be cleared this way. Select the existing text and type over it instead.';

/** `handle_dialog` refuses a call carrying neither `acceptModal` nor
 *  `selectFiles`, and this bridge offers no file chooser — so `accept` is not
 *  optional here, whatever the schema's `required` list says. */
export const DIALOG_ACCEPT_ERROR =
  '"dialog" needs accept: true to accept the dialog, false to dismiss it. VS Code\'s "handle_dialog" refuses a ' +
  'call that says neither.';

/** `raw` is code execution, gated the way the forced click is: `run_playwright_code`
 *  carries `confirmationMessages`, this extension invokes with
 *  `toolInvocationToken: undefined`, and an unanswered modal holds the turn until
 *  the engine's 30s timeout. So the code is not sent at all. */
export function rawBlockedError(): string {
  return (
    `"raw" runs Playwright code through "${ACTION_TOOLS.raw}", which VS Code confirms with a modal dialog ` +
    'unless "chat.tools.global.autoApprove" is on, and that setting is off — the dialog would stop this session ' +
    'until someone answered it. The composer\'s Browser control switches it between Ask and Bypass.'
  );
}

/** The residual that setting cannot suppress: the FIRST time global auto-approve is
 *  used VS Code raises its own opt-in warning, and declining it arrives here as a
 *  cancellation. Reported as the refusal it is, never as a snippet that ran. */
export function rawDismissedError(): string {
  return (
    `VS Code raised its own confirmation for "${ACTION_TOOLS.raw}" and it was dismissed, so the code did not run. ` +
    'That prompt is the one-time opt-in behind global auto-approve; answering it stores the opt-in.'
  );
}

/** The throw VS Code produces when `open_browser_page` is declined — structurally
 *  different from a timed-out navigation or a disposed view. Every throw that is NOT
 *  a cancellation is a capability failure where the open COMMAND is the fallback. */
export function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'Canceled' || /cancel/i.test(error.message));
}

/** The user declined the share-modal VS Code raised. Not the same as a
 *  tool that ran and failed — no tool ran at all. */
export function refusedOpenError(action: string, error: unknown): string {
  return `"${action}" was cancelled: ${error instanceof Error ? error.message : String(error)}`;
}
